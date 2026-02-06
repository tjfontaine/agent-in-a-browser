//! Process module - Node.js process global shim.
//!
//! Provides process.argv, process.env, process.exit, etc.

use rquickjs::{Ctx, Function, Object, Result};
use swc_common::{sync::Lrc, FileName, SourceMap, SyntaxContext, DUMMY_SP};
use swc_ecma_ast::{
    AssignExpr, AssignTarget, BindingIdent, Decl, Expr, ExprStmt, Ident, IdentName, MemberExpr,
    MemberProp, ModuleDecl, ModuleExportName, ModuleItem, Pat, Script, Stmt, Str,
};
use swc_ecma_codegen::{text_writer::JsWriter, Config, Emitter};
use swc_ecma_parser::{lexer::Lexer, EsSyntax, Parser, StringInput, Syntax};

// Embedded JS shim for process object
const PROCESS_JS: &str = include_str!("shims/process.js");

// Thread-local storage for argv passed to the script
thread_local! {
    static SCRIPT_ARGV: std::cell::RefCell<Vec<String>> = std::cell::RefCell::new(Vec::new());
    static RUNTIME_ENV: std::cell::RefCell<RuntimeEnv> = std::cell::RefCell::new(RuntimeEnv::default());
}

#[derive(Clone)]
struct RuntimeEnv {
    cwd: String,
    vars: Vec<(String, String)>,
}

impl Default for RuntimeEnv {
    fn default() -> Self {
        Self {
            cwd: "/".to_string(),
            vars: Vec::new(),
        }
    }
}

/// Set the argv for the current script execution
#[allow(dead_code)]
pub fn set_argv(args: Vec<String>) {
    SCRIPT_ARGV.with(|a| {
        *a.borrow_mut() = args;
    });
}

/// Get the current argv
pub fn get_argv() -> Vec<String> {
    SCRIPT_ARGV.with(|a| a.borrow().clone())
}

/// Set runtime cwd/env payload for current execution.
#[allow(dead_code)]
pub fn set_runtime_env(cwd: String, vars: Vec<(String, String)>) {
    RUNTIME_ENV.with(|env| {
        *env.borrow_mut() = RuntimeEnv { cwd, vars };
    });
}

fn get_runtime_env() -> RuntimeEnv {
    RUNTIME_ENV.with(|env| env.borrow().clone())
}

fn get_cwd() -> String {
    RUNTIME_ENV.with(|env| env.borrow().cwd.clone())
}

fn set_cwd(cwd: String) {
    RUNTIME_ENV.with(|env| {
        env.borrow_mut().cwd = cwd;
    });
}

/// Install process module on the global object.
pub fn install(ctx: &Ctx<'_>) -> Result<()> {
    let globals = ctx.globals();

    // Create process object
    let process = Object::new(ctx.clone())?;

    // Set up argv array (will be populated by JS shim)
    let argv = rquickjs::Array::new(ctx.clone())?;

    // argv[0] is typically the executable name
    argv.set(0, "tsx")?;
    // argv[1] is typically the script name
    argv.set(1, "script.ts")?;

    // Add any additional args from thread-local storage
    let extra_args = get_argv();
    for (i, arg) in extra_args.iter().enumerate() {
        argv.set(i + 2, arg.as_str())?;
    }

    process.set("argv", argv)?;

    let runtime_env = get_runtime_env();

    // Set up env object from runtime payload
    let env = Object::new(ctx.clone())?;
    for (k, v) in runtime_env.vars {
        env.set(k, v)?;
    }
    process.set("env", env)?;

    // Set up platform and version
    process.set("platform", "wasm")?;
    process.set("version", "v20.0.0")?;

    // Install on globalThis
    globals.set("process", process)?;

    // __tsxRequireResolve__(base, specifier) -> resolved path/URL
    let require_resolve = Function::new(
        ctx.clone(),
        |base: String, specifier: String| -> String {
            crate::resolver::resolve_for_require(&base, &specifier)
        },
    )?;
    globals.set("__tsxRequireResolve__", require_resolve)?;

    // __tsxRequireLoad__(resolvedPath) -> JSON envelope
    let require_load = Function::new(ctx.clone(), |resolved: String| -> String {
        match load_module_for_require(&resolved) {
            Ok(payload) => payload.to_string(),
            Err(error) => serde_json::json!({ "ok": false, "error": error }).to_string(),
        }
    })?;
    globals.set("__tsxRequireLoad__", require_load)?;

    // __tsxProcessGetCwd__() -> current cwd
    let process_get_cwd = Function::new(ctx.clone(), || -> String { get_cwd() })?;
    globals.set("__tsxProcessGetCwd__", process_get_cwd)?;

    // __tsxProcessSetCwd__(cwd) -> true
    let process_set_cwd = Function::new(ctx.clone(), |cwd: String| -> bool {
        set_cwd(cwd);
        true
    })?;
    globals.set("__tsxProcessSetCwd__", process_set_cwd)?;

    // Evaluate JS shim for additional functionality
    ctx.eval::<(), _>(PROCESS_JS)?;

    Ok(())
}

