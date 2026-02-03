// WIT Lexer - Tokenizes WIT source files

import Foundation

/// Token types for WIT syntax
public enum WITTokenKind: Sendable, Equatable {
    // Keywords
    case package, interface, world, resource, record, variant, `enum`, flags
    case `func`, `use`, type, include, `import`, export, `static`, constructor
    case bool, u8, u16, u32, u64, s8, s16, s32, s64, f32, f64, char, string
    case list, option, result, tuple, own, borrow
    case `as`, with, `_`
    
    // Punctuation
    case colon          // :
    case semicolon      // ;
    case comma          // ,
    case dot            // .
    case at             // @
    case slash          // /
    case arrow          // ->
    case lBrace         // {
    case rBrace         // }
    case lParen         // (
    case rParen         // )
    case lAngle         // <
    case rAngle         // >
    case equals         // =
    
    // Literals
    case identifier(String)
    case docComment(String)  // /// comment
    case annotation(String)  // @since etc.
    
    // Special
    case eof
}

/// A token with its position in source
public struct WITToken: Sendable, Equatable {
    public var kind: WITTokenKind
    public var line: Int
    public var column: Int
    
    public init(kind: WITTokenKind, line: Int, column: Int) {
        self.kind = kind
        self.line = line
        self.column = column
    }
}

/// WIT Lexer - converts source text to tokens
public struct WITLexer: Sendable {
    private let source: String
    private var index: String.Index
    private var line: Int = 1
    private var column: Int = 1
    
    public init(source: String) {
        self.source = source
        self.index = source.startIndex
    }
    
    /// Tokenize the entire source
    public mutating func tokenize() throws(WITLexerError) -> [WITToken] {
        var tokens: [WITToken] = []
        
        while !isAtEnd {
            skipWhitespaceAndComments()
            if isAtEnd { break }
            
            let token = try nextToken()
            tokens.append(token)
        }
        
        tokens.append(WITToken(kind: .eof, line: line, column: column))
        return tokens
    }
    
    private mutating func nextToken() throws(WITLexerError) -> WITToken {
        let startLine = line
        let startColumn = column
        
        let c = peek()
        
        // Doc comments
        if c == "/" && peekNext() == "/" && peekAt(offset: 2) == "/" {
            let comment = scanDocComment()
            return WITToken(kind: .docComment(comment), line: startLine, column: startColumn)
        }
        
        // Annotations
        if c == "@" && peekNext()?.isLetter == true {
            let annotation = scanAnnotation()
            return WITToken(kind: .annotation(annotation), line: startLine, column: startColumn)
        }
        
        // Single character tokens
        switch c {
        case ":": advance(); return WITToken(kind: .colon, line: startLine, column: startColumn)
        case ";": advance(); return WITToken(kind: .semicolon, line: startLine, column: startColumn)
        case ",": advance(); return WITToken(kind: .comma, line: startLine, column: startColumn)
        case ".": advance(); return WITToken(kind: .dot, line: startLine, column: startColumn)
        case "@":
            // Check if followed by version number (digit)
            if let next = peekNext(), next.isNumber {
                advance() // consume @
                let version = scanVersion()
                return WITToken(kind: .identifier(version), line: startLine, column: startColumn)
            }
            advance(); return WITToken(kind: .at, line: startLine, column: startColumn)
        case "/": advance(); return WITToken(kind: .slash, line: startLine, column: startColumn)
        case "{": advance(); return WITToken(kind: .lBrace, line: startLine, column: startColumn)
        case "}": advance(); return WITToken(kind: .rBrace, line: startLine, column: startColumn)
        case "(": advance(); return WITToken(kind: .lParen, line: startLine, column: startColumn)
        case ")": advance(); return WITToken(kind: .rParen, line: startLine, column: startColumn)
        case "<": advance(); return WITToken(kind: .lAngle, line: startLine, column: startColumn)
        case ">": advance(); return WITToken(kind: .rAngle, line: startLine, column: startColumn)
        case "=": advance(); return WITToken(kind: .equals, line: startLine, column: startColumn)
        case "_":
            if peekNext()?.isIdentifierChar != true {
                advance()
                return WITToken(kind: .`_`, line: startLine, column: startColumn)
            }
        default: break
        }
        
        // Arrow
        if c == "-" && peekNext() == ">" {
            advance(); advance()
            return WITToken(kind: .arrow, line: startLine, column: startColumn)
        }
        
        // Escaped identifiers (for reserved words like %stream)
        if c == "%" && peekNext()?.isIdentifierStart == true {
            advance()  // Skip %
            let ident = scanIdentifier()
            return WITToken(kind: .identifier(ident), line: startLine, column: startColumn)
        }
        
        // Identifiers and keywords (including version numbers like 0.1.0)
        if c.isIdentifierStart || c.isNumber {
            let ident = scanIdentifier()
            let kind = keyword(for: ident) ?? .identifier(ident)
            return WITToken(kind: kind, line: startLine, column: startColumn)
        }
        
        throw WITLexerError.unexpectedCharacter(c, line: line, column: column)
    }
    
