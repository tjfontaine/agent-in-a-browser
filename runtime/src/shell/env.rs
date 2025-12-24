//! Shell environment and result types.
//!
//! This module provides a compliant variable system modeled after brush-core,
//! supporting arrays, variable attributes, and proper POSIX/bash semantics.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

/// Global session counter for generating unique session IDs ($$)
static SESSION_COUNTER: AtomicU64 = AtomicU64::new(1);

// ============================================================================
// Shell Value Types (modeled after brush-core)
// ============================================================================

/// A shell value - can be a string, indexed array, or associative array.
#[derive(Debug, Clone, PartialEq)]
#[allow(dead_code)] // Some variants reserved for array expansion feature
pub enum ShellValue {
    /// A simple string value.
    String(String),
    /// An indexed array (sparse, 0-indexed).
    IndexedArray(BTreeMap<u64, String>),
    /// An associative array (string keys).
    AssociativeArray(BTreeMap<String, String>),
    /// A value that has been declared but not yet set.
    Unset(ShellValueUnsetType),
}

/// The type of an unset shell value.
#[derive(Debug, Clone, PartialEq)]
#[allow(dead_code)] // Reserved for array types
pub enum ShellValueUnsetType {
    /// Untyped/scalar.
    Untyped,
    /// Declared as indexed array.
    IndexedArray,
    /// Declared as associative array.
    AssociativeArray,
}

impl Default for ShellValue {
    fn default() -> Self {
        ShellValue::String(String::new())
    }
}

#[allow(dead_code)] // Public API methods for shell value manipulation
impl ShellValue {
    /// Check if this is an array type.
    pub fn is_array(&self) -> bool {
        matches!(
            self,
            ShellValue::IndexedArray(_)
                | ShellValue::AssociativeArray(_)
                | ShellValue::Unset(ShellValueUnsetType::IndexedArray)
                | ShellValue::Unset(ShellValueUnsetType::AssociativeArray)
        )
    }

    /// Check if the value is set (not Unset variant).
    pub fn is_set(&self) -> bool {
        !matches!(self, ShellValue::Unset(_))
    }

    /// Get the value as a string (for display or scalar context).
    pub fn as_string(&self) -> String {
        match self {
            ShellValue::String(s) => s.clone(),
            ShellValue::IndexedArray(arr) => {
                // In scalar context, return first element or empty
                arr.values().next().cloned().unwrap_or_default()
            }
            ShellValue::AssociativeArray(arr) => {
                // In scalar context, return first element or empty
                arr.values().next().cloned().unwrap_or_default()
            }
            ShellValue::Unset(_) => String::new(),
        }
    }

    /// Get all values (for ${arr[@]} expansion).
    pub fn all_values(&self) -> Vec<String> {
        match self {
            ShellValue::String(s) => vec![s.clone()],
            ShellValue::IndexedArray(arr) => arr.values().cloned().collect(),
            ShellValue::AssociativeArray(arr) => arr.values().cloned().collect(),
            ShellValue::Unset(_) => vec![],
        }
    }

    /// Get all keys (for ${!arr[@]} expansion).
    pub fn all_keys(&self) -> Vec<String> {
        match self {
            ShellValue::String(_) => vec!["0".to_string()],
            ShellValue::IndexedArray(arr) => arr.keys().map(|k| k.to_string()).collect(),
            ShellValue::AssociativeArray(arr) => arr.keys().cloned().collect(),
            ShellValue::Unset(_) => vec![],
        }
    }

    /// Get element count (for ${#arr[@]}).
    pub fn element_count(&self) -> usize {
        match self {
            ShellValue::String(s) if s.is_empty() => 0,
            ShellValue::String(_) => 1,
            ShellValue::IndexedArray(arr) => arr.len(),
            ShellValue::AssociativeArray(arr) => arr.len(),
            ShellValue::Unset(_) => 0,
        }
    }