fn load_module_for_require(resolved: &str) -> std::result::Result<serde_json::Value, String> {
    let local_resolved = crate::resolver::file_url_to_path(resolved);
    let fs_path = local_resolved.as_deref().unwrap_or(resolved);
    let source = if resolved.starts_with("https://") || resolved.starts_with("http://") {
        return Err(format!(
            "require() does not support remote modules yet: {}",
            resolved
        ));
    } else {
        std::fs::read_to_string(fs_path).map_err(|e| format!("{}: {}", resolved, e))?
    };

    if fs_path.ends_with(".json") {
        return Ok(serde_json::json!({
            "ok": true,
            "format": "json",
            "path": resolved,
            "source": source
        }));
    }

    let (format, code) = if fs_path.ends_with(".cjs") {
        ("cjs", source)
    } else if fs_path.ends_with(".ts") || fs_path.ends_with(".tsx") {
        let code = crate::transpiler::transpile_code_only(&source)
            .map_err(|e| format!("Transpile error in {}: {}", resolved, e))?;
        if looks_like_esm(&code) {
            ("esm", code)
        } else {
            ("cjs", code)
        }
    } else if looks_like_esm(&source) {
        ("esm", source)
    } else {
        ("cjs", source)
    };

    let (format, code) = if format == "esm" {
        (
            "cjs",
            transform_esm_to_cjs_for_require(&code, resolved)
                .map_err(|e| format!("ESM require transform error in {}: {}", resolved, e))?,
        )
    } else {
        (format, code)
    };

    Ok(serde_json::json!({
        "ok": true,
        "format": format,
        "path": resolved,
        "source": code
    }))
}

fn looks_like_esm(source: &str) -> bool {
    let compact = source.replace('\n', " ");
    compact.contains(" import ")
        || compact.trim_start().starts_with("import ")
        || compact.contains(" export ")
        || compact.trim_start().starts_with("export ")
}

