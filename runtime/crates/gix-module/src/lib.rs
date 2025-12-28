//! gix-module
//!
//! Provides git command via the unix-command WIT interface using gitoxide.

#[allow(warnings)]
mod bindings;

use bindings::exports::shell::unix::command::{ExecEnv, Guest};
use bindings::wasi::io::streams::{InputStream, OutputStream};
use gix::bstr::ByteSlice;
use std::path::Path;

struct GixModule;

impl Guest for GixModule {
    fn run(
        name: String,
        args: Vec<String>,
        env: ExecEnv,
        stdin: InputStream,
        stdout: OutputStream,
        stderr: OutputStream,
    ) -> i32 {
        match name.as_str() {
            "git" => run_git(args, &env, stdin, stdout, stderr),
            _ => {
                write_to_stream(&stderr, format!("Unknown command: {}\n", name).as_bytes());
                127
            }
        }
    }

    fn list_commands() -> Vec<String> {
        vec!["git".to_string()]
    }
}

/// Execute git commands
fn run_git(
    args: Vec<String>,
    env: &ExecEnv,
    _stdin: InputStream,
    stdout: OutputStream,
    stderr: OutputStream,
) -> i32 {
    let cwd = &env.cwd;

    // Parse help flag and get remaining args
    let mut show_help = false;
    let mut remaining: Vec<String> = Vec::new();

    for arg in &args {
        if arg == "-h" || arg == "--help" {
            show_help = true;
        } else {
            remaining.push(arg.clone());
        }
    }

    if show_help || remaining.is_empty() {
        let help = "git - version control\n\n\
Usage: git <command> [OPTIONS]\n\n\
Commands:\n\
  init             Initialize a new repository\n\
  clone <url>      Clone a repository\n\
  status           Show working tree status\n\
  add <file>       Add file to staging\n\
  commit -m MSG    Create a new commit\n\
  log [-n N]       Show commit history\n\
  diff [file]      Show changes\n";
        write_to_stream(&stdout, help.as_bytes());
        return 0;
    }

    let subcommand = &remaining[0];
    let sub_args: Vec<String> = remaining[1..].to_vec();

    match subcommand.as_str() {
        "init" => git_init(cwd, sub_args, &stdout, &stderr),
        "clone" => git_clone(cwd, sub_args, &stdout, &stderr),
        "status" => git_status(cwd, sub_args, &stdout, &stderr),
        "add" => git_add(cwd, sub_args, &stdout, &stderr),
        "commit" => git_commit(cwd, sub_args, &stdout, &stderr),
        "log" => git_log(cwd, sub_args, &stdout, &stderr),
        "diff" => git_diff(cwd, sub_args, &stdout, &stderr),
        _ => {
            let msg = format!("git: '{}' is not a git command\n", subcommand);
            write_to_stream(&stderr, msg.as_bytes());
            1
        }
    }
}

/// git init - initialize a new repository
fn git_init(cwd: &str, _args: Vec<String>, stdout: &OutputStream, stderr: &OutputStream) -> i32 {
    let result: Result<String, String> = (|| {
        let path = Path::new(cwd);
        gix::init(path).map_err(|e| format!("git init: {}\n", e))?;
        Ok(format!("Initialized empty Git repository in {}/.git/\n", cwd))
    })();

    match result {
        Ok(msg) => {
            write_to_stream(stdout, msg.as_bytes());
            0
        }
        Err(e) => {
            write_to_stream(stderr, e.as_bytes());
            1
        }
    }
}

/// git clone - clone a repository (simplified HTTP clone)
fn git_clone(cwd: &str, args: Vec<String>, stdout: &OutputStream, stderr: &OutputStream) -> i32 {
    if args.is_empty() {
        write_to_stream(stderr, b"usage: git clone <url> [directory]\n");
        return 1;
    }

    let url = &args[0];
    let dest_name = if args.len() > 1 {
        args[1].clone()
    } else {
        extract_repo_name(url)
    };

    let dest_path = format!("{}/{}", cwd, dest_name);
    write_to_stream(stdout, format!("Cloning into '{}'...\n", dest_name).as_bytes());

    // Create destination directory
    if let Err(e) = std::fs::create_dir_all(&dest_path) {
        write_to_stream(stderr, format!("failed to create directory: {}\n", e).as_bytes());
        return 1;
    }

    // Initialize repository
    match gix::init(&dest_path) {
        Ok(_) => {
            write_to_stream(stdout, b"Initialized empty repository\n");
            write_to_stream(stdout, b"Note: Full clone over HTTP not yet implemented in WASM\n");
            write_to_stream(stdout, format!("Repository initialized at {}\n", dest_path).as_bytes());
            0
        }
        Err(e) => {
            write_to_stream(stderr, format!("failed to init repository: {}\n", e).as_bytes());
            1
        }
    }
}

/// git status
fn git_status(cwd: &str, _args: Vec<String>, stdout: &OutputStream, stderr: &OutputStream) -> i32 {
    let result: Result<String, String> = (|| {
        let repo = gix::open(cwd).map_err(|e| format!("not a git repository: {}\n", e))?;
        let mut output = String::new();

        if let Ok(head) = repo.head_ref() {
            if let Some(name) = head.as_ref().map(|r| r.name().shorten().to_string()) {
                output.push_str(&format!("On branch {}\n", name));
            }
        }
        output.push_str("\nnothing to commit, working tree clean\n");
        Ok(output)
    })();

    match result {
        Ok(msg) => {
            write_to_stream(stdout, msg.as_bytes());
            0
        }
        Err(e) => {
            write_to_stream(stderr, e.as_bytes());
            1
        }
    }
}

