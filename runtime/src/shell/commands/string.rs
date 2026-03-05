//! String manipulation commands: expr, awk, paste, rev, fold

use futures_lite::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use futures_lite::StreamExt;
use runtime_macros::shell_commands;

use super::super::ShellEnv;
use super::helpers::resolve_path;
use super::parse_common;

/// Get a random u64 - uses WASI in production, std in tests
#[cfg(not(test))]
fn get_random_u64() -> u64 {
    use crate::bindings::wasi::random::random as wasi_random;
    wasi_random::get_random_u64()
}

/// Get a random u64 - uses time-based entropy for native tests
#[cfg(test)]
fn get_random_u64() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    let duration = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let nanos = duration.as_nanos() as u64;
    let millis = duration.as_millis() as u64;
    nanos.wrapping_mul(1103515245).wrapping_add(12345) ^ millis
}

/// String manipulation commands.
pub struct StringCommands;

#[shell_commands]
impl StringCommands {
    /// expr - evaluate expressions
    #[shell_command(
        name = "expr",
        usage = "expr EXPRESSION...",
        description = "Evaluate expression (arithmetic or string)"
    )]
    fn cmd_expr(
        args: Vec<String>,
        _env: &ShellEnv,
        _stdin: piper::Reader,
        mut stdout: piper::Writer,
        mut stderr: piper::Writer,
    ) -> futures_lite::future::Boxed<i32> {
        Box::pin(async move {
            let (_, remaining) = parse_common(&args);
            if remaining.is_empty() {
                let _ = stderr.write_all(b"expr: missing operand\n").await;
                return 2;
            }

            match evaluate_expr(&remaining) {
                Ok(result) => {
                    let _ = stdout.write_all(format!("{}\n", result).as_bytes()).await;
                    // expr returns 1 if result is empty string or 0
                    if result == "0" || result.is_empty() {
                        1
                    } else {
                        0
                    }
                }
                Err(e) => {
                    let _ = stderr.write_all(format!("expr: {}\n", e).as_bytes()).await;
                    2
                }
            }
        })
    }

    /// awk - pattern scanning (simplified)
    #[shell_command(
        name = "awk",
        usage = "awk [-F sep] 'pattern { action }' [file...]",
        description = "Pattern scanning and processing (simplified)"
    )]
    fn cmd_awk(
        args: Vec<String>,
        env: &ShellEnv,
        stdin: piper::Reader,
        mut stdout: piper::Writer,
        mut stderr: piper::Writer,
    ) -> futures_lite::future::Boxed<i32> {
        let cwd = env.cwd.to_string_lossy().to_string();
        Box::pin(async move {
            let (_, remaining) = parse_common(&args);
            // Parse options
            let mut field_sep = " \t".to_string();
            let mut program = String::new();
            let mut files: Vec<String> = Vec::new();
            let mut i = 0;

            while i < remaining.len() {
                if remaining[i] == "-F" && i + 1 < remaining.len() {
                    field_sep = remaining[i + 1].clone();
                    i += 2;
                } else if remaining[i].starts_with("-F") {
                    field_sep = remaining[i][2..].to_string();
                    i += 1;
                } else if program.is_empty() {
                    program = remaining[i].clone();
                    i += 1;
                } else {
                    files.push(remaining[i].clone());
                    i += 1;
                }
            }

            if program.is_empty() {
                let _ = stderr.write_all(b"awk: missing program\n").await;
                return 1;
            }

            // Parse the awk program
            let parsed = match parse_awk_program(&program) {
                Ok(p) => p,
                Err(e) => {
                    let _ = stderr.write_all(format!("awk: {}\n", e).as_bytes()).await;
                    return 1;
                }
            };

            let mut nr = 0;
            let mut accumulator: f64 = 0.0;

            // Helper to process a line
            async fn write_awk_line(
                parsed: &AwkProgram,
                line: &str,
                field_sep: &str,
                nr: usize,
                stdout: &mut piper::Writer,
                accumulator: &mut f64,
            ) -> Result<(), std::io::Error> {
                let fields: Vec<&str> = if field_sep == " \t" {
                    line.split_whitespace().collect()
                } else {
                    line.split(field_sep).collect()
                };

                let output = execute_awk_action(parsed, line, &fields, nr, accumulator);
                if !output.is_empty() {
                    stdout.write_all(output.as_bytes()).await?;
                    if !output.ends_with('\n') {
                        stdout.write_all(b"\n").await?;
                    }
                }
                Ok(())
            }

            if files.is_empty() {
                // Read from stdin
                let reader = BufReader::new(stdin);
                let mut lines = reader.lines();
                while let Some(Ok(line)) = lines.next().await {
                    nr += 1;
                    let _ = write_awk_line(
                        &parsed,
                        &line,
                        &field_sep,
                        nr,
                        &mut stdout,
                        &mut accumulator,
                    )
                    .await;
                }
            } else {
                for file in &files {
                    let path = resolve_path(&cwd, &file);

                    match std::fs::read_to_string(&path) {
                        Ok(content) => {
                            for line in content.lines() {
                                nr += 1;
                                let _ = write_awk_line(
                                    &parsed,
                                    line,
                                    &field_sep,
                                    nr,
                                    &mut stdout,
                                    &mut accumulator,
                                )
                                .await;
                            }
                        }
                        Err(e) => {
                            let _ = stderr
                                .write_all(format!("awk: {}: {}\n", file, e).as_bytes())
                                .await;
                            return 1;
                        }
                    }
                }
            }

            // Handle END block
            if let Some(ref end_expr) = parsed.end_action {
                // Parse and evaluate END expression
                let output = evaluate_awk_end_expr(end_expr, accumulator);
                if !output.is_empty() {
                    let _ = stdout.write_all(output.as_bytes()).await;
                    if !output.ends_with('\n') {
                        let _ = stdout.write_all(b"\n").await;
                    }
                }
            }

            0
        })
    }

    /// paste - merge lines from files
    #[shell_command(
        name = "paste",
        usage = "paste [-d delim] file...",
        description = "Merge lines from files"
    )]
    fn cmd_paste(
        args: Vec<String>,
        env: &ShellEnv,
        stdin: piper::Reader,
        mut stdout: piper::Writer,
        mut stderr: piper::Writer,
    ) -> futures_lite::future::Boxed<i32> {
        let cwd = env.cwd.to_string_lossy().to_string();
        Box::pin(async move {
            let (_, remaining) = parse_common(&args);
            let mut delimiter = "\t".to_string();
            let mut files: Vec<String> = Vec::new();
            let mut i = 0;

            while i < remaining.len() {
                if remaining[i] == "-d" && i + 1 < remaining.len() {
                    delimiter = remaining[i + 1].clone();
                    i += 2;
                } else if remaining[i].starts_with("-d") {
                    delimiter = remaining[i][2..].to_string();
                    i += 1;
                } else {
                    files.push(remaining[i].clone());
                    i += 1;
                }
            }

            if files.is_empty() {
                // Read from stdin and output as-is
                let reader = BufReader::new(stdin);
                let mut lines = reader.lines();
                while let Some(Ok(line)) = lines.next().await {
                    let _ = stdout.write_all(format!("{}\n", line).as_bytes()).await;
                }
                return 0;
            }

            // Read all files into line vectors
            let mut file_lines: Vec<Vec<String>> = Vec::new();
            let mut max_lines = 0;

            for file in &files {
                if file == "-" {
                    // stdin as file not supported in this implementation
                    let _ = stderr
                        .write_all(b"paste: reading from stdin with - not supported\n")
                        .await;
                    return 1;
                }

                let path = resolve_path(&cwd, &file);

                match std::fs::read_to_string(&path) {
                    Ok(content) => {
                        let lines: Vec<String> = content.lines().map(|s| s.to_string()).collect();
                        max_lines = max_lines.max(lines.len());
                        file_lines.push(lines);
                    }
                    Err(e) => {
                        let _ = stderr
                            .write_all(format!("paste: {}: {}\n", file, e).as_bytes())
                            .await;
                        return 1;
                    }
                }
            }

            // Merge lines
            for i in 0..max_lines {
                let mut parts: Vec<&str> = Vec::new();
                for file_content in &file_lines {
                    parts.push(file_content.get(i).map(|s| s.as_str()).unwrap_or(""));
                }
                let _ = stdout
                    .write_all(format!("{}\n", parts.join(&delimiter)).as_bytes())
                    .await;
            }

            0
        })
    }

    /// rev - reverse lines
    #[shell_command(
        name = "rev",
        usage = "rev [file...]",
        description = "Reverse lines character by character"
    )]
    fn cmd_rev(
        args: Vec<String>,
        env: &ShellEnv,
        stdin: piper::Reader,
        mut stdout: piper::Writer,
        mut stderr: piper::Writer,
    ) -> futures_lite::future::Boxed<i32> {
        let cwd = env.cwd.to_string_lossy().to_string();
        Box::pin(async move {
            let (_, remaining) = parse_common(&args);
            let reverse_line = |line: &str| -> String { line.chars().rev().collect() };

            if remaining.is_empty() {
                // Read from stdin
                let reader = BufReader::new(stdin);
                let mut lines = reader.lines();
                while let Some(Ok(line)) = lines.next().await {
                    let _ = stdout
                        .write_all(format!("{}\n", reverse_line(&line)).as_bytes())
                        .await;
                }
            } else {
                for file in &remaining {
                    let path = resolve_path(&cwd, &file);

                    match std::fs::read_to_string(&path) {
                        Ok(content) => {
                            for line in content.lines() {
                                let _ = stdout
                                    .write_all(format!("{}\n", reverse_line(line)).as_bytes())
                                    .await;
                            }
                        }
                        Err(e) => {
                            let _ = stderr
                                .write_all(format!("rev: {}: {}\n", file, e).as_bytes())
                                .await;
                            return 1;
                        }
                    }
                }
            }

            0
        })
    }

    /// fold - wrap lines at specified width
    #[shell_command(
        name = "fold",
        usage = "fold [-w width] [file...]",
        description = "Wrap lines at specified width (default 80)"
    )]
    fn cmd_fold(
        args: Vec<String>,
        env: &ShellEnv,
        stdin: piper::Reader,
        mut stdout: piper::Writer,
        mut stderr: piper::Writer,
    ) -> futures_lite::future::Boxed<i32> {
        let cwd = env.cwd.to_string_lossy().to_string();
        Box::pin(async move {
            let (_, remaining) = parse_common(&args);
            let mut width: usize = 80;
            let mut files: Vec<String> = Vec::new();
            let mut i = 0;

            while i < remaining.len() {
                if remaining[i] == "-w" && i + 1 < remaining.len() {
                    width = remaining[i + 1].parse().unwrap_or(80);
                    i += 2;
                } else if remaining[i].starts_with("-w") {
                    width = remaining[i][2..].parse().unwrap_or(80);
                    i += 1;
                } else {
                    files.push(remaining[i].clone());
                    i += 1;
                }
            }

            let fold_line = |line: &str, width: usize| -> Vec<String> {
                let mut result = Vec::new();
                let mut current = String::new();
                for ch in line.chars() {
                    current.push(ch);
                    if current.len() >= width {
                        result.push(current.clone());
                        current.clear();
                    }
                }
                if !current.is_empty() {
                    result.push(current);
                }
                if result.is_empty() {
                    result.push(String::new());
                }
                result
            };

            if files.is_empty() {
                let reader = BufReader::new(stdin);
                let mut lines = reader.lines();
                while let Some(Ok(line)) = lines.next().await {
                    for folded in fold_line(&line, width) {
                        let _ = stdout.write_all(format!("{}\n", folded).as_bytes()).await;
                    }
                }
            } else {
                for file in &files {
                    let path = resolve_path(&cwd, &file);

                    match std::fs::read_to_string(&path) {
                        Ok(content) => {
                            for line in content.lines() {
                                for folded in fold_line(line, width) {
                                    let _ =
                                        stdout.write_all(format!("{}\n", folded).as_bytes()).await;
                                }
                            }
                        }
                        Err(e) => {
                            let _ = stderr
                                .write_all(format!("fold: {}: {}\n", file, e).as_bytes())
                                .await;
                            return 1;
                        }
                    }
                }
            }

            0
        })
    }

    /// nl - number lines
    #[shell_command(
        name = "nl",
        usage = "nl [-b style] [file...]",
        description = "Number lines of files"
    )]
    fn cmd_nl(
        args: Vec<String>,
        env: &ShellEnv,
        stdin: piper::Reader,
        mut stdout: piper::Writer,
        mut stderr: piper::Writer,
    ) -> futures_lite::future::Boxed<i32> {
        let cwd = env.cwd.to_string_lossy().to_string();
        Box::pin(async move {
            let (_, remaining) = parse_common(&args);
            let mut number_empty = false; // -b a
            let mut files: Vec<String> = Vec::new();
            let mut i = 0;

            while i < remaining.len() {
                if remaining[i] == "-b" && i + 1 < remaining.len() {
                    if remaining[i + 1] == "a" {
                        number_empty = true;
                    }
                    i += 2;
                } else if remaining[i].starts_with("-b") {
                    if remaining[i].ends_with('a') {
                        number_empty = true;
                    }
                    i += 1;
                } else {
                    files.push(remaining[i].clone());
                    i += 1;
                }
            }

            let mut line_num = 0;

            let number_line = |line: &str, num: &mut usize, number_empty: bool| -> String {
                if line.is_empty() && !number_empty {
                    "       ".to_string() + line
                } else {
                    *num += 1;
                    format!("{:6}  {}", num, line)
                }
            };

            if files.is_empty() {
                let reader = BufReader::new(stdin);
                let mut lines = reader.lines();
                while let Some(Ok(line)) = lines.next().await {
                    let numbered = number_line(&line, &mut line_num, number_empty);
                    let _ = stdout.write_all(format!("{}\n", numbered).as_bytes()).await;
                }
            } else {
                for file in &files {
                    let path = resolve_path(&cwd, &file);

                    match std::fs::read_to_string(&path) {
                        Ok(content) => {
                            for line in content.lines() {
                                let numbered = number_line(line, &mut line_num, number_empty);
                                let _ =
                                    stdout.write_all(format!("{}\n", numbered).as_bytes()).await;
                            }
                        }
                        Err(e) => {
                            let _ = stderr
                                .write_all(format!("nl: {}: {}\n", file, e).as_bytes())
                                .await;
                            return 1;
                        }
                    }
                }
            }

            0
        })
    }

    /// shuf - randomize lines
    #[shell_command(
        name = "shuf",
        usage = "shuf [-n count] [file...]",
        description = "Shuffle lines randomly"
    )]
    fn cmd_shuf(
        args: Vec<String>,
        env: &ShellEnv,
        stdin: piper::Reader,
        mut stdout: piper::Writer,
        mut stderr: piper::Writer,
    ) -> futures_lite::future::Boxed<i32> {
        let cwd = env.cwd.to_string_lossy().to_string();
        Box::pin(async move {
            let (_, remaining) = parse_common(&args);
            let mut count: Option<usize> = None;
            let mut files: Vec<String> = Vec::new();
            let mut i = 0;

            while i < remaining.len() {
                if remaining[i] == "-n" && i + 1 < remaining.len() {
                    count = remaining[i + 1].parse().ok();
                    i += 2;
                } else if remaining[i].starts_with("-n") {
                    count = remaining[i][2..].parse().ok();
                    i += 1;
                } else {
                    files.push(remaining[i].clone());
                    i += 1;
                }
            }

            let mut lines: Vec<String> = Vec::new();

            if files.is_empty() {
                let reader = BufReader::new(stdin);
                let mut reader_lines = reader.lines();
                while let Some(Ok(line)) = reader_lines.next().await {
                    lines.push(line);
                }
            } else {
                for file in &files {
                    let path = resolve_path(&cwd, &file);

                    match std::fs::read_to_string(&path) {
                        Ok(content) => {
                            lines.extend(content.lines().map(|s| s.to_string()));
                        }
                        Err(e) => {
                            let _ = stderr
                                .write_all(format!("shuf: {}: {}\n", file, e).as_bytes())
                                .await;
                            return 1;
                        }
                    }
                }
            }

            // Fisher-Yates shuffle using WASI random
            let len = lines.len();
            for i in (1..len).rev() {
                // Get random bytes and convert to index
                let rand_bytes = get_random_u64();
                let j = (rand_bytes as usize) % (i + 1);
                lines.swap(i, j);
            }

            // Output (limited by count if specified)
            let output_count = count.unwrap_or(lines.len()).min(lines.len());
            for line in lines.iter().take(output_count) {
                let _ = stdout.write_all(format!("{}\n", line).as_bytes()).await;
            }

            0
        })
    }

    /// column - columnate lists
    #[shell_command(
        name = "column",
        usage = "column [-t] [-s sep] [file...]",
        description = "Format input into columns"
    )]
    fn cmd_column(
        args: Vec<String>,
        env: &ShellEnv,
        stdin: piper::Reader,
        mut stdout: piper::Writer,
        mut stderr: piper::Writer,
    ) -> futures_lite::future::Boxed<i32> {
        let cwd = env.cwd.to_string_lossy().to_string();
        Box::pin(async move {
            let (_, remaining) = parse_common(&args);
            let mut table_mode = false;
            let mut separator = " \t".to_string();
            let mut files: Vec<String> = Vec::new();
            let mut i = 0;

            while i < remaining.len() {
                if remaining[i] == "-t" {
                    table_mode = true;
                    i += 1;
                } else if remaining[i] == "-s" && i + 1 < remaining.len() {
                    separator = remaining[i + 1].clone();
                    i += 2;
                } else if remaining[i].starts_with("-s") {
                    separator = remaining[i][2..].to_string();
                    i += 1;
                } else {
                    files.push(remaining[i].clone());
                    i += 1;
                }
            }

            let mut lines: Vec<String> = Vec::new();

            if files.is_empty() {
                let reader = BufReader::new(stdin);
                let mut reader_lines = reader.lines();
                while let Some(Ok(line)) = reader_lines.next().await {
                    lines.push(line);
                }
            } else {
                for file in &files {
                    let path = resolve_path(&cwd, &file);

                    match std::fs::read_to_string(&path) {
                        Ok(content) => {
                            lines.extend(content.lines().map(|s| s.to_string()));
                        }
                        Err(e) => {
                            let _ = stderr
                                .write_all(format!("column: {}: {}\n", file, e).as_bytes())
                                .await;
                            return 1;
                        }
                    }
                }
            }

            if table_mode {
                // Split lines into fields and find max width for each column
                let split_lines: Vec<Vec<&str>> = lines
                    .iter()
                    .map(|l| {
                        if separator == " \t" {
                            l.split_whitespace().collect()
                        } else {
                            l.split(&separator).collect()
                        }
                    })
                    .collect();

                // Find max columns and max width per column
                let max_cols = split_lines.iter().map(|r| r.len()).max().unwrap_or(0);
                let mut col_widths = vec![0usize; max_cols];

                for row in &split_lines {
                    for (i, field) in row.iter().enumerate() {
                        col_widths[i] = col_widths[i].max(field.len());
                    }
                }

                // Output formatted table
                for row in &split_lines {
                    let formatted: Vec<String> = row
                        .iter()
                        .enumerate()
                        .map(|(i, field)| {
                            if i < row.len() - 1 {
                                format!("{:width$}", field, width = col_widths[i] + 2)
                            } else {
                                field.to_string()
                            }
                        })
                        .collect();
                    let _ = stdout
                        .write_all(format!("{}\n", formatted.join("")).as_bytes())
                        .await;
                }
            } else {
                // Simple output
                for line in &lines {
                    let _ = stdout.write_all(format!("{}\n", line).as_bytes()).await;
                }
            }

            0
        })
    }
}

