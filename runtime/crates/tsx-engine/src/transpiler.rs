//! TypeScript to JavaScript transpilation using SWC.
//!
//! All code transformations happen at the AST level for correctness:
//! 1. TypeScript type stripping
//! 2. AwaitLastExpr - wrap last expression with await
//! 3. WrapInAsyncIife - wrap all code in async IIFE with error handling
//!
//! FUTURE IMPROVEMENTS:
//! - Add source maps for accurate error line mapping
//! - Add CommonJS → ESM transform (require() → import)
//! - Add global shim injection at AST level (console, fs, Buffer, etc.)

use std::mem;
use std::collections::BTreeMap;
use swc_common::{
    source_map::DefaultSourceMapGenConfig, sync::Lrc, FileName, Mark, SourceMap, Spanned, DUMMY_SP,
    GLOBALS,
};
use swc_ecma_ast::{
    ArrowExpr, AwaitExpr, BindingIdent, BlockStmt, BlockStmtOrExpr, CallExpr, Callee, EsVersion,
    Expr, ExprOrSpread, ExprStmt, Ident, IdentName, MemberExpr, MemberProp, Module, ModuleItem,
    ParenExpr, Pat, Program, Stmt, ThrowStmt,
};
use swc_ecma_codegen::{text_writer::JsWriter, Config, Emitter};
use swc_ecma_parser::{lexer::Lexer, Parser, StringInput, Syntax, TsSyntax};
use swc_ecma_transforms_base::{fixer::fixer, resolver};
use swc_ecma_transforms_typescript::strip;
use swc_ecma_visit::VisitMut;

// ============================================================================
// TRANSPILE RESULT
// ============================================================================

/// Result of transpilation
#[derive(Debug)]
pub struct TranspileResult {
    /// Generated JavaScript code
    pub code: String,
    /// True when source contains import/export declarations.
    pub contains_module_decls: bool,
    /// Generated-line -> original-line mapping (1-based lines)
    pub line_map: Option<Vec<usize>>,
    /// Source map JSON (for error line mapping) - TODO: implement
    #[allow(dead_code)]
    pub source_map: Option<Vec<u8>>,
}

// ============================================================================
// AST TRANSFORMS
// ============================================================================

/// AST Transform: Wrap the last expression statement with `await`
///
/// This handles the common LLM-generated pattern:
/// ```javascript
/// async function doWork() { await fetch(...); }
/// doWork();  // <- Promise would be orphaned without await
/// ```
///
/// By transforming the last expression to `await doWork();`, we ensure
/// the Promise is awaited and the async function body executes completely.
struct AwaitLastExpr;

impl VisitMut for AwaitLastExpr {
    fn visit_mut_module_items(&mut self, items: &mut Vec<ModuleItem>) {
        if let Some(last) = items.last_mut() {
            if let ModuleItem::Stmt(Stmt::Expr(expr_stmt)) = last {
                let original_expr = mem::take(&mut expr_stmt.expr);
                expr_stmt.expr = Box::new(Expr::Await(AwaitExpr {
                    span: DUMMY_SP,
                    arg: original_expr,
                }));
            }
        }
    }
}

/// AST Transform: Wrap entire module in async IIFE with error handling
///
/// Transforms:
///   stmt1; stmt2; ...
/// Into:
///   (async () => { stmt1; stmt2; ... })().catch(e => { throw e; })
///
/// This enables top-level await and ensures all async code completes.
struct WrapInAsyncIife;