    /// Get element at index.
    pub fn get_at(&self, index: &str) -> Option<String> {
        match self {
            ShellValue::String(s) => {
                if index == "0" || index == "@" || index == "*" {
                    Some(s.clone())
                } else {
                    None
                }
            }
            ShellValue::IndexedArray(arr) => {
                if index == "@" || index == "*" {
                    Some(arr.values().cloned().collect::<Vec<_>>().join(" "))
                } else {
                    index.parse::<u64>().ok().and_then(|i| arr.get(&i).cloned())
                }
            }
            ShellValue::AssociativeArray(arr) => {
                if index == "@" || index == "*" {
                    Some(arr.values().cloned().collect::<Vec<_>>().join(" "))
                } else {
                    arr.get(index).cloned()
                }
            }
            ShellValue::Unset(_) => None,
        }
    }

    /// Set element at index.
    pub fn set_at(&mut self, index: &str, value: String) -> Result<(), String> {
        match self {
            ShellValue::String(_) => {
                // Convert to indexed array
                let mut arr = BTreeMap::new();
                let idx = index.parse::<u64>().unwrap_or(0);
                arr.insert(idx, value);
                *self = ShellValue::IndexedArray(arr);
                Ok(())
            }
            ShellValue::IndexedArray(arr) => {
                let idx = index
                    .parse::<u64>()
                    .map_err(|_| format!("invalid array index: {}", index))?;
                arr.insert(idx, value);
                Ok(())
            }
            ShellValue::AssociativeArray(arr) => {
                arr.insert(index.to_string(), value);
                Ok(())
            }
            ShellValue::Unset(ty) => {
                // Initialize based on declared type
                match ty {
                    ShellValueUnsetType::AssociativeArray => {
                        let mut arr = BTreeMap::new();
                        arr.insert(index.to_string(), value);
                        *self = ShellValue::AssociativeArray(arr);
                    }
                    _ => {
                        let mut arr = BTreeMap::new();
                        let idx = index.parse::<u64>().unwrap_or(0);
                        arr.insert(idx, value);
                        *self = ShellValue::IndexedArray(arr);
                    }
                }
                Ok(())
            }
        }
    }

    /// Create an indexed array from a list of strings.
    pub fn indexed_array_from_vec(values: Vec<String>) -> Self {
        let mut arr = BTreeMap::new();
        for (i, v) in values.into_iter().enumerate() {
            arr.insert(i as u64, v);
        }
        ShellValue::IndexedArray(arr)
    }
}

// ============================================================================
// Shell Variable (with attributes)
// ============================================================================

/// Transform to apply when variable is updated (brush-parser compatible).
#[derive(Debug, Clone, Copy, PartialEq, Default)]
#[allow(dead_code)] // Reserved for declare -l/-u implementation
pub enum ShellVariableTransform {
    #[default]
    None,
    /// Convert to lowercase on assignment (declare -l).
    Lowercase,
    /// Convert to uppercase on assignment (declare -u).
    Uppercase,
}

/// A shell variable with value and attributes (brush-parser compatible).
#[derive(Debug, Clone)]
pub struct ShellVariable {
    /// The value.
    pub value: ShellValue,
    /// Whether the variable is exported.
    pub exported: bool,
    /// Whether the variable is readonly.
    pub readonly: bool,
    /// Whether to treat as integer.
    pub integer: bool,
    /// Transform to apply on update.
    pub transform: ShellVariableTransform,
    /// Whether this is a nameref (declare -n).
    pub nameref: bool,
}

impl Default for ShellVariable {
    fn default() -> Self {
        Self {
            value: ShellValue::default(),
            exported: false,
            readonly: false,
            integer: false,
            transform: ShellVariableTransform::None,
            nameref: false,
        }
    }
}

impl ShellVariable {
    /// Create a new variable with a string value.
    pub fn new(value: impl Into<String>) -> Self {
        Self {
            value: ShellValue::String(value.into()),
            ..Default::default()
        }
    }

    /// Create an indexed array variable.
    pub fn indexed_array(values: Vec<String>) -> Self {
        Self {
            value: ShellValue::indexed_array_from_vec(values),
            ..Default::default()
        }
    }

    /// Apply transforms and set the value.
    pub fn set_value(&mut self, mut value: String) -> Result<(), String> {
        if self.readonly {
            return Err("readonly variable".to_string());
        }

        // Apply transforms
        match self.transform {
            ShellVariableTransform::Lowercase => value = value.to_lowercase(),
            ShellVariableTransform::Uppercase => value = value.to_uppercase(),
            ShellVariableTransform::None => {}
        }

        // If integer, evaluate as arithmetic
        if self.integer {
            let int_val: i64 = value.parse().unwrap_or(0);
            value = int_val.to_string();
        }

        self.value = ShellValue::String(value);
        Ok(())
    }

