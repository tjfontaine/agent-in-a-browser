//! Shell environment and result types.

use std::collections::HashMap;
use std::path::PathBuf;

/// Shell execution environment.
#[derive(Debug, Clone)]
pub struct ShellEnv {
    /// Current working directory.
    pub cwd: PathBuf,
    /// Previous working directory (for cd -).
    pub prev_cwd: PathBuf,
    /// Directory stack (for pushd/popd).
    pub dir_stack: Vec<PathBuf>,
    /// Environment variables.
    pub env_vars: HashMap<String, String>,
}

impl ShellEnv {
    /// Create a new shell environment with default values.
    pub fn new() -> Self {
        Self {
            // Use "/" for root directory - consistent with absolute paths in the VFS
            cwd: PathBuf::from("/"),
            prev_cwd: PathBuf::from("/"),
            dir_stack: Vec::new(),
            env_vars: HashMap::new(),
        }
    }
}

impl Default for ShellEnv {
    fn default() -> Self {
        Self::new()
    }
}

/// Result of shell command execution.
#[derive(Debug, Clone)]
pub struct ShellResult {
    /// Standard output.
    pub stdout: String,
    /// Standard error.
    pub stderr: String,
    /// Exit code (0 = success).
    pub code: i32,
}

impl ShellResult {
    /// Create a successful result with stdout.
    pub fn success(stdout: impl Into<String>) -> Self {
        Self {
            stdout: stdout.into(),
            stderr: String::new(),
            code: 0,
        }
    }

    /// Create an error result.
    pub fn error(stderr: impl Into<String>, code: i32) -> Self {
        Self {
            stdout: String::new(),
            stderr: stderr.into(),
            code,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_shell_env_default() {
        let env = ShellEnv::new();
        assert_eq!(env.cwd, PathBuf::from("/"));
        assert!(env.env_vars.is_empty());
    }

    #[test]
    fn test_shell_result_success() {
        let result = ShellResult::success("hello");
        assert_eq!(result.stdout, "hello");
        assert_eq!(result.code, 0);
    }

    #[test]
    fn test_shell_result_error() {
        let result = ShellResult::error("not found", 1);
        assert_eq!(result.stderr, "not found");
        assert_eq!(result.code, 1);
    }
}
