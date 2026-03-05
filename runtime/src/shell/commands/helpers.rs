//! Shared utilities for shell commands.
//!
//! Eliminates boilerplate duplicated across 50+ shell command implementations:
//! - `resolve_path`: path resolution (absolute vs relative to cwd)
//! - `shell_err!`: write formatted error messages to stderr
//! - `write_stdout!` / `write_line!`: write to stdout
//! - `truncate_line`: Unicode-safe string truncation

/// Resolve a path relative to the current working directory.
///
/// If `path` is absolute (starts with `/`), returns it as-is.
/// If `path` is relative, joins it with `cwd`.
/// Handles empty `path` by returning `cwd`.
pub fn resolve_path(cwd: &str, path: &str) -> String {
    if path.is_empty() {
        return cwd.to_string();
    }
    if path.starts_with('/') {
        path.to_string()
    } else if cwd.is_empty() || cwd == "/" {
        format!("/{}", path)
    } else {
        format!("{}/{}", cwd, path)
    }
}

/// Truncate a string to at most `max_len` characters (Unicode-safe).
///
/// If the string is longer than `max_len`, it is truncated and `...` is appended.
/// If `max_len` is less than 3, the string is simply truncated without ellipsis.
#[allow(dead_code)]
pub fn truncate_line(s: &str, max_len: usize) -> String {
    let char_count = s.chars().count();
    if char_count <= max_len {
        return s.to_string();
    }
    if max_len < 3 {
        return s.chars().take(max_len).collect();
    }
    let truncated: String = s.chars().take(max_len - 3).collect();
    format!("{}...", truncated)
}

/// Write a formatted error message to stderr.
///
/// Usage: `shell_err!(stderr, "cmd: {}: {}\n", path, err);`
///
/// Equivalent to:
/// ```ignore
/// let msg = format!("cmd: {}: {}\n", path, err);
/// let _ = stderr.write_all(msg.as_bytes()).await;
/// ```
#[macro_export]
macro_rules! shell_err {
    ($stderr:expr, $($arg:tt)*) => {{
        let msg = format!($($arg)*);
        let _ = $stderr.write_all(msg.as_bytes()).await;
    }};
}

/// Write formatted output to stdout.
///
/// Usage: `write_stdout!(stdout, "value: {}\n", val);`
#[macro_export]
macro_rules! write_stdout {
    ($stdout:expr, $($arg:tt)*) => {{
        let msg = format!($($arg)*);
        let _ = $stdout.write_all(msg.as_bytes()).await;
    }};
}

/// Write a line to stdout (appends newline).
///
/// Usage: `write_line!(stdout, "{}", val);`
#[macro_export]
macro_rules! write_line {
    ($stdout:expr, $($arg:tt)*) => {{
        let msg = format!($($arg)*);
        let _ = $stdout.write_all(msg.as_bytes()).await;
        let _ = $stdout.write_all(b"\n").await;
    }};
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---- resolve_path tests ----

    #[test]
    fn test_resolve_path_absolute() {
        assert_eq!(resolve_path("/home/user", "/etc/config"), "/etc/config");
    }

    #[test]
    fn test_resolve_path_relative() {
        assert_eq!(
            resolve_path("/home/user", "file.txt"),
            "/home/user/file.txt"
        );
    }

    #[test]
    fn test_resolve_path_relative_subdir() {
        assert_eq!(
            resolve_path("/home/user", "src/main.rs"),
            "/home/user/src/main.rs"
        );
    }

    #[test]
    fn test_resolve_path_empty_path() {
        assert_eq!(resolve_path("/home/user", ""), "/home/user");
    }

    #[test]
    fn test_resolve_path_root_cwd() {
        assert_eq!(resolve_path("/", "file.txt"), "/file.txt");
    }

    #[test]
    fn test_resolve_path_root_cwd_no_double_slash() {
        // Must not produce "//file.txt"
        let result = resolve_path("/", "file.txt");
        assert!(!result.starts_with("//"));
    }

    #[test]
    fn test_resolve_path_with_dotdot() {
        // resolve_path does simple concatenation, not normalization
        assert_eq!(
            resolve_path("/home/user", "../etc/config"),
            "/home/user/../etc/config"
        );
    }

    #[test]
    fn test_resolve_path_with_dot() {
        assert_eq!(
            resolve_path("/home/user", "./file.txt"),
            "/home/user/./file.txt"
        );
    }

    #[test]
    fn test_resolve_path_absolute_ignores_cwd() {
        assert_eq!(resolve_path("/some/deep/path", "/absolute"), "/absolute");
    }

    #[test]
    fn test_resolve_path_empty_cwd() {
        // Edge case: empty cwd with relative path
        assert_eq!(resolve_path("", "file.txt"), "/file.txt");
    }

    // ---- truncate_line tests ----

    #[test]
    fn test_truncate_line_short_string() {
        assert_eq!(truncate_line("hello", 10), "hello");
    }

    #[test]
    fn test_truncate_line_exact_length() {
        assert_eq!(truncate_line("hello", 5), "hello");
    }

    #[test]
    fn test_truncate_line_over_length() {
        assert_eq!(truncate_line("hello world", 8), "hello...");
    }

    #[test]
    fn test_truncate_line_empty() {
        assert_eq!(truncate_line("", 10), "");
    }

    #[test]
    fn test_truncate_line_zero_max() {
        assert_eq!(truncate_line("hello", 0), "");
    }

    #[test]
    fn test_truncate_line_max_less_than_3() {
        assert_eq!(truncate_line("hello", 2), "he");
    }

    #[test]
    fn test_truncate_line_max_exactly_3() {
        assert_eq!(truncate_line("hello", 3), "...");
    }

    #[test]
    fn test_truncate_line_unicode() {
        // Japanese characters are single chars
        assert_eq!(truncate_line("こんにちは世界", 5), "こん...");
    }

    #[test]
    fn test_truncate_line_unicode_exact() {
        assert_eq!(truncate_line("café", 4), "café");
    }

    #[test]
    fn test_truncate_line_unicode_over() {
        assert_eq!(truncate_line("café!", 4), "c...");
    }
}