    /// Get the value as a string.
    pub fn as_string(&self) -> String {
        self.value.as_string()
    }
}

// ============================================================================
// Shell Options
// ============================================================================

/// Shell options (set -e, -u, -x, etc.)
#[derive(Debug, Clone, Default)]
pub struct ShellOptions {
    // Single-character options
    /// -a: Export variables on modification
    pub allexport: bool,
    /// -e: Exit immediately if a command exits with non-zero status
    pub errexit: bool,
    /// -f: Disable filename globbing
    pub noglob: bool,
    /// -h: Remember command locations
    pub hashall: bool,
    /// -n: Read commands but do not execute
    pub noexec: bool,
    /// -u: Treat unset variables as an error
    pub nounset: bool,
    /// -v: Print shell input lines
    pub verbose: bool,
    /// -x: Print commands before execution
    pub xtrace: bool,
    /// -B: Perform brace expansion
    pub braceexpand: bool,
    /// -E: Shell functions inherit ERR trap
    pub errtrace: bool,

    // Long options (set -o)
    /// pipefail: Return value of pipeline is last non-zero
    pub pipefail: bool,
    /// posix: POSIX mode
    pub posix: bool,

    // shopt options
    /// extglob: Extended globbing
    pub extglob: bool,
    /// nullglob: Expand globs with no matches to empty
    pub nullglob: bool,
    /// dotglob: Include dotfiles in glob expansion
    pub dotglob: bool,
    /// globstar: Enable ** recursive globbing
    pub globstar: bool,
    /// nocasematch: Case-insensitive pattern matching
    pub nocasematch: bool,
    /// nocaseglob: Case-insensitive globbing
    pub nocaseglob: bool,
    /// expand_aliases: Expand aliases
    pub expand_aliases: bool,
}

impl ShellOptions {
    /// Create default options (like non-interactive bash).
    pub fn new() -> Self {
        Self {
            braceexpand: true,  // -B is on by default
            hashall: true,      // -h is on by default
            expand_aliases: false, // Off in non-interactive
            ..Default::default()
        }
    }

    /// Parse a set option string (e.g., "-e", "-x", "+e")
    #[allow(dead_code)] // Reserved for `set` builtin enhancements
    pub fn parse_option(&mut self, opt: &str) -> Result<(), String> {
        let (enable, flag) = if let Some(f) = opt.strip_prefix('-') {
            (true, f)
        } else if let Some(f) = opt.strip_prefix('+') {
            (false, f)
        } else {
            return Err(format!("Invalid option: {}", opt));
        };

        match flag {
            "a" => self.allexport = enable,
            "e" => self.errexit = enable,
            "f" => self.noglob = enable,
            "h" => self.hashall = enable,
            "n" => self.noexec = enable,
            "u" => self.nounset = enable,
            "v" => self.verbose = enable,
            "x" => self.xtrace = enable,
            "B" => self.braceexpand = enable,
            "E" => self.errtrace = enable,
            "o" => {} // Handled separately for long options
            _ => return Err(format!("Unknown option: {}", opt)),
        }
        Ok(())
    }

    /// Parse -o option (e.g., "pipefail")
    pub fn parse_long_option(&mut self, opt: &str, enable: bool) -> Result<(), String> {
        match opt {
            "allexport" => self.allexport = enable,
            "errexit" => self.errexit = enable,
            "noglob" => self.noglob = enable,
            "hashall" => self.hashall = enable,
            "noexec" => self.noexec = enable,
            "nounset" => self.nounset = enable,
            "verbose" => self.verbose = enable,
            "xtrace" => self.xtrace = enable,
            "braceexpand" => self.braceexpand = enable,
            "errtrace" => self.errtrace = enable,
            "pipefail" => self.pipefail = enable,
            "posix" => self.posix = enable,
            _ => return Err(format!("Unknown option: {}", opt)),
        }
        Ok(())
    }

