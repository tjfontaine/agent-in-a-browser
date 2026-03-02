//! JSON and pipeline commands: jq, xargs

use futures_lite::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use futures_lite::StreamExt;
use lexopt::prelude::*;
use runtime_macros::shell_commands;

use super::super::ShellEnv;
use super::{make_parser, parse_common};

/// JSON and pipeline commands.
pub struct JsonCommands;

#[shell_commands]
impl JsonCommands {
    /// jq - JSON processor
    #[shell_command(
        name = "jq",
        usage = "jq [-r] FILTER [FILE]",
        description = "JSON processor for querying and transforming data"
    )]
    fn cmd_jq(
        args: Vec<String>,
        env: &ShellEnv,
        stdin: piper::Reader,
        mut stdout: piper::Writer,
        mut stderr: piper::Writer,
    ) -> futures_lite::future::Boxed<i32> {
        let cwd = env.cwd.to_string_lossy().to_string();
        Box::pin(async move {
            let (opts, remaining) = parse_common(&args);
            if opts.help {
                if let Some(help) = JsonCommands::show_help("jq") {
                    let _ = stdout.write_all(help.as_bytes()).await;
                    return 0;
                }
            }

            let mut raw_output = false;
            let mut positional: Vec<String> = Vec::new();
            let mut parser = make_parser(remaining);

            while let Some(arg) = parser.next().ok().flatten() {
                match arg {
                    Short('r') => raw_output = true,
                    Value(val) => positional.push(val.string().unwrap_or_default()),
                    _ => {}
                }
            }

            if positional.is_empty() {
                let _ = stderr.write_all(b"jq: missing filter\n").await;
                return 1;
            }

            let filter = &positional[0];
            let file = positional.get(1);

            // Read JSON input
            let input = if let Some(file_path) = file {
                let path = if file_path.starts_with('/') {
                    file_path.clone()
                } else {
                    format!("{}/{}", cwd, file_path)
                };

                match std::fs::read_to_string(&path) {
                    Ok(content) => content,
                    Err(e) => {
                        let msg = format!("jq: {}: {}\n", path, e);
                        let _ = stderr.write_all(msg.as_bytes()).await;
                        return 1;
                    }
                }
            } else {
                // Read from stdin
                let mut content = String::new();
                let reader = BufReader::new(stdin);
                let mut lines = reader.lines();
                while let Some(Ok(line)) = lines.next().await {
                    content.push_str(&line);
                    content.push('\n');
                }
                content
            };

            // Parse JSON
            let json: serde_json::Value = match serde_json::from_str(&input) {
                Ok(v) => v,
                Err(e) => {
                    let msg = format!("jq: parse error: {}\n", e);
                    let _ = stderr.write_all(msg.as_bytes()).await;
                    return 1;
                }
            };

            // Apply filter
            let result = match apply_jq_filter(&json, filter) {
                Ok(v) => v,
                Err(e) => {
                    let msg = format!("jq: {}\n", e);
                    let _ = stderr.write_all(msg.as_bytes()).await;
                    return 1;
                }
            };

            // Output result
            for value in result {
                let output = if raw_output {
                    match &value {
                        serde_json::Value::String(s) => s.clone(),
                        v => v.to_string(),
                    }
                } else {
                    serde_json::to_string_pretty(&value).unwrap_or_else(|_| value.to_string())
                };
                let _ = stdout.write_all(output.as_bytes()).await;
                let _ = stdout.write_all(b"\n").await;
            }

            0
        })
    }

    /// xargs - build and execute commands from stdin
    #[shell_command(
        name = "xargs",
        usage = "xargs [-n NUM] [-I REPLACE] COMMAND [ARGS]...",
        description = "Build and execute commands from stdin"
    )]
    fn cmd_xargs(
        args: Vec<String>,
        env: &ShellEnv,
        stdin: piper::Reader,
        mut stdout: piper::Writer,
        mut stderr: piper::Writer,
    ) -> futures_lite::future::Boxed<i32> {
        let env = env.clone();
        Box::pin(async move {
            let (opts, remaining) = parse_common(&args);
            if opts.help {
                if let Some(help) = JsonCommands::show_help("xargs") {
                    let _ = stdout.write_all(help.as_bytes()).await;
                    return 0;
                }
            }

            let mut max_args: Option<usize> = None;
            let mut replace_str: Option<String> = None;
            let mut command_args: Vec<String> = Vec::new();
            let mut in_options = true;

            let mut i = 0;
            while i < remaining.len() {
                if in_options {
                    match remaining[i].as_str() {
                        "-n" => {
                            i += 1;
                            if i < remaining.len() {
                                max_args = remaining[i].parse().ok();
                            }
                        }
                        "-I" => {
                            i += 1;
                            if i < remaining.len() {
                                replace_str = Some(remaining[i].clone());
                            }
                        }
                        s if s.starts_with('-') => {
                            // Skip unknown options
                        }
                        _ => {
                            in_options = false;
                            command_args.push(remaining[i].clone());
                        }
                    }
                } else {
                    command_args.push(remaining[i].clone());
                }
                i += 1;
            }

            if command_args.is_empty() {
                command_args.push("echo".to_string());
            }

            // Read items from stdin
            let mut items: Vec<String> = Vec::new();
            let reader = BufReader::new(stdin);
            let mut lines = reader.lines();

            while let Some(Ok(line)) = lines.next().await {
                for word in line.split_whitespace() {
                    items.push(word.to_string());
                }
            }

            if items.is_empty() {
                return 0;
            }

            // Execute the built commands
            if let Some(ref repl) = replace_str {
                // -I mode: one command per item, replacing the placeholder
                for item in &items {
                    let cmd_line: Vec<String> = command_args
                        .iter()
                        .map(|arg| arg.replace(repl, item))
                        .collect();
                    let code =
                        execute_xargs_cmd(&cmd_line, &env, &mut stdout, &mut stderr).await;
                    if code != 0 {
                        return code;
                    }
                }
            } else if let Some(n) = max_args {
                // -n mode: batch items
                for chunk in items.chunks(n) {
                    let mut cmd_line = command_args.clone();
                    cmd_line.extend(chunk.iter().cloned());
                    let code =
                        execute_xargs_cmd(&cmd_line, &env, &mut stdout, &mut stderr).await;
                    if code != 0 {
                        return code;
                    }
                }
            } else {
                // Default: all items in one command
                let mut cmd_line = command_args.clone();
                cmd_line.extend(items);
                return execute_xargs_cmd(&cmd_line, &env, &mut stdout, &mut stderr).await;
            }

            0
        })
    }
}

