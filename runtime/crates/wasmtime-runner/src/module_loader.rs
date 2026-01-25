//! Module loader host implementation
//!
//! Provides `mcp:module-loader/loader` interface for lazy-loading WASM modules.
//! Implements the lazy-process resource for subprocess-like I/O with WASM modules.

use anyhow::Result;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};

/// Terminal dimensions
#[derive(Clone, Copy, Debug, Default)]
pub struct TerminalSize {
    pub cols: u32,
    pub rows: u32,
}

/// A lazy-loaded process handle
/// For now, we spawn native processes as a fallback for commands like vim/sqlite3
pub struct LazyProcess {
    /// Native child process (fallback mode)
    child: Option<Child>,
    /// Terminal dimensions
    terminal_size: TerminalSize,
    /// Raw mode state
    raw_mode: bool,
    /// Stdout buffer
    stdout_buf: Vec<u8>,
    /// Stderr buffer
    stderr_buf: Vec<u8>,
    /// Exit code (if finished)
    exit_code: Option<i32>,
}

impl LazyProcess {
    /// Create a new lazy process from a native command
    pub fn spawn_native(
        command: &str,
        args: &[String],
        cwd: &str,
        env: &[(String, String)],
    ) -> Result<Self> {
        let mut cmd = Command::new(command);
        cmd.args(args)
            .current_dir(cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        for (key, value) in env {
            cmd.env(key, value);
        }

        let child = cmd.spawn()?;

        Ok(Self {
            child: Some(child),
            terminal_size: TerminalSize::default(),
            raw_mode: false,
            stdout_buf: Vec::new(),
            stderr_buf: Vec::new(),
            exit_code: None,
        })
    }

    /// Create a stub process that immediately exits (for unimplemented commands)
    pub fn stub(message: &str) -> Self {
        Self {
            child: None,
            terminal_size: TerminalSize::default(),
            raw_mode: false,
            stdout_buf: Vec::new(),
            stderr_buf: format!("{}\n", message).into_bytes(),
            exit_code: Some(1),
        }
    }

    pub fn is_ready(&mut self) -> bool {
        if self.exit_code.is_some() {
            return true;
        }
        // Try to check if child has exited
        if let Some(ref mut child) = self.child {
            match child.try_wait() {
                Ok(Some(status)) => {
                    self.exit_code = Some(status.code().unwrap_or(-1));
                    true
                }
                Ok(None) => false,
                Err(_) => true,
            }
        } else {
            true
        }
    }

    pub fn write_stdin(&mut self, data: &[u8]) -> u64 {
        if let Some(ref mut child) = self.child {
            if let Some(ref mut stdin) = child.stdin {
                match stdin.write(data) {
                    Ok(n) => return n as u64,
                    Err(_) => return 0,
                }
            }
        }
        0
    }

    pub fn close_stdin(&mut self) {
        if let Some(ref mut child) = self.child {
            child.stdin.take();
        }
    }

    pub fn read_stdout(&mut self, max_bytes: u64) -> Vec<u8> {
        // First drain any buffered data
        if !self.stdout_buf.is_empty() {
            let n = std::cmp::min(max_bytes as usize, self.stdout_buf.len());
            return self.stdout_buf.drain(..n).collect();
        }

        if let Some(ref mut child) = self.child {
            if let Some(ref mut stdout) = child.stdout {
                let mut buf = vec![0u8; max_bytes as usize];
                match stdout.read(&mut buf) {
                    Ok(n) => {
                        buf.truncate(n);
                        return buf;
                    }
                    Err(_) => return Vec::new(),
                }
            }
        }
        Vec::new()
    }

    pub fn read_stderr(&mut self, max_bytes: u64) -> Vec<u8> {
        // First drain any buffered data
        if !self.stderr_buf.is_empty() {
            let n = std::cmp::min(max_bytes as usize, self.stderr_buf.len());
            return self.stderr_buf.drain(..n).collect();
        }

        if let Some(ref mut child) = self.child {
            if let Some(ref mut stderr) = child.stderr {
                let mut buf = vec![0u8; max_bytes as usize];
                match stderr.read(&mut buf) {
                    Ok(n) => {
                        buf.truncate(n);
                        return buf;
                    }
                    Err(_) => return Vec::new(),
                }
            }
        }
        Vec::new()
    }

    pub fn try_wait(&mut self) -> Option<i32> {
        if self.exit_code.is_some() {
            return self.exit_code;
        }

        if let Some(ref mut child) = self.child {
            match child.try_wait() {
                Ok(Some(status)) => {
                    self.exit_code = Some(status.code().unwrap_or(-1));
                    self.exit_code
                }
                _ => None,
            }
        } else {
            self.exit_code
        }
    }

    pub fn get_terminal_size(&self) -> TerminalSize {
        self.terminal_size
    }

    pub fn set_terminal_size(&mut self, size: TerminalSize) {
        self.terminal_size = size;
    }

    pub fn set_raw_mode(&mut self, enabled: bool) {
        self.raw_mode = enabled;
    }

    pub fn is_raw_mode(&self) -> bool {
        self.raw_mode
    }

    pub fn send_signal(&mut self, signum: u8) {
        #[cfg(unix)]
        if let Some(ref child) = self.child {
            unsafe {
                libc::kill(child.id() as i32, signum as i32);
            }
        }
        #[cfg(not(unix))]
        {
            let _ = signum;
            // On non-Unix, we can only kill
            if let Some(ref mut child) = self.child {
                let _ = child.kill();
            }
        }
    }
}

/// Registry of lazy-loadable modules
pub struct ModuleLoader {
    modules_dir: PathBuf,
    /// Command -> (module_name, is_interactive)
    registry: HashMap<&'static str, (&'static str, bool)>,
    /// Shared process table
    processes: Arc<Mutex<Vec<LazyProcess>>>,
}