    /// Parse shopt option
    pub fn parse_shopt(&mut self, opt: &str, enable: bool) -> Result<(), String> {
        match opt {
            "extglob" => self.extglob = enable,
            "nullglob" => self.nullglob = enable,
            "dotglob" => self.dotglob = enable,
            "globstar" => self.globstar = enable,
            "nocasematch" => self.nocasematch = enable,
            "nocaseglob" => self.nocaseglob = enable,
            "expand_aliases" => self.expand_aliases = enable,
            _ => return Err(format!("Unknown shopt option: {}", opt)),
        }
        Ok(())
    }
}

// ============================================================================
// Shell Environment
// ============================================================================

/// Shell execution environment.
#[derive(Debug, Clone)]
pub struct ShellEnv {
    /// Current working directory.
    pub cwd: PathBuf,
    /// Previous working directory (for cd -).
    pub prev_cwd: PathBuf,
    /// Directory stack (for pushd/popd).
    pub dir_stack: Vec<PathBuf>,

    /// All shell variables (with full attributes).
    variables: HashMap<String, ShellVariable>,
    /// Local variable scope stack (for function calls).
    #[allow(dead_code)] // Used indirectly via local_scopes methods, value never read directly
    local_scopes: Vec<HashSet<String>>,

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
    
    // Loop control
    /// Current loop nesting depth (0 = not in loop)
    pub loop_depth: usize,
    /// Break level requested (0 = no break, 1 = break innermost, etc.)
    pub break_level: usize,
    /// Continue level requested (0 = no continue, 1 = continue innermost, etc.)
    pub continue_level: usize,
    
    /// Command aliases (name -> expansion)
    pub aliases: HashMap<String, String>,

    // Legacy compatibility fields (to avoid breaking existing code)
    /// Alias for exported variables lookup
    pub env_vars: HashMap<String, String>,
    /// Legacy local_vars map for compatibility
    pub local_vars: HashMap<String, String>,
    /// Legacy readonly set
    pub readonly: HashSet<String>,
}

impl ShellEnv {
    /// Create a new shell environment with default values.
    pub fn new() -> Self {
        Self {
            // Use "/" for root directory - consistent with absolute paths in the VFS
            cwd: PathBuf::from("/"),
            prev_cwd: PathBuf::from("/"),
            dir_stack: Vec::new(),
            variables: HashMap::new(),
            local_scopes: Vec::new(),
            positional_params: Vec::new(),
            last_exit_code: 0,
            session_id: SESSION_COUNTER.fetch_add(1, Ordering::SeqCst),
            options: ShellOptions::new(),
            script_name: "shell".to_string(),
            subshell_depth: 0,
            traps: HashMap::new(),
            functions: HashMap::new(),
            in_function: false,
            // Loop control
            loop_depth: 0,
            break_level: 0,
            continue_level: 0,
            // Aliases
            aliases: HashMap::new(),
            // Legacy compatibility
            env_vars: HashMap::new(),
            local_vars: HashMap::new(),
            readonly: HashSet::new(),
        }
    }

    // ========================================================================
    // Variable Access (Enhanced API)
    // ========================================================================

    /// Get a variable by name (full ShellVariable).
    /// If the variable is a nameref, follows the reference to the target.
    pub fn get_variable(&self, name: &str) -> Option<&ShellVariable> {
        self.resolve_nameref(name, 0)
    }
    
    /// Resolve nameref chain (with recursion limit to prevent infinite loops).
    fn resolve_nameref(&self, name: &str, depth: usize) -> Option<&ShellVariable> {
        if depth > 10 {
            return None; // Prevent infinite nameref loops
        }
        
        let var = self.variables.get(name)?;
        
        if var.nameref {
            // The value contains the name of the target variable
            let target_name = var.value.as_string();
            if !target_name.is_empty() {
                return self.resolve_nameref(&target_name, depth + 1);
            }
        }
        
        Some(var)
    }

    /// Get a variable mutably.
    #[allow(dead_code)] // Public API for mutable variable access
    pub fn get_variable_mut(&mut self, name: &str) -> Option<&mut ShellVariable> {
        self.variables.get_mut(name)
    }

    /// Get all variable names matching a prefix.
    pub fn variable_names_with_prefix(&self, prefix: &str) -> Vec<String> {
        self.variables.keys()
            .filter(|k| k.starts_with(prefix))
            .cloned()
            .collect()
    }