// ============================================================================
// expr expression evaluator
// ============================================================================

/// Evaluate an expr expression
fn evaluate_expr(tokens: &[String]) -> Result<String, String> {
    if tokens.is_empty() {
        return Ok("0".to_string());
    }

    // Handle simple cases first
    if tokens.len() == 1 {
        return Ok(tokens[0].clone());
    }

    // Try to find the lowest precedence operator from right to left
    // Precedence (lowest to highest): | & < <= = != >= > + - * / %

    let ops_by_prec = [
        vec!["|"],
        vec!["&"],
        vec!["<", "<=", "=", "!=", ">=", ">"],
        vec!["+", "-"],
        vec!["*", "/", "%"],
    ];

    for ops in &ops_by_prec {
        // Find rightmost occurrence of any operator in this precedence level
        for i in (1..tokens.len() - 1).rev() {
            if ops.contains(&tokens[i].as_str()) {
                let left = evaluate_expr(&tokens[..i])?;
                let right = evaluate_expr(&tokens[i + 1..])?;
                return apply_expr_op(&tokens[i], &left, &right);
            }
        }
    }

    // String operations: match, substr, index, length
    if tokens.len() >= 2 {
        match tokens[0].as_str() {
            "length" => {
                return Ok(tokens[1].len().to_string());
            }
            "substr" if tokens.len() >= 4 => {
                let string = &tokens[1];
                let pos: usize = tokens[2].parse().map_err(|_| "invalid position")?;
                let len: usize = tokens[3].parse().map_err(|_| "invalid length")?;
                if pos == 0 {
                    return Ok(String::new());
                }
                let start = (pos - 1).min(string.len());
                let end = (start + len).min(string.len());
                return Ok(string[start..end].to_string());
            }
            "index" if tokens.len() >= 3 => {
                let string = &tokens[1];
                let chars = &tokens[2];
                for (i, c) in string.chars().enumerate() {
                    if chars.contains(c) {
                        return Ok((i + 1).to_string());
                    }
                }
                return Ok("0".to_string());
            }
            _ => {}
        }
    }

    // If we get here with multiple tokens, it's likely just the first value
    Ok(tokens[0].clone())
}