    private mutating func scanIdentifier() -> String {
        var result = ""
        while !isAtEnd && peek().isIdentifierChar {
            result.append(peek())
            advance()
        }
        return result
    }
    
    private mutating func scanVersion() -> String {
        // Scan version like "0.1.0" - digits and dots
        // Don't consume trailing dot (it's a separator token)
        var result = ""
        while !isAtEnd {
            let c = peek()
            if c.isNumber {
                result.append(c)
                advance()
            } else if c == "." {
                // Only consume dot if followed by a digit
                if let next = peekNext(), next.isNumber {
                    result.append(c)
                    advance()
                } else {
                    // Trailing dot - don't consume it
                    break
                }
            } else {
                break
            }
        }
        return result
    }
    
    private mutating func scanDocComment() -> String {
        // Skip ///
        advance(); advance(); advance()
        
        var result = ""
        while !isAtEnd && peek() != "\n" {
            result.append(peek())
            advance()
        }
        return result.trimmingCharacters(in: .whitespaces)
    }
    
    private mutating func scanAnnotation() -> String {
        advance()  // Skip @
        var result = ""
        // Scan annotation name until whitespace, ( or )
        while !isAtEnd && !peek().isWhitespace && peek() != "(" && peek() != ")" {
            result.append(peek())
            advance()
        }
        
        // Include parenthesized content if present
        if peek() == "(" {
            result.append(peek())
            advance()
            var depth = 1
            while !isAtEnd && depth > 0 {
                let c = peek()
                result.append(c)
                advance()
                if c == "(" { depth += 1 }
                else if c == ")" { depth -= 1 }
            }
        }
        
        return result
    }
    
    private func keyword(for identifier: String) -> WITTokenKind? {
        switch identifier {
        case "package": return .package
        case "interface": return .interface
        case "world": return .world
        case "resource": return .resource
        case "record": return .record
        case "variant": return .variant
        case "enum": return .enum
        case "flags": return .flags
        case "func": return .func
        case "use": return .use
        case "type": return .type
        case "include": return .include
        case "import": return .import
        case "export": return .export
        case "static": return .static
        case "constructor": return .constructor
        case "bool": return .bool
        case "u8": return .u8
        case "u16": return .u16
        case "u32": return .u32
        case "u64": return .u64
        case "s8": return .s8
        case "s16": return .s16
        case "s32": return .s32
        case "s64": return .s64
        case "f32": return .f32
        case "f64": return .f64
        case "char": return .char
        case "string": return .string
        case "list": return .list
        case "option": return .option
        case "result": return .result
        case "tuple": return .tuple
        case "own": return .own
        case "borrow": return .borrow
        case "as": return .as
        case "with": return .with
        default: return nil
        }
    }
    
    private mutating func skipWhitespaceAndComments() {
        while !isAtEnd {
            let c = peek()
            
            if c.isWhitespace {
                if c == "\n" {
                    line += 1
                    column = 0
                }
                advance()
            } else if c == "/" && peekNext() == "/" && peekAt(offset: 2) != "/" {
                // Regular comment (not doc comment)
                while !isAtEnd && peek() != "\n" {
                    advance()
                }
            } else if c == "/" && peekNext() == "*" {
                // Block comment
                advance(); advance()  // Skip /*
                while !isAtEnd {
                    if peek() == "*" && peekNext() == "/" {
                        advance(); advance()
                        break
                    }
                    if peek() == "\n" {
                        line += 1
                        column = 0
                    }
                    advance()
                }
            } else {
                break
            }
        }
    }
    
    // MARK: - Helpers
    
    private var isAtEnd: Bool {
        index >= source.endIndex
    }
    
    private func peek() -> Character {
        guard index < source.endIndex else { return "\0" }
        return source[index]
    }
    
    private func peekNext() -> Character? {
        let next = source.index(after: index)
        guard next < source.endIndex else { return nil }
        return source[next]
    }
    
    private func peekAt(offset: Int) -> Character? {
        guard let idx = source.index(index, offsetBy: offset, limitedBy: source.endIndex) else {
            return nil
        }
        guard idx < source.endIndex else { return nil }
        return source[idx]
    }
    
    @discardableResult
    private mutating func advance() -> Character {
        let c = source[index]
        index = source.index(after: index)
        column += 1
        return c
    }
}

/// Lexer errors
public enum WITLexerError: Error, Sendable {
    case unexpectedCharacter(Character, line: Int, column: Int)
    case unterminatedString(line: Int, column: Int)
}

// MARK: - Character Extensions

extension Character {
    var isIdentifierStart: Bool {
        isLetter || self == "_"
    }
    
    var isIdentifierChar: Bool {
        isLetter || isNumber || self == "_" || self == "-"
    }
}