/// Execute a single command for xargs, with concurrent output draining
async fn execute_xargs_cmd(
    cmd_line: &[String],
    env: &ShellEnv,
    stdout: &mut piper::Writer,
    stderr: &mut piper::Writer,
) -> i32 {
    use futures::future::join;
    use futures_lite::io::AsyncReadExt;

    if cmd_line.is_empty() {
        return 0;
    }
    let cmd_name = &cmd_line[0];
    let cmd_args = cmd_line[1..].to_vec();

    if let Some(cmd_fn) = super::ShellCommands::get_command(cmd_name) {
        let (child_stdin_r, child_stdin_w) = piper::pipe(1024);
        let (child_stdout_r, child_stdout_w) = piper::pipe(65536);
        let (child_stderr_r, child_stderr_w) = piper::pipe(65536);
        drop(child_stdin_w); // No stdin for child command

        // Run command and drain outputs concurrently to avoid deadlocks
        let cmd = cmd_fn(cmd_args, env, child_stdin_r, child_stdout_w, child_stderr_w);
        let drain_out = async {
            let mut buf = Vec::new();
            let mut r = child_stdout_r;
            let _ = r.read_to_end(&mut buf).await;
            buf
        };
        let drain_err = async {
            let mut buf = Vec::new();
            let mut r = child_stderr_r;
            let _ = r.read_to_end(&mut buf).await;
            buf
        };

        let (code, (out_bytes, err_bytes)) = join(cmd, join(drain_out, drain_err)).await;

        if !out_bytes.is_empty() {
            let _ = stdout.write_all(&out_bytes).await;
        }
        if !err_bytes.is_empty() {
            let _ = stderr.write_all(&err_bytes).await;
        }

        code
    } else {
        let msg = format!("xargs: {}: command not found\n", cmd_name);
        let _ = stderr.write_all(msg.as_bytes()).await;
        127
    }
}