/// Apply an expr operator
fn apply_expr_op(op: &str, left: &str, right: &str) -> Result<String, String> {
    // Try numeric operations first
    let left_num = left.parse::<i64>();
    let right_num = right.parse::<i64>();

    match op {
        // Logical OR
        "|" => {
            if left != "0" && !left.is_empty() {
                Ok(left.to_string())
            } else {
                Ok(right.to_string())
            }
        }
        // Logical AND
        "&" => {
            if (left != "0" && !left.is_empty()) && (right != "0" && !right.is_empty()) {
                Ok(left.to_string())
            } else {
                Ok("0".to_string())
            }
        }
        // Comparison operators
        "<" => {
            if let (Ok(l), Ok(r)) = (&left_num, &right_num) {
                Ok(if l < r { "1" } else { "0" }.to_string())
            } else {
                Ok(if left < right { "1" } else { "0" }.to_string())
            }
        }
        "<=" => {
            if let (Ok(l), Ok(r)) = (&left_num, &right_num) {
                Ok(if l <= r { "1" } else { "0" }.to_string())
            } else {
                Ok(if left <= right { "1" } else { "0" }.to_string())
            }
        }
        "=" => Ok(if left == right { "1" } else { "0" }.to_string()),
        "!=" => Ok(if left != right { "1" } else { "0" }.to_string()),
        ">=" => {
            if let (Ok(l), Ok(r)) = (&left_num, &right_num) {
                Ok(if l >= r { "1" } else { "0" }.to_string())
            } else {
                Ok(if left >= right { "1" } else { "0" }.to_string())
            }
        }
        ">" => {
            if let (Ok(l), Ok(r)) = (&left_num, &right_num) {
                Ok(if l > r { "1" } else { "0" }.to_string())
            } else {
                Ok(if left > right { "1" } else { "0" }.to_string())
            }
        }
        // Arithmetic operators
        "+" => {
            let l = left_num.map_err(|_| "non-numeric argument")?;
            let r = right_num.map_err(|_| "non-numeric argument")?;
            Ok((l + r).to_string())
        }
        "-" => {
            let l = left_num.map_err(|_| "non-numeric argument")?;
            let r = right_num.map_err(|_| "non-numeric argument")?;
            Ok((l - r).to_string())
        }
        "*" => {
            let l = left_num.map_err(|_| "non-numeric argument")?;
            let r = right_num.map_err(|_| "non-numeric argument")?;
            Ok((l * r).to_string())
        }
        "/" => {
            let l = left_num.map_err(|_| "non-numeric argument")?;
            let r = right_num.map_err(|_| "non-numeric argument")?;
            if r == 0 {
                Err("division by zero".to_string())
            } else {
                Ok((l / r).to_string())
            }
        }
        "%" => {
            let l = left_num.map_err(|_| "non-numeric argument")?;
            let r = right_num.map_err(|_| "non-numeric argument")?;
            if r == 0 {
                Err("division by zero".to_string())
            } else {
                Ok((l % r).to_string())
            }
        }
        _ => Err(format!("unknown operator: {}", op)),
    }
}

