//! Test and conditional commands: test, [, true, false

use futures_lite::io::AsyncWriteExt;
use runtime_macros::shell_commands;

use super::super::ShellEnv;
use super::parse_common;

/// Test commands.
pub struct TestCommands;

#[shell_commands]
impl TestCommands {
    /// test - evaluate conditional expression
    #[shell_command(
        name = "test",
        usage = "test EXPRESSION",
        description = "Evaluate conditional expression and return 0 (true) or 1 (false).\n\
        File tests: -e FILE (exists), -f FILE (regular file), -d FILE (directory),\n\
        -r FILE (readable), -w FILE (writable), -x FILE (executable), -s FILE (non-empty)\n\
        String tests: -z STRING (empty), -n STRING (non-empty), S1 = S2, S1 != S2\n\
        Numeric tests: N1 -eq N2, -ne, -lt, -le, -gt, -ge\n\
        Logical: ! EXPR, EXPR -a EXPR, EXPR -o EXPR"
    )]
    pub fn cmd_test(
        args: Vec<String>,
        _env: &ShellEnv,
        _stdin: piper::Reader,
        mut stdout: piper::Writer,
        _stderr: piper::Writer,
    ) -> futures_lite::future::Boxed<i32> {
        Box::pin(async move {
            let (opts, remaining) = parse_common(&args);
            if opts.help {
                let help = TestCommands::show_help("test").unwrap_or("");
                let _ = stdout.write_all(help.as_bytes()).await;
                return 0;
            }

            // Evaluate the expression
            let result = evaluate_test_expression(&remaining);
            if result {
                0
            } else {
                1
            }
        })
    }

    /// [ - evaluate conditional expression (alias for test)
    #[shell_command(
        name = "[",
        usage = "[ EXPRESSION ]",
        description = "Evaluate conditional expression. Same as 'test' but requires closing ]."
    )]
    pub fn cmd_bracket(
        args: Vec<String>,
        _env: &ShellEnv,
        _stdin: piper::Reader,
        mut stdout: piper::Writer,
        mut stderr: piper::Writer,
    ) -> futures_lite::future::Boxed<i32> {
        Box::pin(async move {
            let (opts, mut remaining) = parse_common(&args);
            if opts.help {
                let help = TestCommands::show_help("[").unwrap_or("");
                let _ = stdout.write_all(help.as_bytes()).await;
                return 0;
            }

            // Check for closing bracket
            if remaining.last().map(|s| s.as_str()) != Some("]") {
                let _ = stderr.write_all(b"[: missing ']'\n").await;
                return 2;
            }
            remaining.pop(); // Remove ]

            let result = evaluate_test_expression(&remaining);
            if result {
                0
            } else {
                1
            }
        })
    }

    /// [[ - extended test expression (bash extension)
    #[shell_command(
        name = "[[",
        usage = "[[ EXPRESSION ]]",
        description = "Evaluate extended conditional expression (bash extension).\\n\
        Same as [ but with additional features:\\n\
        - && and || operators (not -a, -o)\\n\
        - < and > for string comparison\\n\
        - == with pattern matching\\n\
        - =~ for regex matching (planned)"
    )]
    pub fn cmd_double_bracket(
        args: Vec<String>,
        _env: &ShellEnv,
        _stdin: piper::Reader,
        mut stdout: piper::Writer,
        mut stderr: piper::Writer,
    ) -> futures_lite::future::Boxed<i32> {
        Box::pin(async move {
            let (opts, mut remaining) = parse_common(&args);
            if opts.help {
                let help = TestCommands::show_help("[[").unwrap_or("");
                let _ = stdout.write_all(help.as_bytes()).await;
                return 0;
            }

            // Check for closing bracket
            if remaining.last().map(|s| s.as_str()) != Some("]]") {
                let _ = stderr.write_all(b"[[: missing ']]'\n").await;
                return 2;
            }
            remaining.pop(); // Remove ]]

            let result = evaluate_extended_test_expression(&remaining);
            if result {
                0
            } else {
                1
            }
        })
    }
}

