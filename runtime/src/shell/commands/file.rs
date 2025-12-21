//! File manipulation commands: ls, cat, touch, mkdir, rmdir, rm, mv, cp

use futures_lite::io::AsyncWriteExt;
use lexopt::prelude::*;
use runtime_macros::{shell_command, shell_commands};

use super::super::ShellEnv;
use super::{make_parser, parse_common, CommandFn};

/// File manipulation commands.
pub struct FileCommands;

#[shell_commands]
impl FileCommands {
    /// ls - list directory
    #[shell_command(
        name = "ls",
        usage = "ls [-la] [PATH]...",
        description = "List directory contents"
    )]
    fn cmd_ls(
        args: Vec<String>,
        env: &ShellEnv,
        _stdin: piper::Reader,
        mut stdout: piper::Writer,
        mut stderr: piper::Writer,
    ) -> futures_lite::future::Boxed<i32> {
        let cwd_str = env.cwd.to_string_lossy().to_string();
        
        Box::pin(async move {
            let (opts, remaining) = parse_common(&args);
            if opts.help {
                if let Some(help) = FileCommands::show_help("ls") {
                    let _ = stdout.write_all(help.as_bytes()).await;
                    return 0;
                }
            }
            
            let mut long_format = false;
            let mut show_all = false;
            let mut paths: Vec<String> = Vec::new();
            let mut parser = make_parser(remaining);
            
            while let Some(arg) = parser.next().ok().flatten() {
                match arg {
                    Short('l') => long_format = true,
                    Short('a') => show_all = true,
                    Value(val) => paths.push(val.string().unwrap_or_default()),
                    _ => {}
                }
            }
            
            if paths.is_empty() {
                let path = if cwd_str == "." || cwd_str.is_empty() {
                    "/".to_string()
                } else {
                    cwd_str.clone()
                };
                paths.push(path);
            }
            
            for path in paths {
                let resolved = if path.starts_with('/') {
                    path.clone()
                } else if cwd_str == "." || cwd_str.is_empty() {
                    format!("/{}", path)
                } else {
                    format!("{}/{}", cwd_str, path)
                };
                
                match std::fs::read_dir(&resolved) {
                    Ok(entries) => {
                        let mut items: Vec<(String, std::fs::Metadata)> = entries
                            .filter_map(|e| e.ok())
                            .filter_map(|e| {
                                let name = e.file_name().to_string_lossy().to_string();
                                if !show_all && name.starts_with('.') {
                                    return None;
                                }
                                e.metadata().ok().map(|m| (name, m))
                            })
                            .collect();
                        items.sort_by(|a, b| a.0.cmp(&b.0));

                        for (name, meta) in items {
                            if long_format {
                                let size = meta.len();
                                let is_dir = if meta.is_dir() { "d" } else { "-" };
                                let line = format!("{} {:>8}  {}\n", is_dir, size, name);
                                let _ = stdout.write_all(line.as_bytes()).await;
                            } else {
                                let display = if meta.is_dir() {
                                    format!("{}/\n", name)
                                } else {
                                    format!("{}\n", name)
                                };
                                let _ = stdout.write_all(display.as_bytes()).await;
                            }
                        }
                    }
                    Err(e) => {
                        let msg = format!("ls: {}: {}\n", resolved, e);
                        let _ = stderr.write_all(msg.as_bytes()).await;
                        return 1;
                    }
                }
            }
            0
        })
    }

    /// cat - concatenate and display files
    #[shell_command(
        name = "cat",
        usage = "cat [FILE]...",
        description = "Concatenate files to standard output"
    )]
    fn cmd_cat(
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
                if let Some(help) = FileCommands::show_help("cat") {
                    let _ = stdout.write_all(help.as_bytes()).await;
                    return 0;
                }
            }
            
            if remaining.is_empty() {
                let mut buf = [0u8; 4096];
                let mut reader = stdin;
                loop {
                    match futures_lite::io::AsyncReadExt::read(&mut reader, &mut buf).await {
                        Ok(0) => break,
                        Ok(n) => {
                            if stdout.write_all(&buf[..n]).await.is_err() {
                                break;
                            }
                        }
                        Err(_) => break,
                    }
                }
            } else {
                for arg in &remaining {
                    let path = if arg.starts_with('/') {
                        arg.clone()
                    } else {
                        format!("{}/{}", cwd, arg)
                    };

                    match std::fs::read_to_string(&path) {
                        Ok(content) => {
                            if stdout.write_all(content.as_bytes()).await.is_err() {
                                return 1;
                            }
                        }
                        Err(e) => {
                            let msg = format!("cat: {}: {}\n", path, e);
                            let _ = stderr.write_all(msg.as_bytes()).await;
                            return 1;
                        }
                    }
                }
            }
            0
        })
    }

    /// touch - create empty file or update timestamps
    #[shell_command(
        name = "touch",
        usage = "touch FILE...",
        description = "Create empty files or update timestamps"
    )]
    fn cmd_touch(
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
                if let Some(help) = FileCommands::show_help("touch") {
                    let _ = stdout.write_all(help.as_bytes()).await;
                    return 0;
                }
            }
            
            if remaining.is_empty() {
                let _ = stderr.write_all(b"touch: missing file operand\n").await;
                return 1;
            }
            
            let mut exit_code = 0;
            for arg in &remaining {
                let path = if arg.starts_with('/') {
                    arg.clone()
                } else {
                    format!("{}/{}", cwd, arg)
                };
                
                if let Err(e) = std::fs::OpenOptions::new()
                    .create(true)
                    .write(true)
                    .open(&path)
                {
                    let msg = format!("touch: {}: {}\n", path, e);
                    let _ = stderr.write_all(msg.as_bytes()).await;
                    exit_code = 1;
                }
            }
            exit_code
        })
    }

    /// mkdir - create directories
    #[shell_command(
        name = "mkdir",
        usage = "mkdir [-p] DIR...",
        description = "Create directories"
    )]
    fn cmd_mkdir(
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
                if let Some(help) = FileCommands::show_help("mkdir") {
                    let _ = stdout.write_all(help.as_bytes()).await;
                    return 0;
                }
            }
            
            let mut parents = false;
            let mut dirs: Vec<String> = Vec::new();
            let mut parser = make_parser(remaining);
            
            while let Some(arg) = parser.next().ok().flatten() {
                match arg {
                    Short('p') => parents = true,
                    Value(val) => dirs.push(val.string().unwrap_or_default()),
                    _ => {}
                }
            }
            
            if dirs.is_empty() {
                let _ = stderr.write_all(b"mkdir: missing operand\n").await;
                return 1;
            }
            
            let mut exit_code = 0;
            for dir in dirs {
                let path = if dir.starts_with('/') {
                    dir.clone()
                } else {
                    format!("{}/{}", cwd, dir)
                };
                
                let result = if parents {
                    std::fs::create_dir_all(&path)
                } else {
                    std::fs::create_dir(&path)
                };
                
                if let Err(e) = result {
                    let msg = format!("mkdir: {}: {}\n", path, e);
                    let _ = stderr.write_all(msg.as_bytes()).await;
                    exit_code = 1;
                }
            }
            exit_code
        })
    }

    /// rmdir - remove empty directories
    #[shell_command(
        name = "rmdir",
        usage = "rmdir DIR...",
        description = "Remove empty directories"
    )]
    fn cmd_rmdir(
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
                if let Some(help) = FileCommands::show_help("rmdir") {
                    let _ = stdout.write_all(help.as_bytes()).await;
                    return 0;
                }
            }
            
            if remaining.is_empty() {
                let _ = stderr.write_all(b"rmdir: missing operand\n").await;
                return 1;
            }
            
            let mut exit_code = 0;
            for dir in &remaining {
                let path = if dir.starts_with('/') {
                    dir.clone()
                } else {
                    format!("{}/{}", cwd, dir)
                };
                
                if let Err(e) = std::fs::remove_dir(&path) {
                    let msg = format!("rmdir: {}: {}\n", path, e);
                    let _ = stderr.write_all(msg.as_bytes()).await;
                    exit_code = 1;
                }
            }
            exit_code
        })
    }

    /// rm - remove files or directories
    #[shell_command(
        name = "rm",
        usage = "rm [-rf] FILE...",
        description = "Remove files or directories"
    )]
    fn cmd_rm(
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
                if let Some(help) = FileCommands::show_help("rm") {
                    let _ = stdout.write_all(help.as_bytes()).await;
                    return 0;
                }
            }
            
            let mut recursive = false;
            let mut force = false;
            let mut files: Vec<String> = Vec::new();
            let mut parser = make_parser(remaining);
            
            while let Some(arg) = parser.next().ok().flatten() {
                match arg {
                    Short('r') | Short('R') => recursive = true,
                    Short('f') => force = true,
                    Value(val) => files.push(val.string().unwrap_or_default()),
                    _ => {}
                }
            }
            
            if files.is_empty() {
                if !force {
                    let _ = stderr.write_all(b"rm: missing operand\n").await;
                }
                return if force { 0 } else { 1 };
            }
            
            let mut exit_code = 0;
            for file in files {
                let path = if file.starts_with('/') {
                    file.clone()
                } else {
                    format!("{}/{}", cwd, file)
                };
                
                let metadata = match std::fs::metadata(&path) {
                    Ok(m) => m,
                    Err(e) => {
                        if !force {
                            let msg = format!("rm: {}: {}\n", path, e);
                            let _ = stderr.write_all(msg.as_bytes()).await;
                            exit_code = 1;
                        }
                        continue;
                    }
                };
                
                let result = if metadata.is_dir() {
                    if recursive {
                        std::fs::remove_dir_all(&path)
                    } else {
                        let msg = format!("rm: {}: is a directory\n", path);
                        let _ = stderr.write_all(msg.as_bytes()).await;
                        exit_code = 1;
                        continue;
                    }
                } else {
                    std::fs::remove_file(&path)
                };
                
                if let Err(e) = result {
                    if !force {
                        let msg = format!("rm: {}: {}\n", path, e);
                        let _ = stderr.write_all(msg.as_bytes()).await;
                        exit_code = 1;
                    }
                }
            }
            exit_code
        })
    }

    /// mv - move files
    #[shell_command(
        name = "mv",
        usage = "mv SOURCE DEST",
        description = "Move or rename files"
    )]
    fn cmd_mv(
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
                if let Some(help) = FileCommands::show_help("mv") {
                    let _ = stdout.write_all(help.as_bytes()).await;
                    return 0;
                }
            }
            
            if remaining.len() < 2 {
                let _ = stderr.write_all(b"mv: missing destination operand\n").await;
                return 1;
            }
            
            let resolve = |p: &str| -> String {
                if p.starts_with('/') { p.to_string() } else { format!("{}/{}", cwd, p) }
            };
            
            let src = resolve(&remaining[0]);
            let dst = resolve(&remaining[1]);
            
            if let Err(e) = std::fs::rename(&src, &dst) {
                let msg = format!("mv: {}: {}\n", src, e);
                let _ = stderr.write_all(msg.as_bytes()).await;
                return 1;
            }
            0
        })
    }

    /// cp - copy files
    #[shell_command(
        name = "cp",
        usage = "cp [-r] SOURCE DEST",
        description = "Copy files and directories"
    )]
    fn cmd_cp(
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
                if let Some(help) = FileCommands::show_help("cp") {
                    let _ = stdout.write_all(help.as_bytes()).await;
                    return 0;
                }
            }
            
            let mut recursive = false;
            let mut paths: Vec<String> = Vec::new();
            let mut parser = make_parser(remaining);
            
            while let Some(arg) = parser.next().ok().flatten() {
                match arg {
                    Short('r') | Short('R') => recursive = true,
                    Value(val) => paths.push(val.string().unwrap_or_default()),
                    _ => {}
                }
            }
            
            if paths.len() < 2 {
                let _ = stderr.write_all(b"cp: missing destination operand\n").await;
                return 1;
            }
            
            let resolve = |p: &str| -> String {
                if p.starts_with('/') { p.to_string() } else { format!("{}/{}", cwd, p) }
            };
            
            let src = resolve(&paths[0]);
            let dst = resolve(&paths[1]);
            
            let metadata = match std::fs::metadata(&src) {
                Ok(m) => m,
                Err(e) => {
                    let msg = format!("cp: {}: {}\n", src, e);
                    let _ = stderr.write_all(msg.as_bytes()).await;
                    return 1;
                }
            };
            
            if metadata.is_dir() {
                if !recursive {
                    let msg = format!("cp: {}: is a directory (use -r)\n", src);
                    let _ = stderr.write_all(msg.as_bytes()).await;
                    return 1;
                }
                if let Err(e) = super::copy_dir_recursive(&src, &dst) {
                    let msg = format!("cp: {}\n", e);
                    let _ = stderr.write_all(msg.as_bytes()).await;
                    return 1;
                }
            } else if let Err(e) = std::fs::copy(&src, &dst) {
                let msg = format!("cp: {}: {}\n", src, e);
                let _ = stderr.write_all(msg.as_bytes()).await;
                return 1;
            }
            0
        })
    }
}