fn transform_esm_to_cjs_for_require(
    source: &str,
    path: &str,
) -> std::result::Result<String, String> {
    let cm: Lrc<SourceMap> = Default::default();
    let fm = cm.new_source_file(Lrc::new(FileName::Custom(path.into())), source.to_string());
    let lexer = Lexer::new(
        Syntax::Es(EsSyntax {
            allow_return_outside_function: true,
            ..Default::default()
        }),
        swc_ecma_ast::EsVersion::Es2020,
        StringInput::from(&*fm),
        None,
    );
    let mut parser = Parser::new_from(lexer);
    let module = parser
        .parse_module()
        .map_err(|e| format!("Failed to parse ESM: {:?}", e))?;
    if let Some(err) = parser.take_errors().into_iter().next() {
        return Err(format!("ESM parse error: {:?}", err));
    }

    let mut out_stmts: Vec<Stmt> = Vec::new();
    let mut import_idx = 0usize;

    for item in module.body {
        match item {
            ModuleItem::Stmt(stmt) => out_stmts.push(stmt),
            ModuleItem::ModuleDecl(decl) => match decl {
                ModuleDecl::Import(import_decl) => {
                    let req_var = format!("__tsx_req_{}", import_idx);
                    import_idx += 1;
                    if import_decl.specifiers.is_empty() {
                        push_snippet_stmt(
                            &mut out_stmts,
                            &format!("require({});", js_string_literal_wtf8(&import_decl.src)),
                        )?;
                        continue;
                    }
                    push_snippet_stmt(
                        &mut out_stmts,
                        &format!(
                            "const {} = require({});",
                            req_var,
                            js_string_literal_wtf8(&import_decl.src)
                        ),
                    )?;
                    for spec in import_decl.specifiers {
                        match spec {
                            swc_ecma_ast::ImportSpecifier::Default(default_spec) => {
                                push_snippet_stmt(
                                    &mut out_stmts,
                                    &format!(
                                        "const {} = ({} && {}.__esModule) ? {}.default : {};",
                                        default_spec.local.sym,
                                        req_var,
                                        req_var,
                                        req_var,
                                        req_var
                                    ),
                                )?;
                            }
                            swc_ecma_ast::ImportSpecifier::Namespace(ns_spec) => {
                                push_snippet_stmt(
                                    &mut out_stmts,
                                    &format!("const {} = {};", ns_spec.local.sym, req_var),
                                )?;
                            }
                            swc_ecma_ast::ImportSpecifier::Named(named_spec) => {
                                let imported = named_spec
                                    .imported
                                    .as_ref()
                                    .map(module_export_name_to_string)
                                    .unwrap_or_else(|| named_spec.local.sym.to_string());
                                push_snippet_stmt(
                                    &mut out_stmts,
                                    &format!(
                                        "const {} = {}[{}];",
                                        named_spec.local.sym,
                                        req_var,
                                        js_string_literal(&imported)
                                    ),
                                )?;
                            }
                        }
                    }
                }
                ModuleDecl::ExportDecl(export_decl) => {
                    let decl_stmt: Stmt = match &export_decl.decl {
                        Decl::Class(v) => v.clone().into(),
                        Decl::Fn(v) => v.clone().into(),
                        Decl::Var(v) => (*v.clone()).into(),
                        _ => continue,
                    };
                    out_stmts.push(decl_stmt);
                    let mut names = Vec::new();
                    collect_decl_names(&export_decl.decl, &mut names);
                    for name in names {
                        push_snippet_stmt(
                            &mut out_stmts,
                            &format!("exports[{}] = {};", js_string_literal(&name), name),
                        )?;
                    }
                }
                ModuleDecl::ExportDefaultExpr(default_expr) => {
                    out_stmts.push(make_exports_default_assign_stmt(*default_expr.expr)?);
                }
                ModuleDecl::ExportDefaultDecl(default_decl) => match default_decl.decl {
                    swc_ecma_ast::DefaultDecl::Fn(fn_expr) => {
                        if let Some(ident) = fn_expr.ident {
                            out_stmts.push(
                                swc_ecma_ast::FnDecl {
                                    ident: ident.clone(),
                                    declare: false,
                                    function: fn_expr.function,
                                }
                                .into(),
                            );
                            push_snippet_stmt(
                                &mut out_stmts,
                                &format!("exports.default = {};", ident.sym),
                            )?;
                        } else {
                            out_stmts.push(make_exports_default_assign_stmt(Expr::Fn(fn_expr))?);
                        }
                    }
                    swc_ecma_ast::DefaultDecl::Class(class_expr) => {
                        if let Some(ident) = class_expr.ident {
                            out_stmts.push(
                                swc_ecma_ast::ClassDecl {
                                    ident: ident.clone(),
                                    declare: false,
                                    class: class_expr.class,
                                }
                                .into(),
                            );
                            push_snippet_stmt(
                                &mut out_stmts,
                                &format!("exports.default = {};", ident.sym),
                            )?;
                        } else {
                            out_stmts.push(make_exports_default_assign_stmt(Expr::Class(class_expr))?);
                        }
                    }
                    _ => {}
                },
                ModuleDecl::ExportNamed(named) => {
                    if let Some(src) = named.src {
                        let req_var = format!("__tsx_req_{}", import_idx);
                        import_idx += 1;
                        push_snippet_stmt(
                            &mut out_stmts,
                            &format!(
                                "const {} = require({});",
                                req_var,
                                js_string_literal_wtf8(&src)
                            ),
                        )?;
                        for spec in named.specifiers {
                            match spec {
                                swc_ecma_ast::ExportSpecifier::Named(named_spec) => {
                                    let orig = module_export_name_to_string(&named_spec.orig);
                                    let exported = named_spec
                                        .exported
                                        .as_ref()
                                        .map(module_export_name_to_string)
                                        .unwrap_or_else(|| orig.clone());
                                    push_snippet_stmt(
                                        &mut out_stmts,
                                        &format!(
                                            "exports[{}] = {}[{}];",
                                            js_string_literal(&exported),
                                            req_var,
                                            js_string_literal(&orig)
                                        ),
                                    )?;
                                }
                                swc_ecma_ast::ExportSpecifier::Default(default_spec) => {
                                    push_snippet_stmt(
                                        &mut out_stmts,
                                        &format!(
                                            "exports[{}] = ({} && {}.__esModule) ? {}.default : {};",
                                            js_string_literal(&default_spec.exported.sym),
                                            req_var,
                                            req_var,
                                            req_var,
                                            req_var
                                        ),
                                    )?;
                                }
                                swc_ecma_ast::ExportSpecifier::Namespace(ns_spec) => {
                                    let name = module_export_name_to_string(&ns_spec.name);
                                    push_snippet_stmt(
                                        &mut out_stmts,
                                        &format!("exports[{}] = {};", js_string_literal(&name), req_var),
                                    )?;
                                }
                            }
                        }
                    } else {
                        for spec in named.specifiers {
                            if let swc_ecma_ast::ExportSpecifier::Named(named_spec) = spec {
                                let orig = module_export_name_to_string(&named_spec.orig);
                                let exported = named_spec
                                    .exported
                                    .as_ref()
                                    .map(module_export_name_to_string)
                                    .unwrap_or_else(|| orig.clone());
                                push_snippet_stmt(
                                    &mut out_stmts,
                                    &format!(
                                        "exports[{}] = {};",
                                        js_string_literal(&exported),
                                        orig
                                    ),
                                )?;
                            }
                        }
                    }
                }
                ModuleDecl::ExportAll(export_all) => {
                    push_snippet_stmt(
                        &mut out_stmts,
                        &format!(
                            "Object.assign(exports, require({}));",
                            js_string_literal_wtf8(&export_all.src)
                        ),
                    )?;
                }
                _ => {}
            },
        }
    }

    let script = Script {
        span: DUMMY_SP,
        body: out_stmts,
        shebang: None,
    };

    let mut buf = Vec::new();
    let mut emitter = Emitter {
        cfg: Config::default(),
        cm: cm.clone(),
        comments: None,
        wr: JsWriter::new(cm, "\n", &mut buf, None),
    };
    emitter
        .emit_script(&script)
        .map_err(|e| format!("Failed to emit transformed CJS: {:?}", e))?;
    String::from_utf8(buf).map_err(|e| format!("UTF-8 error: {}", e))
}