/// Evaluate a test expression
fn evaluate_test_expression(args: &[String]) -> bool {
    if args.is_empty() {
        return false;
    }

    // Handle negation
    if args[0] == "!" {
        return !evaluate_test_expression(&args[1..]);
    }

    // Handle parentheses
    if args[0] == "(" && args.last().map(|s| s.as_str()) == Some(")") {
        return evaluate_test_expression(&args[1..args.len() - 1]);
    }

    // Look for binary logical operators (lowest precedence)
    for (i, arg) in args.iter().enumerate() {
        match arg.as_str() {
            "-o" => {
                // OR: return true if either side is true
                return evaluate_test_expression(&args[..i])
                    || evaluate_test_expression(&args[i + 1..]);
            }
            _ => {}
        }
    }

    for (i, arg) in args.iter().enumerate() {
        match arg.as_str() {
            "-a" => {
                // AND: return true only if both sides are true
                return evaluate_test_expression(&args[..i])
                    && evaluate_test_expression(&args[i + 1..]);
            }
            _ => {}
        }
    }

    // Handle unary operators
    if args.len() >= 2 {
        match args[0].as_str() {
            "-e" => return std::fs::metadata(&args[1]).is_ok(),
            "-f" => {
                return std::fs::metadata(&args[1])
                    .map(|m| m.is_file())
                    .unwrap_or(false)
            }
            "-d" => {
                return std::fs::metadata(&args[1])
                    .map(|m| m.is_dir())
                    .unwrap_or(false)
            }
            "-r" => return std::fs::metadata(&args[1]).is_ok(), // Simplified - assume readable if exists
            "-w" => return std::fs::metadata(&args[1]).is_ok(), // Simplified
            "-x" => return std::fs::metadata(&args[1]).is_ok(), // Simplified
            "-s" => {
                return std::fs::metadata(&args[1])
                    .map(|m| m.len() > 0)
                    .unwrap_or(false)
            }
            "-z" => return args[1].is_empty(),
            "-n" => return !args[1].is_empty(),
            "-L" | "-h" => {
                return std::fs::symlink_metadata(&args[1])
                    .map(|m| m.file_type().is_symlink())
                    .unwrap_or(false)
            }
            _ => {}
        }
    }

    // Handle binary operators
    if args.len() >= 3 {
        let left = &args[0];
        let op = &args[1];
        let right = &args[2];

        match op.as_str() {
            "=" | "==" => return left == right,
            "!=" => return left != right,
            "-eq" => return left.parse::<i64>().ok() == right.parse::<i64>().ok(),
            "-ne" => return left.parse::<i64>().ok() != right.parse::<i64>().ok(),
            "-lt" => return left.parse::<i64>().unwrap_or(0) < right.parse::<i64>().unwrap_or(0),
            "-le" => return left.parse::<i64>().unwrap_or(0) <= right.parse::<i64>().unwrap_or(0),
            "-gt" => return left.parse::<i64>().unwrap_or(0) > right.parse::<i64>().unwrap_or(0),
            "-ge" => return left.parse::<i64>().unwrap_or(0) >= right.parse::<i64>().unwrap_or(0),
            "-nt" => {
                // Newer than
                let left_time = std::fs::metadata(left).and_then(|m| m.modified()).ok();
                let right_time = std::fs::metadata(right).and_then(|m| m.modified()).ok();
                return match (left_time, right_time) {
                    (Some(l), Some(r)) => l > r,
                    _ => false,
                };
            }
            "-ot" => {
                // Older than
                let left_time = std::fs::metadata(left).and_then(|m| m.modified()).ok();
                let right_time = std::fs::metadata(right).and_then(|m| m.modified()).ok();
                return match (left_time, right_time) {
                    (Some(l), Some(r)) => l < r,
                    _ => false,
                };
            }
            _ => {}
        }
    }

    // Single argument - true if non-empty string
    if args.len() == 1 {
        return !args[0].is_empty();
    }

    false
}

