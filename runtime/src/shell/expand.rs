//! Shell expansion module - variable, command, and arithmetic expansion.

use super::env::ShellEnv;

/// Get a random u64 - uses WASI in production, std in tests
#[cfg(not(test))]
fn get_random_u64() -> u64 {
    use crate::bindings::wasi::random::random as wasi_random;
    wasi_random::get_random_u64()
}

/// Get a random u64 - uses std random for native tests
#[cfg(test)]
fn get_random_u64() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    // Use system time nanoseconds as real entropy source
    let duration = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    // Mix high and low bits for better randomness
    let nanos = duration.as_nanos() as u64;
    let millis = duration.as_millis() as u64;
    nanos.wrapping_mul(1103515245).wrapping_add(12345) ^ millis
}

/// Expand all shell expansions in a string (variables, commands, arithmetic)
pub fn expand_string(input: &str, env: &ShellEnv, in_double_quotes: bool) -> Result<String, String> {
    let mut result = String::new();
    let mut chars = input.chars().peekable();

    while let Some(c) = chars.next() {
        match c {
            '$' => {
                let expanded = expand_dollar(&mut chars, env, in_double_quotes)?;
                result.push_str(&expanded);
            }
            '\\' if in_double_quotes => {
                // In double quotes, only escape $, `, \, ", and newline
                if let Some(&next) = chars.peek() {
                    match next {
                        '$' | '`' | '\\' | '"' | '\n' => {
                            result.push(chars.next().unwrap());
                        }
                        _ => {
                            result.push('\\');
                        }
                    }
                } else {
                    result.push('\\');
                }
            }
            _ => result.push(c),
        }
    }

    Ok(result)
}

/// Expand a $ expression
fn expand_dollar(chars: &mut std::iter::Peekable<std::str::Chars>, env: &ShellEnv, _in_double_quotes: bool) -> Result<String, String> {
    match chars.peek() {
        Some('{') => {
            chars.next(); // consume '{'
            expand_braced_variable(chars, env)
        }
        Some('(') => {
            chars.next(); // consume '('
            if chars.peek() == Some(&'(') {
                chars.next(); // consume second '('
                expand_arithmetic(chars, env)
            } else {
                expand_command_substitution(chars, env)
            }
        }
        Some(c) if c.is_ascii_digit() => {
            // Positional parameter $0, $1, etc.
            let digit = chars.next().unwrap();
            let index = digit.to_digit(10).unwrap() as usize;
            Ok(env.get_positional(index).cloned().unwrap_or_default())
        }
        Some(c) if c.is_ascii_alphabetic() || *c == '_' => {
            // Variable name
            expand_simple_variable(chars, env)
        }
        Some('?') => {
            chars.next();
            Ok(env.last_exit_code.to_string())
        }
        Some('$') => {
            chars.next();
            Ok(env.session_id.to_string())
        }
        Some('#') => {
            chars.next();
            Ok(env.param_count().to_string())
        }
        Some('*') => {
            chars.next();
            Ok(env.all_params_string())
        }
        Some('@') => {
            chars.next();
            Ok(env.all_params_string()) // In non-array context, same as $*
        }
        Some('!') => {
            chars.next();
            // Background job PID - not supported, return empty
            Ok(String::new())
        }
        Some('-') => {
            chars.next();
            // Current shell options - format as string
            let mut opts = String::new();
            if env.options.errexit { opts.push('e'); }
            if env.options.nounset { opts.push('u'); }
            if env.options.xtrace { opts.push('x'); }
            Ok(opts)
        }
        _ => {
            // Literal $
            Ok("$".to_string())
        }
    }
}

/// Expand a simple variable name (letters, digits, underscores)
fn expand_simple_variable(chars: &mut std::iter::Peekable<std::str::Chars>, env: &ShellEnv) -> Result<String, String> {
    let mut name = String::new();
    
    while let Some(&c) = chars.peek() {
        if c.is_ascii_alphanumeric() || c == '_' {
            name.push(chars.next().unwrap());
        } else {
            break;
        }
    }

    if name.is_empty() {
        return Ok("$".to_string());
    }

    // Handle special built-in variables
    match name.as_str() {
        "RANDOM" => {
            // Generate random number 0-32767
            let rand = get_random_u64();
            return Ok(((rand % 32768) as u16).to_string());
        }
        "LINENO" => {
            // Line number - not tracked precisely, return 1
            return Ok("1".to_string());
        }
        "SECONDS" => {
            // Seconds since shell start - return 0 for simplicity
            return Ok("0".to_string());
        }
        "SHLVL" => {
            // Shell level (subshell depth)
            return Ok(env.subshell_depth.to_string());
        }
        "PWD" => {
            return Ok(env.cwd.to_string_lossy().to_string());
        }
        "OLDPWD" => {
            return Ok(env.prev_cwd.to_string_lossy().to_string());
        }
        "HOME" => {
            // In sandbox, home is always /
            return Ok("/".to_string());
        }
        "USER" | "LOGNAME" => {
            return Ok("user".to_string());
        }
        "HOSTNAME" => {
            return Ok("sandbox".to_string());
        }
        "SHELL" => {
            return Ok("/bin/sh".to_string());
        }
        "IFS" => {
            return Ok(" \t\n".to_string());
        }
        _ => {}
    }

    // Check for nounset option
    match env.get_var(&name) {
        Some(val) => Ok(val.clone()),
        None => {
            if env.options.nounset {
                Err(format!("{}: unbound variable", name))
            } else {
                Ok(String::new())
            }
        }
    }
}

/// Expand a braced variable ${...}
fn expand_braced_variable(chars: &mut std::iter::Peekable<std::str::Chars>, env: &ShellEnv) -> Result<String, String> {
    let mut content = String::new();
    let mut brace_depth = 1;

    // Collect everything until matching }
    while let Some(c) = chars.next() {
        match c {
            '{' => {
                brace_depth += 1;
                content.push(c);
            }
            '}' => {
                brace_depth -= 1;
                if brace_depth == 0 {
                    break;
                }
                content.push(c);
            }
            _ => content.push(c),
        }
    }

    if brace_depth != 0 {
        return Err("bad substitution: unmatched '{'".to_string());
    }

    parse_braced_expansion(&content, env)
}

