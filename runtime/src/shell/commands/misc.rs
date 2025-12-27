//! Miscellaneous commands: seq, sleep, date

use futures_lite::io::AsyncWriteExt;
use runtime_macros::shell_commands;

use super::super::ShellEnv;
use super::parse_common;

// Import WASI clock bindings
use crate::bindings::wasi::clocks::monotonic_clock;
use crate::bindings::wasi::clocks::wall_clock;

/// Miscellaneous commands.
pub struct MiscCommands;

#[shell_commands]
impl MiscCommands {
    /// seq - print sequence of numbers
    #[shell_command(
        name = "seq",
        usage = "seq [FIRST] [INCREMENT] LAST",
        description = "Print sequence of numbers"
    )]
    fn cmd_seq(
        args: Vec<String>,
        _env: &ShellEnv,
        _stdin: piper::Reader,
        mut stdout: piper::Writer,
        mut stderr: piper::Writer,
    ) -> futures_lite::future::Boxed<i32> {
        Box::pin(async move {
            let (opts, remaining) = parse_common(&args);
            if opts.help {
                if let Some(help) = MiscCommands::show_help("seq") {
                    let _ = stdout.write_all(help.as_bytes()).await;
                    return 0;
                }
            }
            
            let nums: Vec<i64> = remaining.iter()
                .filter_map(|s| s.parse().ok())
                .collect();
            
            let (first, incr, last) = match nums.len() {
                0 => {
                    let _ = stderr.write_all(b"seq: missing operand\n").await;
                    return 1;
                }
                1 => (1, 1, nums[0]),
                2 => (nums[0], 1, nums[1]),
                _ => (nums[0], nums[1], nums[2]),
            };
            
            let mut current = first;
            if incr > 0 {
                while current <= last {
                    let _ = stdout.write_all(format!("{}\n", current).as_bytes()).await;
                    current += incr;
                }
            } else if incr < 0 {
                while current >= last {
                    let _ = stdout.write_all(format!("{}\n", current).as_bytes()).await;
                    current += incr;
                }
            }
            0
        })
    }

    /// sleep - delay for a specified time
    #[shell_command(
        name = "sleep",
        usage = "sleep SECONDS",
        description = "Delay for a specified time"
    )]
    fn cmd_sleep(
        args: Vec<String>,
        _env: &ShellEnv,
        _stdin: piper::Reader,
        mut stdout: piper::Writer,
        mut stderr: piper::Writer,
    ) -> futures_lite::future::Boxed<i32> {
        Box::pin(async move {
            let (opts, remaining) = parse_common(&args);
            if opts.help {
                if let Some(help) = MiscCommands::show_help("sleep") {
                    let _ = stdout.write_all(help.as_bytes()).await;
                    return 0;
                }
            }
            
            if remaining.is_empty() {
                let _ = stderr.write_all(b"sleep: missing operand\n").await;
                return 1;
            }
            
            let secs: f64 = remaining[0].parse().unwrap_or(0.0);
            
            // Convert seconds to nanoseconds for WASI Duration
            let nanos = (secs * 1_000_000_000.0) as u64;
            
            if nanos > 0 {
                // Idiomatic WASI: subscribe to a duration pollable and block until ready
                let pollable = monotonic_clock::subscribe_duration(nanos);
                pollable.block();
            }
            
            0
        })
    }

    /// date - print the current date and time
    #[shell_command(
        name = "date",
        usage = "date [+FORMAT]",
        description = "Print the current date and time"
    )]
    fn cmd_date(
        args: Vec<String>,
        _env: &ShellEnv,
        _stdin: piper::Reader,
        mut stdout: piper::Writer,
        _stderr: piper::Writer,
    ) -> futures_lite::future::Boxed<i32> {
        Box::pin(async move {
            let (opts, _remaining) = parse_common(&args);
            if opts.help {
                if let Some(help) = MiscCommands::show_help("date") {
                    let _ = stdout.write_all(help.as_bytes()).await;
                    return 0;
                }
            }
            
            // Get current wall clock time from WASI
            let datetime = wall_clock::now();
            
            // Convert to human-readable format
            // datetime.seconds is seconds since Unix epoch (1970-01-01 00:00:00 UTC)
            let total_secs = datetime.seconds;
            
            // Simple date/time calculation (UTC)
            const SECS_PER_MIN: u64 = 60;
            const SECS_PER_HOUR: u64 = 3600;
            const SECS_PER_DAY: u64 = 86400;
            
            let days_since_epoch = total_secs / SECS_PER_DAY;
            let time_of_day = total_secs % SECS_PER_DAY;
            
            let hours = time_of_day / SECS_PER_HOUR;
            let minutes = (time_of_day % SECS_PER_HOUR) / SECS_PER_MIN;
            let seconds = time_of_day % SECS_PER_MIN;
            
            // Calculate year, month, day from days since epoch
            // Using a simplified algorithm
            let (year, month, day) = days_to_ymd(days_since_epoch);
            
            let output = format!(
                "{:04}-{:02}-{:02} {:02}:{:02}:{:02} UTC\n",
                year, month, day, hours, minutes, seconds
            );
            
            let _ = stdout.write_all(output.as_bytes()).await;
            0
        })
    }

    /// curl - transfer data from URLs
    #[shell_command(
        name = "curl",
        usage = "curl [-X METHOD] [-H HEADER] [-d DATA] [-o FILE] [-s] URL",
        description = "Transfer data from or to a server"
    )]
    fn cmd_curl(
        args: Vec<String>,
        env: &ShellEnv,
        _stdin: piper::Reader,
        mut stdout: piper::Writer,
        mut stderr: piper::Writer,
    ) -> futures_lite::future::Boxed<i32> {
        let cwd = env.cwd.to_string_lossy().to_string();
        Box::pin(async move {
            let (opts, remaining) = parse_common(&args);
            if opts.help {
                if let Some(help) = MiscCommands::show_help("curl") {
                    let _ = stdout.write_all(help.as_bytes()).await;
                    return 0;
                }
            }
            
            let mut method = "GET".to_string();
            let mut headers: Vec<(String, String)> = Vec::new();
            let mut data: Option<String> = None;
            let mut output_file: Option<String> = None;
            let mut silent = false;
            let mut url: Option<String> = None;
            
            // Manual argument parsing for complex options
            let mut i = 0;
            while i < remaining.len() {
                let arg = &remaining[i];
                match arg.as_str() {
                    "-X" | "--request" => {
                        i += 1;
                        if i < remaining.len() {
                            method = remaining[i].clone();
                        }
                    }
                    "-H" | "--header" => {
                        i += 1;
                        if i < remaining.len() {
                            let header = &remaining[i];
                            if let Some(colon_pos) = header.find(':') {
                                let name = header[..colon_pos].trim().to_string();
                                let value = header[colon_pos + 1..].trim().to_string();
                                headers.push((name, value));
                            }
                        }
                    }
                    "-d" | "--data" => {
                        i += 1;
                        if i < remaining.len() {
                            data = Some(remaining[i].clone());
                            if method == "GET" {
                                method = "POST".to_string();
                            }
                        }
                    }
                    "-o" | "--output" => {
                        i += 1;
                        if i < remaining.len() {
                            output_file = Some(remaining[i].clone());
                        }
                    }
                    "-s" | "--silent" => {
                        silent = true;
                    }
                    s if !s.starts_with('-') => {
                        url = Some(s.to_string());
                    }
                    _ => {}
                }
                i += 1;
            }
            
            let url = match url {
                Some(u) => u,
                None => {
                    let _ = stderr.write_all(b"curl: no URL specified\n").await;
                    return 1;
                }
            };
            
            // Build headers JSON
            let headers_json = if headers.is_empty() {
                None
            } else {
                let pairs: Vec<String> = headers.iter()
                    .map(|(k, v)| format!("\"{}\":\"{}\"", k, v))
                    .collect();
                Some(format!("{{{}}}", pairs.join(",")))
            };
            
            // Make HTTP request using our existing http_client
            match crate::http_client::fetch_request(
                &method,
                &url,
                headers_json.as_deref(),
                data.as_deref(),
            ) {
                Ok(response) => {
                    if let Some(out_path) = output_file {
                        let path = if out_path.starts_with('/') {
                            out_path
                        } else {
                            format!("{}/{}", cwd, out_path)
                        };
                        if let Err(e) = std::fs::write(&path, &response.body()) {
                            let msg = format!("curl: {}: {}\n", path, e);
                            let _ = stderr.write_all(msg.as_bytes()).await;
                            return 1;
                        }
                    } else {
                        let _ = stdout.write_all(response.body().as_bytes()).await;
                        if !response.body().ends_with('\n') {
                            let _ = stdout.write_all(b"\n").await;
                        }
                    }
                    
                    if !silent && !response.ok {
                        let msg = format!("curl: HTTP {}\n", response.status);
                        let _ = stderr.write_all(msg.as_bytes()).await;
                    }
                    
                    if response.ok { 0 } else { 22 } // curl uses 22 for HTTP errors
                }
                Err(e) => {
                    if !silent {
                        let msg = format!("curl: {}\n", e);
                        let _ = stderr.write_all(msg.as_bytes()).await;
                    }
                    1
                }
            }
        })
    }

    /// tsc - transpile TypeScript to JavaScript
    #[shell_command(
        name = "tsc",
        usage = "tsc [-o FILE] FILE",
        description = "Transpile TypeScript to JavaScript"
    )]
    fn cmd_tsc(
        args: Vec<String>,
        env: &ShellEnv,
        _stdin: piper::Reader,
        mut stdout: piper::Writer,
        mut stderr: piper::Writer,
    ) -> futures_lite::future::Boxed<i32> {
        let cwd = env.cwd.to_string_lossy().to_string();
        Box::pin(async move {
            let (opts, remaining) = parse_common(&args);
            if opts.help {
                if let Some(help) = MiscCommands::show_help("tsc") {
                    let _ = stdout.write_all(help.as_bytes()).await;
                    return 0;
                }
            }
            
            let mut output_file: Option<String> = None;
            let mut input_file: Option<String> = None;
            
            let mut i = 0;
            while i < remaining.len() {
                match remaining[i].as_str() {
                    "-o" | "--output" => {
                        i += 1;
                        if i < remaining.len() {
                            output_file = Some(remaining[i].clone());
                        }
                    }
                    s if !s.starts_with('-') => {
                        input_file = Some(s.to_string());
                    }
                    _ => {}
                }
                i += 1;
            }
            
            let input_file = match input_file {
                Some(f) => f,
                None => {
                    let _ = stderr.write_all(b"tsc: no input file\n").await;
                    return 1;
                }
            };
            
            let path = if input_file.starts_with('/') {
                input_file.clone()
            } else {
                format!("{}/{}", cwd, input_file)
            };
            
            let ts_code = match std::fs::read_to_string(&path) {
                Ok(c) => c,
                Err(e) => {
                    let msg = format!("tsc: {}: {}\n", path, e);
                    let _ = stderr.write_all(msg.as_bytes()).await;
                    return 1;
                }
            };
            
            let js_code = match crate::transpiler::transpile(&ts_code) {
                Ok(js) => js,
                Err(e) => {
                    let msg = format!("tsc: {}\n", e);
                    let _ = stderr.write_all(msg.as_bytes()).await;
                    return 1;
                }
            };
            
            if let Some(out_path) = output_file {
                let out = if out_path.starts_with('/') {
                    out_path
                } else {
                    format!("{}/{}", cwd, out_path)
                };
                if let Err(e) = std::fs::write(&out, &js_code) {
                    let msg = format!("tsc: {}: {}\n", out, e);
                    let _ = stderr.write_all(msg.as_bytes()).await;
                    return 1;
                }
            } else {
                let _ = stdout.write_all(js_code.as_bytes()).await;
                if !js_code.ends_with('\n') {
                    let _ = stdout.write_all(b"\n").await;
                }
            }
            
            0
        })
    }
}

/// Convert days since Unix epoch to year, month, day
fn days_to_ymd(days: u64) -> (i32, u32, u32) {
    // Days since 1970-01-01
    let mut remaining_days = days as i64;
    let mut year = 1970i32;
    
    loop {
        let days_in_year = if is_leap_year(year) { 366 } else { 365 };
        if remaining_days < days_in_year {
            break;
        }
        remaining_days -= days_in_year;
        year += 1;
    }
    
    let leap = is_leap_year(year);
    let days_in_months: [i64; 12] = if leap {
        [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    } else {
        [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    };
    
    let mut month = 1u32;
    for days_in_month in days_in_months.iter() {
        if remaining_days < *days_in_month {
            break;
        }
        remaining_days -= days_in_month;
        month += 1;
    }
    
    let day = (remaining_days + 1) as u32;
    
    (year, month, day)
}

fn is_leap_year(year: i32) -> bool {
    (year % 4 == 0 && year % 100 != 0) || (year % 400 == 0)
}