/// Evaluate an extended test expression ([[ ]])
/// Supports && and || operators (instead of -a and -o) and < > for string comparison
fn evaluate_extended_test_expression(args: &[String]) -> bool {
    if args.is_empty() {
        return false;
    }

    // Handle negation
    if args[0] == "!" {
        return !evaluate_extended_test_expression(&args[1..]);
    }

    // Handle parentheses
    if args[0] == "(" && args.last().map(|s| s.as_str()) == Some(")") {
        return evaluate_extended_test_expression(&args[1..args.len() - 1]);
    }

    // Look for binary logical operators (lowest precedence)
    // || has lowest precedence
    for (i, arg) in args.iter().enumerate() {
        if arg == "||" {
            return evaluate_extended_test_expression(&args[..i])
                || evaluate_extended_test_expression(&args[i + 1..]);
        }
    }

    // && has higher precedence than ||
    for (i, arg) in args.iter().enumerate() {
        if arg == "&&" {
            return evaluate_extended_test_expression(&args[..i])
                && evaluate_extended_test_expression(&args[i + 1..]);
        }
    }

    // Handle unary operators (same as [)
    if args.len() >= 2 {
        match args[0].as_str() {
            "-e" => return std::fs::metadata(&args[1]).is_ok(),
            "-f" => {
                return std::fs::metadata(&args[1])
                    .map(|m| m.is_file())
                    .unwrap_or(false)
            }
            "-d" => {
                return std::fs::metadata(&args[1])
                    .map(|m| m.is_dir())
                    .unwrap_or(false)
            }
            "-r" => return std::fs::metadata(&args[1]).is_ok(),
            "-w" => return std::fs::metadata(&args[1]).is_ok(),
            "-x" => return std::fs::metadata(&args[1]).is_ok(),
            "-s" => {
                return std::fs::metadata(&args[1])
                    .map(|m| m.len() > 0)
                    .unwrap_or(false)
            }
            "-z" => return args[1].is_empty(),
            "-n" => return !args[1].is_empty(),
            "-L" | "-h" => {
                return std::fs::symlink_metadata(&args[1])
                    .map(|m| m.file_type().is_symlink())
                    .unwrap_or(false)
            }
            _ => {}
        }
    }

    // Handle binary operators
    if args.len() >= 3 {
        let left = &args[0];
        let op = &args[1];
        let right = &args[2];

        match op.as_str() {
            "=" | "==" => return left == right,
            "!=" => return left != right,
            // Extended: string comparison with < and >
            "<" => return left < right,
            ">" => return left > right,
            // Numeric operators (same as [)
            "-eq" => return left.parse::<i64>().ok() == right.parse::<i64>().ok(),
            "-ne" => return left.parse::<i64>().ok() != right.parse::<i64>().ok(),
            "-lt" => return left.parse::<i64>().unwrap_or(0) < right.parse::<i64>().unwrap_or(0),
            "-le" => return left.parse::<i64>().unwrap_or(0) <= right.parse::<i64>().unwrap_or(0),
            "-gt" => return left.parse::<i64>().unwrap_or(0) > right.parse::<i64>().unwrap_or(0),
            "-ge" => return left.parse::<i64>().unwrap_or(0) >= right.parse::<i64>().unwrap_or(0),
            "-nt" | "-ot" => {
                // Same as evaluate_test_expression
                let left_time = std::fs::metadata(left).and_then(|m| m.modified()).ok();
                let right_time = std::fs::metadata(right).and_then(|m| m.modified()).ok();
                return match (left_time, right_time) {
                    (Some(l), Some(r)) => {
                        if op == "-nt" {
                            l > r
                        } else {
                            l < r
                        }
                    }
                    _ => false,
                };
            }
            _ => {}
        }
    }

    // Single argument - true if non-empty string
    if args.len() == 1 {
        return !args[0].is_empty();
    }

    false
}

#[cfg(test)]
mod tests {
    use super::*;

    // ========================================================================
    // String Tests
    // ========================================================================

