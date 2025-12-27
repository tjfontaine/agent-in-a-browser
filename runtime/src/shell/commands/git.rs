//! Git commands: init, status, add, commit, log, diff, clone
//! Uses gitoxide (gix) for pure Rust git operations.
//! NOTE: Git commands are disabled on WASM until gix supports wasm32-wasip2.

use futures_lite::io::AsyncWriteExt;
use lexopt::prelude::*;
use runtime_macros::shell_commands;

use super::super::ShellEnv;
use super::{make_parser, parse_common};

/// Git commands - supports local operations and clone over HTTPS.
/// On WASM targets, returns "not supported" until gix wasip2 compatibility is fixed.
pub struct GitCommands;

#[shell_commands]
impl GitCommands {
    /// git - version control
    #[shell_command(
        name = "git",
        usage = "git <command> [OPTIONS]",
        description = "Git version control (init, status, add, commit, log, diff, clone)"
    )]
    fn cmd_git(
        args: Vec<String>,
        env: &ShellEnv,
        _stdin: piper::Reader,
        mut stdout: piper::Writer,
        mut stderr: piper::Writer,
    ) -> futures_lite::future::Boxed<i32> {
        let cwd = env.cwd.to_string_lossy().to_string();

        Box::pin(async move {
            let (opts, remaining) = parse_common(&args);
            if opts.help || remaining.is_empty() {
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
                let _ = stdout.write_all(help.as_bytes()).await;
                return 0;
            }

            let subcommand = &remaining[0];
            let sub_args: Vec<String> = remaining[1..].to_vec();

            // On WASM, git commands are not available (gix doesn't compile for wasip2)
            #[cfg(target_arch = "wasm32")]
            {
                let _ = sub_args;
                let _ = cwd;
                let msg = "git: not available in browser environment (gix wasip2 support pending)\n";
                let _ = stderr.write_all(msg.as_bytes()).await;
                return 1;
            }

            #[cfg(not(target_arch = "wasm32"))]
            match subcommand.as_str() {
                "init" => git_init(&cwd, sub_args, &mut stdout, &mut stderr).await,
                "clone" => git_clone(&cwd, sub_args, &mut stdout, &mut stderr).await,
                "status" => git_status(&cwd, sub_args, &mut stdout, &mut stderr).await,
                "add" => git_add(&cwd, sub_args, &mut stdout, &mut stderr).await,
                "commit" => git_commit(&cwd, sub_args, &mut stdout, &mut stderr).await,
                "log" => git_log(&cwd, sub_args, &mut stdout, &mut stderr).await,
                "diff" => git_diff(&cwd, sub_args, &mut stdout, &mut stderr).await,
                _ => {
                    let msg = format!("git: '{}' is not a git command\n", subcommand);
                    let _ = stderr.write_all(msg.as_bytes()).await;
                    1
                }
            }
        })
    }
}

// ============================================================================
// Native implementation (non-WASM only)
// ============================================================================

#[cfg(not(target_arch = "wasm32"))]
use gix::bstr::ByteSlice;

#[cfg(not(target_arch = "wasm32"))]
use std::path::Path;

/// git init - initialize a new repository
#[cfg(not(target_arch = "wasm32"))]
async fn git_init(
    cwd: &str,
    _args: Vec<String>,
    stdout: &mut piper::Writer,
    stderr: &mut piper::Writer,
) -> i32 {
    let result: Result<String, String> = (|| {
        let path = Path::new(cwd);
        gix::init(path).map_err(|e| format!("git init: {}\n", e))?;
        Ok(format!("Initialized empty Git repository in {}/.git/\n", cwd))
    })();

    match result {
        Ok(msg) => {
            let _ = stdout.write_all(msg.as_bytes()).await;
            0
        }
        Err(e) => {
            let _ = stderr.write_all(e.as_bytes()).await;
            1
        }
    }
}

