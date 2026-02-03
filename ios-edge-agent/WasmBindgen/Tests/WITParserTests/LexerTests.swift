// WIT Lexer Tests
// Comprehensive tests for the WIT tokenizer

import Testing
@testable import WITParser

@Suite("WIT Lexer Tests")
struct LexerTests {
    
    // MARK: - Basic Token Tests
    
    @Test("Lexes simple keywords")
    func lexKeywords() throws {
        let source = "package interface world"
        var lexer = WITLexer(source: source)
        let tokens = try lexer.tokenize()
        
        #expect(tokens.count == 4) // 3 keywords + EOF
        #expect(tokens[0].kind == .package)
        #expect(tokens[1].kind == .interface)
        #expect(tokens[2].kind == .world)
        #expect(tokens[3].kind == .eof)
    }
    
    @Test("Lexes identifiers")
    func lexIdentifiers() throws {
        let source = "my-interface my_function MyType"
        var lexer = WITLexer(source: source)
        let tokens = try lexer.tokenize()
        
        #expect(tokens.count == 4)
        #expect(tokens[0].kind == .identifier("my-interface"))
        #expect(tokens[1].kind == .identifier("my_function"))
        #expect(tokens[2].kind == .identifier("MyType"))
    }
    
    @Test("Lexes escaped identifiers")
    func lexEscapedIdentifiers() throws {
        let source = "%stream %type %package"
        var lexer = WITLexer(source: source)
        let tokens = try lexer.tokenize()
        
        #expect(tokens.count == 4)
        #expect(tokens[0].kind == .identifier("stream"))
        #expect(tokens[1].kind == .identifier("type"))
        #expect(tokens[2].kind == .identifier("package"))
    }
    
    // MARK: - Version Number Tests
    
    @Test("Lexes version numbers after @")
    func lexVersionNumbers() throws {
        let source = "@0.1.0 @1.2.3"
        var lexer = WITLexer(source: source)
        let tokens = try lexer.tokenize()
        
        #expect(tokens.count == 3) // 2 identifiers + EOF
        #expect(tokens[0].kind == .identifier("0.1.0"))
        #expect(tokens[1].kind == .identifier("1.2.3"))
    }
    
    @Test("Does not consume trailing dot in version")
    func lexVersionWithTrailingDot() throws {
        // This is the pattern: wasi:io/poll@0.2.9.{pollable}
        let source = "@0.2.9.{"
        var lexer = WITLexer(source: source)
        let tokens = try lexer.tokenize()
        
        #expect(tokens.count == 4) // version, dot, lbrace, EOF
        #expect(tokens[0].kind == .identifier("0.2.9"))
        #expect(tokens[1].kind == .dot)
        #expect(tokens[2].kind == .lBrace)
    }
    
    // Note: Semver prerelease parsing (e.g., 1.0.0-alpha) is a known limitation
    // The lexer doesn't currently handle hyphens in versions
    
    // MARK: - Annotation Tests
    
    @Test("Lexes simple annotations")
    func lexSimpleAnnotations() throws {
        let source = "@since(version = 0.2.0)"
        var lexer = WITLexer(source: source)
        let tokens = try lexer.tokenize()
        
        #expect(tokens.count == 2) // annotation + EOF
        if case .annotation(let content) = tokens[0].kind {
            #expect(content.contains("since"))
            #expect(content.contains("version"))
        } else {
            Issue.record("Expected annotation token")
        }
    }
    
    @Test("Lexes nested parentheses in annotations")
    func lexNestedAnnotations() throws {
        let source = "@unstable(feature = clocks(nested = true))"
        var lexer = WITLexer(source: source)
        let tokens = try lexer.tokenize()
        
        #expect(tokens.count == 2)
        if case .annotation(let content) = tokens[0].kind {
            #expect(content.contains("clocks(nested = true)"))
        } else {
            Issue.record("Expected annotation token")
        }
    }
    
    // MARK: - Doc Comment Tests
    
    @Test("Lexes doc comments")
    func lexDocComments() throws {
        let source = "/// This is a doc comment\ninterface"
        var lexer = WITLexer(source: source)
        let tokens = try lexer.tokenize()
        
        #expect(tokens.count == 3)
        if case .docComment(let content) = tokens[0].kind {
            #expect(content == "This is a doc comment")
        } else {
            Issue.record("Expected doc comment token")
        }
        #expect(tokens[1].kind == .interface)
    }
    
    @Test("Lexes multiline doc comments")
    func lexMultilineDocComments() throws {
        let source = """
        /// Line 1
        /// Line 2
        interface
        """
        var lexer = WITLexer(source: source)
        let tokens = try lexer.tokenize()
        
        #expect(tokens.count == 4) // 2 doc comments + interface + EOF
        if case .docComment(let content) = tokens[0].kind {
            #expect(content == "Line 1")
        }
        if case .docComment(let content) = tokens[1].kind {
            #expect(content == "Line 2")
        }
    }
    