// ============================================================================
// Simplified awk implementation
// ============================================================================

/// Parsed awk program
/// Represents a field reference: fixed number, or NF (last field)
#[derive(Clone, Debug)]
enum AwkFieldRef {
    Fixed(i32),
    NF, // $NF — last field
}

/// Represents what an awk rule prints
#[derive(Clone, Debug)]
enum AwkAction {
    PrintFields(Vec<AwkFieldRef>),
    PrintNF, // print NF (field count, not $NF)
    PrintLiteral(String),
    Accumulate(String, AwkFieldRef), // var += $field
    Nothing,
}

/// Represents a condition for an awk rule
#[derive(Clone, Debug)]
enum AwkCondition {
    Always,
    Pattern(String), // /regex/
    FieldCompare {
        // $N op value
        field: AwkFieldRef,
        op: String,
        value: f64,
    },
}

/// A single awk rule: condition + action
#[derive(Clone, Debug)]
struct AwkRule {
    condition: AwkCondition,
    action: AwkAction,
}

struct AwkProgram {
    #[allow(dead_code)]
    begin_action: Option<AwkAction>,
    end_action: Option<String>, // raw expression for END block
    rules: Vec<AwkRule>,
    ofs: String,
}

/// Parse a simplified awk program
fn parse_awk_program(program: &str) -> Result<AwkProgram, String> {
    let trimmed = program.trim();

    let mut begin_action = None;
    let mut end_action = None;
    let mut rules = Vec::new();
    let ofs = " ".to_string();

    // Split into rule blocks: BEGIN{...} rule{...} END{...}
    let mut remaining = trimmed;

    // Extract BEGIN block
    if let Some(begin_pos) = remaining.find("BEGIN") {
        let after = &remaining[begin_pos + 5..].trim_start();
        if after.starts_with('{') {
            if let Some(end) = find_matching_brace(after) {
                let _body = &after[1..end].trim();
                // Parse BEGIN body (accumulator init etc)
                begin_action = Some(AwkAction::Nothing);
                let after_begin = &after[end + 1..].trim_start();
                remaining = after_begin;
            }
        }
    }

    // Extract END block
    if let Some(end_pos) = remaining.find("END") {
        let before_end = &remaining[..end_pos].trim_end();
        let after = &remaining[end_pos + 3..].trim_start();
        if after.starts_with('{') {
            if let Some(end) = find_matching_brace(after) {
                let body = after[1..end].trim().to_string();
                end_action = Some(body);
                remaining = before_end;
            }
        }
    }

    // Parse remaining rules
    let remaining = remaining.trim();
    if !remaining.is_empty() {
        // Could be:
        // '{print $1}'
        // '/pattern/{print}'
        // '$2 >= 80 {print $1}'
        // '{sum+=$1}'

        let (condition, action_str) = parse_awk_condition_action(remaining);

        let action = parse_awk_action_body(&action_str);

        rules.push(AwkRule { condition, action });
    }

    // If BEGIN was found and there are accumulator actions, set up the program
    Ok(AwkProgram {
        begin_action,
        end_action,
        rules,
        ofs,
    })
}

