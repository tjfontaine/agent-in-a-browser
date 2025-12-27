//! Archive manipulation commands: tar, gzip, gunzip, zcat, bzip2, bunzip2, zip, unzip

use flate2::read::{GzDecoder, GzEncoder};
use flate2::Compression;
use futures_lite::io::AsyncWriteExt;
use lexopt::prelude::*;
use runtime_macros::shell_commands;
use std::io::{Read, Write};

use super::super::ShellEnv;
use super::{make_parser, parse_common};

/// Archive manipulation commands.
pub struct ArchiveCommands;

#[shell_commands]
impl ArchiveCommands {
    /// tar - archive manipulation
    #[shell_command(
        name = "tar",
        usage = "tar [-c|-x|-t] [-v] [-z|-j] [-f FILE] [FILES...]",
        description = "Create, extract, or list TAR archives"
    )]
    fn cmd_tar(
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
                if let Some(help) = ArchiveCommands::show_help("tar") {
                    let _ = stdout.write_all(help.as_bytes()).await;
                    return 0;
                }
            }

            let mut create = false;
            let mut extract = false;
            let mut list = false;
            let mut verbose = false;
            let mut gzip = false;
            let mut bzip2 = false;
            let mut archive_file: Option<String> = None;
            let mut files: Vec<String> = Vec::new();
            let mut parser = make_parser(remaining);

            while let Some(arg) = parser.next().ok().flatten() {
                match arg {
                    Short('c') => create = true,
                    Short('x') => extract = true,
                    Short('t') => list = true,
                    Short('v') => verbose = true,
                    Short('z') => gzip = true,
                    Short('j') => bzip2 = true,
                    Short('f') => {
                        if let Ok(val) = parser.value() {
                            archive_file = Some(val.string().unwrap_or_default());
                        }
                    }
                    Value(val) => files.push(val.string().unwrap_or_default()),
                    _ => {}
                }
            }

            let resolve = |p: &str| -> String {
                if p.starts_with('/') {
                    p.to_string()
                } else {
                    format!("{}/{}", cwd, p)
                }
            };

            // Determine operation based on flags
            if create {
                // Create archive - do synchronously to avoid Send issues with tar::Builder
                let archive_path = match &archive_file {
                    Some(f) => resolve(f),
                    None => {
                        let _ = stderr.write_all(b"tar: no archive file specified (-f)\n").await;
                        return 1;
                    }
                };

                if files.is_empty() {
                    let _ = stderr.write_all(b"tar: no files to archive\n").await;
                    return 1;
                }

                // Do all tar operations synchronously
                let result: Result<(Vec<String>, Vec<String>), String> = (|| {
                    let file = std::fs::File::create(&archive_path)
                        .map_err(|e| format!("tar: {}: {}\n", archive_path, e))?;

                    // Apply compression wrapper if needed
                    let writer: Box<dyn Write> = if gzip {
                        Box::new(flate2::write::GzEncoder::new(file, Compression::default()))
                    } else if bzip2 {
                        Box::new(bzip2::write::BzEncoder::new(file, bzip2::Compression::default()))
                    } else {
                        Box::new(file)
                    };

                    let mut builder = tar::Builder::new(writer);
                    let mut stdout_msgs = Vec::new();
                    let mut stderr_msgs = Vec::new();

                    for file_path in &files {
                        let resolved = resolve(file_path);
                        let metadata = match std::fs::metadata(&resolved) {
                            Ok(m) => m,
                            Err(e) => {
                                stderr_msgs.push(format!("tar: {}: {}\n", resolved, e));
                                continue;
                            }
                        };

                        // Archive paths must be relative - strip leading slash
                        let archive_path = file_path.trim_start_matches('/');
                        
                        if verbose {
                            stdout_msgs.push(format!("a {}\n", archive_path));
                        }

                        if metadata.is_dir() {
                            if let Err(e) = builder.append_dir_all(archive_path, &resolved) {
                                stderr_msgs.push(format!("tar: {}: {}\n", resolved, e));
                            }
                        } else {
                            // Read file content first to avoid WASI File::metadata issues
                            let content = match std::fs::read(&resolved) {
                                Ok(c) => c,
                                Err(e) => {
                                    stderr_msgs.push(format!("tar: {}: {}\n", resolved, e));
                                    continue;
                                }
                            };
                            
                            // Create header manually
                            let mut header = tar::Header::new_gnu();
                            header.set_path(archive_path).unwrap_or_else(|_| {});
                            header.set_size(content.len() as u64);
                            header.set_mode(0o644);
                            header.set_mtime(metadata.modified()
                                .map(|t| t.duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs())
                                .unwrap_or(0));
                            header.set_cksum();
                            
                            if let Err(e) = builder.append_data(&mut header, archive_path, content.as_slice()) {
                                stderr_msgs.push(format!("tar: {}: {}\n", resolved, e));
                            }
                        }
                    }

                    builder.finish()
                        .map_err(|e| format!("tar: error finishing archive: {}\n", e))?;

                    Ok((stdout_msgs, stderr_msgs))
                })();

                match result {
                    Ok((stdout_msgs, stderr_msgs)) => {
                        for msg in stdout_msgs {
                            let _ = stdout.write_all(msg.as_bytes()).await;
                        }
                        for msg in stderr_msgs {
                            let _ = stderr.write_all(msg.as_bytes()).await;
                        }
                        0
                    }
                    Err(e) => {
                        let _ = stderr.write_all(e.as_bytes()).await;
                        1
                    }
                }
            } else if extract {
                // Extract archive - do synchronously to avoid Send issues with tar::Entry
                let archive_path = match &archive_file {
                    Some(f) => resolve(f),
                    None => {
                        let _ = stderr.write_all(b"tar: no archive file specified (-f)\n").await;
                        return 1;
                    }
                };

                let is_gzip = gzip || archive_path.ends_with(".gz") || archive_path.ends_with(".tgz");
                let is_bzip2 = bzip2 || archive_path.ends_with(".bz2") || archive_path.ends_with(".tbz") || archive_path.ends_with(".tbz2");

                // Do all tar operations synchronously
                let result: Result<(Vec<String>, Vec<String>), String> = (|| {
                    let file = std::fs::File::open(&archive_path)
                        .map_err(|e| format!("tar: {}: {}\n", archive_path, e))?;

                    let reader: Box<dyn Read> = if is_gzip {
                        Box::new(GzDecoder::new(file))
                    } else if is_bzip2 {
                        Box::new(bzip2::read::BzDecoder::new(file))
                    } else {
                        Box::new(file)
                    };

                    let mut archive = tar::Archive::new(reader);
                    let entries = archive.entries()
                        .map_err(|e| format!("tar: error reading archive: {}\n", e))?;

                    let mut stdout_msgs = Vec::new();
                    let mut stderr_msgs = Vec::new();

                    for entry in entries {
                        match entry {
                            Ok(mut e) => {
                                let path = match e.path() {
                                    Ok(p) => p.to_string_lossy().to_string(),
                                    Err(_) => continue,
                                };
                                if verbose {
                                    stdout_msgs.push(format!("x {}\n", path));
                                }
                                let dest = format!("{}/{}", cwd, path);
                                if let Err(e) = e.unpack(&dest) {
                                    stderr_msgs.push(format!("tar: {}: {}\n", path, e));
                                }
                            }
                            Err(e) => {
                                stderr_msgs.push(format!("tar: error reading entry: {}\n", e));
                            }
                        }
                    }
                    Ok((stdout_msgs, stderr_msgs))
                })();

                match result {
                    Ok((stdout_msgs, stderr_msgs)) => {
                        for msg in stdout_msgs {
                            let _ = stdout.write_all(msg.as_bytes()).await;
                        }
                        for msg in stderr_msgs {
                            let _ = stderr.write_all(msg.as_bytes()).await;
                        }
                        0
                    }
                    Err(e) => {
                        let _ = stderr.write_all(e.as_bytes()).await;
                        1
                    }
                }
            } else if list {
                // List archive contents - do synchronously to avoid Send issues
                let archive_path = match &archive_file {
                    Some(f) => resolve(f),
                    None => {
                        let _ = stderr.write_all(b"tar: no archive file specified (-f)\n").await;
                        return 1;
                    }
                };

                let is_gzip = gzip || archive_path.ends_with(".gz") || archive_path.ends_with(".tgz");
                let is_bzip2 = bzip2 || archive_path.ends_with(".bz2") || archive_path.ends_with(".tbz") || archive_path.ends_with(".tbz2");

                // Do all tar operations synchronously
                let result: Result<(Vec<String>, Vec<String>), String> = (|| {
                    let file = std::fs::File::open(&archive_path)
                        .map_err(|e| format!("tar: {}: {}\n", archive_path, e))?;

                    let reader: Box<dyn Read> = if is_gzip {
                        Box::new(GzDecoder::new(file))
                    } else if is_bzip2 {
                        Box::new(bzip2::read::BzDecoder::new(file))
                    } else {
                        Box::new(file)
                    };

                    let mut archive = tar::Archive::new(reader);
                    let entries = archive.entries()
                        .map_err(|e| format!("tar: error reading archive: {}\n", e))?;

                    let mut stdout_msgs = Vec::new();
                    let mut stderr_msgs = Vec::new();

                    for entry in entries {
                        match entry {
                            Ok(e) => {
                                if let Ok(path) = e.path() {
                                    if verbose {
                                        let size = e.size();
                                        stdout_msgs.push(format!("{:>10} {}\n", size, path.display()));
                                    } else {
                                        stdout_msgs.push(format!("{}\n", path.display()));
                                    }
                                }
                            }
                            Err(e) => {
                                stderr_msgs.push(format!("tar: error reading entry: {}\n", e));
                            }
                        }
                    }
                    Ok((stdout_msgs, stderr_msgs))
                })();

                match result {
                    Ok((stdout_msgs, stderr_msgs)) => {
                        for msg in stdout_msgs {
                            let _ = stdout.write_all(msg.as_bytes()).await;
                        }
                        for msg in stderr_msgs {
                            let _ = stderr.write_all(msg.as_bytes()).await;
                        }
                        0
                    }
                    Err(e) => {
                        let _ = stderr.write_all(e.as_bytes()).await;
                        1
                    }
                }
            } else {
                let _ = stderr.write_all(b"tar: must specify -c, -x, or -t\n").await;
                1
            }
        })
    }

    /// gzip - compress files
    #[shell_command(
        name = "gzip",
        usage = "gzip [-d] [-c] [-k] [FILE]",
        description = "Compress or decompress files using gzip"
    )]
    fn cmd_gzip(
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
                if let Some(help) = ArchiveCommands::show_help("gzip") {
                    let _ = stdout.write_all(help.as_bytes()).await;
                    return 0;
                }
            }

            let mut decompress = false;
            let mut to_stdout = false;
            let mut keep = false;
            let mut files: Vec<String> = Vec::new();
            let mut parser = make_parser(remaining);

            while let Some(arg) = parser.next().ok().flatten() {
                match arg {
                    Short('d') => decompress = true,
                    Short('c') => to_stdout = true,
                    Short('k') => keep = true,
                    Value(val) => files.push(val.string().unwrap_or_default()),
                    _ => {}
                }
            }

            let resolve = |p: &str| -> String {
                if p.starts_with('/') {
                    p.to_string()
                } else {
                    format!("{}/{}", cwd, p)
                }
            };

            // If no files, read from stdin and write to stdout
            if files.is_empty() {
                let mut input_data = Vec::new();
                let mut reader = stdin;
                let mut buf = [0u8; 4096];
                loop {
                    match futures_lite::io::AsyncReadExt::read(&mut reader, &mut buf).await {
                        Ok(0) => break,
                        Ok(n) => input_data.extend_from_slice(&buf[..n]),
                        Err(_) => break,
                    }
                }

                if decompress {
                    let mut decoder = GzDecoder::new(&input_data[..]);
                    let mut output = Vec::new();
                    if let Err(e) = decoder.read_to_end(&mut output) {
                        let msg = format!("gzip: {}\n", e);
                        let _ = stderr.write_all(msg.as_bytes()).await;
                        return 1;
                    }
                    let _ = stdout.write_all(&output).await;
                } else {
                    let mut encoder = GzEncoder::new(&input_data[..], Compression::default());
                    let mut output = Vec::new();
                    if let Err(e) = encoder.read_to_end(&mut output) {
                        let msg = format!("gzip: {}\n", e);
                        let _ = stderr.write_all(msg.as_bytes()).await;
                        return 1;
                    }
                    let _ = stdout.write_all(&output).await;
                }
                return 0;
            }

            for file_path in &files {
                let input_path = resolve(file_path);
                
                let input_data = match std::fs::read(&input_path) {
                    Ok(d) => d,
                    Err(e) => {
                        let msg = format!("gzip: {}: {}\n", input_path, e);
                        let _ = stderr.write_all(msg.as_bytes()).await;
                        return 1;
                    }
                };

                if decompress {
                    // Decompress
                    if !input_path.ends_with(".gz") {
                        let msg = format!("gzip: {}: unknown suffix -- ignored\n", input_path);
                        let _ = stderr.write_all(msg.as_bytes()).await;
                        continue;
                    }

                    let mut decoder = GzDecoder::new(&input_data[..]);
                    let mut output = Vec::new();
                    if let Err(e) = decoder.read_to_end(&mut output) {
                        let msg = format!("gzip: {}: {}\n", input_path, e);
                        let _ = stderr.write_all(msg.as_bytes()).await;
                        return 1;
                    }

                    if to_stdout {
                        let _ = stdout.write_all(&output).await;
                    } else {
                        let output_path = input_path.trim_end_matches(".gz");
                        if let Err(e) = std::fs::write(output_path, &output) {
                            let msg = format!("gzip: {}: {}\n", output_path, e);
                            let _ = stderr.write_all(msg.as_bytes()).await;
                            return 1;
                        }
                        if !keep {
                            let _ = std::fs::remove_file(&input_path);
                        }
                    }
                } else {
                    // Compress
                    let mut encoder = GzEncoder::new(&input_data[..], Compression::default());
                    let mut output = Vec::new();
                    if let Err(e) = encoder.read_to_end(&mut output) {
                        let msg = format!("gzip: {}: {}\n", input_path, e);
                        let _ = stderr.write_all(msg.as_bytes()).await;
                        return 1;
                    }

                    if to_stdout {
                        let _ = stdout.write_all(&output).await;
                    } else {
                        let output_path = format!("{}.gz", input_path);
                        if let Err(e) = std::fs::write(&output_path, &output) {
                            let msg = format!("gzip: {}: {}\n", output_path, e);
                            let _ = stderr.write_all(msg.as_bytes()).await;
                            return 1;
                        }
                        if !keep {
                            let _ = std::fs::remove_file(&input_path);
                        }
                    }
                }
            }
            0
        })
    }

    /// gunzip - decompress gzip files
    #[shell_command(
        name = "gunzip",
        usage = "gunzip [-c] [-k] [FILE]",
        description = "Decompress gzip files"
    )]
    fn cmd_gunzip(
        args: Vec<String>,
        env: &ShellEnv,
        stdin: piper::Reader,
        stdout: piper::Writer,
        stderr: piper::Writer,
    ) -> futures_lite::future::Boxed<i32> {
        // gunzip is just gzip -d
        let mut new_args = vec!["-d".to_string()];
        new_args.extend(args);
        ArchiveCommands::cmd_gzip(new_args, env, stdin, stdout, stderr)
    }

    /// zcat - view compressed file contents
    #[shell_command(
        name = "zcat",
        usage = "zcat [FILE]",
        description = "View contents of gzip compressed files"
    )]
    fn cmd_zcat(
        args: Vec<String>,
        env: &ShellEnv,
        stdin: piper::Reader,
        stdout: piper::Writer,
        stderr: piper::Writer,
    ) -> futures_lite::future::Boxed<i32> {
        // zcat is just gzip -dc
        let mut new_args = vec!["-d".to_string(), "-c".to_string()];
        new_args.extend(args);
        ArchiveCommands::cmd_gzip(new_args, env, stdin, stdout, stderr)
    }

    /// bzip2 - compress files with bzip2
    #[shell_command(
        name = "bzip2",
        usage = "bzip2 [-d] [-c] [-k] [FILE]",
        description = "Compress or decompress files using bzip2"
    )]
    fn cmd_bzip2(
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
                if let Some(help) = ArchiveCommands::show_help("bzip2") {
                    let _ = stdout.write_all(help.as_bytes()).await;
                    return 0;
                }
            }

            let mut decompress = false;
            let mut to_stdout = false;
            let mut keep = false;
            let mut files: Vec<String> = Vec::new();
            let mut parser = make_parser(remaining);

            while let Some(arg) = parser.next().ok().flatten() {
                match arg {
                    Short('d') => decompress = true,
                    Short('c') => to_stdout = true,
                    Short('k') => keep = true,
                    Value(val) => files.push(val.string().unwrap_or_default()),
                    _ => {}
                }
            }

            let resolve = |p: &str| -> String {
                if p.starts_with('/') {
                    p.to_string()
                } else {
                    format!("{}/{}", cwd, p)
                }
            };

            // If no files, read from stdin
            if files.is_empty() {
                let mut input_data = Vec::new();
                let mut reader = stdin;
                let mut buf = [0u8; 4096];
                loop {
                    match futures_lite::io::AsyncReadExt::read(&mut reader, &mut buf).await {
                        Ok(0) => break,
                        Ok(n) => input_data.extend_from_slice(&buf[..n]),
                        Err(_) => break,
                    }
                }

                if decompress {
                    let mut decoder = bzip2::read::BzDecoder::new(&input_data[..]);
                    let mut output = Vec::new();
                    if let Err(e) = decoder.read_to_end(&mut output) {
                        let msg = format!("bzip2: {}\n", e);
                        let _ = stderr.write_all(msg.as_bytes()).await;
                        return 1;
                    }
                    let _ = stdout.write_all(&output).await;
                } else {
                    let mut encoder = bzip2::read::BzEncoder::new(&input_data[..], bzip2::Compression::default());
                    let mut output = Vec::new();
                    if let Err(e) = encoder.read_to_end(&mut output) {
                        let msg = format!("bzip2: {}\n", e);
                        let _ = stderr.write_all(msg.as_bytes()).await;
                        return 1;
                    }
                    let _ = stdout.write_all(&output).await;
                }
                return 0;
            }

            for file_path in &files {
                let input_path = resolve(file_path);
                
                let input_data = match std::fs::read(&input_path) {
                    Ok(d) => d,
                    Err(e) => {
                        let msg = format!("bzip2: {}: {}\n", input_path, e);
                        let _ = stderr.write_all(msg.as_bytes()).await;
                        return 1;
                    }
                };

                if decompress {
                    if !input_path.ends_with(".bz2") {
                        let msg = format!("bzip2: {}: unknown suffix -- ignored\n", input_path);
                        let _ = stderr.write_all(msg.as_bytes()).await;
                        continue;
                    }

                    let mut decoder = bzip2::read::BzDecoder::new(&input_data[..]);
                    let mut output = Vec::new();
                    if let Err(e) = decoder.read_to_end(&mut output) {
                        let msg = format!("bzip2: {}: {}\n", input_path, e);
                        let _ = stderr.write_all(msg.as_bytes()).await;
                        return 1;
                    }

                    if to_stdout {
                        let _ = stdout.write_all(&output).await;
                    } else {
                        let output_path = input_path.trim_end_matches(".bz2");
                        if let Err(e) = std::fs::write(output_path, &output) {
                            let msg = format!("bzip2: {}: {}\n", output_path, e);
                            let _ = stderr.write_all(msg.as_bytes()).await;
                            return 1;
                        }
                        if !keep {
                            let _ = std::fs::remove_file(&input_path);
                        }
                    }
                } else {
                    let mut encoder = bzip2::read::BzEncoder::new(&input_data[..], bzip2::Compression::default());
                    let mut output = Vec::new();
                    if let Err(e) = encoder.read_to_end(&mut output) {
                        let msg = format!("bzip2: {}: {}\n", input_path, e);
                        let _ = stderr.write_all(msg.as_bytes()).await;
                        return 1;
                    }

                    if to_stdout {
                        let _ = stdout.write_all(&output).await;
                    } else {
                        let output_path = format!("{}.bz2", input_path);
                        if let Err(e) = std::fs::write(&output_path, &output) {
                            let msg = format!("bzip2: {}: {}\n", output_path, e);
                            let _ = stderr.write_all(msg.as_bytes()).await;
                            return 1;
                        }
                        if !keep {
                            let _ = std::fs::remove_file(&input_path);
                        }
                    }
                }
            }
            0
        })
    }

    /// bunzip2 - decompress bzip2 files
    #[shell_command(
        name = "bunzip2",
        usage = "bunzip2 [-c] [-k] [FILE]",
        description = "Decompress bzip2 files"
    )]
    fn cmd_bunzip2(
        args: Vec<String>,
        env: &ShellEnv,
        stdin: piper::Reader,
        stdout: piper::Writer,
        stderr: piper::Writer,
    ) -> futures_lite::future::Boxed<i32> {
        let mut new_args = vec!["-d".to_string()];
        new_args.extend(args);
        ArchiveCommands::cmd_bzip2(new_args, env, stdin, stdout, stderr)
    }

    /// zip - create ZIP archives
    #[shell_command(
        name = "zip",
        usage = "zip [-r] ARCHIVE FILE...",
        description = "Create ZIP archives"
    )]
    fn cmd_zip(
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
                if let Some(help) = ArchiveCommands::show_help("zip") {
                    let _ = stdout.write_all(help.as_bytes()).await;
                    return 0;
                }
            }

            let mut recursive = false;
            let mut files: Vec<String> = Vec::new();
            let mut parser = make_parser(remaining);

            while let Some(arg) = parser.next().ok().flatten() {
                match arg {
                    Short('r') => recursive = true,
                    Value(val) => files.push(val.string().unwrap_or_default()),
                    _ => {}
                }
            }

            if files.len() < 2 {
                let _ = stderr.write_all(b"zip: need archive name and files to add\n").await;
                return 1;
            }

            let resolve = |p: &str| -> String {
                if p.starts_with('/') {
                    p.to_string()
                } else {
                    format!("{}/{}", cwd, p)
                }
            };

            let archive_path = resolve(&files[0]);
            let files_to_add = &files[1..];

            // Use in-memory buffer to avoid WASI streaming issues with direct File writes
            let mut buffer = std::io::Cursor::new(Vec::new());

            {
                let mut zip = zip_next::ZipWriter::new(&mut buffer);
                let options = zip_next::write::SimpleFileOptions::default()
                    .compression_method(zip_next::CompressionMethod::Deflated);

                fn add_file_to_zip<W: Write + std::io::Seek>(
                    zip: &mut zip_next::ZipWriter<W>,
                    file_path: &str,
                    archive_name: &str,
                    options: zip_next::write::SimpleFileOptions,
                ) -> Result<(), String> {
                    let content = std::fs::read(file_path)
                        .map_err(|e| format!("{}: {}", file_path, e))?;
                    zip.start_file(archive_name, options)
                        .map_err(|e| format!("{}: {}", archive_name, e))?;
                    zip.write_all(&content)
                        .map_err(|e| format!("{}: {}", archive_name, e))?;
                    Ok(())
                }

                fn add_dir_to_zip<W: Write + std::io::Seek>(
                    zip: &mut zip_next::ZipWriter<W>,
                    dir_path: &str,
                    base_name: &str,
                    options: zip_next::write::SimpleFileOptions,
                ) -> Result<(), String> {
                    for entry in std::fs::read_dir(dir_path)
                        .map_err(|e| format!("{}: {}", dir_path, e))?
                    {
                        let entry = entry.map_err(|e| format!("{}", e))?;
                        let path = entry.path();
                        let name = format!("{}/{}", base_name, entry.file_name().to_string_lossy());
                        
                        if path.is_dir() {
                            add_dir_to_zip(zip, &path.to_string_lossy(), &name, options)?;
                        } else {
                            add_file_to_zip(zip, &path.to_string_lossy(), &name, options)?;
                        }
                    }
                    Ok(())
                }

                for file_path in files_to_add {
                    let resolved = resolve(file_path);
                    let metadata = match std::fs::metadata(&resolved) {
                        Ok(m) => m,
                        Err(e) => {
                            let msg = format!("zip: {}: {}\n", resolved, e);
                            let _ = stderr.write_all(msg.as_bytes()).await;
                            continue;
                        }
                    };

                    if metadata.is_dir() {
                        if !recursive {
                            let msg = format!("zip: {}: is a directory (use -r)\n", resolved);
                            let _ = stderr.write_all(msg.as_bytes()).await;
                            continue;
                        }
                        if let Err(e) = add_dir_to_zip(&mut zip, &resolved, file_path, options) {
                            let msg = format!("zip: {}\n", e);
                            let _ = stderr.write_all(msg.as_bytes()).await;
                        }
                    } else {
                        if let Err(e) = add_file_to_zip(&mut zip, &resolved, file_path, options) {
                            let msg = format!("zip: {}\n", e);
                            let _ = stderr.write_all(msg.as_bytes()).await;
                        }
                    }
                }

                if let Err(e) = zip.finish() {
                    let msg = format!("zip: error finishing archive: {}\n", e);
                    let _ = stderr.write_all(msg.as_bytes()).await;
                    return 1;
                }
            }

            // Write the completed zip buffer to the file
            if let Err(e) = std::fs::write(&archive_path, buffer.into_inner()) {
                let msg = format!("zip: {}: {}\n", archive_path, e);
                let _ = stderr.write_all(msg.as_bytes()).await;
                return 1;
            }
            0
        })
    }

    /// unzip - extract ZIP archives
    #[shell_command(
        name = "unzip",
        usage = "unzip [-l] [-d DIR] ARCHIVE",
        description = "Extract ZIP archives"
    )]
    fn cmd_unzip(
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
                if let Some(help) = ArchiveCommands::show_help("unzip") {
                    let _ = stdout.write_all(help.as_bytes()).await;
                    return 0;
                }
            }

            let mut list_only = false;
            let mut dest_dir: Option<String> = None;
            let mut archive_file: Option<String> = None;
            let mut parser = make_parser(remaining);

            while let Some(arg) = parser.next().ok().flatten() {
                match arg {
                    Short('l') => list_only = true,
                    Short('d') => {
                        if let Ok(val) = parser.value() {
                            dest_dir = Some(val.string().unwrap_or_default());
                        }
                    }
                    Value(val) => archive_file = Some(val.string().unwrap_or_default()),
                    _ => {}
                }
            }

            let resolve = |p: &str| -> String {
                if p.starts_with('/') {
                    p.to_string()
                } else {
                    format!("{}/{}", cwd, p)
                }
            };

            let archive_path = match &archive_file {
                Some(f) => resolve(f),
                None => {
                    let _ = stderr.write_all(b"unzip: no archive specified\n").await;
                    return 1;
                }
            };

            let extract_dir = match &dest_dir {
                Some(d) => resolve(d),
                None => cwd.clone(),
            };

            // Do all zip operations synchronously to avoid Send issues with ZipFile  
            let result: Result<(Vec<String>, Vec<String>), String> = (|| {
                // Read entire file into memory to avoid WASI File::seek issues
                let file_data = std::fs::read(&archive_path)
                    .map_err(|e| format!("unzip: {}: {}\n", archive_path, e))?;
                
                let cursor = std::io::Cursor::new(file_data);
                let mut zip = zip_next::ZipArchive::new(cursor)
                    .map_err(|e| format!("unzip: {}: {}\n", archive_path, e))?;

                let mut stdout_msgs = Vec::new();
                let mut stderr_msgs = Vec::new();

                if list_only {
                    for i in 0..zip.len() {
                        if let Ok(file) = zip.by_index(i) {
                            stdout_msgs.push(format!("{:>10} {}\n", file.size(), file.name()));
                        }
                    }
                } else {
                    // Extract
                    for i in 0..zip.len() {
                        let mut file = match zip.by_index(i) {
                            Ok(f) => f,
                            Err(e) => {
                                stderr_msgs.push(format!("unzip: error reading entry: {}\n", e));
                                continue;
                            }
                        };

                        let outpath = format!("{}/{}", extract_dir, file.name());

                        if file.name().ends_with('/') {
                            // Directory
                            if let Err(e) = std::fs::create_dir_all(&outpath) {
                                stderr_msgs.push(format!("unzip: {}: {}\n", outpath, e));
                            }
                        } else {
                            // File
                            if let Some(parent) = std::path::Path::new(&outpath).parent() {
                                let _ = std::fs::create_dir_all(parent);
                            }
                            let mut content = Vec::new();
                            if let Err(e) = file.read_to_end(&mut content) {
                                stderr_msgs.push(format!("unzip: {}: {}\n", file.name(), e));
                                continue;
                            }
                            if let Err(e) = std::fs::write(&outpath, &content) {
                                stderr_msgs.push(format!("unzip: {}: {}\n", outpath, e));
                            }
                        }
                    }
                }

                Ok((stdout_msgs, stderr_msgs))
            })();

            match result {
                Ok((stdout_msgs, stderr_msgs)) => {
                    for msg in stdout_msgs {
                        let _ = stdout.write_all(msg.as_bytes()).await;
                    }
                    for msg in stderr_msgs {
                        let _ = stderr.write_all(msg.as_bytes()).await;
                    }
                    0
                }
                Err(e) => {
                    let _ = stderr.write_all(e.as_bytes()).await;
                    1
                }
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_archive_commands_exist() {
        assert!(ArchiveCommands::get_command("tar").is_some());
        assert!(ArchiveCommands::get_command("gzip").is_some());
        assert!(ArchiveCommands::get_command("gunzip").is_some());
        assert!(ArchiveCommands::get_command("zcat").is_some());
        assert!(ArchiveCommands::get_command("bzip2").is_some());
        assert!(ArchiveCommands::get_command("bunzip2").is_some());
        assert!(ArchiveCommands::get_command("zip").is_some());
        assert!(ArchiveCommands::get_command("unzip").is_some());
    }

    #[test]
    fn test_show_help() {
        let help = ArchiveCommands::show_help("tar");
        assert!(help.is_some());
        let text = help.unwrap();
        assert!(text.contains("tar"));
        assert!(text.contains("Usage:"));
    }
}