impl WrapInAsyncIife {
    fn transform(module: &mut Module) {
        // Take all existing items
        let items = mem::take(&mut module.body);

        // Convert ModuleItems to Stmts
        let stmts: Vec<Stmt> = items
            .into_iter()
            .filter_map(|item| match item {
                ModuleItem::Stmt(s) => Some(s),
                ModuleItem::ModuleDecl(_) => None, // Module declarations not supported in eval
            })
            .collect();

        if stmts.is_empty() {
            return;
        }

        // Build: async () => { stmts }
        let async_body = Expr::Arrow(ArrowExpr {
            span: DUMMY_SP,
            params: vec![],
            body: Box::new(BlockStmtOrExpr::BlockStmt(BlockStmt {
                span: DUMMY_SP,
                stmts,
                ctxt: Default::default(),
            })),
            is_async: true,
            is_generator: false,
            type_params: None,
            return_type: None,
            ctxt: Default::default(),
        });

        // Build: (async () => {...})()
        let iife = Expr::Call(CallExpr {
            span: DUMMY_SP,
            callee: Callee::Expr(Box::new(Expr::Paren(ParenExpr {
                span: DUMMY_SP,
                expr: Box::new(async_body),
            }))),
            args: vec![],
            type_args: None,
            ctxt: Default::default(),
        });

        // Build error handler: e => { console.error('Uncaught:', e); throw e; }
        // We log first because async throws become unhandled rejections that QuickJS ignores
        let catch_handler = Expr::Arrow(ArrowExpr {
            span: DUMMY_SP,
            params: vec![Pat::Ident(BindingIdent {
                id: Ident::new("e".into(), DUMMY_SP, Default::default()),
                type_ann: None,
            })],
            body: Box::new(BlockStmtOrExpr::BlockStmt(BlockStmt {
                span: DUMMY_SP,
                stmts: vec![
                    // console.error('Uncaught:', e)
                    Stmt::Expr(ExprStmt {
                        span: DUMMY_SP,
                        expr: Box::new(Expr::Call(CallExpr {
                            span: DUMMY_SP,
                            callee: Callee::Expr(Box::new(Expr::Member(MemberExpr {
                                span: DUMMY_SP,
                                obj: Box::new(Expr::Ident(Ident::new(
                                    "console".into(),
                                    DUMMY_SP,
                                    Default::default(),
                                ))),
                                prop: MemberProp::Ident(IdentName::new("error".into(), DUMMY_SP)),
                            }))),
                            args: vec![
                                ExprOrSpread {
                                    spread: None,
                                    expr: Box::new(Expr::Lit(swc_ecma_ast::Lit::Str(
                                        swc_ecma_ast::Str {
                                            span: DUMMY_SP,
                                            value: "Uncaught:".into(),
                                            raw: None,
                                        },
                                    ))),
                                },
                                ExprOrSpread {
                                    spread: None,
                                    expr: Box::new(Expr::Ident(Ident::new(
                                        "e".into(),
                                        DUMMY_SP,
                                        Default::default(),
                                    ))),
                                },
                            ],
                            type_args: None,
                            ctxt: Default::default(),
                        })),
                    }),
                    // throw e
                    Stmt::Throw(ThrowStmt {
                        span: DUMMY_SP,
                        arg: Box::new(Expr::Ident(Ident::new(
                            "e".into(),
                            DUMMY_SP,
                            Default::default(),
                        ))),
                    }),
                ],
                ctxt: Default::default(),
            })),
            is_async: false,
            is_generator: false,
            type_params: None,
            return_type: None,
            ctxt: Default::default(),
        });

        // Build: .catch(e => { throw e; })
        // Use IdentName for property access (not Ident)
        let full_expr = Expr::Call(CallExpr {
            span: DUMMY_SP,
            callee: Callee::Expr(Box::new(Expr::Member(MemberExpr {
                span: DUMMY_SP,
                obj: Box::new(iife),
                prop: MemberProp::Ident(IdentName::new("catch".into(), DUMMY_SP)),
            }))),
            args: vec![ExprOrSpread {
                spread: None,
                expr: Box::new(catch_handler),
            }],
            type_args: None,
            ctxt: Default::default(),
        });

        // Replace module body with single expression statement
        module.body = vec![ModuleItem::Stmt(Stmt::Expr(ExprStmt {
            span: DUMMY_SP,
            expr: Box::new(full_expr),
        }))];
    }
}

// ============================================================================
// PUBLIC API
// ============================================================================

/// Transpile TypeScript code to JavaScript with async IIFE wrapping.
///
/// Applies the following transforms:
/// 1. TypeScript type stripping
/// 2. AwaitLastExpr - wrap last expression with await
/// 3. WrapInAsyncIife - wrap in async IIFE
///
/// Returns generated code and placeholder for future source map.
pub fn transpile(ts_code: &str) -> Result<TranspileResult, String> {
    GLOBALS.set(&Default::default(), || transpile_inner(ts_code, true))
}

/// Transpile TypeScript code to JavaScript WITHOUT async IIFE wrapping.
/// Used for module loading where the wrapper isn't needed.
pub fn transpile_code_only(ts_code: &str) -> Result<String, String> {
    GLOBALS.set(&Default::default(), || {
        transpile_inner(ts_code, false).map(|r| r.code)
    })
}