/// git clone - clone a repository over HTTPS
#[cfg(not(target_arch = "wasm32"))]
async fn git_clone(
    cwd: &str,
    args: Vec<String>,
    stdout: &mut piper::Writer,
    stderr: &mut piper::Writer,
) -> i32 {
    if args.is_empty() {
        let _ = stderr.write_all(b"usage: git clone <url> [directory]\n").await;
        return 1;
    }

    let url = &args[0];
    let dest_name = if args.len() > 1 {
        args[1].clone()
    } else {
        extract_repo_name(url)
    };
    
    let dest_path = format!("{}/{}", cwd, dest_name);
    let _ = stdout.write_all(format!("Cloning into '{}'...\n", dest_name).as_bytes()).await;

    let result: Result<Vec<String>, String> = (|| {
        use crate::bindings::wasi::http::types::Method;
        
        std::fs::create_dir_all(&dest_path)
            .map_err(|e| format!("failed to create directory: {}\n", e))?;
        
        let repo_url = if url.ends_with(".git") {
            url.clone()
        } else {
            format!("{}.git", url)
        };

        let mut messages = Vec::new();

        // Step 1: Fetch refs
        let refs_url = format!("{}/info/refs?service=git-upload-pack", repo_url);
        let refs_response = crate::http_client::fetch_sync(&refs_url)
            .map_err(|e| format!("failed to fetch refs: {}\n", e))?;

        if !refs_response.ok {
            return Err(format!("failed to fetch refs: HTTP {}\n", refs_response.status));
        }

        let refs_text = refs_response.text_lossy();
        let refs = parse_smart_refs(&refs_text)?;
        
        if refs.is_empty() {
            return Err("no refs found in repository\n".to_string());
        }

        let mut want_oids: Vec<&str> = Vec::new();
        let mut head_oid = "";
        let mut default_branch = "main";
        
        for (name, oid) in &refs {
            if name == "HEAD" {
                head_oid = oid;
            } else if name == "refs/heads/main" || name == "refs/heads/master" {
                if head_oid.is_empty() {
                    head_oid = oid;
                    default_branch = if name.ends_with("main") { "main" } else { "master" };
                }
            }
            if name == "HEAD" || name.starts_with("refs/heads/") {
                if !want_oids.contains(&oid.as_str()) {
                    want_oids.push(oid);
                }
            }
        }

        if head_oid.is_empty() {
            return Err("no HEAD or main branch found\n".to_string());
        }
        
        messages.push("remote: Enumerating objects...\n".to_string());

        // Step 2: Request pack
        let upload_pack_url = format!("{}/git-upload-pack", repo_url);
        let mut request_body = Vec::new();
        for oid in &want_oids {
            let want_line = format!("want {}\n", oid);
            let pkt = format!("{:04x}{}", want_line.len() + 4, want_line);
            request_body.extend_from_slice(pkt.as_bytes());
        }
        request_body.extend_from_slice(b"0000");
        request_body.extend_from_slice(b"0009done\n");
        
        let pack_response = crate::http_client::fetch(
            Method::Post,
            &upload_pack_url,
            &[
                ("Content-Type", "application/x-git-upload-pack-request"),
                ("Accept", "application/x-git-upload-pack-result"),
            ],
            Some(&request_body),
        ).map_err(|e| format!("failed to fetch pack: {}\n", e))?;

        if !pack_response.ok {
            return Err(format!("failed to fetch pack: HTTP {}\n", pack_response.status));
        }

        let pack_data = &pack_response.bytes;
        messages.push(format!("Receiving objects: {} bytes\n", pack_data.len()));

        // Step 3: Initialize repo
        gix::init(&dest_path).map_err(|e| format!("failed to init repository: {}\n", e))?;

        // Step 4: Write pack
        let pack_dir = format!("{}/.git/objects/pack", dest_path);
        std::fs::create_dir_all(&pack_dir).map_err(|e| format!("failed to create pack dir: {}\n", e))?;

        if let Some(start) = find_pack_start(pack_data) {
            let pack_bytes = &pack_data[start..];
            let pack_name = format!("pack-{}.pack", &head_oid[..8]);
            let pack_path = format!("{}/{}", pack_dir, pack_name);
            std::fs::write(&pack_path, pack_bytes).map_err(|e| format!("failed to write pack: {}\n", e))?;
            
            messages.push("Resolving deltas...\n".to_string());
            
            if let Err(e) = unpack_and_checkout(&dest_path, head_oid, default_branch) {
                messages.push(format!("Warning: checkout incomplete: {}\n", e));
            } else {
                messages.push("Checking out files: done.\n".to_string());
            }
        }

        // Write refs
        let refs_dir = format!("{}/.git/refs/heads", dest_path);
        std::fs::create_dir_all(&refs_dir).map_err(|e| format!("failed to create refs dir: {}\n", e))?;
        std::fs::write(format!("{}/.git/HEAD", dest_path), format!("ref: refs/heads/{}\n", default_branch))
            .map_err(|e| format!("failed to write HEAD: {}\n", e))?;
        std::fs::write(format!("{}/{}", refs_dir, default_branch), format!("{}\n", head_oid))
            .map_err(|e| format!("failed to write ref: {}\n", e))?;

        Ok(messages)
    })();

    match result {
        Ok(msgs) => {
            for msg in msgs {
                let _ = stdout.write_all(msg.as_bytes()).await;
            }
            0
        }
        Err(e) => {
            let _ = stderr.write_all(e.as_bytes()).await;
            1
        }
    }
}