fn js_string_literal(s: &str) -> String {
    serde_json::to_string(s).unwrap_or_else(|_| "\"\"".to_string())
}

fn js_string_literal_wtf8(s: &Str) -> String {
    js_string_literal(&s.value.to_string_lossy())
}

fn push_snippet_stmt(target: &mut Vec<Stmt>, snippet: &str) -> std::result::Result<(), String> {
    let cm: Lrc<SourceMap> = Default::default();
    let fm = cm.new_source_file(
        Lrc::new(FileName::Custom("tsx-esm-cjs-snippet.js".into())),
        snippet.to_string(),
    );
    let lexer = Lexer::new(
        Syntax::Es(EsSyntax {
            allow_return_outside_function: true,
            ..Default::default()
        }),
        swc_ecma_ast::EsVersion::Es2020,
        StringInput::from(&*fm),
        None,
    );
    let mut parser = Parser::new_from(lexer);
    let script = parser
        .parse_script()
        .map_err(|e| format!("Snippet parse error for `{}`: {:?}", snippet, e))?;
    if let Some(err) = parser.take_errors().into_iter().next() {
        return Err(format!(
            "Snippet parse error for `{}`: {:?}",
            snippet, err
        ));
    }
    target.extend(script.body);
    Ok(())
}

fn module_export_name_to_string(name: &ModuleExportName) -> String {
    match name {
        ModuleExportName::Ident(i) => i.sym.to_string(),
        ModuleExportName::Str(s) => s.value.to_string_lossy().to_string(),
    }
}

fn collect_decl_names(decl: &Decl, out: &mut Vec<String>) {
    match decl {
        Decl::Fn(f) => out.push(f.ident.sym.to_string()),
        Decl::Class(c) => out.push(c.ident.sym.to_string()),
        Decl::Var(v) => {
            for d in &v.decls {
                collect_pat_names(&d.name, out);
            }
        }
        _ => {}
    }
}

fn collect_pat_names(pat: &Pat, out: &mut Vec<String>) {
    match pat {
        Pat::Ident(BindingIdent { id, .. }) => out.push(id.sym.to_string()),
        Pat::Array(arr) => {
            for p in arr.elems.iter().flatten() {
                collect_pat_names(p, out);
            }
        }
        Pat::Object(obj) => {
            for prop in &obj.props {
                match prop {
                    swc_ecma_ast::ObjectPatProp::Assign(assign) => {
                        out.push(assign.key.sym.to_string());
                    }
                    swc_ecma_ast::ObjectPatProp::KeyValue(kv) => {
                        collect_pat_names(&kv.value, out);
                    }
                    swc_ecma_ast::ObjectPatProp::Rest(rest) => {
                        collect_pat_names(&rest.arg, out);
                    }
                }
            }
        }
        Pat::Rest(rest) => collect_pat_names(&rest.arg, out),
        Pat::Assign(assign) => collect_pat_names(&assign.left, out),
        _ => {}
    }
}

fn make_exports_default_assign_stmt(rhs: Expr) -> std::result::Result<Stmt, String> {
    let left_expr = Expr::Member(MemberExpr {
        span: DUMMY_SP,
        obj: Box::new(Expr::Ident(Ident::new(
            "exports".into(),
            DUMMY_SP,
            SyntaxContext::empty(),
        ))),
        prop: MemberProp::Ident(IdentName::new("default".into(), DUMMY_SP)),
    });
    let left: AssignTarget = Box::new(left_expr)
        .try_into()
        .map_err(|_| "Failed to build assignment target for exports.default".to_string())?;
    Ok(Stmt::Expr(ExprStmt {
        span: DUMMY_SP,
        expr: Box::new(Expr::Assign(AssignExpr {
            span: DUMMY_SP,
            op: swc_ecma_ast::op!("="),
            left,
            right: Box::new(rhs),
        })),
    }))
}
