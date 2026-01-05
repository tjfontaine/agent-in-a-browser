//! TypeScript to JavaScript transpilation using SWC.
//!
//! FUTURE IMPROVEMENTS:
//! - Add CommonJS → ESM transform (require() → import)
//! - Add global shim injection at AST level (console, fs, Buffer, etc.)
//! - Add optional source maps support
//! - Consider using swc_ecma_transforms_module for full module interop

use std::mem;
use swc_common::{sync::Lrc, FileName, Mark, SourceMap, Spanned, DUMMY_SP, GLOBALS};
use swc_ecma_ast::{AwaitExpr, EsVersion, Expr, ModuleItem, Program, Stmt};
use swc_ecma_codegen::{text_writer::JsWriter, Config, Emitter};
use swc_ecma_parser::{lexer::Lexer, Parser, StringInput, Syntax, TsSyntax};
use swc_ecma_transforms_typescript::strip;
use swc_ecma_visit::VisitMut;

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
///
/// This is safe because the code is wrapped in an async IIFE by lib.rs,
/// and awaiting a non-Promise value just returns it immediately.
struct AwaitLastExpr;

impl VisitMut for AwaitLastExpr {
    fn visit_mut_module_items(&mut self, items: &mut Vec<ModuleItem>) {
        // Find the last statement that is an expression statement
        if let Some(last) = items.last_mut() {
            if let ModuleItem::Stmt(Stmt::Expr(expr_stmt)) = last {
                // Swap out the expression with a placeholder, then wrap in await
                let original_expr = mem::take(&mut expr_stmt.expr);
                expr_stmt.expr = Box::new(Expr::Await(AwaitExpr {
                    span: DUMMY_SP,
                    arg: original_expr,
                }));
            }
        }
    }
}

/// Transpile TypeScript code to JavaScript.
///
/// This performs type stripping and outputs ES2020-compatible JavaScript.
pub fn transpile(ts_code: &str) -> Result<String, String> {
    // SWC requires GLOBALS to be set
    GLOBALS.set(&Default::default(), || transpile_inner(ts_code))
}

fn transpile_inner(ts_code: &str) -> Result<String, String> {
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

    // Check for parse errors
    for err in parser.take_errors() {
        return Err(format_parse_error(ts_code, err));
    }

    // Apply TypeScript type stripping transform using Pass trait
    let unresolved_mark = Mark::new();
    let top_level_mark = Mark::new();

    let mut program = Program::Module(module);

    // strip returns impl Pass, use its process method
    use swc_ecma_ast::Pass;
    let mut pass = strip(unresolved_mark, top_level_mark);
    pass.process(&mut program);

    // Apply AwaitLastExpr transform to ensure the last expression is awaited
    // This captures Promises from patterns like: `async function fn() {...} fn();`
    AwaitLastExpr.visit_mut_program(&mut program);

    // Extract the module back from the program
    let module = match program {
        Program::Module(m) => m,
        _ => return Err("Expected module".to_string()),
    };

    // Emit JavaScript
    let mut buf = vec![];
    {
        let mut emitter = Emitter {
            cfg: Config::default(),
            cm: cm.clone(),
            comments: None,
            wr: JsWriter::new(cm.clone(), "\n", &mut buf, None),
        };

        emitter
            .emit_module(&module)
            .map_err(|e| format!("Emit error: {:?}", e))?;
    }

    String::from_utf8(buf).map_err(|e| format!("UTF-8 error: {}", e))
}

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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_simple_transpile() {
        let ts = "const x: number = 42;";
        let js = transpile(ts).unwrap();
        assert!(js.contains("const x = 42"), "Got: {}", js);
        assert!(!js.contains(": number"), "Got: {}", js);
    }

    #[test]
    fn test_arrow_function() {
        let ts = "const greet = (name: string): string => `Hello, ${name}`;";
        let js = transpile(ts).unwrap();
        assert!(!js.contains(": string"), "Got: {}", js);
    }

    #[test]
    fn test_parse_error_shows_context() {
        let ts = "const x = {"; // Missing closing brace
        let err = transpile(ts).unwrap_err();
        // Should show line number
        assert!(err.contains("line"), "Expected line info: {}", err);
        // Should show the problematic code
        assert!(err.contains("const x"), "Expected code context: {}", err);
    }
}