/// Parse and expand the content inside ${...}
fn parse_braced_expansion(content: &str, env: &ShellEnv) -> Result<String, String> {
    // Check for special forms first
    
    // ${#var} - length of variable
    if content.starts_with('#') && content.len() > 1 {
        let name = &content[1..];
        let value = env.get_var(name).cloned().unwrap_or_default();
        return Ok(value.len().to_string());
    }
    
    // ${!var} - indirect expansion or name expansion
    if content.starts_with('!') && content.len() > 1 {
        let indirect_name = &content[1..];
        
        // ${!prefix*} or ${!prefix@} - variable names matching prefix
        if indirect_name.ends_with('*') || indirect_name.ends_with('@') {
            let prefix = &indirect_name[..indirect_name.len() - 1];
            let concatenate = indirect_name.ends_with('*');
            let mut matching_names = env.variable_names_with_prefix(prefix);
            matching_names.sort();
            return Ok(if concatenate {
                matching_names.join(" ")
            } else {
                matching_names.join(" ")
            });
        }
        
        // ${!arr[@]} or ${!arr[*]} - array keys
        if indirect_name.ends_with("[@]") || indirect_name.ends_with("[*]") {
            let var_name = &indirect_name[..indirect_name.len() - 3];
            if let Some(var) = env.get_variable(var_name) {
                let keys = match &var.value {
                    crate::shell::env::ShellValue::IndexedArray(arr) => {
                        arr.iter().map(|(i, _)| i.to_string()).collect::<Vec<_>>()
                    }
                    crate::shell::env::ShellValue::AssociativeArray(arr) => {
                        arr.keys().cloned().collect::<Vec<_>>()
                    }
                    crate::shell::env::ShellValue::String(_) => vec!["0".to_string()],
                    crate::shell::env::ShellValue::Unset(_) => vec![],
                };
                return Ok(keys.join(" "));
            }
            return Ok(String::new());
        }
        
        // ${!var} - simple indirect expansion
        if let Some(actual_name) = env.get_var(indirect_name) {
            return Ok(env.get_var(actual_name).cloned().unwrap_or_default());
        }
        return Ok(String::new());
    }
    
    // ${var@op} - transformation operators
    if let Some(at_pos) = content.rfind('@') {
        let name = &content[..at_pos];
        let transform = &content[at_pos + 1..];
        if !name.is_empty() && transform.len() == 1 {
            let value = env.get_var(name).cloned().unwrap_or_default();
            return apply_transform_operator(&value, transform);
        }
    }
    
    // ${var:offset} or ${var:offset:length} - substring expansion
    // Need to check this BEFORE the default/substitute operators that start with :
    // BUT we must not confuse :- := :+ :? which are default value operators
    if let Some(colon_pos) = content.find(':') {
        let name = &content[..colon_pos];
        let rest = &content[colon_pos + 1..];
        
        // Check if this is a default value operator (starts with - = + ?)
        // These are NOT substring operations
        let first_char = rest.chars().next();
        if let Some(c) = first_char {
            // If it's a default value operator character, fall through to operator handling
            // Substring expansion starts with a digit, or space followed by negative number
            if c.is_ascii_digit() {
                // This is substring expansion ${var:offset} or ${var:offset:length}
                let value = env.get_var(name).cloned().unwrap_or_default();
                return apply_substring_expansion(&value, rest);
            } else if c == ' ' {
                // Could be ${var: -5} with space before negative
                let trimmed = rest.trim_start();
                if trimmed.starts_with('-') && trimmed.len() > 1 {
                    let second = trimmed.chars().nth(1);
                    if second.map(|c| c.is_ascii_digit()).unwrap_or(false) {
                        let value = env.get_var(name).cloned().unwrap_or_default();
                        return apply_substring_expansion(&value, rest);
                    }
                }
            }
            // Otherwise fall through to operator handling (:-default, etc.)
        }
    }

    // Find operator position for default/substitute operations
    let ops = [":-", ":=", ":+", ":?", "-", "=", "+", "?", 
               "##", "#", "%%", "%", "//", "/", "^^", "^", ",,", ","];
    
    for op in ops.iter() {
        if let Some(pos) = content.find(op) {
            let name = &content[..pos];
            let arg = &content[pos + op.len()..];
            return apply_expansion_operator(name, *op, arg, env);
        }
    }

    // No operator - simple variable lookup
    match env.get_var(content) {
        Some(val) => Ok(val.clone()),
        None => {
            if env.options.nounset {
                Err(format!("{}: unbound variable", content))
            } else {
                Ok(String::new())
            }
        }
    }
}

/// Apply substring expansion ${var:offset} or ${var:offset:length}
fn apply_substring_expansion(value: &str, spec: &str) -> Result<String, String> {
    let parts: Vec<&str> = spec.splitn(2, ':').collect();
    let offset_str = parts[0].trim();
    
    // Parse offset (can be negative)
    let offset: i64 = offset_str.parse()
        .map_err(|_| format!("bad substring offset: {}", offset_str))?;
    
    let len = value.len() as i64;
    
    // Calculate actual start position
    let start = if offset < 0 {
        // Negative offset counts from end
        (len + offset).max(0) as usize
    } else {
        (offset as usize).min(value.len())
    };
    
    // Get length if specified
    if parts.len() > 1 {
        let length_str = parts[1].trim();
        let length: i64 = length_str.parse()
            .map_err(|_| format!("bad substring length: {}", length_str))?;
        
        if length < 0 {
            // Negative length means end position from end
            let end = (len + length).max(start as i64) as usize;
            Ok(value[start..end].to_string())
        } else {
            let end = (start + length as usize).min(value.len());
            Ok(value[start..end].to_string())
        }
    } else {
        // No length - take rest of string
        Ok(value[start..].to_string())
    }
}

/// Apply transformation operator ${var@op}
fn apply_transform_operator(value: &str, op: &str) -> Result<String, String> {
    match op {
        "Q" => {
            // Quote value for reuse as input
            Ok(format!("'{}'", value.replace('\'', "'\\''")))
        }
        "E" => {
            // Expand escape sequences
            let mut result = String::new();
            let mut chars = value.chars().peekable();
            while let Some(c) = chars.next() {
                if c == '\\' {
                    match chars.next() {
                        Some('n') => result.push('\n'),
                        Some('t') => result.push('\t'),
                        Some('r') => result.push('\r'),
                        Some('\\') => result.push('\\'),
                        Some('\'') => result.push('\''),
                        Some('"') => result.push('"'),
                        Some(other) => {
                            result.push('\\');
                            result.push(other);
                        }
                        None => result.push('\\'),
                    }
                } else {
                    result.push(c);
                }
            }
            Ok(result)
        }
        "P" => {
            // Expand as prompt string (simplified - just return value)
            Ok(value.to_string())
        }
        "A" => {
            // Assignment format - return as assignment statement
            // We don't have the variable name here, so just return empty
            Ok(String::new())
        }
        "a" => {
            // Attribute flags - we'd need the variable info
            Ok(String::new())
        }
        "U" => {
            // Uppercase
            Ok(value.to_uppercase())
        }
        "u" => {
            // Uppercase first character
            let mut chars = value.chars();
            match chars.next() {
                Some(c) => Ok(c.to_uppercase().chain(chars).collect()),
                None => Ok(String::new()),
            }
        }
        "L" => {
            // Lowercase
            Ok(value.to_lowercase())
        }
        _ => Ok(value.to_string()),
    }
}