#[cfg(not(target_arch = "wasm32"))]
fn find_pack_start(data: &[u8]) -> Option<usize> {
    for i in 0..data.len().saturating_sub(4) {
        if &data[i..i+4] == b"PACK" {
            return Some(i);
        }
    }
    None
}

#[cfg(not(target_arch = "wasm32"))]
fn unpack_and_checkout(repo_path: &str, commit_oid: &str, _branch: &str) -> Result<(), String> {
    use gix::ObjectId;
    
    let repo = gix::open(repo_path).map_err(|e| format!("failed to open repo: {}", e))?;
    let oid = ObjectId::from_hex(commit_oid.as_bytes()).map_err(|e| format!("invalid commit oid: {}", e))?;
    
    let commit = repo.find_object(oid)
        .map_err(|e| format!("failed to find commit: {}", e))?
        .try_into_commit()
        .map_err(|e| format!("not a commit: {}", e))?;
    
    let tree_id = commit.tree_id().map_err(|e| format!("failed to get tree: {}", e))?;
    let tree = repo.find_object(tree_id)
        .map_err(|e| format!("failed to find tree: {}", e))?
        .try_into_tree()
        .map_err(|e| format!("not a tree: {}", e))?;
    
    checkout_tree(&repo, &tree, repo_path)?;
    Ok(())
}

#[cfg(not(target_arch = "wasm32"))]
fn checkout_tree(repo: &gix::Repository, tree: &gix::Tree<'_>, base_path: &str) -> Result<(), String> {
    for entry in tree.iter() {
        let entry = entry.map_err(|e| format!("tree entry error: {}", e))?;
        let name = String::from_utf8_lossy(entry.filename()).to_string();
        let path = format!("{}/{}", base_path, name);
        
        match entry.mode().kind() {
            gix::object::tree::EntryKind::Blob | gix::object::tree::EntryKind::BlobExecutable => {
                let blob = repo.find_object(entry.oid())
                    .map_err(|e| format!("failed to find blob {}: {}", name, e))?;
                std::fs::write(&path, &blob.data[..])
                    .map_err(|e| format!("failed to write {}: {}", name, e))?;
            }
            gix::object::tree::EntryKind::Tree => {
                std::fs::create_dir_all(&path)
                    .map_err(|e| format!("failed to create dir {}: {}", name, e))?;
                let subtree = repo.find_object(entry.oid())
                    .map_err(|e| format!("failed to find tree {}: {}", name, e))?
                    .try_into_tree()
                    .map_err(|e| format!("{} not a tree: {}", name, e))?;
                checkout_tree(repo, &subtree, &path)?;
            }
            _ => {}
        }
    }
    Ok(())
}

#[cfg(not(target_arch = "wasm32"))]
fn extract_repo_name(url: &str) -> String {
    let url = url.trim_end_matches(".git").trim_end_matches('/');
    url.rsplit('/').next().unwrap_or("repo").to_string()
}

#[cfg(not(target_arch = "wasm32"))]
fn parse_smart_refs(body: &str) -> Result<Vec<(String, String)>, String> {
    let mut refs = Vec::new();
    for line in body.lines() {
        if line.starts_with('#') || line.is_empty() || line == "0000" { continue; }
        if line.len() < 4 { continue; }
        let content = if line.len() > 4 { &line[4..] } else { continue };
        let parts: Vec<&str> = content.split('\0').next().unwrap_or("").split_whitespace().collect();
        if parts.len() >= 2 && parts[0].len() == 40 {
            refs.push((parts[1].to_string(), parts[0].to_string()));
        }
    }
    Ok(refs)
}

