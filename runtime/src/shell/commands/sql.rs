//! SQL commands: sqlite3
//!
//! Provides SQL database functionality using turso_core.
//! Matches the standard sqlite3 CLI interface.

use futures_lite::io::AsyncWriteExt;
use runtime_macros::shell_commands;
use std::sync::Arc;

use super::super::ShellEnv;
use super::parse_common;
use super::wasi_io::WasiIO;

use turso_core::{Database, MemoryIO, IO};

/// SQL commands using turso_core.
pub struct SqlCommands;

#[shell_commands]
impl SqlCommands {
    /// sqlite3 - execute SQL queries using SQLite-compatible database
    #[shell_command(
        name = "sqlite3",
        usage = "sqlite3 [DATABASE] [SQL]",
        description = "SQLite database CLI. DATABASE defaults to :memory: if not specified."
    )]
    fn cmd_sqlite3(
        args: Vec<String>,
        _env: &ShellEnv,
        stdin: piper::Reader,
        mut stdout: piper::Writer,
        mut stderr: piper::Writer,
    ) -> futures_lite::future::Boxed<i32> {
        Box::pin(async move {
            let (opts, remaining) = parse_common(&args);
            if opts.help {
                if let Some(help) = SqlCommands::show_help("sqlite3") {
                    let _ = stdout.write_all(help.as_bytes()).await;
                    return 0;
                }
            }

            // Parse positional arguments: [DATABASE] [SQL]
            // If only one arg, it could be DATABASE or SQL
            // If arg looks like a path or :memory:, treat as DATABASE
            // Otherwise treat as SQL
            let (db_path, sql_arg): (String, Option<String>) = match remaining.len() {
                0 => (":memory:".to_string(), None),
                1 => {
                    let arg = &remaining[0];
                    // If it looks like a database path/name, use it as database
                    if arg == ":memory:"
                        || arg.ends_with(".db")
                        || arg.ends_with(".sqlite")
                        || arg.ends_with(".sqlite3")
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
                    let db = remaining[0].clone();
                    let sql = remaining[1..].join(" ");
                    (db, Some(sql))
                }
            };

            // Get SQL from arg or stdin
            let sql = if let Some(s) = sql_arg {
                s
            } else {
                // Read from stdin
                use futures_lite::io::AsyncReadExt;
                let mut buf = Vec::new();
                let mut reader = stdin;
                let _ = reader.read_to_end(&mut buf).await;
                String::from_utf8_lossy(&buf).to_string()
            };

            if sql.trim().is_empty() {
                let _ = stderr.write_all(b"Error: no SQL provided\n").await;
                return 1;
            }

            // Create IO backend based on database path
            let io: Arc<dyn IO> = if db_path == ":memory:" {
                Arc::new(MemoryIO::new())
            } else {
                Arc::new(WasiIO::new())
            };

            // Open database
            let db = match Database::open_file(io.clone(), &db_path) {
                Ok(db) => db,
                Err(e) => {
                    let msg = format!("Error: unable to open database \"{}\": {}\n", db_path, e);
                    let _ = stderr.write_all(msg.as_bytes()).await;
                    return 1;
                }
            };

            // Get a connection
            let conn = match db.connect() {
                Ok(c) => c,
                Err(e) => {
                    let msg = format!("Error: {}\n", e);
                    let _ = stderr.write_all(msg.as_bytes()).await;
                    return 1;
                }
            };

            // Execute SQL statements (split by semicolon for multiple statements)
            let statements: Vec<&str> = sql
                .split(';')
                .map(|s| s.trim())
                .filter(|s| !s.is_empty())
                .collect();

            for stmt_sql in statements {
                // Query returns Option<Statement>
                let mut stmt = match conn.query(stmt_sql) {
                    Ok(Some(s)) => s,
                    Ok(None) => {
                        // Empty statement, skip
                        continue;
                    }
                    Err(e) => {
                        let msg = format!("Error: {}\n", e);
                        let _ = stderr.write_all(msg.as_bytes()).await;
                        return 1;
                    }
                };

                // Run statement with row callback
                let result = stmt.run_with_row_callback(|row| {
                    // Get column count and format output
                    let values = row.get_values();
                    let formatted: Vec<String> = values.map(format_value).collect();
                    let line = formatted.join("|") + "\n";
                    // Use blocking write for callback context
                    let _ = futures_lite::future::block_on(stdout.write_all(line.as_bytes()));
                    Ok(())
                });

                if let Err(e) = result {
                    let msg = format!("Error: {}\n", e);
                    let _ = stderr.write_all(msg.as_bytes()).await;
                    return 1;
                }
            }

            0
        })
    }
}

/// Format a Value for output
fn format_value(val: &turso_core::Value) -> String {
    match val {
        turso_core::Value::Null => "".to_string(), // sqlite3 shows empty for NULL
        turso_core::Value::Integer(i) => i.to_string(),
        turso_core::Value::Float(f) => f.to_string(),
        turso_core::Value::Text(s) => s.to_string(),
        turso_core::Value::Blob(b) => format!("<blob:{} bytes>", b.len()),
    }
}
