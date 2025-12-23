//! Shell environment and result types.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

/// Global session counter for generating unique session IDs ($$)
static SESSION_COUNTER: AtomicU64 = AtomicU64::new(1);

/// Shell options (set -e, -u, -x, etc.)
#[derive(Debug, Clone, Default)]
pub struct ShellOptions {
    /// Exit immediately if a command exits with non-zero status (set -e)
    pub errexit: bool,
    /// Treat unset variables as an error (set -u)
    pub nounset: bool,
    /// Print commands before execution (set -x)
    pub xtrace: bool,
    /// Return value of a pipeline is the status of the last command to exit with non-zero (set -o pipefail)
    pub pipefail: bool,
    /// Do not exit on error in subshells
    pub errtrace: bool,
}

impl ShellOptions {
    /// Parse a set option string (e.g., "-e", "-x", "+e")
    pub fn parse_option(&mut self, opt: &str) -> Result<(), String> {
        let (enable, flag) = if opt.starts_with('-') {
            (true, &opt[1..])
        } else if opt.starts_with('+') {
            (false, &opt[1..])
        } else {
            return Err(format!("Invalid option: {}", opt));
        };

        match flag {
            "e" => self.errexit = enable,
            "u" => self.nounset = enable,
            "x" => self.xtrace = enable,
            "E" => self.errtrace = enable,
            "o" => {} // Handled separately for pipefail
            _ => return Err(format!("Unknown option: {}", opt)),
        }
        Ok(())
    }

    /// Parse -o option (e.g., "pipefail")
    pub fn parse_long_option(&mut self, opt: &str, enable: bool) -> Result<(), String> {
        match opt {
            "pipefail" => self.pipefail = enable,
            "errexit" => self.errexit = enable,
            "nounset" => self.nounset = enable,
            "xtrace" => self.xtrace = enable,
            "errtrace" => self.errtrace = enable,
            _ => return Err(format!("Unknown option: {}", opt)),
        }
        Ok(())
    }
}