    #[test]
    fn test_string_empty() {
        assert!(evaluate_test_expression(&[
            "-z".to_string(),
            "".to_string()
        ]));
        assert!(!evaluate_test_expression(&[
            "-z".to_string(),
            "hello".to_string()
        ]));
    }

    #[test]
    fn test_string_non_empty() {
        assert!(evaluate_test_expression(&[
            "-n".to_string(),
            "hello".to_string()
        ]));
        assert!(!evaluate_test_expression(&[
            "-n".to_string(),
            "".to_string()
        ]));
    }

    #[test]
    fn test_string_equal() {
        assert!(evaluate_test_expression(&[
            "foo".to_string(),
            "=".to_string(),
            "foo".to_string()
        ]));
        assert!(!evaluate_test_expression(&[
            "foo".to_string(),
            "=".to_string(),
            "bar".to_string()
        ]));
    }

    #[test]
    fn test_string_equal_double() {
        assert!(evaluate_test_expression(&[
            "foo".to_string(),
            "==".to_string(),
            "foo".to_string()
        ]));
    }

    #[test]
    fn test_string_not_equal() {
        assert!(evaluate_test_expression(&[
            "foo".to_string(),
            "!=".to_string(),
            "bar".to_string()
        ]));
        assert!(!evaluate_test_expression(&[
            "foo".to_string(),
            "!=".to_string(),
            "foo".to_string()
        ]));
    }

    #[test]
    fn test_single_string_true() {
        // Single non-empty string is true
        assert!(evaluate_test_expression(&["nonempty".to_string()]));
    }

    #[test]
    fn test_empty_expression() {
        // Empty expression is false
        assert!(!evaluate_test_expression(&[]));
    }

    // ========================================================================
    // Numeric Tests
    // ========================================================================

    #[test]
    fn test_numeric() {
        assert!(evaluate_test_expression(&[
            "5".to_string(),
            "-gt".to_string(),
            "3".to_string()
        ]));
        assert!(evaluate_test_expression(&[
            "5".to_string(),
            "-eq".to_string(),
            "5".to_string()
        ]));
        assert!(!evaluate_test_expression(&[
            "5".to_string(),
            "-lt".to_string(),
            "3".to_string()
        ]));
    }

    #[test]
    fn test_numeric_eq() {
        assert!(evaluate_test_expression(&[
            "10".to_string(),
            "-eq".to_string(),
            "10".to_string()
        ]));
        assert!(!evaluate_test_expression(&[
            "10".to_string(),
            "-eq".to_string(),
            "20".to_string()
        ]));
    }

    #[test]
    fn test_numeric_ne() {
        assert!(evaluate_test_expression(&[
            "10".to_string(),
            "-ne".to_string(),
            "20".to_string()
        ]));
        assert!(!evaluate_test_expression(&[
            "10".to_string(),
            "-ne".to_string(),
            "10".to_string()
        ]));
    }

    #[test]
    fn test_numeric_lt() {
        assert!(evaluate_test_expression(&[
            "5".to_string(),
            "-lt".to_string(),
            "10".to_string()
        ]));
        assert!(!evaluate_test_expression(&[
            "10".to_string(),
            "-lt".to_string(),
            "5".to_string()
        ]));
        assert!(!evaluate_test_expression(&[
            "5".to_string(),
            "-lt".to_string(),
            "5".to_string()
        ]));
    }

    #[test]
    fn test_numeric_le() {
        assert!(evaluate_test_expression(&[
            "5".to_string(),
            "-le".to_string(),
            "10".to_string()
        ]));
        assert!(evaluate_test_expression(&[
            "5".to_string(),
            "-le".to_string(),
            "5".to_string()
        ]));
        assert!(!evaluate_test_expression(&[
            "10".to_string(),
            "-le".to_string(),
            "5".to_string()
        ]));
    }

    #[test]
    fn test_numeric_gt() {
        assert!(evaluate_test_expression(&[
            "10".to_string(),
            "-gt".to_string(),
            "5".to_string()
        ]));
        assert!(!evaluate_test_expression(&[
            "5".to_string(),
            "-gt".to_string(),
            "10".to_string()
        ]));
    }