/// Apply a jq-style filter to a JSON value
fn apply_jq_filter(
    json: &serde_json::Value,
    filter: &str,
) -> Result<Vec<serde_json::Value>, String> {
    let filter = filter.trim();

    // Handle pipe chains: split on | and process sequentially
    if let Some((left, right)) = split_jq_pipe(filter) {
        let intermediate = apply_jq_filter(json, left.trim())?;
        let mut results = Vec::new();
        for item in &intermediate {
            let sub = apply_jq_filter(item, right.trim())?;
            results.extend(sub);
        }
        return Ok(results);
    }

    if filter == "." {
        return Ok(vec![json.clone()]);
    }

    if filter == "keys" {
        return match json {
            serde_json::Value::Object(map) => {
                let keys: Vec<serde_json::Value> = map
                    .keys()
                    .map(|k| serde_json::Value::String(k.clone()))
                    .collect();
                Ok(vec![serde_json::Value::Array(keys)])
            }
            serde_json::Value::Array(arr) => {
                let indices: Vec<serde_json::Value> = (0..arr.len())
                    .map(|i| serde_json::Value::Number(i.into()))
                    .collect();
                Ok(vec![serde_json::Value::Array(indices)])
            }
            _ => Err("keys: not an object or array".to_string()),
        };
    }

    if filter == "length" {
        return match json {
            serde_json::Value::Object(map) => Ok(vec![serde_json::json!(map.len())]),
            serde_json::Value::Array(arr) => Ok(vec![serde_json::json!(arr.len())]),
            serde_json::Value::String(s) => Ok(vec![serde_json::json!(s.len())]),
            serde_json::Value::Null => Ok(vec![serde_json::json!(0)]),
            _ => Err("length: not applicable".to_string()),
        };
    }

    if filter == "type" {
        let type_name = match json {
            serde_json::Value::Null => "null",
            serde_json::Value::Bool(_) => "boolean",
            serde_json::Value::Number(_) => "number",
            serde_json::Value::String(_) => "string",
            serde_json::Value::Array(_) => "array",
            serde_json::Value::Object(_) => "object",
        };
        return Ok(vec![serde_json::Value::String(type_name.to_string())]);
    }

    if filter == ".[]" {
        return match json {
            serde_json::Value::Array(arr) => Ok(arr.clone()),
            serde_json::Value::Object(map) => Ok(map.values().cloned().collect()),
            _ => Err(".[] requires an array or object".to_string()),
        };
    }

    // Handle .[].field or .[].field1.field2 — iterate then access fields on each element
    if let Some(rest) = filter.strip_prefix(".[].") {
        let items = match json {
            serde_json::Value::Array(arr) => arr.clone(),
            serde_json::Value::Object(map) => map.values().cloned().collect(),
            _ => return Err(".[].field requires an array or object".to_string()),
        };
        let sub_filter = format!(".{}", rest);
        let mut results = Vec::new();
        for item in &items {
            let sub = apply_jq_filter(item, &sub_filter)?;
            results.extend(sub);
        }
        return Ok(results);
    }

    // select(.field op value) — filter
    if filter.starts_with("select(") && filter.ends_with(')') {
        let inner = &filter[7..filter.len() - 1];
        let matches = evaluate_jq_condition(json, inner)?;
        if matches {
            return Ok(vec![json.clone()]);
        } else {
            return Ok(vec![]);
        }
    }

    // has("key") — check if key exists
    if filter.starts_with("has(") && filter.ends_with(')') {
        let inner = &filter[4..filter.len() - 1].trim();
        let key = inner.trim_matches('"');
        let result = match json {
            serde_json::Value::Object(map) => map.contains_key(key),
            serde_json::Value::Array(arr) => {
                if let Ok(idx) = key.parse::<usize>() {
                    idx < arr.len()
                } else {
                    false
                }
            }
            _ => false,
        };
        return Ok(vec![serde_json::Value::Bool(result)]);
    }

    // map(expr) — apply expr to each element
    if filter.starts_with("map(") && filter.ends_with(')') {
        let inner = &filter[4..filter.len() - 1];
        return match json {
            serde_json::Value::Array(arr) => {
                let mut results = Vec::new();
                for item in arr {
                    let sub = apply_jq_map_expr(item, inner.trim())?;
                    results.push(sub);
                }
                Ok(vec![serde_json::Value::Array(results)])
            }
            _ => Err("map requires an array".to_string()),
        };
    }

    // Handle field access: .field or .field1.field2
    if filter.starts_with('.') {
        let path = &filter[1..];
        let mut current = json;

        for part in path.split('.') {
            if part.is_empty() {
                continue;
            }

            // Check for array index: [n]
            if let Some(bracket_start) = part.find('[') {
                let field = &part[..bracket_start];
                let rest = &part[bracket_start..];

                // Access field first if present
                if !field.is_empty() {
                    current = match current.get(field) {
                        Some(v) => v,
                        None => return Ok(vec![serde_json::Value::Null]),
                    };
                }

                // Then handle bracket(s)
                let mut temp = current;
                for cap in rest.split('[').skip(1) {
                    if let Some(idx_str) = cap.strip_suffix(']') {
                        if let Ok(idx) = idx_str.parse::<usize>() {
                            temp = match temp.get(idx) {
                                Some(v) => v,
                                None => return Ok(vec![serde_json::Value::Null]),
                            };
                        }
                    }
                }
                current = temp;
            } else {
                current = match current.get(part) {
                    Some(v) => v,
                    None => return Ok(vec![serde_json::Value::Null]),
                };
            }
        }

        return Ok(vec![current.clone()]);
    }

    Err(format!("unsupported filter: {}", filter))
}