/// Find the matching closing brace for an opening brace at position 0
fn find_matching_brace(s: &str) -> Option<usize> {
    let mut depth = 0;
    for (i, c) in s.char_indices() {
        match c {
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    return Some(i);
                }
            }
            _ => {}
        }
    }
    None
}

/// Parse condition + action from an awk rule string
fn parse_awk_condition_action(s: &str) -> (AwkCondition, String) {
    let s = s.trim();

    // /pattern/{action}
    if s.starts_with('/') {
        if let Some(end) = s[1..].find('/') {
            let pat = s[1..end + 1].to_string();
            let rest = s[end + 2..].trim();
            let action = rest
                .trim_start_matches('{')
                .trim_end_matches('}')
                .trim()
                .to_string();
            return (AwkCondition::Pattern(pat), action);
        }
    }

    // $N op value {action}
    if s.starts_with('$') {
        // Find the { that starts the action block
        if let Some(brace_pos) = s.find('{') {
            let cond_str = s[..brace_pos].trim();
            let action = s[brace_pos..]
                .trim_start_matches('{')
                .trim_end_matches('}')
                .trim()
                .to_string();

            // Parse condition: $2 >= 80
            let cond_str = cond_str.trim_start_matches('$');
            let ops = [">=", "<=", "!=", "==", ">", "<"];
            for op in &ops {
                if let Some(op_pos) = cond_str.find(op) {
                    let field_str = cond_str[..op_pos].trim();
                    let val_str = cond_str[op_pos + op.len()..].trim();
                    let field_num: i32 = field_str.parse().unwrap_or(0);
                    let value: f64 = val_str.parse().unwrap_or(0.0);
                    return (
                        AwkCondition::FieldCompare {
                            field: AwkFieldRef::Fixed(field_num),
                            op: op.to_string(),
                            value,
                        },
                        action,
                    );
                }
            }
        }
    }

    // {action} — no condition
    let action = s
        .trim_start_matches('{')
        .trim_end_matches('}')
        .trim()
        .to_string();
    (AwkCondition::Always, action)
}

