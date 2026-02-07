//! sqlite-module
//!
//! Provides sqlite3 command via the unix-command WIT interface.

#[allow(warnings)]
mod bindings;

use bindings::exports::shell::unix::command::{ExecEnv, Guest};
use bindings::wasi::io::streams::{InputStream, OutputStream};
use std::sync::Arc;
use turso_core::{Database, MemoryIO, Value, IO};

struct SqliteModule;

impl Guest for SqliteModule {
    fn run(
        name: String,
        args: Vec<String>,
        _env: ExecEnv,
        stdin: InputStream,
        stdout: OutputStream,
        stderr: OutputStream,
    ) -> i32 {
        match name.as_str() {
            "sqlite3" => run_sqlite3(args, stdin, stdout, stderr),
            _ => {
                write_to_stream(&stderr, format!("Unknown command: {}\n", name).as_bytes());
                127
            }
        }
    }

    fn list_commands() -> Vec<String> {
        vec!["sqlite3".to_string()]
    }
}

/// Execute SQLite commands
fn run_sqlite3(
    args: Vec<String>,
    stdin: InputStream,
    stdout: OutputStream,
    stderr: OutputStream,
) -> i32 {
    // Parse arguments: [DATABASE] [SQL]
    let (db_path, sql_arg): (String, Option<String>) = match args.len() {
        0 => (":memory:".to_string(), None),
        1 => {
            let arg = &args[0];
            // If it looks like a database path, use it as database
            if arg == ":memory:"
                || arg.ends_with(".db")
                || arg.ends_with(".sqlite")
                || arg.contains('/')
            {
                (arg.clone(), None)
            } else {
                // Treat as SQL
                (":memory:".to_string(), Some(arg.clone()))
            }
        }
        _ => {
            // First arg is database, rest is SQL
            let db = args[0].clone();
            let sql = args[1..].join(" ");
            (db, Some(sql))
        }
    };

    // Get SQL from arg or stdin
    let sql = if let Some(s) = sql_arg {
        s
    } else {
        match read_all_from_stream(&stdin) {
            Ok(data) => String::from_utf8_lossy(&data).to_string(),
            Err(e) => {
                write_to_stream(
                    &stderr,
                    format!("sqlite3: failed to read stdin: {}\n", e).as_bytes(),
                );
                return 1;
            }
        }
    };

    if sql.trim().is_empty() {
        write_to_stream(&stderr, b"Error: no SQL provided\n");
        return 1;
    }

    // Create IO backend (memory only for now - WASI filesystem support would need WasiIO)
    let io: Arc<dyn IO> = Arc::new(MemoryIO::new());

    // Open database
    let db = match Database::open_file(io.clone(), &db_path) {
        Ok(db) => db,
        Err(e) => {
            write_to_stream(
                &stderr,
                format!("Error: unable to open database \"{}\": {}\n", db_path, e).as_bytes(),
            );
            return 1;
        }
    };

    // Get a connection
    let conn = match db.connect() {
        Ok(c) => c,
        Err(e) => {
            write_to_stream(&stderr, format!("Error: {}\n", e).as_bytes());
            return 1;
        }
    };

    // Execute SQL statements
    let statements: Vec<&str> = sql
        .split(';')
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .collect();

    for stmt_sql in statements {
        let mut stmt = match conn.query(stmt_sql) {
            Ok(Some(s)) => s,
            Ok(None) => continue,
            Err(e) => {
                write_to_stream(&stderr, format!("Error: {}\n", e).as_bytes());
                return 1;
            }
        };

        // Collect output and write after
        let mut output_lines: Vec<String> = Vec::new();

        let result = stmt.run_with_row_callback(|row| {
            let values = row.get_values();
            let formatted: Vec<String> = values.map(format_value).collect();
            output_lines.push(formatted.join("|"));
            Ok(())
        });

        // Write collected output
        for line in &output_lines {
            write_to_stream(&stdout, line.as_bytes());
            write_to_stream(&stdout, b"\n");
        }

        if let Err(e) = result {
            write_to_stream(&stderr, format!("Error: {}\n", e).as_bytes());
            return 1;
        }
    }

    0
}

/// Format a Value for output
fn format_value(val: &Value) -> String {
    match val {
        Value::Null => "".to_string(),
        Value::Integer(i) => i.to_string(),
        Value::Float(f) => f.to_string(),
        Value::Text(s) => s.to_string(),
        Value::Blob(b) => format!("<blob:{} bytes>", b.len()),
    }
}

/// Helper to write data to an output stream
fn write_to_stream(stream: &OutputStream, data: &[u8]) {
    let _ = stream.blocking_write_and_flush(data);
}

/// Helper to read all data from an input stream
fn read_all_from_stream(stream: &InputStream) -> Result<Vec<u8>, String> {
    let mut result = Vec::new();
    while let Ok(chunk) = stream.blocking_read(4096) {
        if chunk.is_empty() {
            break;
        }
        result.extend_from_slice(&chunk);
    }
    Ok(result)
}

bindings::export!(SqliteModule with_types_in bindings);