    /// Set a variable with full control.
    pub fn set_variable(&mut self, name: &str, var: ShellVariable) -> Result<(), String> {
        // Check readonly
        if let Some(existing) = self.variables.get(name) {
            if existing.readonly {
                return Err(format!("{}: readonly variable", name));
            }
        }

        // Track in local scope if in function
        if self.in_function {
            if let Some(scope) = self.local_scopes.last_mut() {
                scope.insert(name.to_string());
            }
        }

        // Update legacy compatibility maps
        if var.exported {
            self.env_vars
                .insert(name.to_string(), var.value.as_string());
        }
        if var.readonly {
            self.readonly.insert(name.to_string());
        }

        self.variables.insert(name.to_string(), var);
        Ok(())
    }

    /// Declare a variable with specific type (for declare builtin).
    pub fn declare_variable(
        &mut self,
        name: &str,
        indexed_array: bool,
        assoc_array: bool,
        exported: bool,
        readonly: bool,
        integer: bool,
        lowercase: bool,
        uppercase: bool,
        nameref: bool,
    ) -> Result<(), String> {
        let mut var = self
            .variables
            .get(name)
            .cloned()
            .unwrap_or_else(ShellVariable::default);

        // Check readonly before modifying
        if var.readonly && !readonly {
            return Err(format!("{}: readonly variable", name));
        }

        // Set type if not already set
        if indexed_array && !var.value.is_array() {
            var.value = ShellValue::Unset(ShellValueUnsetType::IndexedArray);
        }
        if assoc_array && !matches!(var.value, ShellValue::AssociativeArray(_)) {
            var.value = ShellValue::Unset(ShellValueUnsetType::AssociativeArray);
        }

        // Set attributes
        if exported {
            var.exported = true;
        }
        if readonly {
            var.readonly = true;
        }
        if integer {
            var.integer = true;
        }
        if lowercase {
            var.transform = ShellVariableTransform::Lowercase;
        }
        if uppercase {
            var.transform = ShellVariableTransform::Uppercase;
        }
        if nameref {
            var.nameref = true;
        }

        self.variables.insert(name.to_string(), var);
        Ok(())
    }

    // ========================================================================
    // Simple Variable Access (Backward Compatible API)
    // ========================================================================

    /// Get a variable value as string (legacy API).
    pub fn get_var(&self, name: &str) -> Option<&String> {
        // First check local_vars for legacy compatibility
        if let Some(v) = self.local_vars.get(name) {
            return Some(v);
        }

        // Then check new variable system
        self.variables.get(name).map(|v| {
            // This is a bit awkward - we store String in ShellValue but need &String
            // For now, check env_vars as fallback for exported vars
            match &v.value {
                ShellValue::String(s) => {
                    // Return from env_vars if exported (it's always in sync)
                    if v.exported {
                        self.env_vars.get(name).unwrap_or(s)
                    } else {
                        // This won't work directly - need to rethink
                        // For now, always check env_vars
                        self.env_vars.get(name).or(Some(s)).unwrap()
                    }
                }
                _ => {
                    // For arrays, fall back to env_vars
                    self.env_vars.get(name).expect("array variable")
                }
            }
        }).or_else(|| self.env_vars.get(name))
    }

    /// Get a variable value as String (owned, preferred method).
    pub fn get_var_value(&self, name: &str) -> Option<String> {
        // Check local_vars first
        if let Some(v) = self.local_vars.get(name) {
            return Some(v.clone());
        }

        // Then new variable system
        if let Some(var) = self.variables.get(name) {
            return Some(var.value.as_string());
        }

        // Fall back to env_vars
        self.env_vars.get(name).cloned()
    }

    /// Set a variable value (legacy API).
    pub fn set_var(&mut self, name: &str, value: &str) -> Result<(), String> {
        // Check readonly
        if self.readonly.contains(name) {
            return Err(format!("{}: readonly variable", name));
        }

        // Check in new system too
        if let Some(existing) = self.variables.get(name) {
            if existing.readonly {
                return Err(format!("{}: readonly variable", name));
            }
        }

        // Store in new system
        let mut var = self
            .variables
            .get(name)
            .cloned()
            .unwrap_or_else(ShellVariable::default);
        var.set_value(value.to_string())?;

        // Also store in legacy map for compatibility
        if var.exported {
            self.env_vars.insert(name.to_string(), value.to_string());
        }

        self.variables.insert(name.to_string(), var);
        Ok(())
    }