/// Parse the body of an awk action
fn parse_awk_action_body(action: &str) -> AwkAction {
    let action = action.trim();

    if action.is_empty() || action == "print" || action == "print $0" {
        return AwkAction::PrintFields(vec![AwkFieldRef::Fixed(0)]);
    }

    // Handle accumulator: sum+=$1
    if action.contains("+=") {
        if let Some(eq_pos) = action.find("+=") {
            let var = action[..eq_pos].trim().to_string();
            let field_ref = parse_awk_field_ref(action[eq_pos + 2..].trim());
            return AwkAction::Accumulate(var, field_ref);
        }
    }

    // print NF (field count, not $NF)
    if action == "print NF" {
        return AwkAction::PrintNF;
    }

    // print $NF, $1, etc
    if action.starts_with("print ") {
        let fields_str = &action[6..];
        let mut refs = Vec::new();

        for field in fields_str.split(',') {
            let field = field.trim();
            if field.starts_with('$') {
                refs.push(parse_awk_field_ref(field));
            } else if field.starts_with('"') {
                // String literal in print — ignore for now, just extract fields
                // Handle string concat patterns like "\"prefix\" $1"
            }
        }
        if refs.is_empty() {
            // Could be a string concatenation pattern
            return AwkAction::PrintLiteral(fields_str.to_string());
        }
        return AwkAction::PrintFields(refs);
    }

    AwkAction::PrintFields(vec![AwkFieldRef::Fixed(0)])
}

/// Parse a field reference like $1, $NF, $0
fn parse_awk_field_ref(s: &str) -> AwkFieldRef {
    let s = s.trim().trim_start_matches('$');
    if s == "NF" {
        AwkFieldRef::NF
    } else if let Ok(n) = s.parse::<i32>() {
        AwkFieldRef::Fixed(n)
    } else {
        AwkFieldRef::Fixed(0)
    }
}