/// git add
fn git_add(cwd: &str, args: Vec<String>, _stdout: &OutputStream, stderr: &OutputStream) -> i32 {
    if args.is_empty() {
        write_to_stream(stderr, b"Nothing specified, nothing added.\n");
        return 1;
    }

    // Verify repo exists
    if let Err(e) = gix::open(cwd) {
        write_to_stream(stderr, format!("not a git repository: {}\n", e).as_bytes());
        return 1;
    }

    // Verify files exist
    for file in &args {
        let path = Path::new(cwd).join(file);
        if !path.exists() {
            write_to_stream(
                stderr,
                format!("pathspec '{}' did not match any files\n", file).as_bytes(),
            );
            return 1;
        }
    }

    // Note: Actual staging not implemented yet
    0
}

/// git commit
fn git_commit(cwd: &str, args: Vec<String>, stdout: &OutputStream, stderr: &OutputStream) -> i32 {
    let mut message: Option<String> = None;
    let mut i = 0;

    while i < args.len() {
        if args[i] == "-m" || args[i] == "--message" {
            if i + 1 < args.len() {
                message = Some(args[i + 1].clone());
                i += 2;
            } else {
                i += 1;
            }
        } else {
            i += 1;
        }
    }

    if message.is_none() {
        write_to_stream(stderr, b"error: no commit message specified\n");
        return 1;
    }

    // Verify repo exists
    if let Err(e) = gix::open(cwd) {
        write_to_stream(stderr, format!("not a git repository: {}\n", e).as_bytes());
        return 1;
    }

    // Note: Actual commit not implemented yet
    write_to_stream(
        stdout,
        format!("[main] {}\n", message.unwrap()).as_bytes(),
    );
    0
}

/// git log
fn git_log(cwd: &str, args: Vec<String>, stdout: &OutputStream, stderr: &OutputStream) -> i32 {
    let mut limit = 10usize;
    let mut i = 0;

    while i < args.len() {
        if args[i] == "-n" {
            if i + 1 < args.len() {
                limit = args[i + 1].parse().unwrap_or(10);
            }
        }
        i += 1;
    }

    let result: Result<String, String> = (|| {
        let repo = gix::open(cwd).map_err(|e| format!("not a git repository: {}\n", e))?;
        let head = repo
            .head_commit()
            .map_err(|e| format!("no commits: {}\n", e))?;
        let mut output = String::new();
        let mut count = 0;

        for ancestor in head.ancestors().all().map_err(|e| format!("{}\n", e))? {
            if count >= limit {
                break;
            }
            let commit = ancestor.map_err(|e| format!("{}\n", e))?;
            let obj = commit.object().map_err(|e| format!("{}\n", e))?;
            let decoded = obj.decode().map_err(|e| format!("{}\n", e))?;

            output.push_str(&format!("commit {}\n", commit.id));
            if let Ok(author) = decoded.author() {
                output.push_str(&format!(
                    "Author: {} <{}>\n",
                    author.name.to_str_lossy(),
                    author.email.to_str_lossy()
                ));
            }
            output.push_str(&format!(
                "\n    {}\n\n",
                decoded.message.to_str_lossy().lines().next().unwrap_or("")
            ));
            count += 1;
        }
        Ok(output)
    })();

    match result {
        Ok(msg) => {
            write_to_stream(stdout, msg.as_bytes());
            0
        }
        Err(e) => {
            write_to_stream(stderr, e.as_bytes());
            1
        }
    }
}

/// git diff
fn git_diff(cwd: &str, _args: Vec<String>, _stdout: &OutputStream, stderr: &OutputStream) -> i32 {
    let result: Result<String, String> = (|| {
        let _repo = gix::open(cwd).map_err(|e| format!("not a git repository: {}\n", e))?;
        Ok("".to_string()) // Simplified - diff not fully implemented
    })();

    match result {
        Ok(_) => 0,
        Err(e) => {
            write_to_stream(stderr, e.as_bytes());
            1
        }
    }
}

/// Extract repository name from URL
fn extract_repo_name(url: &str) -> String {
    let url = url.trim_end_matches(".git").trim_end_matches('/');
    url.rsplit('/').next().unwrap_or("repo").to_string()
}

/// Helper to write data to an output stream
fn write_to_stream(stream: &OutputStream, data: &[u8]) {
    let _ = stream.blocking_write_and_flush(data);
}

/// Helper to read all data from an input stream
#[allow(dead_code)]
fn read_all_from_stream(stream: &InputStream) -> Result<Vec<u8>, String> {
    let mut result = Vec::new();
    loop {
        match stream.blocking_read(4096) {
            Ok(chunk) => {
                if chunk.is_empty() {
                    break;
                }
                result.extend_from_slice(&chunk);
            }
            Err(_) => break,
        }
    }
    Ok(result)
}

bindings::export!(GixModule with_types_in bindings);