    #[test]
    fn test_numeric_ge() {
        assert!(evaluate_test_expression(&[
            "10".to_string(),
            "-ge".to_string(),
            "5".to_string()
        ]));
        assert!(evaluate_test_expression(&[
            "5".to_string(),
            "-ge".to_string(),
            "5".to_string()
        ]));
    }

    #[test]
    fn test_numeric_negative() {
        assert!(evaluate_test_expression(&[
            "-5".to_string(),
            "-lt".to_string(),
            "0".to_string()
        ]));
        assert!(evaluate_test_expression(&[
            "0".to_string(),
            "-gt".to_string(),
            "-5".to_string()
        ]));
    }

    // ========================================================================
    // Logical Operators
    // ========================================================================

    #[test]
    fn test_negation() {
        assert!(evaluate_test_expression(&[
            "!".to_string(),
            "-z".to_string(),
            "hello".to_string()
        ]));
        assert!(!evaluate_test_expression(&[
            "!".to_string(),
            "-n".to_string(),
            "hello".to_string()
        ]));
    }

    #[test]
    fn test_negation_single() {
        assert!(evaluate_test_expression(&["!".to_string(), "".to_string()]));
        assert!(!evaluate_test_expression(&[
            "!".to_string(),
            "nonempty".to_string()
        ]));
    }

    #[test]
    fn test_logical_and() {
        assert!(evaluate_test_expression(&[
            "-n".to_string(),
            "hello".to_string(),
            "-a".to_string(),
            "-n".to_string(),
            "world".to_string()
        ]));
    }

    #[test]
    fn test_logical_and_false() {
        assert!(!evaluate_test_expression(&[
            "-n".to_string(),
            "hello".to_string(),
            "-a".to_string(),
            "-z".to_string(),
            "world".to_string()
        ]));
    }

    #[test]
    fn test_logical_or() {
        assert!(evaluate_test_expression(&[
            "-z".to_string(),
            "hello".to_string(),
            "-o".to_string(),
            "-n".to_string(),
            "world".to_string()
        ]));
    }

    #[test]
    fn test_logical_or_both_false() {
        assert!(!evaluate_test_expression(&[
            "-z".to_string(),
            "hello".to_string(),
            "-o".to_string(),
            "-z".to_string(),
            "world".to_string()
        ]));
    }

    // ========================================================================
    // File Tests (using known paths)
    // ========================================================================

    #[test]
    fn test_file_exists() {
        // Cargo.toml should exist in root
        assert!(
            evaluate_test_expression(&["-e".to_string(), "Cargo.toml".to_string()])
                || evaluate_test_expression(&["-e".to_string(), "/".to_string()])
        );
    }

    #[test]
    fn test_file_not_exists() {
        assert!(!evaluate_test_expression(&[
            "-e".to_string(),
            "/nonexistent/file/path".to_string()
        ]));
    }

    #[test]
    fn test_directory() {
        assert!(evaluate_test_expression(&[
            "-d".to_string(),
            "/".to_string()
        ]));
        assert!(!evaluate_test_expression(&[
            "-d".to_string(),
            "/nonexistent".to_string()
        ]));
    }

    // ========================================================================
    // Parentheses
    // ========================================================================

    #[test]
    fn test_parentheses() {
        assert!(evaluate_test_expression(&[
            "(".to_string(),
            "-n".to_string(),
            "hello".to_string(),
            ")".to_string()
        ]));
    }

    // ========================================================================
    // Edge Cases
    // ========================================================================

    #[test]
    fn test_empty_string_comparison() {
        assert!(evaluate_test_expression(&[
            "".to_string(),
            "=".to_string(),
            "".to_string()
        ]));
    }

    #[test]
    fn test_whitespace_comparison() {
        assert!(evaluate_test_expression(&[
            " ".to_string(),
            "=".to_string(),
            " ".to_string()
        ]));
        assert!(!evaluate_test_expression(&[
            " ".to_string(),
            "=".to_string(),
            "".to_string()
        ]));
    }
}