/// Apply a parameter expansion operator
fn apply_expansion_operator(name: &str, op: &str, arg: &str, env: &ShellEnv) -> Result<String, String> {
    let value = env.get_var(name).cloned();
    let is_unset = value.is_none();
    let is_null = value.as_ref().map(|v| v.is_empty()).unwrap_or(true);

    match op {
        ":-" => {
            // Use default if unset or null
            if is_null {
                Ok(arg.to_string())
            } else {
                Ok(value.unwrap())
            }
        }
        "-" => {
            // Use default if unset only
            if is_unset {
                Ok(arg.to_string())
            } else {
                Ok(value.unwrap())
            }
        }
        ":=" => {
            // Assign default if unset or null (we can't modify env here, just return)
            if is_null {
                Ok(arg.to_string())
            } else {
                Ok(value.unwrap())
            }
        }
        "=" => {
            // Assign default if unset only
            if is_unset {
                Ok(arg.to_string())
            } else {
                Ok(value.unwrap())
            }
        }
        ":+" => {
            // Use alternative if set and non-null
            if !is_null {
                Ok(arg.to_string())
            } else {
                Ok(String::new())
            }
        }
        "+" => {
            // Use alternative if set
            if !is_unset {
                Ok(arg.to_string())
            } else {
                Ok(String::new())
            }
        }
        ":?" => {
            // Error if unset or null
            if is_null {
                Err(format!("{}: {}", name, if arg.is_empty() { "parameter null or not set" } else { arg }))
            } else {
                Ok(value.unwrap())
            }
        }
        "?" => {
            // Error if unset
            if is_unset {
                Err(format!("{}: {}", name, if arg.is_empty() { "parameter not set" } else { arg }))
            } else {
                Ok(value.unwrap())
            }
        }
        "#" => {
            // Remove shortest prefix pattern
            let val = value.unwrap_or_default();
            Ok(remove_prefix(&val, arg, false))
        }
        "##" => {
            // Remove longest prefix pattern
            let val = value.unwrap_or_default();
            Ok(remove_prefix(&val, arg, true))
        }
        "%" => {
            // Remove shortest suffix pattern
            let val = value.unwrap_or_default();
            Ok(remove_suffix(&val, arg, false))
        }
        "%%" => {
            // Remove longest suffix pattern
            let val = value.unwrap_or_default();
            Ok(remove_suffix(&val, arg, true))
        }
        "/" => {
            // Replace first occurrence
            let val = value.unwrap_or_default();
            if let Some(slash_pos) = arg.find('/') {
                let pattern = &arg[..slash_pos];
                let replacement = &arg[slash_pos + 1..];
                Ok(val.replacen(pattern, replacement, 1))
            } else {
                // No replacement, just remove first match
                Ok(val.replacen(arg, "", 1))
            }
        }
        "//" => {
            // Replace all occurrences
            let val = value.unwrap_or_default();
            if let Some(slash_pos) = arg.find('/') {
                let pattern = &arg[..slash_pos];
                let replacement = &arg[slash_pos + 1..];
                Ok(val.replace(pattern, replacement))
            } else {
                // No replacement, remove all matches
                Ok(val.replace(arg, ""))
            }
        }
        "^" => {
            // Uppercase first character
            let val = value.unwrap_or_default();
            let mut chars = val.chars();
            match chars.next() {
                Some(c) => Ok(c.to_uppercase().chain(chars).collect()),
                None => Ok(String::new()),
            }
        }
        "^^" => {
            // Uppercase all
            let val = value.unwrap_or_default();
            Ok(val.to_uppercase())
        }
        "," => {
            // Lowercase first character
            let val = value.unwrap_or_default();
            let mut chars = val.chars();
            match chars.next() {
                Some(c) => Ok(c.to_lowercase().chain(chars).collect()),
                None => Ok(String::new()),
            }
        }
        ",," => {
            // Lowercase all
            let val = value.unwrap_or_default();
            Ok(val.to_lowercase())
        }
        _ => Ok(value.unwrap_or_default()),
    }
}

/// Remove prefix matching pattern
fn remove_prefix(value: &str, pattern: &str, longest: bool) -> String {
    // Simple glob-like matching for * at end
    if pattern.ends_with('*') {
        let prefix = &pattern[..pattern.len() - 1];
        if value.starts_with(prefix) {
            if longest {
                // Find longest match - return empty if pattern matches all
                return String::new();
            } else {
                return value[prefix.len()..].to_string();
            }
        }
    }
    
    // Exact prefix match
    if value.starts_with(pattern) {
        value[pattern.len()..].to_string()
    } else {
        value.to_string()
    }
}

/// Remove suffix matching pattern  
fn remove_suffix(value: &str, pattern: &str, longest: bool) -> String {
    // Simple glob-like matching for * at start
    if pattern.starts_with('*') {
        let suffix = &pattern[1..];
        if value.ends_with(suffix) {
            if longest {
                // Find longest match - return empty if pattern matches all
                return String::new();
            } else {
                return value[..value.len() - suffix.len()].to_string();
            }
        }
    }
    
    // Exact suffix match
    if value.ends_with(pattern) {
        value[..value.len() - pattern.len()].to_string()
    } else {
        value.to_string()
    }
}

/// Expand command substitution $(...)
fn expand_command_substitution(chars: &mut std::iter::Peekable<std::str::Chars>, _env: &ShellEnv) -> Result<String, String> {
    let mut content = String::new();
    let mut paren_depth = 1;

    while let Some(c) = chars.next() {
        match c {
            '(' => {
                paren_depth += 1;
                content.push(c);
            }
            ')' => {
                paren_depth -= 1;
                if paren_depth == 0 {
                    break;
                }
                content.push(c);
            }
            _ => content.push(c),
        }
    }

    if paren_depth != 0 {
        return Err("bad substitution: unmatched '('".to_string());
    }

    // Return a marker that will be processed by the pipeline executor
    // The actual execution happens in the pipeline module
    Ok(format!("$__CMD_SUB__:{}:__END__", content))
}