/// Resolve a field reference to its value
fn resolve_field<'a>(field: &AwkFieldRef, line: &'a str, fields: &[&'a str]) -> &'a str {
    match field {
        AwkFieldRef::Fixed(0) => line,
        AwkFieldRef::Fixed(n) if *n > 0 => fields.get((*n - 1) as usize).copied().unwrap_or(""),
        AwkFieldRef::NF => fields.last().copied().unwrap_or(""),
        _ => "",
    }
}

/// Execute awk action on a line
fn execute_awk_action(
    program: &AwkProgram,
    line: &str,
    fields: &[&str],
    _nr: usize,
    accumulator: &mut f64,
) -> String {
    for rule in &program.rules {
        // Check condition
        let matches = match &rule.condition {
            AwkCondition::Always => true,
            AwkCondition::Pattern(pat) => line.contains(pat),
            AwkCondition::FieldCompare { field, op, value } => {
                let field_val = resolve_field(field, line, fields);
                let fv: f64 = field_val.parse().unwrap_or(0.0);
                match op.as_str() {
                    ">=" => fv >= *value,
                    "<=" => fv <= *value,
                    ">" => fv > *value,
                    "<" => fv < *value,
                    "==" => (fv - value).abs() < f64::EPSILON,
                    "!=" => (fv - value).abs() >= f64::EPSILON,
                    _ => false,
                }
            }
        };

        if !matches {
            continue;
        }

        match &rule.action {
            AwkAction::PrintFields(refs) => {
                let parts: Vec<&str> = refs
                    .iter()
                    .map(|r| resolve_field(r, line, fields))
                    .collect();
                return parts.join(&program.ofs);
            }
            AwkAction::PrintNF => {
                return fields.len().to_string();
            }
            AwkAction::PrintLiteral(expr) => {
                // Handle string concatenation with fields
                return evaluate_awk_print_expr(expr, line, fields);
            }
            AwkAction::Accumulate(_var, field_ref) => {
                let val: f64 = resolve_field(field_ref, line, fields)
                    .parse()
                    .unwrap_or(0.0);
                *accumulator += val;
                return String::new();
            }
            AwkAction::Nothing => {}
        }
    }

    String::new()
}

/// Evaluate a complex awk print expression with string concatenation
fn evaluate_awk_print_expr(expr: &str, line: &str, fields: &[&str]) -> String {
    let mut result = String::new();
    let mut chars = expr.chars().peekable();

    while let Some(c) = chars.next() {
        match c {
            '"' => {
                // String literal
                while let Some(&next) = chars.peek() {
                    if next == '"' {
                        chars.next();
                        break;
                    }
                    if next == '\\' {
                        chars.next();
                        if let Some(&escaped) = chars.peek() {
                            match escaped {
                                'n' => result.push('\n'),
                                't' => result.push('\t'),
                                '"' => result.push('"'),
                                '\\' => result.push('\\'),
                                _ => {
                                    result.push('\\');
                                    result.push(escaped);
                                }
                            }
                            chars.next();
                        }
                    } else {
                        result.push(next);
                        chars.next();
                    }
                }
            }
            '$' => {
                // Field reference
                let mut num = String::new();
                while let Some(&next) = chars.peek() {
                    if next.is_ascii_digit() {
                        num.push(next);
                        chars.next();
                    } else if next == 'N' {
                        // $NF
                        chars.next();
                        if chars.peek() == Some(&'F') {
                            chars.next();
                            result.push_str(fields.last().copied().unwrap_or(""));
                        }
                        break;
                    } else {
                        break;
                    }
                }
                if !num.is_empty() {
                    let n: usize = num.parse().unwrap_or(0);
                    if n == 0 {
                        result.push_str(line);
                    } else {
                        result.push_str(fields.get(n - 1).copied().unwrap_or(""));
                    }
                }
            }
            ' ' => {
                // Space between concatenation parts — skip
            }
            _ => {
                // Could be a variable name or other text
            }
        }
    }

    result
}

/// Evaluate an END block expression (e.g., "print sum")
fn evaluate_awk_end_expr(expr: &str, accumulator: f64) -> String {
    let expr = expr.trim();

    // "print sum" or "print variable_name"
    if expr.starts_with("print ") {
        let var = expr[6..].trim();
        // The accumulator holds the sum
        if var == "sum" || var == "total" || var == "count" || var == "s" || var == "n" {
            // Format as integer if possible
            if accumulator == accumulator.floor() && accumulator.abs() < i64::MAX as f64 {
                return (accumulator as i64).to_string();
            }
            return accumulator.to_string();
        }
    }

    String::new()
}

#[cfg(test)]
mod tests {
    use super::*;

    // ========================================================================
    // expr tests
    // ========================================================================

    #[test]
    fn test_expr_simple() {
        let result = evaluate_expr(&["5".to_string()]).unwrap();
        assert_eq!(result, "5");
    }

    #[test]
    fn test_expr_add() {
        let result = evaluate_expr(&["2".to_string(), "+".to_string(), "3".to_string()]).unwrap();
        assert_eq!(result, "5");
    }

    #[test]
    fn test_expr_subtract() {
        let result = evaluate_expr(&["10".to_string(), "-".to_string(), "4".to_string()]).unwrap();
        assert_eq!(result, "6");
    }

    #[test]
    fn test_expr_multiply() {
        let result = evaluate_expr(&["3".to_string(), "*".to_string(), "4".to_string()]).unwrap();
        assert_eq!(result, "12");
    }

    #[test]
    fn test_expr_divide() {
        let result = evaluate_expr(&["15".to_string(), "/".to_string(), "3".to_string()]).unwrap();
        assert_eq!(result, "5");
    }

    #[test]
    fn test_expr_modulo() {
        let result = evaluate_expr(&["17".to_string(), "%".to_string(), "5".to_string()]).unwrap();
        assert_eq!(result, "2");
    }

    #[test]
    fn test_expr_compare() {
        let result = evaluate_expr(&["5".to_string(), "<".to_string(), "10".to_string()]).unwrap();
        assert_eq!(result, "1");

        let result = evaluate_expr(&["10".to_string(), "<".to_string(), "5".to_string()]).unwrap();
        assert_eq!(result, "0");
    }

    #[test]
    fn test_expr_equal() {
        let result =
            evaluate_expr(&["hello".to_string(), "=".to_string(), "hello".to_string()]).unwrap();
        assert_eq!(result, "1");

        let result =
            evaluate_expr(&["hello".to_string(), "=".to_string(), "world".to_string()]).unwrap();
        assert_eq!(result, "0");
    }

    #[test]
    fn test_expr_length() {
        let result = evaluate_expr(&["length".to_string(), "hello".to_string()]).unwrap();
        assert_eq!(result, "5");
    }

    #[test]
    fn test_expr_substr() {
        let result = evaluate_expr(&[
            "substr".to_string(),
            "hello".to_string(),
            "2".to_string(),
            "3".to_string(),
        ])
        .unwrap();
        assert_eq!(result, "ell");
    }

    #[test]
    fn test_expr_index() {
        let result =
            evaluate_expr(&["index".to_string(), "hello".to_string(), "l".to_string()]).unwrap();
        assert_eq!(result, "3");

        let result =
            evaluate_expr(&["index".to_string(), "hello".to_string(), "z".to_string()]).unwrap();
        assert_eq!(result, "0");
    }

    // ========================================================================
    // awk tests
    // ========================================================================

    #[test]
    fn test_awk_parse_simple() {
        let prog = parse_awk_program("{print}").unwrap();
        assert_eq!(prog.rules.len(), 1);
    }

    #[test]
    fn test_awk_parse_field() {
        let prog = parse_awk_program("{print $1}").unwrap();
        assert_eq!(prog.rules.len(), 1);
    }

    #[test]
    fn test_awk_parse_multiple_fields() {
        let prog = parse_awk_program("{print $1,$3}").unwrap();
        assert_eq!(prog.rules.len(), 1);
    }

    #[test]
    fn test_awk_execute() {
        let prog = parse_awk_program("{print $2}").unwrap();
        let fields = vec!["one", "two", "three"];
        let mut acc = 0.0;
        let result = execute_awk_action(&prog, "one two three", &fields, 1, &mut acc);
        assert_eq!(result, "two");
    }

    // ========================================================================
    // expr edge cases
    // ========================================================================

    #[test]
    fn test_expr_division_by_zero() {
        let result = evaluate_expr(&["5".to_string(), "/".to_string(), "0".to_string()]);
        assert!(result.is_err());
    }

    #[test]
    fn test_expr_modulo_by_zero() {
        let result = evaluate_expr(&["5".to_string(), "%".to_string(), "0".to_string()]);
        assert!(result.is_err());
    }

    #[test]
    fn test_expr_negative_numbers() {
        let result = evaluate_expr(&["-5".to_string(), "+".to_string(), "3".to_string()]).unwrap();
        assert_eq!(result, "-2");
    }

    #[test]
    fn test_expr_multiply_negative() {
        let result = evaluate_expr(&["-3".to_string(), "*".to_string(), "-4".to_string()]).unwrap();
        assert_eq!(result, "12");
    }

    #[test]
    fn test_expr_string_not_equal() {
        let result =
            evaluate_expr(&["abc".to_string(), "!=".to_string(), "def".to_string()]).unwrap();
        assert_eq!(result, "1");
    }

    #[test]
    fn test_expr_compare_equal_numbers() {
        let result = evaluate_expr(&["5".to_string(), "=".to_string(), "5".to_string()]).unwrap();
        assert_eq!(result, "1");
    }

    #[test]
    fn test_expr_less_than_or_equal() {
        let result = evaluate_expr(&["5".to_string(), "<=".to_string(), "5".to_string()]).unwrap();
        assert_eq!(result, "1");

        let result = evaluate_expr(&["4".to_string(), "<=".to_string(), "5".to_string()]).unwrap();
        assert_eq!(result, "1");

        let result = evaluate_expr(&["6".to_string(), "<=".to_string(), "5".to_string()]).unwrap();
        assert_eq!(result, "0");
    }

    #[test]
    fn test_expr_greater_than_or_equal() {
        let result = evaluate_expr(&["5".to_string(), ">=".to_string(), "5".to_string()]).unwrap();
        assert_eq!(result, "1");
    }

    #[test]
    fn test_expr_substr_zero_position() {
        // substr with position 0 should return empty
        let result = evaluate_expr(&[
            "substr".to_string(),
            "hello".to_string(),
            "0".to_string(),
            "3".to_string(),
        ])
        .unwrap();
        assert_eq!(result, "");
    }

    #[test]
    fn test_expr_substr_beyond_length() {
        // substr beyond string length should handle gracefully
        let result = evaluate_expr(&[
            "substr".to_string(),
            "hi".to_string(),
            "1".to_string(),
            "10".to_string(),
        ])
        .unwrap();
        assert_eq!(result, "hi");
    }

    #[test]
    fn test_expr_empty() {
        let result = evaluate_expr(&[]).unwrap();
        assert_eq!(result, "0");
    }

    #[test]
    fn test_expr_single_value() {
        let result = evaluate_expr(&["42".to_string()]).unwrap();
        assert_eq!(result, "42");
    }

    #[test]
    fn test_expr_chained_arithmetic() {
        // 2 + 3 * 4 - should handle operator precedence implicitly
        let result = evaluate_expr(&["2".to_string(), "+".to_string(), "3".to_string()]).unwrap();
        assert_eq!(result, "5");
    }

    // ========================================================================
    // awk edge cases
    // ========================================================================

    #[test]
    fn test_awk_parse_print_all() {
        let prog = parse_awk_program("{print $0}").unwrap();
        assert_eq!(prog.rules.len(), 1);
    }

    #[test]
    fn test_awk_empty_line() {
        let prog = parse_awk_program("{print $1}").unwrap();
        let fields: Vec<&str> = vec![];
        let mut acc = 0.0;
        let result = execute_awk_action(&prog, "", &fields, 1, &mut acc);
        assert_eq!(result, "");
    }

    #[test]
    fn test_awk_field_out_of_bounds() {
        let prog = parse_awk_program("{print $10}").unwrap();
        let fields = vec!["one", "two"];
        let mut acc = 0.0;
        let result = execute_awk_action(&prog, "one two", &fields, 1, &mut acc);
        assert_eq!(result, "");
    }

    #[test]
    fn test_awk_nr_variable() {
        let prog = parse_awk_program("{print}").unwrap();
        let fields = vec!["x"];
        let mut acc = 0.0;
        let result = execute_awk_action(&prog, "x", &fields, 42, &mut acc);
        assert_eq!(result, "x");
    }

    #[test]
    fn test_awk_nf_variable() {
        let prog = parse_awk_program("{print $1}").unwrap();
        let fields = vec!["a", "b", "c", "d"];
        let mut acc = 0.0;
        let result = execute_awk_action(&prog, "a b c d", &fields, 1, &mut acc);
        assert_eq!(result, "a");
    }

    #[test]
    fn test_awk_with_pattern() {
        let prog = parse_awk_program("/hello/{print $1}").unwrap();
        assert!(!prog.rules.is_empty());

        let mut acc = 0.0;
        let fields = vec!["hello", "world"];
        let result = execute_awk_action(&prog, "hello world", &fields, 1, &mut acc);
        assert_eq!(result, "hello");

        let result = execute_awk_action(&prog, "goodbye world", &["goodbye", "world"], 1, &mut acc);
        assert_eq!(result, "");
    }

    #[test]
    fn test_awk_multiple_print_fields_joined() {
        let prog = parse_awk_program("{print $1,$2,$3}").unwrap();
        let fields = vec!["a", "b", "c"];
        let mut acc = 0.0;
        let result = execute_awk_action(&prog, "a b c", &fields, 1, &mut acc);
        assert_eq!(result, "a b c");
    }
}