    /// Export a variable to the environment.
    pub fn export_var(&mut self, name: &str, value: Option<&str>) -> Result<(), String> {
        if self.readonly.contains(name) {
            return Err(format!("{}: readonly variable", name));
        }

        let val = value
            .map(|v| v.to_string())
            .or_else(|| self.get_var_value(name))
            .unwrap_or_default();

        // Update in new system
        let mut var = self
            .variables
            .get(name)
            .cloned()
            .unwrap_or_else(ShellVariable::default);
        var.exported = true;
        if value.is_some() {
            var.set_value(val.clone())?;
        }
        self.variables.insert(name.to_string(), var);

        // Always update env_vars (legacy)
        self.env_vars.insert(name.to_string(), val);
        Ok(())
    }

    /// Unset a variable.
    pub fn unset_var(&mut self, name: &str) -> Result<(), String> {
        if self.readonly.contains(name) {
            return Err(format!("{}: readonly variable", name));
        }
        if let Some(var) = self.variables.get(name) {
            if var.readonly {
                return Err(format!("{}: readonly variable", name));
            }
        }

        self.variables.remove(name);
        self.env_vars.remove(name);
        self.local_vars.remove(name);
        Ok(())
    }

    /// Mark a variable as readonly.
    pub fn set_readonly(&mut self, name: &str, value: Option<&str>) -> Result<(), String> {
        if let Some(v) = value {
            self.set_var(name, v)?;
        }

        // Mark in new system
        if let Some(var) = self.variables.get_mut(name) {
            var.readonly = true;
        } else {
            let mut var = ShellVariable::new(value.unwrap_or(""));
            var.readonly = true;
            self.variables.insert(name.to_string(), var);
        }

        self.readonly.insert(name.to_string());
        Ok(())
    }

    // ========================================================================
    // Array Operations
    // ========================================================================

    /// Get array element: ${arr[index]}
    pub fn get_array_element(&self, name: &str, index: &str) -> Option<String> {
        self.variables
            .get(name)
            .and_then(|var| var.value.get_at(index))
    }

    /// Set array element: arr[index]=value
    pub fn set_array_element(&mut self, name: &str, index: &str, value: &str) -> Result<(), String> {
        let var = self
            .variables
            .entry(name.to_string())
            .or_insert_with(|| ShellVariable {
                value: ShellValue::Unset(ShellValueUnsetType::IndexedArray),
                ..Default::default()
            });

        if var.readonly {
            return Err(format!("{}: readonly variable", name));
        }

        var.value.set_at(index, value.to_string())
    }

    /// Get all array values: ${arr[@]}
    pub fn get_array_values(&self, name: &str) -> Vec<String> {
        self.variables
            .get(name)
            .map(|var| var.value.all_values())
            .unwrap_or_default()
    }

    /// Get all array keys: ${!arr[@]}
    pub fn get_array_keys(&self, name: &str) -> Vec<String> {
        self.variables
            .get(name)
            .map(|var| var.value.all_keys())
            .unwrap_or_default()
    }

    /// Get array length: ${#arr[@]}
    pub fn get_array_length(&self, name: &str) -> usize {
        self.variables
            .get(name)
            .map(|var| var.value.element_count())
            .unwrap_or(0)
    }

    /// Set array from values: arr=(val1 val2 val3)
    pub fn set_indexed_array(&mut self, name: &str, values: Vec<String>) -> Result<(), String> {
        if self.readonly.contains(name) {
            return Err(format!("{}: readonly variable", name));
        }

        let var = ShellVariable::indexed_array(values);
        self.variables.insert(name.to_string(), var);
        Ok(())
    }

    // ========================================================================
    // Positional Parameters
    // ========================================================================

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

    // ========================================================================
    // Scope Management
    // ========================================================================

    /// Enter a function scope (push local variable frame).
    pub fn enter_function_scope(&mut self) {
        self.in_function = true;
        self.local_scopes.push(HashSet::new());
    }