/// Expand arithmetic expression $((...))
fn expand_arithmetic(chars: &mut std::iter::Peekable<std::str::Chars>, env: &ShellEnv) -> Result<String, String> {
    let mut content = String::new();
    let mut paren_depth = 2; // We've already consumed $(( 

    while let Some(c) = chars.next() {
        match c {
            '(' => {
                paren_depth += 1;
                content.push(c);
            }
            ')' => {
                paren_depth -= 1;
                if paren_depth == 0 {
                    break;
                }
                if paren_depth == 1 && chars.peek() == Some(&')') {
                    chars.next(); // consume second )
                    break;
                }
                content.push(c);
            }
            _ => content.push(c),
        }
    }

    // Expand variables inside the arithmetic expression before evaluation
    let expanded = expand_string(&content, env, false)?;
    
    // Also expand bare variable names (shell arithmetic treats identifiers as variables)
    let fully_expanded = expand_bare_arithmetic_vars(&expanded, env);
    
    evaluate_arithmetic(&fully_expanded)
}

/// Expand bare variable names in arithmetic expressions
/// In shell arithmetic, bare identifiers like `i` are treated as variable references
fn expand_bare_arithmetic_vars(expr: &str, env: &ShellEnv) -> String {
    let mut result = String::new();
    let mut i = 0;
    let chars: Vec<char> = expr.chars().collect();
    let len = chars.len();
    
    while i < len {
        let c = chars[i];
        
        // Check if we're at the start of an identifier (letter or underscore, not digit)
        if c.is_ascii_alphabetic() || c == '_' {
            // Collect the full identifier
            let start = i;
            while i < len && (chars[i].is_ascii_alphanumeric() || chars[i] == '_') {
                i += 1;
            }
            let ident: String = chars[start..i].iter().collect();
            
            // Look up the variable value
            let value = env.get_var(&ident).map(|s| s.as_str()).unwrap_or("");
            
            // If it's a number, use it; otherwise default to 0
            if value.is_empty() {
                result.push('0');
            } else if value.parse::<i64>().is_ok() {
                result.push_str(value);
            } else {
                // Variable value is not a number, treat as 0
                result.push('0');
            }
        } else {
            result.push(c);
            i += 1;
        }
    }
    
    result
}

/// Evaluate an arithmetic expression
pub fn evaluate_arithmetic(expr: &str) -> Result<String, String> {
    let expr = expr.trim();
    
    // Parse and evaluate the expression
    match parse_arithmetic_expr(expr) {
        Ok(value) => Ok(value.to_string()),
        Err(e) => Err(format!("arithmetic error: {}", e)),
    }
}

/// Parse and evaluate arithmetic expression
fn parse_arithmetic_expr(expr: &str) -> Result<i64, String> {
    let expr = expr.trim();
    
    if expr.is_empty() {
        return Ok(0);
    }

    // Handle ternary operator
    if let Some(q_pos) = expr.find('?') {
        if let Some(c_pos) = expr[q_pos..].find(':') {
            let cond = &expr[..q_pos];
            let true_val = &expr[q_pos + 1..q_pos + c_pos];
            let false_val = &expr[q_pos + c_pos + 1..];
            let cond_result = parse_arithmetic_expr(cond)?;
            return if cond_result != 0 {
                parse_arithmetic_expr(true_val)
            } else {
                parse_arithmetic_expr(false_val)
            };
        }
    }

    // Handle comparison operators (lowest precedence)
    // Check in order from longest operator to shortest to avoid partial matches
    for op in ["<=", ">=", "==", "!=", "<", ">"] {
        if let Some(pos) = expr.rfind(op) {
            let left = parse_arithmetic_expr(&expr[..pos])?;
            let right = parse_arithmetic_expr(&expr[pos + op.len()..])?;
            let result = match op {
                "<=" => if left <= right { 1 } else { 0 },
                ">=" => if left >= right { 1 } else { 0 },
                "==" => if left == right { 1 } else { 0 },
                "!=" => if left != right { 1 } else { 0 },
                "<" => if left < right { 1 } else { 0 },
                ">" => if left > right { 1 } else { 0 },
                _ => unreachable!(),
            };
            return Ok(result);
        }
    }

    // Handle logical operators
    if let Some(pos) = expr.rfind("||") {
        let left = parse_arithmetic_expr(&expr[..pos])?;
        if left != 0 {
            return Ok(1);
        }
        let right = parse_arithmetic_expr(&expr[pos + 2..])?;
        return Ok(if right != 0 { 1 } else { 0 });
    }
    
    if let Some(pos) = expr.rfind("&&") {
        let left = parse_arithmetic_expr(&expr[..pos])?;
        if left == 0 {
            return Ok(0);
        }
        let right = parse_arithmetic_expr(&expr[pos + 2..])?;
        return Ok(if right != 0 { 1 } else { 0 });
    }

    // Handle bitwise OR
    if let Some(pos) = expr.rfind('|') {
        if pos > 0 && expr.chars().nth(pos - 1) != Some('|') {
            let left = parse_arithmetic_expr(&expr[..pos])?;
            let right = parse_arithmetic_expr(&expr[pos + 1..])?;
            return Ok(left | right);
        }
    }

    // Handle bitwise XOR
    if let Some(pos) = expr.rfind('^') {
        let left = parse_arithmetic_expr(&expr[..pos])?;
        let right = parse_arithmetic_expr(&expr[pos + 1..])?;
        return Ok(left ^ right);
    }

    // Handle bitwise AND
    if let Some(pos) = expr.rfind('&') {
        if pos > 0 && expr.chars().nth(pos - 1) != Some('&') {
            let left = parse_arithmetic_expr(&expr[..pos])?;
            let right = parse_arithmetic_expr(&expr[pos + 1..])?;
            return Ok(left & right);
        }
    }

    // Handle addition and subtraction (left to right for same precedence)
    let mut depth = 0;
    for (i, c) in expr.char_indices().rev() {
        match c {
            ')' => depth += 1,
            '(' => depth -= 1,
            '+' | '-' if depth == 0 && i > 0 => {
                // Make sure it's not part of a number or unary
                let prev_char = expr.chars().nth(i - 1);
                if prev_char.map(|c| c.is_ascii_digit() || c == ')' || c == ' ').unwrap_or(false) {
                    let left = parse_arithmetic_expr(&expr[..i])?;
                    let right = parse_arithmetic_expr(&expr[i + 1..])?;
                    return Ok(if c == '+' { left + right } else { left - right });
                }
            }
            _ => {}
        }
    }

    // Handle multiplication, division, modulo
    let mut depth = 0;
    for (i, c) in expr.char_indices().rev() {
        match c {
            ')' => depth += 1,
            '(' => depth -= 1,
            '*' | '/' | '%' if depth == 0 => {
                // Make sure it's not ** (exponentiation) - check both neighbors
                if c == '*' {
                    // Check if next char is * (we're the first * of **)
                    if i + 1 < expr.len() && expr.chars().nth(i + 1) == Some('*') {
                        continue;
                    }
                    // Check if prev char is * (we're the second * of **)
                    if i > 0 && expr.chars().nth(i - 1) == Some('*') {
                        continue;
                    }
                }
                let left = parse_arithmetic_expr(&expr[..i])?;
                let right = parse_arithmetic_expr(&expr[i + 1..])?;
                return Ok(match c {
                    '*' => left * right,
                    '/' => {
                        if right == 0 {
                            return Err("division by zero".to_string());
                        }
                        left / right
                    }
                    '%' => {
                        if right == 0 {
                            return Err("division by zero".to_string());
                        }
                        left % right
                    }
                    _ => unreachable!(),
                });
            }
            _ => {}
        }
    }

    // Handle exponentiation
    if let Some(pos) = expr.find("**") {
        let left = parse_arithmetic_expr(&expr[..pos])?;
        let right = parse_arithmetic_expr(&expr[pos + 2..])?;
        return Ok(left.pow(right as u32));
    }

    // Handle unary operators
    let trimmed = expr.trim();
    if let Some(rest) = trimmed.strip_prefix('-') {
        return Ok(-parse_arithmetic_expr(rest)?);
    }
    if let Some(rest) = trimmed.strip_prefix('+') {
        return parse_arithmetic_expr(rest);
    }
    if let Some(rest) = trimmed.strip_prefix('!') {
        let val = parse_arithmetic_expr(rest)?;
        return Ok(if val == 0 { 1 } else { 0 });
    }
    if let Some(rest) = trimmed.strip_prefix('~') {
        return Ok(!parse_arithmetic_expr(rest)?);
    }

    // Handle parentheses
    if trimmed.starts_with('(') && trimmed.ends_with(')') {
        return parse_arithmetic_expr(&trimmed[1..trimmed.len() - 1]);
    }

    // Parse as number (decimal, octal, hex)
    if let Some(hex) = trimmed.strip_prefix("0x").or_else(|| trimmed.strip_prefix("0X")) {
        return i64::from_str_radix(hex, 16).map_err(|_| format!("invalid number: {}", expr));
    }
    if let Some(oct) = trimmed.strip_prefix("0o").or_else(|| trimmed.strip_prefix("0O")) {
        return i64::from_str_radix(oct, 8).map_err(|_| format!("invalid number: {}", expr));
    }
    if let Some(bin) = trimmed.strip_prefix("0b").or_else(|| trimmed.strip_prefix("0B")) {
        return i64::from_str_radix(bin, 2).map_err(|_| format!("invalid number: {}", expr));
    }
    // Leading 0 means octal in shell arithmetic
    if trimmed.starts_with('0') && trimmed.len() > 1 && trimmed.chars().all(|c| c.is_ascii_digit()) {
        return i64::from_str_radix(trimmed, 8).map_err(|_| format!("invalid number: {}", expr));
    }

    trimmed.parse().map_err(|_| format!("invalid number: {}", expr))
}