fn transpile_inner(ts_code: &str, wrap_in_iife: bool) -> Result<TranspileResult, String> {
    let cm: Lrc<SourceMap> = Default::default();

    // Create a source file
    let source = ts_code.to_string();
    let fm = cm.new_source_file(Lrc::new(FileName::Custom("input.ts".into())), source);

    // Configure TypeScript parser with TSX support
    let syntax = Syntax::Typescript(TsSyntax {
        tsx: true,
        decorators: true,
        ..Default::default()
    });

    // Parse the TypeScript
    let lexer = Lexer::new(syntax, EsVersion::Es2020, StringInput::from(&*fm), None);
    let mut parser = Parser::new_from(lexer);

    let module = parser
        .parse_module()
        .map_err(|e| format_parse_error(ts_code, e))?;

    let contains_module_decls = module
        .body
        .iter()
        .any(|item| matches!(item, ModuleItem::ModuleDecl(_)));

    // Check for parse errors
    for err in parser.take_errors() {
        return Err(format_parse_error(ts_code, err));
    }

    // Transform 1: Strip TypeScript types
    let unresolved_mark = Mark::new();
    let top_level_mark = Mark::new();
    let mut program = Program::Module(module);

    use swc_ecma_ast::Pass;
    let mut resolver_pass = resolver(unresolved_mark, top_level_mark, true);
    resolver_pass.process(&mut program);

    let mut pass = strip(unresolved_mark, top_level_mark);
    pass.process(&mut program);

    if wrap_in_iife && !contains_module_decls {
        // Transform 2: Await last expression
        AwaitLastExpr.visit_mut_program(&mut program);

        // Transform 3: Wrap in async IIFE
        if let Program::Module(ref mut module) = program {
            WrapInAsyncIife::transform(module);
        }
    }

    let mut fix = fixer(None);
    fix.process(&mut program);

    // Extract the module
    let module = match program {
        Program::Module(m) => m,
        _ => return Err("Expected module".to_string()),
    };

    // Emit JavaScript (source map generation TODO)
    let mut buf = vec![];
    let mut raw_mappings = Vec::new();
    {
        let mut emitter = Emitter {
            cfg: Config::default(),
            cm: cm.clone(),
            comments: None,
            wr: JsWriter::new(cm.clone(), "\n", &mut buf, Some(&mut raw_mappings)),
        };

        emitter
            .emit_module(&module)
            .map_err(|e| format!("Emit error: {:?}", e))?;
    }

    let mut line_map = BTreeMap::<usize, usize>::new();
    for (byte_pos, gen_loc) in &raw_mappings {
        let orig_loc = cm.lookup_char_pos(*byte_pos);
        line_map
            .entry(gen_loc.line as usize + 1)
            .or_insert(orig_loc.line);
    }
    let max_gen_line = line_map.keys().copied().max().unwrap_or(0);
    let dense_line_map = if max_gen_line > 0 {
        let mut dense = vec![0usize; max_gen_line];
        let mut last = 1usize;
        for line in 1..=max_gen_line {
            if let Some(mapped) = line_map.get(&line) {
                last = *mapped;
            }
            dense[line - 1] = last;
        }
        Some(dense)
    } else {
        None
    };

    let mut source_map_bytes = Vec::new();
    let source_map = cm.build_source_map(&raw_mappings, None, DefaultSourceMapGenConfig);
    source_map
        .to_writer(&mut source_map_bytes)
        .map_err(|e| format!("Source map emit error: {:?}", e))?;

    Ok(TranspileResult {
        code: String::from_utf8(buf).map_err(|e| format!("UTF-8 error: {}", e))?,
        contains_module_decls,
        line_map: dense_line_map,
        source_map: Some(source_map_bytes),
    })
}

// ============================================================================
// ERROR FORMATTING
// ============================================================================

/// Format a parse error with code context and a human-readable description
fn format_parse_error(source: &str, err: swc_ecma_parser::error::Error) -> String {
    let span = err.span();
    let lo = span.lo.0 as usize;

    // Find line number and column
    let mut line_num = 1;
    let mut line_start = 0;
    let mut col = lo;

    for (i, c) in source.char_indices() {
        if i >= lo {
            col = lo - line_start;
            break;
        }
        if c == '\n' {
            line_num += 1;
            line_start = i + 1;
        }
    }

    // Get the problematic line
    let line_content: &str = source[line_start..].lines().next().unwrap_or("");

    // Build caret pointer
    let caret = format!("{}^", " ".repeat(col));

    // Get human-readable error message
    let err_msg = format!("{:?}", err);
    let readable_msg = extract_readable_error(&err_msg);

    format!(
        "Parse error at line {}:\n  {}\n  {}\n{}",
        line_num, line_content, caret, readable_msg
    )
}