impl ModuleLoader {
    pub fn new(modules_dir: PathBuf) -> Self {
        let mut registry = HashMap::new();

        // edtui-module (vim/vi editor)
        registry.insert("vim", ("edtui_module.wasm", true));
        registry.insert("vi", ("edtui_module.wasm", true));

        // sqlite-module
        registry.insert("sqlite3", ("sqlite_module.wasm", false));

        // tsx-engine
        registry.insert("tsx", ("tsx_engine.wasm", false));
        registry.insert("tsc", ("tsx_engine.wasm", false));

        Self {
            modules_dir,
            registry,
            processes: Arc::new(Mutex::new(Vec::new())),
        }
    }

    /// Get the module name for a command (None if not a lazy command)
    pub fn get_lazy_module(&self, command: &str) -> Option<String> {
        self.registry.get(command).map(|(m, _)| m.to_string())
    }

    /// Check if a command is interactive (needs terminal handoff)
    pub fn is_interactive_command(&self, command: &str) -> bool {
        self.registry.get(command).map(|(_, i)| *i).unwrap_or(false)
    }

    /// Get the path to a module WASM file
    #[allow(dead_code)]
    pub fn module_path(&self, module: &str) -> PathBuf {
        self.modules_dir.join(module)
    }

    /// Spawn a lazy command (for now, stub or native fallback)
    pub fn spawn_lazy_command(
        &self,
        module: &str,
        command: &str,
        args: Vec<String>,
        cwd: String,
        env: Vec<(String, String)>,
    ) -> usize {
        // For now, try to spawn the native command as a fallback
        // TODO: Actually load and run the WASM module
        let process = match LazyProcess::spawn_native(command, &args, &cwd, &env) {
            Ok(p) => p,
            Err(_) => LazyProcess::stub(&format!(
                "Command '{}' (module: {}) not available in native mode",
                command, module
            )),
        };

        let mut processes = self.processes.lock().unwrap();
        let id = processes.len();
        processes.push(process);
        id
    }

    pub fn get_process_mut(
        &self,
        _id: usize,
    ) -> Option<std::sync::MutexGuard<'_, Vec<LazyProcess>>> {
        Some(self.processes.lock().unwrap())
    }
}

// NOTE: add_to_linker for mcp:module-loader/loader is now generated by bindgen
// and implemented via the Host trait in host_traits.rs
