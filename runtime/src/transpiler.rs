//! TypeScript to JavaScript transpilation using SWC.

use swc_common::{sync::Lrc, FileName, Mark, SourceMap, GLOBALS};
use swc_ecma_ast::{EsVersion, Program};
use swc_ecma_codegen::{text_writer::JsWriter, Config, Emitter};
use swc_ecma_parser::{lexer::Lexer, Parser, StringInput, Syntax, TsSyntax};
use swc_ecma_transforms_typescript::strip;

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
        .map_err(|e| format!("Parse error: {:?}", e))?;

    // Check for parse errors
    for err in parser.take_errors() {
        return Err(format!("Parse error: {:?}", err));
    }

    // Apply TypeScript type stripping transform using Pass trait
    let unresolved_mark = Mark::new();
    let top_level_mark = Mark::new();

    let mut program = Program::Module(module);

    // strip returns impl Pass, use its process method
    use swc_ecma_ast::Pass;
    let mut pass = strip(unresolved_mark, top_level_mark);
    pass.process(&mut program);

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
}