/// Split a jq filter on the top-level pipe character, respecting parentheses
fn split_jq_pipe(filter: &str) -> Option<(&str, &str)> {
    let mut paren_depth = 0;
    let mut bracket_depth = 0;
    let mut in_string = false;
    let bytes = filter.as_bytes();

    for i in 0..bytes.len() {
        match bytes[i] {
            b'"' if !in_string => in_string = true,
            b'"' if in_string => in_string = false,
            b'(' if !in_string => paren_depth += 1,
            b')' if !in_string => paren_depth -= 1,
            b'[' if !in_string => bracket_depth += 1,
            b']' if !in_string => bracket_depth -= 1,
            b'|' if !in_string && paren_depth == 0 && bracket_depth == 0 => {
                return Some((&filter[..i], &filter[i + 1..]));
            }
            _ => {}
        }
    }
    None
}

/// Evaluate a simple jq condition (for select)
fn evaluate_jq_condition(json: &serde_json::Value, condition: &str) -> Result<bool, String> {
    let condition = condition.trim();

    // Parse: .field op value
    // Operators: >, <, >=, <=, ==, !=
    let ops = [">=", "<=", "!=", "==", ">", "<"];
    for op in &ops {
        if let Some(pos) = condition.find(op) {
            let left_expr = condition[..pos].trim();
            let right_expr = condition[pos + op.len()..].trim();

            // Evaluate left side
            let left_vals = apply_jq_filter(json, left_expr)?;
            let left_val = left_vals.first().cloned().unwrap_or(serde_json::Value::Null);

            // Parse right side as a value
            let right_val = parse_jq_literal(right_expr);

            return Ok(compare_jq_values(&left_val, *op, &right_val));
        }
    }

    // Just a field access as boolean
    let vals = apply_jq_filter(json, condition)?;
    Ok(vals
        .first()
        .map(|v| match v {
            serde_json::Value::Bool(b) => *b,
            serde_json::Value::Null => false,
            _ => true,
        })
        .unwrap_or(false))
}

/// Parse a literal value in a jq expression
fn parse_jq_literal(s: &str) -> serde_json::Value {
    let s = s.trim();
    // Try string (quoted)
    if (s.starts_with('"') && s.ends_with('"')) || (s.starts_with('\\') && s.contains('"')) {
        let unquoted = s.trim_matches('"').trim_start_matches("\\\"").trim_end_matches("\\\"");
        // Also handle escaped quotes within
        let clean = s.trim_matches(|c| c == '"' || c == '\\');
        if !clean.is_empty() {
            return serde_json::Value::String(clean.to_string());
        }
        return serde_json::Value::String(unquoted.to_string());
    }
    // Try number
    if let Ok(n) = s.parse::<i64>() {
        return serde_json::json!(n);
    }
    if let Ok(n) = s.parse::<f64>() {
        return serde_json::json!(n);
    }
    // Try bool/null
    match s {
        "true" => serde_json::Value::Bool(true),
        "false" => serde_json::Value::Bool(false),
        "null" => serde_json::Value::Null,
        _ => serde_json::Value::String(s.to_string()),
    }
}

