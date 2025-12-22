//! JSON and pipeline commands: jq, xargs

use futures_lite::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use futures_lite::StreamExt;
use lexopt::prelude::*;
use runtime_macros::{shell_command, shell_commands};

use super::super::ShellEnv;
use super::{make_parser, parse_common, CommandFn};

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
        description = "Build arguments from stdin and output the command"
    )]
    fn cmd_xargs(
        args: Vec<String>,
        _env: &ShellEnv,
        stdin: piper::Reader,
        mut stdout: piper::Writer,
        mut stderr: piper::Writer,
    ) -> futures_lite::future::Boxed<i32> {
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
            
            // Output the command(s) that would be executed
            // In a full implementation, we'd actually execute these
            if let Some(ref repl) = replace_str {
                // -I mode: one command per item, replacing the placeholder
                for item in &items {
                    let cmd_line: Vec<String> = command_args.iter()
                        .map(|arg| arg.replace(repl, item))
                        .collect();
                    let _ = stdout.write_all(cmd_line.join(" ").as_bytes()).await;
                    let _ = stdout.write_all(b"\n").await;
                }
            } else if let Some(n) = max_args {
                // -n mode: batch items
                for chunk in items.chunks(n) {
                    let mut cmd_line = command_args.clone();
                    cmd_line.extend(chunk.iter().cloned());
                    let _ = stdout.write_all(cmd_line.join(" ").as_bytes()).await;
                    let _ = stdout.write_all(b"\n").await;
                }
            } else {
                // Default: all items in one command
                let mut cmd_line = command_args.clone();
                cmd_line.extend(items);
                let _ = stdout.write_all(cmd_line.join(" ").as_bytes()).await;
                let _ = stdout.write_all(b"\n").await;
            }
            
            0
        })
    }
}

/// Apply a jq-style filter to a JSON value
fn apply_jq_filter(json: &serde_json::Value, filter: &str) -> Result<Vec<serde_json::Value>, String> {
    let filter = filter.trim();
    
    if filter == "." {
        return Ok(vec![json.clone()]);
    }
    
    if filter == "keys" {
        return match json {
            serde_json::Value::Object(map) => {
                let keys: Vec<serde_json::Value> = map.keys()
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
    
    if filter == ".[]" {
        return match json {
            serde_json::Value::Array(arr) => Ok(arr.clone()),
            serde_json::Value::Object(map) => Ok(map.values().cloned().collect()),
            _ => Err(".[] requires an array or object".to_string()),
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
        let result = apply_jq_filter(&data, "select(.x > 1)");
        assert!(result.is_err());
    }
}