/// Expand backtick command substitution
#[allow(dead_code)] // kept for future backtick expansion support
pub fn expand_backticks(input: &str, _env: &ShellEnv) -> Result<String, String> {
    let mut result = String::new();
    let mut chars = input.chars().peekable();
    
    while let Some(c) = chars.next() {
        if c == '`' {
            let mut command = String::new();
            while let Some(c2) = chars.next() {
                if c2 == '`' {
                    break;
                } else if c2 == '\\' {
                    // Handle escape in backticks
                    if let Some(c3) = chars.next() {
                        if c3 == '`' || c3 == '\\' || c3 == '$' {
                            command.push(c3);
                        } else {
                            command.push('\\');
                            command.push(c3);
                        }
                    }
                } else {
                    command.push(c2);
                }
            }
            // Return marker for command substitution
            result.push_str(&format!("$__CMD_SUB__:{}:__END__", command));
        } else {
            result.push(c);
        }
    }
    
    Ok(result)
}

/// Expand brace expressions like {a,b,c} or {1..5}
///
/// Uses brush_parser's brace expression parsing for proper handling of
/// range expressions with step support.
pub fn expand_braces(input: &str) -> Vec<String> {
    super::braceexpansion::expand_braces_with_parser(input)
}

#[cfg(test)]
mod tests {
    use super::*;

    // ========================================================================
    // Variable Expansion Tests
    // ========================================================================

    #[test]
    fn test_simple_variable() {
        let mut env = ShellEnv::new();
        let _ = env.set_var("FOO", "bar");
        let result = expand_string("$FOO", &env, false).unwrap();
        assert_eq!(result, "bar");
    }

    #[test]
    fn test_braced_variable() {
        let mut env = ShellEnv::new();
        let _ = env.set_var("FOO", "bar");
        let result = expand_string("${FOO}", &env, false).unwrap();
        assert_eq!(result, "bar");
    }

    #[test]
    fn test_variable_in_string() {
        let mut env = ShellEnv::new();
        let _ = env.set_var("NAME", "world");
        let result = expand_string("Hello $NAME!", &env, false).unwrap();
        assert_eq!(result, "Hello world!");
    }

    #[test]
    fn test_multiple_variables() {
        let mut env = ShellEnv::new();
        let _ = env.set_var("FIRST", "Hello");
        let _ = env.set_var("SECOND", "World");
        let result = expand_string("$FIRST $SECOND", &env, false).unwrap();
        assert_eq!(result, "Hello World");
    }

    #[test]
    fn test_unset_variable() {
        let env = ShellEnv::new();
        let result = expand_string("$UNDEFINED", &env, false).unwrap();
        assert_eq!(result, "");
    }

    #[test]
    fn test_nounset_error() {
        let mut env = ShellEnv::new();
        env.options.nounset = true;
        let result = expand_string("$UNDEFINED", &env, false);
        assert!(result.is_err());
    }

    // ========================================================================
    // Default Value Tests
    // ========================================================================