    /// Exit a function scope (pop local variable frame).
    pub fn exit_function_scope(&mut self) {
        if let Some(scope) = self.local_scopes.pop() {
            // Remove local variables from this scope
            for name in scope {
                self.local_vars.remove(&name);
            }
        }
        self.in_function = !self.local_scopes.is_empty();
    }

    /// Set a local variable (function-scoped).
    pub fn set_local_var(&mut self, name: &str, value: &str) -> Result<(), String> {
        if !self.in_function {
            return Err("local: can only be used in a function".to_string());
        }

        // Track in current scope
        if let Some(scope) = self.local_scopes.last_mut() {
            scope.insert(name.to_string());
        }

        self.local_vars.insert(name.to_string(), value.to_string());
        Ok(())
    }

    /// Create a subshell environment (copy with incremented depth)
    pub fn subshell(&self) -> Self {
        let mut sub = self.clone();
        sub.subshell_depth += 1;
        sub
    }

    // ========================================================================
    // Trap Support
    // ========================================================================

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

    // ========================================================================
    // Variable Listing
    // ========================================================================

    /// List all exported variables.
    pub fn list_exports(&self) -> impl Iterator<Item = (&String, &String)> {
        self.env_vars.iter()
    }

    /// List all variables (for `set` with no args).
    pub fn list_all_variables(&self) -> impl Iterator<Item = (&String, &ShellVariable)> {
        self.variables.iter()
    }
}

impl Default for ShellEnv {
    fn default() -> Self {
        Self::new()
    }
}

// ============================================================================
// Shell Result
// ============================================================================

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

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_shell_env_default() {
        let env = ShellEnv::new();
        assert_eq!(env.cwd, PathBuf::from("/"));
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
        assert_eq!(env.get_var_value("FOO"), Some("bar".to_string()));
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
        let mut opts = ShellOptions::new();
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

    #[test]
    fn test_shell_value_indexed_array() {
        let arr = ShellValue::indexed_array_from_vec(vec!["a".into(), "b".into(), "c".into()]);
        assert!(arr.is_array());
        assert_eq!(arr.get_at("0"), Some("a".to_string()));
        assert_eq!(arr.get_at("1"), Some("b".to_string()));
        assert_eq!(arr.get_at("2"), Some("c".to_string()));
        assert_eq!(arr.element_count(), 3);
    }

    #[test]
    fn test_shell_value_all_values() {
        let arr = ShellValue::indexed_array_from_vec(vec!["a".into(), "b".into()]);
        let vals = arr.all_values();
        assert_eq!(vals, vec!["a", "b"]);
    }

    #[test]
    fn test_array_element_operations() {
        let mut env = ShellEnv::new();
        env.set_indexed_array("arr", vec!["one".into(), "two".into(), "three".into()])
            .unwrap();

        assert_eq!(
            env.get_array_element("arr", "0"),
            Some("one".to_string())
        );
        assert_eq!(
            env.get_array_element("arr", "1"),
            Some("two".to_string())
        );
        assert_eq!(env.get_array_length("arr"), 3);

        // Modify element
        env.set_array_element("arr", "1", "TWO").unwrap();
        assert_eq!(
            env.get_array_element("arr", "1"),
            Some("TWO".to_string())
        );

        // Get all values
        let vals = env.get_array_values("arr");
        assert_eq!(vals, vec!["one", "TWO", "three"]);
    }

    #[test]
    fn test_declare_variable() {
        let mut env = ShellEnv::new();

        // Declare as indexed array
        env.declare_variable("myarr", true, false, false, false, false, false, false, false)
            .unwrap();
        assert!(env
            .get_variable("myarr")
            .map(|v| v.value.is_array())
            .unwrap_or(false));

        // Declare with export
        env.declare_variable("myexport", false, false, true, false, false, false, false, false)
            .unwrap();
        assert!(env
            .get_variable("myexport")
            .map(|v| v.exported)
            .unwrap_or(false));
    }

    #[test]
    fn test_shopt_options() {
        let mut opts = ShellOptions::new();
        opts.parse_shopt("extglob", true).unwrap();
        assert!(opts.extglob);
        opts.parse_shopt("nullglob", true).unwrap();
        assert!(opts.nullglob);
    }
}