/// Compare two jq values with an operator
fn compare_jq_values(left: &serde_json::Value, op: &str, right: &serde_json::Value) -> bool {
    // Numeric comparison
    let left_num = match left {
        serde_json::Value::Number(n) => n.as_f64(),
        _ => None,
    };
    let right_num = match right {
        serde_json::Value::Number(n) => n.as_f64(),
        _ => None,
    };

    if let (Some(l), Some(r)) = (left_num, right_num) {
        return match op {
            ">" => l > r,
            "<" => l < r,
            ">=" => l >= r,
            "<=" => l <= r,
            "==" => (l - r).abs() < f64::EPSILON,
            "!=" => (l - r).abs() >= f64::EPSILON,
            _ => false,
        };
    }

    // String comparison
    let left_str = match left {
        serde_json::Value::String(s) => Some(s.as_str()),
        _ => None,
    };
    let right_str = match right {
        serde_json::Value::String(s) => Some(s.as_str()),
        _ => None,
    };

    if let (Some(l), Some(r)) = (left_str, right_str) {
        return match op {
            "==" => l == r,
            "!=" => l != r,
            ">" => l > r,
            "<" => l < r,
            ">=" => l >= r,
            "<=" => l <= r,
            _ => false,
        };
    }

    // General equality
    match op {
        "==" => left == right,
        "!=" => left != right,
        _ => false,
    }
}

/// Apply a simple map expression (. * N, . + N, etc.)
fn apply_jq_map_expr(
    item: &serde_json::Value,
    expr: &str,
) -> Result<serde_json::Value, String> {
    let expr = expr.trim();

    // Handle ". * N" or ". + N"
    let ops = ["*", "+", "-", "/"];
    for op in &ops {
        if let Some(pos) = expr.find(op) {
            let left = expr[..pos].trim();
            let right = expr[pos + 1..].trim();

            if left == "." {
                let item_num = match item {
                    serde_json::Value::Number(n) => n.as_f64().unwrap_or(0.0),
                    _ => return Ok(item.clone()),
                };
                let right_num: f64 = right.parse().unwrap_or(0.0);
                let result = match *op {
                    "*" => item_num * right_num,
                    "+" => item_num + right_num,
                    "-" => item_num - right_num,
                    "/" => {
                        if right_num != 0.0 {
                            item_num / right_num
                        } else {
                            0.0
                        }
                    }
                    _ => item_num,
                };
                // Return as integer if possible
                if result == result.floor() && result.abs() < i64::MAX as f64 {
                    return Ok(serde_json::json!(result as i64));
                }
                return Ok(serde_json::json!(result));
            }
        }
    }

    // Simple field access
    apply_jq_filter(item, expr).map(|v| v.into_iter().next().unwrap_or(serde_json::Value::Null))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_jq_identity() {
        let data = json!({"a": 1});
        let result = apply_jq_filter(&data, ".").unwrap();
        assert_eq!(result, vec![data]);
    }

    #[test]
    fn test_jq_field_access() {
        let data = json!({"name": "test", "count": 5});
        let result = apply_jq_filter(&data, ".name").unwrap();
        assert_eq!(result, vec![json!("test")]);
    }

    #[test]
    fn test_jq_nested_field() {
        let data = json!({"user": {"name": "alice"}});
        let result = apply_jq_filter(&data, ".user.name").unwrap();
        assert_eq!(result, vec![json!("alice")]);
    }

    #[test]
    fn test_jq_array_index() {
        let data = json!({"items": [1, 2, 3]});
        let result = apply_jq_filter(&data, ".items[1]").unwrap();
        assert_eq!(result, vec![json!(2)]);
    }

    #[test]
    fn test_jq_keys() {
        let data = json!({"a": 1, "b": 2});
        let result = apply_jq_filter(&data, "keys").unwrap();
        assert_eq!(result.len(), 1);
        if let serde_json::Value::Array(keys) = &result[0] {
            assert!(keys.contains(&json!("a")));
            assert!(keys.contains(&json!("b")));
        } else {
            panic!("Expected array");
        }
    }

    #[test]
    fn test_jq_length() {
        let arr = json!([1, 2, 3, 4]);
        let result = apply_jq_filter(&arr, "length").unwrap();
        assert_eq!(result, vec![json!(4)]);

        let obj = json!({"a": 1, "b": 2});
        let result = apply_jq_filter(&obj, "length").unwrap();
        assert_eq!(result, vec![json!(2)]);
    }

    #[test]
    fn test_jq_iterate() {
        let data = json!([1, 2, 3]);
        let result = apply_jq_filter(&data, ".[]").unwrap();
        assert_eq!(result, vec![json!(1), json!(2), json!(3)]);
    }

    #[test]
    fn test_jq_null_for_missing() {
        let data = json!({"a": 1});
        let result = apply_jq_filter(&data, ".missing").unwrap();
        assert_eq!(result, vec![serde_json::Value::Null]);
    }

    #[test]
    fn test_jq_unsupported() {
        let data = json!({});
        let result = apply_jq_filter(&data, "some_unknown_func()");
        assert!(result.is_err());
    }
}