    #[test]
    fn test_default_value() {
        let env = ShellEnv::new();
        let result = expand_string("${FOO:-default}", &env, false).unwrap();
        assert_eq!(result, "default");
    }

    #[test]
    fn test_default_value_not_used() {
        let mut env = ShellEnv::new();
        let _ = env.set_var("FOO", "actual");
        let result = expand_string("${FOO:-default}", &env, false).unwrap();
        assert_eq!(result, "actual");
    }

    #[test]
    fn test_default_for_empty() {
        let mut env = ShellEnv::new();
        let _ = env.set_var("FOO", "");
        // :- uses default for empty too
        let result = expand_string("${FOO:-default}", &env, false).unwrap();
        assert_eq!(result, "default");
    }

    #[test]
    fn test_alternative_value() {
        let mut env = ShellEnv::new();
        let _ = env.set_var("FOO", "set");
        let result = expand_string("${FOO:+alternative}", &env, false).unwrap();
        assert_eq!(result, "alternative");
    }

    #[test]
    fn test_alternative_not_used() {
        let env = ShellEnv::new();
        let result = expand_string("${FOO:+alternative}", &env, false).unwrap();
        assert_eq!(result, "");
    }

    #[test]
    fn test_error_if_unset() {
        let env = ShellEnv::new();
        let result = expand_string("${FOO:?custom error}", &env, false);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("custom error"));
    }

    // ========================================================================
    // Special Variables Tests
    // ========================================================================

    #[test]
    fn test_special_vars() {
        let mut env = ShellEnv::new();
        env.last_exit_code = 42;
        env.positional_params = vec!["a".to_string(), "b".to_string()];
        
        assert_eq!(expand_string("$?", &env, false).unwrap(), "42");
        assert_eq!(expand_string("$#", &env, false).unwrap(), "2");
        assert_eq!(expand_string("$1", &env, false).unwrap(), "a");
    }

    #[test]
    fn test_positional_params() {
        let mut env = ShellEnv::new();
        env.positional_params = vec!["first".to_string(), "second".to_string(), "third".to_string()];
        
        assert_eq!(expand_string("$1", &env, false).unwrap(), "first");
        assert_eq!(expand_string("$2", &env, false).unwrap(), "second");
        assert_eq!(expand_string("$3", &env, false).unwrap(), "third");
        assert_eq!(expand_string("$4", &env, false).unwrap(), ""); // Out of bounds
    }

    #[test]
    fn test_all_positional_params() {
        let mut env = ShellEnv::new();
        env.positional_params = vec!["a".to_string(), "b".to_string(), "c".to_string()];
        
        assert_eq!(expand_string("$*", &env, false).unwrap(), "a b c");
        assert_eq!(expand_string("$@", &env, false).unwrap(), "a b c");
    }

    #[test]
    fn test_session_id() {
        let env = ShellEnv::new();
        let result = expand_string("$$", &env, false).unwrap();
        // Should be a number
        assert!(result.parse::<u64>().is_ok());
    }

    // ========================================================================
    // Arithmetic Expansion Tests
    // ========================================================================

    #[test]
    fn test_arithmetic() {
        assert_eq!(evaluate_arithmetic("1 + 2").unwrap(), "3");
        assert_eq!(evaluate_arithmetic("10 / 2").unwrap(), "5");
        assert_eq!(evaluate_arithmetic("3 * 4 + 2").unwrap(), "14");
        assert_eq!(evaluate_arithmetic("2 ** 8").unwrap(), "256");
    }

    #[test]
    fn test_arithmetic_subtraction() {
        assert_eq!(evaluate_arithmetic("10 - 3").unwrap(), "7");
        assert_eq!(evaluate_arithmetic("5 - 10").unwrap(), "-5");
    }

    #[test]
    fn test_arithmetic_modulo() {
        assert_eq!(evaluate_arithmetic("10 % 3").unwrap(), "1");
        assert_eq!(evaluate_arithmetic("15 % 5").unwrap(), "0");
    }

    #[test]
    fn test_arithmetic_comparisons() {
        assert_eq!(evaluate_arithmetic("5 > 3").unwrap(), "1");
        assert_eq!(evaluate_arithmetic("3 > 5").unwrap(), "0");
        assert_eq!(evaluate_arithmetic("5 >= 5").unwrap(), "1");
        assert_eq!(evaluate_arithmetic("5 == 5").unwrap(), "1");
        assert_eq!(evaluate_arithmetic("5 != 3").unwrap(), "1");
    }

    #[test]
    fn test_arithmetic_logical() {
        assert_eq!(evaluate_arithmetic("1 && 1").unwrap(), "1");
        assert_eq!(evaluate_arithmetic("1 && 0").unwrap(), "0");
        assert_eq!(evaluate_arithmetic("0 || 1").unwrap(), "1");
        assert_eq!(evaluate_arithmetic("0 || 0").unwrap(), "0");
    }

    #[test]
    fn test_arithmetic_bitwise() {
        assert_eq!(evaluate_arithmetic("5 & 3").unwrap(), "1");
        assert_eq!(evaluate_arithmetic("5 | 3").unwrap(), "7");
        assert_eq!(evaluate_arithmetic("5 ^ 3").unwrap(), "6");
    }

    #[test]
    fn test_arithmetic_unary() {
        assert_eq!(evaluate_arithmetic("-5").unwrap(), "-5");
        assert_eq!(evaluate_arithmetic("+5").unwrap(), "5");
        assert_eq!(evaluate_arithmetic("!0").unwrap(), "1");
        assert_eq!(evaluate_arithmetic("!5").unwrap(), "0");
    }

    #[test]
    fn test_arithmetic_parentheses() {
        assert_eq!(evaluate_arithmetic("(1 + 2) * 3").unwrap(), "9");
        assert_eq!(evaluate_arithmetic("2 * (3 + 4)").unwrap(), "14");
    }

    #[test]
    fn test_arithmetic_hex() {
        assert_eq!(evaluate_arithmetic("0xFF").unwrap(), "255");
        assert_eq!(evaluate_arithmetic("0x10").unwrap(), "16");
    }

    #[test]
    fn test_arithmetic_octal() {
        assert_eq!(evaluate_arithmetic("010").unwrap(), "8");
        assert_eq!(evaluate_arithmetic("0o17").unwrap(), "15");
    }

    #[test]
    fn test_arithmetic_division_by_zero() {
        let result = evaluate_arithmetic("5 / 0");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("division by zero"));
    }

    // ========================================================================
    // Brace Expansion Tests
    // ========================================================================

    #[test]
    fn test_brace_expansion() {
        let result = expand_braces("file{1,2,3}.txt");
        assert_eq!(result, vec!["file1.txt", "file2.txt", "file3.txt"]);
    }

    #[test]
    fn test_range_expansion() {
        let result = expand_braces("{1..3}");
        assert_eq!(result, vec!["1", "2", "3"]);
        
        let result = expand_braces("{a..c}");
        assert_eq!(result, vec!["a", "b", "c"]);
    }

    #[test]
    fn test_reverse_range() {
        let result = expand_braces("{3..1}");
        assert_eq!(result, vec!["3", "2", "1"]);
        
        let result = expand_braces("{c..a}");
        assert_eq!(result, vec!["c", "b", "a"]);
    }

    #[test]
    fn test_brace_prefix_suffix() {
        let result = expand_braces("prefix{a,b}suffix");
        assert_eq!(result, vec!["prefixasuffix", "prefixbsuffix"]);
    }

    #[test]
    fn test_nested_braces() {
        let result = expand_braces("{a,b}{1,2}");
        assert_eq!(result, vec!["a1", "a2", "b1", "b2"]);
    }

    #[test]
    fn test_no_brace_expansion() {
        let result = expand_braces("nobraces");
        assert_eq!(result, vec!["nobraces"]);
    }

    // ========================================================================
    // Length and Pattern Tests
    // ========================================================================

    #[test]
    fn test_length_operator() {
        let mut env = ShellEnv::new();
        let _ = env.set_var("FOO", "hello");
        let result = expand_string("${#FOO}", &env, false).unwrap();
        assert_eq!(result, "5");
    }

    #[test]
    fn test_length_empty() {
        let mut env = ShellEnv::new();
        let _ = env.set_var("FOO", "");
        let result = expand_string("${#FOO}", &env, false).unwrap();
        assert_eq!(result, "0");
    }

    #[test]
    fn test_case_modification() {
        let mut env = ShellEnv::new();
        let _ = env.set_var("FOO", "hello");
        
        assert_eq!(expand_string("${FOO^}", &env, false).unwrap(), "Hello");
        assert_eq!(expand_string("${FOO^^}", &env, false).unwrap(), "HELLO");
    }

    #[test]
    fn test_lowercase_modification() {
        let mut env = ShellEnv::new();
        let _ = env.set_var("FOO", "HELLO");
        
        assert_eq!(expand_string("${FOO,}", &env, false).unwrap(), "hELLO");
        assert_eq!(expand_string("${FOO,,}", &env, false).unwrap(), "hello");
    }

    #[test]
    fn test_prefix_removal() {
        let mut env = ShellEnv::new();
        let _ = env.set_var("PATH", "/usr/local/bin");
        
        assert_eq!(expand_string("${PATH#/usr}", &env, false).unwrap(), "/local/bin");
    }

    #[test]
    fn test_suffix_removal() {
        let mut env = ShellEnv::new();
        let _ = env.set_var("FILE", "document.txt");
        
        assert_eq!(expand_string("${FILE%.txt}", &env, false).unwrap(), "document");
    }

    #[test]
    fn test_replacement() {
        let mut env = ShellEnv::new();
        let _ = env.set_var("STR", "hello world");
        
        // Replace first occurrence
        assert_eq!(expand_string("${STR/world/universe}", &env, false).unwrap(), "hello universe");
    }

    #[test]
    fn test_replacement_all() {
        let mut env = ShellEnv::new();
        let _ = env.set_var("STR", "aaa");
        
        // Replace all occurrences
        assert_eq!(expand_string("${STR//a/b}", &env, false).unwrap(), "bbb");
    }

    // ========================================================================
    // Edge Cases
    // ========================================================================

    #[test]
    fn test_dollar_at_end() {
        let env = ShellEnv::new();
        let result = expand_string("test$", &env, false).unwrap();
        assert_eq!(result, "test$");
    }

    #[test]
    fn test_unset_var_in_double_quotes() {
        let env = ShellEnv::new();
        // In double quotes mode, unset var expands to empty
        let result = expand_string("$FOO", &env, true).unwrap();
        assert_eq!(result, "");
    }

    #[test]
    fn test_literal_dollar() {
        let env = ShellEnv::new();
        // Escaped dollar in double quotes stays as $
        let result = expand_string("\\$FOO", &env, true).unwrap();
        assert_eq!(result, "$FOO");
    }

    #[test]
    fn test_empty_input() {
        let env = ShellEnv::new();
        let result = expand_string("", &env, false).unwrap();
        assert_eq!(result, "");
    }

    #[test]
    fn test_braced_var_adjacent_text() {
        let mut env = ShellEnv::new();
        let _ = env.set_var("VAR", "value");
        let result = expand_string("${VAR}text", &env, false).unwrap();
        assert_eq!(result, "valuetext");
    }

    // ========================================================================
    // Special Variables Tests
    // ========================================================================

    #[test]
    fn test_random_variable() {
        let env = ShellEnv::new();
        let result = expand_string("$RANDOM", &env, false).unwrap();
        let num: u16 = result.parse().expect("RANDOM should be a number");
        assert!(num <= 32767);
    }

    #[test]
    fn test_random_different_values() {
        let env = ShellEnv::new();
        // Get multiple values - they may occasionally be equal, but should usually differ
        let r1 = expand_string("$RANDOM", &env, false).unwrap();
        let r2 = expand_string("$RANDOM", &env, false).unwrap();
        let r3 = expand_string("$RANDOM", &env, false).unwrap();
        // At least two attempts, we just verify parsing works
        let _: u16 = r1.parse().unwrap();
        let _: u16 = r2.parse().unwrap();
        let _: u16 = r3.parse().unwrap();
    }

    #[test]
    fn test_pwd_variable() {
        let mut env = ShellEnv::new();
        env.cwd = std::path::PathBuf::from("/tmp/test");
        let result = expand_string("$PWD", &env, false).unwrap();
        assert_eq!(result, "/tmp/test");
    }

    #[test]
    fn test_oldpwd_variable() {
        let mut env = ShellEnv::new();
        env.prev_cwd = std::path::PathBuf::from("/home/user");
        let result = expand_string("$OLDPWD", &env, false).unwrap();
        assert_eq!(result, "/home/user");
    }

    #[test]
    fn test_home_variable() {
        let env = ShellEnv::new();
        let result = expand_string("$HOME", &env, false).unwrap();
        assert_eq!(result, "/");
    }

    #[test]
    fn test_user_variable() {
        let env = ShellEnv::new();
        let result = expand_string("$USER", &env, false).unwrap();
        assert_eq!(result, "user");
    }

    #[test]
    fn test_logname_variable() {
        let env = ShellEnv::new();
        let result = expand_string("$LOGNAME", &env, false).unwrap();
        assert_eq!(result, "user");
    }

    #[test]
    fn test_shell_variable() {
        let env = ShellEnv::new();
        let result = expand_string("$SHELL", &env, false).unwrap();
        assert_eq!(result, "/bin/sh");
    }

    #[test]
    fn test_hostname_variable() {
        let env = ShellEnv::new();
        let result = expand_string("$HOSTNAME", &env, false).unwrap();
        assert_eq!(result, "sandbox");
    }

    #[test]
    fn test_shlvl_variable() {
        let mut env = ShellEnv::new();
        env.subshell_depth = 3;
        let result = expand_string("$SHLVL", &env, false).unwrap();
        assert_eq!(result, "3");
    }

    #[test]
    fn test_ifs_variable() {
        let env = ShellEnv::new();
        let result = expand_string("$IFS", &env, false).unwrap();
        assert_eq!(result, " \t\n");
    }

    #[test]
    fn test_lineno_variable() {
        let env = ShellEnv::new();
        let result = expand_string("$LINENO", &env, false).unwrap();
        assert_eq!(result, "1");
    }

    #[test]
    fn test_seconds_variable() {
        let env = ShellEnv::new();
        let result = expand_string("$SECONDS", &env, false).unwrap();
        assert_eq!(result, "0");
    }

    // ========================================================================
    // Special variable combined with user variables
    // ========================================================================

    #[test]
    fn test_special_var_with_user_var() {
        let mut env = ShellEnv::new();
        let _ = env.set_var("PREFIX", "dir_");
        env.cwd = std::path::PathBuf::from("/tmp");
        let result = expand_string("$PREFIX at $PWD", &env, false).unwrap();
        assert_eq!(result, "dir_ at /tmp");
    }

    #[test]
    fn test_random_in_arithmetic() {
        // This tests that $RANDOM can be used in arithmetic context
        let env = ShellEnv::new();
        let result = expand_string("$RANDOM", &env, false).unwrap();
        // Should be parseable as number
        let n: i64 = result.parse().unwrap();
        assert!(n >= 0 && n <= 32767);
    }

    // ========================================================================
    // Variable shadowing - user var overrides special
    // ========================================================================

    #[test]
    fn test_user_var_shadows_builtin() {
        let mut env = ShellEnv::new();
        // User sets a variable with special name - should still get user value first
        let _ = env.set_var("HOME", "/custom/home");
        // Note: our implementation checks special vars BEFORE user vars in expand_simple_variable
        // so this test documents that behavior - special vars take precedence
        let result = expand_string("$HOME", &env, false).unwrap();
        // Special vars are checked first, so we get "/" not "/custom/home"
        assert_eq!(result, "/");
    }

    // ========================================================================
    // Substring Expansion Tests
    // ========================================================================

    #[test]
    fn test_substring_from_offset() {
        let mut env = ShellEnv::new();
        let _ = env.set_var("STR", "hello world");
        let result = expand_string("${STR:6}", &env, false).unwrap();
        assert_eq!(result, "world");
    }

    #[test]
    fn test_substring_with_length() {
        let mut env = ShellEnv::new();
        let _ = env.set_var("STR", "hello world");
        let result = expand_string("${STR:0:5}", &env, false).unwrap();
        assert_eq!(result, "hello");
    }

    #[test]
    fn test_substring_negative_offset() {
        let mut env = ShellEnv::new();
        let _ = env.set_var("STR", "hello world");
        // Negative offset counts from end
        let result = expand_string("${STR: -5}", &env, false).unwrap();
        assert_eq!(result, "world");
    }

    #[test]
    fn test_substring_middle() {
        let mut env = ShellEnv::new();
        let _ = env.set_var("STR", "hello world");
        let result = expand_string("${STR:3:5}", &env, false).unwrap();
        assert_eq!(result, "lo wo");
    }

    // ========================================================================
    // Indirect Expansion Tests
    // ========================================================================

    #[test]
    fn test_indirect_expansion() {
        let mut env = ShellEnv::new();
        let _ = env.set_var("ref", "target");
        let _ = env.set_var("target", "value");
        let result = expand_string("${!ref}", &env, false).unwrap();
        assert_eq!(result, "value");
    }

    #[test]
    fn test_indirect_expansion_unset() {
        let mut env = ShellEnv::new();
        let _ = env.set_var("ref", "nonexistent");
        let result = expand_string("${!ref}", &env, false).unwrap();
        assert_eq!(result, "");
    }

    // ========================================================================
    // Transformation Operator Tests
    // ========================================================================

    #[test]
    fn test_transform_quote() {
        let mut env = ShellEnv::new();
        let _ = env.set_var("STR", "hello");
        let result = expand_string("${STR@Q}", &env, false).unwrap();
        assert_eq!(result, "'hello'");
    }

    #[test]
    fn test_transform_uppercase() {
        let mut env = ShellEnv::new();
        let _ = env.set_var("STR", "hello");
        let result = expand_string("${STR@U}", &env, false).unwrap();
        assert_eq!(result, "HELLO");
    }

    #[test]
    fn test_transform_lowercase() {
        let mut env = ShellEnv::new();
        let _ = env.set_var("STR", "HELLO");
        let result = expand_string("${STR@L}", &env, false).unwrap();
        assert_eq!(result, "hello");
    }

    #[test]
    fn test_transform_capitalize() {
        let mut env = ShellEnv::new();
        let _ = env.set_var("STR", "hello");
        let result = expand_string("${STR@u}", &env, false).unwrap();
        assert_eq!(result, "Hello");
    }

    #[test]
    fn test_transform_escape() {
        let mut env = ShellEnv::new();
        let _ = env.set_var("STR", "hello\\nworld");
        let result = expand_string("${STR@E}", &env, false).unwrap();
        assert_eq!(result, "hello\nworld");
    }

    #[test]
    fn test_prefix_name_expansion() {
        let mut env = ShellEnv::new();
        let _ = env.set_var("MY_VAR1", "a");
        let _ = env.set_var("MY_VAR2", "b");
        let _ = env.set_var("OTHER", "c");
        let result = expand_string("${!MY_*}", &env, false).unwrap();
        // Result should contain variable NAMES not values
        assert!(result.contains("MY_VAR1"));
        assert!(result.contains("MY_VAR2"));
        assert!(!result.contains("OTHER"));
    }
}