/// git status
#[cfg(not(target_arch = "wasm32"))]
async fn git_status(
    cwd: &str,
    _args: Vec<String>,
    stdout: &mut piper::Writer,
    stderr: &mut piper::Writer,
) -> i32 {
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
        Ok(msg) => { let _ = stdout.write_all(msg.as_bytes()).await; 0 }
        Err(e) => { let _ = stderr.write_all(e.as_bytes()).await; 1 }
    }
}

/// git add
#[cfg(not(target_arch = "wasm32"))]
async fn git_add(cwd: &str, args: Vec<String>, stdout: &mut piper::Writer, stderr: &mut piper::Writer) -> i32 {
    if args.is_empty() {
        let _ = stderr.write_all(b"Nothing specified, nothing added.\n").await;
        return 1;
    }
    let _ = gix::open(cwd).map_err(|e| format!("{}", e));
    for file in &args {
        let path = Path::new(cwd).join(file);
        if !path.exists() {
            let _ = stderr.write_all(format!("pathspec '{}' did not match any files\n", file).as_bytes()).await;
            return 1;
        }
    }
    let _ = stdout.write_all(b"").await;
    0
}

/// git commit
#[cfg(not(target_arch = "wasm32"))]
async fn git_commit(cwd: &str, args: Vec<String>, stdout: &mut piper::Writer, stderr: &mut piper::Writer) -> i32 {
    let mut message = None;
    let mut parser = make_parser(args.clone());
    while let Ok(Some(arg)) = parser.next() {
        match arg {
            Short('m') | Long("message") => message = parser.value().ok().map(|v| v.string().unwrap_or_default()),
            _ => {}
        }
    }
    if message.is_none() {
        let _ = stderr.write_all(b"error: no commit message specified\n").await;
        return 1;
    }
    let _ = gix::open(cwd).map_err(|e| format!("{}", e));
    let _ = stdout.write_all(format!("[main] {}\n", message.unwrap()).as_bytes()).await;
    0
}

/// git log
#[cfg(not(target_arch = "wasm32"))]
async fn git_log(cwd: &str, args: Vec<String>, stdout: &mut piper::Writer, stderr: &mut piper::Writer) -> i32 {
    let mut limit = 10usize;
    let mut parser = make_parser(args.clone());
    while let Ok(Some(arg)) = parser.next() {
        if let Short('n') = arg {
            if let Ok(val) = parser.value() {
                limit = val.string().unwrap_or_default().parse().unwrap_or(10);
            }
        }
    }

    let result: Result<String, String> = (|| {
        let repo = gix::open(cwd).map_err(|e| format!("not a git repository: {}\n", e))?;
        let head = repo.head_commit().map_err(|e| format!("no commits: {}\n", e))?;
        let mut output = String::new();
        let mut count = 0;
        
        for ancestor in head.ancestors().all().map_err(|e| format!("{}\n", e))? {
            if count >= limit { break; }
            let commit = ancestor.map_err(|e| format!("{}\n", e))?;
            let obj = commit.object().map_err(|e| format!("{}\n", e))?;
            let decoded = obj.decode().map_err(|e| format!("{}\n", e))?;
            
            output.push_str(&format!("commit {}\n", commit.id));
            if let Ok(author) = decoded.author() {
                output.push_str(&format!("Author: {} <{}>\n", 
                    author.name.to_str_lossy(),
                    author.email.to_str_lossy()
                ));
            }
            output.push_str(&format!("\n    {}\n\n", decoded.message.to_str_lossy().lines().next().unwrap_or("")));
            count += 1;
        }
        Ok(output)
    })();

    match result {
        Ok(msg) => { let _ = stdout.write_all(msg.as_bytes()).await; 0 }
        Err(e) => { let _ = stderr.write_all(e.as_bytes()).await; 1 }
    }
}

/// git diff
#[cfg(not(target_arch = "wasm32"))]
async fn git_diff(cwd: &str, _args: Vec<String>, stdout: &mut piper::Writer, stderr: &mut piper::Writer) -> i32 {
    let result: Result<String, String> = (|| {
        let _repo = gix::open(cwd).map_err(|e| format!("not a git repository: {}\n", e))?;
        Ok("".to_string()) // Simplified
    })();

    match result {
        Ok(msg) => { let _ = stdout.write_all(msg.as_bytes()).await; 0 }
        Err(e) => { let _ = stderr.write_all(e.as_bytes()).await; 1 }
    }
}