/// Shell execution environment.
#[derive(Debug, Clone)]
pub struct ShellEnv {
    /// Current working directory.
    pub cwd: PathBuf,
    /// Previous working directory (for cd -).
    pub prev_cwd: PathBuf,
    /// Directory stack (for pushd/popd).
    pub dir_stack: Vec<PathBuf>,
    /// Environment variables (exported).
    pub env_vars: HashMap<String, String>,
    /// Shell variables (not exported).
    pub variables: HashMap<String, String>,
    /// Read-only variables.
    pub readonly: HashSet<String>,
    /// Local variables (function scope).
    pub local_vars: HashMap<String, String>,
    /// Positional parameters ($1, $2, etc.)
    pub positional_params: Vec<String>,
    /// Last command exit code ($?)
    pub last_exit_code: i32,
    /// Session ID ($$)
    pub session_id: u64,
    /// Shell options
    pub options: ShellOptions,
    /// Current function/script name ($0)
    pub script_name: String,
    /// Subshell depth (for nested execution)
    pub subshell_depth: usize,
    /// Trap handlers (signal -> command)
    #[allow(dead_code)] // kept for POSIX shell trap support
    pub traps: HashMap<String, String>,
    /// Shell functions (name -> body)
    pub functions: HashMap<String, String>,
    /// Are we in a function scope?
    pub in_function: bool,
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
            variables: HashMap::new(),
            readonly: HashSet::new(),
            local_vars: HashMap::new(),
            positional_params: Vec::new(),
            last_exit_code: 0,
            session_id: SESSION_COUNTER.fetch_add(1, Ordering::SeqCst),
            options: ShellOptions::default(),
            script_name: "shell".to_string(),
            subshell_depth: 0,
            traps: HashMap::new(),
            functions: HashMap::new(),
            in_function: false,
        }
    }

    /// Get a variable value (checks local_vars first, then variables, then env_vars)
    pub fn get_var(&self, name: &str) -> Option<&String> {
        self.local_vars.get(name)
            .or_else(|| self.variables.get(name))
            .or_else(|| self.env_vars.get(name))
    }

    /// Set a variable value
    pub fn set_var(&mut self, name: &str, value: &str) -> Result<(), String> {
        if self.readonly.contains(name) {
            return Err(format!("{}: readonly variable", name));
        }
        self.variables.insert(name.to_string(), value.to_string());
        Ok(())
    }

    /// Export a variable to the environment
    pub fn export_var(&mut self, name: &str, value: Option<&str>) -> Result<(), String> {
        if self.readonly.contains(name) {
            return Err(format!("{}: readonly variable", name));
        }
        let val = value
            .map(|v| v.to_string())
            .or_else(|| self.variables.get(name).cloned())
            .unwrap_or_default();
        self.env_vars.insert(name.to_string(), val);
        Ok(())
    }

    /// Unset a variable
    pub fn unset_var(&mut self, name: &str) -> Result<(), String> {
        if self.readonly.contains(name) {
            return Err(format!("{}: readonly variable", name));
        }
        self.variables.remove(name);
        self.env_vars.remove(name);
        Ok(())
    }

    /// Mark a variable as readonly
    pub fn set_readonly(&mut self, name: &str, value: Option<&str>) -> Result<(), String> {
        if let Some(v) = value {
            self.set_var(name, v)?;
        }
        self.readonly.insert(name.to_string());
        Ok(())
    }

    /// Get a positional parameter ($1, $2, etc. - 1-indexed)
    pub fn get_positional(&self, index: usize) -> Option<&String> {
        if index == 0 {
            Some(&self.script_name)
        } else {
            self.positional_params.get(index - 1)
        }
    }

    /// Get number of positional parameters ($#)
    pub fn param_count(&self) -> usize {
        self.positional_params.len()
    }

    /// Get all positional parameters as a single string ($*)
    pub fn all_params_string(&self) -> String {
        self.positional_params.join(" ")
    }

    /// Get all positional parameters as quoted strings ($@)
    #[allow(dead_code)] // POSIX shell API
    pub fn all_params(&self) -> &[String] {
        &self.positional_params
    }

    /// Create a subshell environment (copy with incremented depth)
    pub fn subshell(&self) -> Self {
        let mut sub = self.clone();
        sub.subshell_depth += 1;
        sub
    }

    /// Set a trap handler
    #[allow(dead_code)] // kept for POSIX trap support
    pub fn set_trap(&mut self, signal: &str, command: Option<&str>) {
        if let Some(cmd) = command {
            self.traps.insert(signal.to_string(), cmd.to_string());
        } else {
            self.traps.remove(signal);
        }
    }

    /// Get a trap handler
    #[allow(dead_code)] // kept for POSIX trap support
    pub fn get_trap(&self, signal: &str) -> Option<&String> {
        self.traps.get(signal)
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
        assert!(env.variables.is_empty());
        assert_eq!(env.last_exit_code, 0);
        assert!(env.session_id > 0);
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

    #[test]
    fn test_set_get_var() {
        let mut env = ShellEnv::new();
        env.set_var("FOO", "bar").unwrap();
        assert_eq!(env.get_var("FOO"), Some(&"bar".to_string()));
    }

    #[test]
    fn test_readonly_var() {
        let mut env = ShellEnv::new();
        env.set_readonly("CONST", Some("value")).unwrap();
        assert!(env.set_var("CONST", "new").is_err());
        assert!(env.unset_var("CONST").is_err());
    }

    #[test]
    fn test_export_var() {
        let mut env = ShellEnv::new();
        env.set_var("LOCAL", "value").unwrap();
        env.export_var("LOCAL", None).unwrap();
        assert_eq!(env.env_vars.get("LOCAL"), Some(&"value".to_string()));
    }

    #[test]
    fn test_positional_params() {
        let mut env = ShellEnv::new();
        env.positional_params = vec!["arg1".to_string(), "arg2".to_string()];
        assert_eq!(env.get_positional(0), Some(&"shell".to_string()));
        assert_eq!(env.get_positional(1), Some(&"arg1".to_string()));
        assert_eq!(env.get_positional(2), Some(&"arg2".to_string()));
        assert_eq!(env.param_count(), 2);
        assert_eq!(env.all_params_string(), "arg1 arg2");
    }

    #[test]
    fn test_shell_options() {
        let mut opts = ShellOptions::default();
        opts.parse_option("-e").unwrap();
        assert!(opts.errexit);
        opts.parse_option("+e").unwrap();
        assert!(!opts.errexit);
        opts.parse_long_option("pipefail", true).unwrap();
        assert!(opts.pipefail);
    }

    #[test]
    fn test_subshell() {
        let env = ShellEnv::new();
        let sub = env.subshell();
        assert_eq!(sub.subshell_depth, 1);
        assert_eq!(sub.session_id, env.session_id);
    }

    #[test]
    fn test_trap() {
        let mut env = ShellEnv::new();
        env.set_trap("EXIT", Some("cleanup"));
        assert_eq!(env.get_trap("EXIT"), Some(&"cleanup".to_string()));
        env.set_trap("EXIT", None);
        assert_eq!(env.get_trap("EXIT"), None);
    }
}