/// Extract a human-readable message from SWC error debug output
fn extract_readable_error(err_debug: &str) -> String {
    // Common TypeScript error codes to human-readable messages
    if err_debug.contains("TS1109") {
        return "Expression expected".to_string();
    } else if err_debug.contains("TS1005") {
        return "Expected token (likely missing semicolon, comma, or bracket)".to_string();
    } else if err_debug.contains("TS1002") {
        return "Unterminated string literal".to_string();
    } else if err_debug.contains("TS1003") {
        return "Identifier expected".to_string();
    } else if err_debug.contains("TS1128") {
        return "Declaration or statement expected".to_string();
    } else if err_debug.contains("TS1136") {
        return "Property assignment expected".to_string();
    } else if err_debug.contains("TS1160") {
        return "Tagged template expressions not allowed here".to_string();
    } else if err_debug.contains("TS2304") {
        return "Cannot find name".to_string();
    } else if err_debug.contains("TS1161") {
        return "Unterminated regular expression literal".to_string();
    } else if err_debug.contains("Unexpected eof") || err_debug.contains("UnexpectedEof") {
        return "Unexpected end of file (likely missing closing bracket or quote)".to_string();
    }

    // If no known code, return a cleaned-up version
    if let Some(msg_start) = err_debug.find("message:") {
        let rest = &err_debug[msg_start + 8..];
        if let Some(end) = rest.find([',', '}']) {
            return rest[..end].trim().trim_matches('"').to_string();
        }
    }

    "Syntax error".to_string()
}

// ============================================================================
// TESTS
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_simple_transpile() {
        let ts = "const x: number = 42;";
        let result = transpile(ts).unwrap();
        assert!(result.code.contains("const x = 42"), "Got: {}", result.code);
        assert!(!result.code.contains(": number"), "Got: {}", result.code);
    }

    #[test]
    fn test_arrow_function() {
        let ts = "const greet = (name: string): string => `Hello, ${name}`;";
        let result = transpile(ts).unwrap();
        assert!(!result.code.contains(": string"), "Got: {}", result.code);
    }

    #[test]
    fn test_async_iife_wrapping() {
        let ts = "console.log('hello');";
        let result = transpile(ts).unwrap();
        // Should be wrapped in async IIFE
        assert!(result.code.contains("async"), "Got: {}", result.code);
        assert!(result.code.contains("catch"), "Got: {}", result.code);
    }

    #[test]
    fn test_code_only_no_wrapping() {
        let ts = "const x = 1;";
        let code = transpile_code_only(ts).unwrap();
        // Should NOT be wrapped in async IIFE
        assert!(!code.contains("catch"), "Got: {}", code);
    }

    #[test]
    fn test_parse_error_shows_context() {
        let ts = "const x = {"; // Missing closing brace
        let err = transpile(ts).unwrap_err();
        assert!(err.contains("line"), "Expected line info: {}", err);
        assert!(err.contains("const x"), "Expected code context: {}", err);
    }

    #[test]
    fn test_transpile_marks_module_declarations() {
        let ts = "import { x } from './x.ts';\nexport const y: number = 1;";
        let result = transpile(ts).unwrap();
        assert!(
            result.contains_module_decls,
            "Expected module declarations to be detected"
        );
    }

    #[test]
    fn test_transpile_preserves_import_export_without_iife() {
        let ts = "import { x } from './x.ts';\nexport const y: number = x;";
        let result = transpile(ts).unwrap();
        assert!(result.code.contains("import "), "Got: {}", result.code);
        assert!(result.code.contains("export "), "Got: {}", result.code);
        assert!(
            !result.code.contains(".catch("),
            "Module source should not be wrapped in async IIFE: {}",
            result.code
        );
    }

    #[test]
    fn test_transpile_emits_source_map_json() {
        let ts = "const x: number = 42;\nconsole.log(x);";
        let result = transpile(ts).unwrap();
        let source_map = result.source_map.expect("expected source map bytes");
        let v: serde_json::Value = serde_json::from_slice(&source_map).unwrap();
        assert_eq!(v.get("version").and_then(|x| x.as_u64()), Some(3));
        let sources = v
            .get("sources")
            .and_then(|x| x.as_array())
            .expect("sources array");
        assert!(!sources.is_empty(), "sources must not be empty");
        let mappings = v
            .get("mappings")
            .and_then(|x| x.as_str())
            .expect("mappings string");
        assert!(
            !mappings.is_empty(),
            "mappings should not be empty for non-empty input"
        );
    }
}