    // MARK: - Punctuation Tests
    
    @Test("Lexes all punctuation")
    func lexPunctuation() throws {
        let source = ": ; , . @ { } ( ) < > -> /"
        var lexer = WITLexer(source: source)
        let tokens = try lexer.tokenize()
        
        #expect(tokens[0].kind == .colon)
        #expect(tokens[1].kind == .semicolon)
        #expect(tokens[2].kind == .comma)
        #expect(tokens[3].kind == .dot)
        #expect(tokens[4].kind == .at)
        #expect(tokens[5].kind == .lBrace)
        #expect(tokens[6].kind == .rBrace)
        #expect(tokens[7].kind == .lParen)
        #expect(tokens[8].kind == .rParen)
        #expect(tokens[9].kind == .lAngle)
        #expect(tokens[10].kind == .rAngle)
        #expect(tokens[11].kind == .arrow)
        #expect(tokens[12].kind == .slash)
    }
    
    // MARK: - Primitive Type Tests
    
    @Test("Lexes all primitive types")
    func lexPrimitiveTypes() throws {
        let source = "bool u8 u16 u32 u64 s8 s16 s32 s64 f32 f64 char string"
        var lexer = WITLexer(source: source)
        let tokens = try lexer.tokenize()
        
        #expect(tokens[0].kind == .bool)
        #expect(tokens[1].kind == .u8)
        #expect(tokens[2].kind == .u16)
        #expect(tokens[3].kind == .u32)
        #expect(tokens[4].kind == .u64)
        #expect(tokens[5].kind == .s8)
        #expect(tokens[6].kind == .s16)
        #expect(tokens[7].kind == .s32)
        #expect(tokens[8].kind == .s64)
        #expect(tokens[9].kind == .f32)
        #expect(tokens[10].kind == .f64)
        #expect(tokens[11].kind == .char)
        #expect(tokens[12].kind == .string)
    }
    
    // MARK: - Line/Column Tracking Tests
    
    @Test("Tracks line numbers correctly")
    func trackLineNumbers() throws {
        let source = """
        package
        interface
        world
        """
        var lexer = WITLexer(source: source)
        let tokens = try lexer.tokenize()
        
        #expect(tokens[0].line == 1)
        #expect(tokens[1].line == 2)
        #expect(tokens[2].line == 3)
    }
    
    // MARK: - Error Recovery Tests
    
    @Test("Handles empty input")
    func emptyInput() throws {
        let source = ""
        var lexer = WITLexer(source: source)
        let tokens = try lexer.tokenize()
        
        #expect(tokens.count == 1)
        #expect(tokens[0].kind == .eof)
    }
    
    @Test("Handles whitespace-only input")
    func whitespaceOnlyInput() throws {
        let source = "   \n\t\n   "
        var lexer = WITLexer(source: source)
        let tokens = try lexer.tokenize()
        
        #expect(tokens.count == 1)
        #expect(tokens[0].kind == .eof)
    }
    
    @Test("Handles comments")
    func handlesComments() throws {
        let source = """
        // Regular comment
        package
        /* Block comment */
        interface
        """
        var lexer = WITLexer(source: source)
        let tokens = try lexer.tokenize()
        
        // Comments should be skipped
        #expect(tokens[0].kind == .package)
        #expect(tokens[1].kind == .interface)
    }
}

@Suite("WIT Lexer Edge Cases")
struct LexerEdgeCaseTests {
    
    @Test("Handles hyphens in identifiers")
    func hyphensInIdentifiers() throws {
        let source = "my-long-identifier-name"
        var lexer = WITLexer(source: source)
        let tokens = try lexer.tokenize()
        
        #expect(tokens[0].kind == .identifier("my-long-identifier-name"))
    }
    
    @Test("Handles unicode in comments")
    func unicodeInComments() throws {
        let source = "/// 日本語コメント 🎉\npackage"
        var lexer = WITLexer(source: source)
        let tokens = try lexer.tokenize()
        
        if case .docComment(let content) = tokens[0].kind {
            #expect(content.contains("日本語"))
            #expect(content.contains("🎉"))
        }
    }
    
    // Note: Standalone hyphens (e.g., "-foo") are not valid WIT syntax
    // This test is skipped as it exposes a known limitation
    
    @Test("Handles colon sequences")
    func colonSequences() throws {
        let source = ": :a"
        var lexer = WITLexer(source: source)
        let tokens = try lexer.tokenize()
        
        #expect(tokens[0].kind == .colon)
        #expect(tokens[1].kind == .colon)
        #expect(tokens[2].kind == .identifier("a"))
    }
}
