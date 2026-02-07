//! Encoding and crypto commands: base64, md5sum, sha256sum, xxd

use base64::{engine::general_purpose, Engine as _};
use futures_lite::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use md5::Md5;
use runtime_macros::shell_commands;
use sha2::{Digest, Sha256};

use super::super::ShellEnv;
use super::parse_common;

/// Encoding commands.
pub struct EncodingCommands;

#[shell_commands]
impl EncodingCommands {
    /// base64 - encode/decode base64
    #[shell_command(
        name = "base64",
        usage = "base64 [-d] [FILE]",
        description = "Encode or decode base64.\n\
        -d: Decode data"
    )]
    pub fn cmd_base64(
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
                let help = EncodingCommands::show_help("base64").unwrap_or("");
                let _ = stdout.write_all(help.as_bytes()).await;
                return 0;
            }

            let mut decode = false;
            let mut file = None;

            for arg in &remaining {
                match arg.as_str() {
                    "-d" | "--decode" => decode = true,
                    s if !s.starts_with('-') => file = Some(s.to_string()),
                    _ => {}
                }
            }

            // Read input
            let input = if let Some(f) = file {
                let path = if f.starts_with('/') {
                    f
                } else {
                    format!("{}/{}", cwd, f)
                };
                match std::fs::read(&path) {
                    Ok(data) => data,
                    Err(e) => {
                        let _ = stderr
                            .write_all(format!("base64: {}: {}\n", path, e).as_bytes())
                            .await;
                        return 1;
                    }
                }
            } else {
                // Read from stdin
                let mut data = Vec::new();
                let mut reader = BufReader::new(stdin);
                let mut line = String::new();
                while reader.read_line(&mut line).await.unwrap_or(0) > 0 {
                    data.extend_from_slice(line.as_bytes());
                    line.clear();
                }
                data
            };

            if decode {
                // Filter whitespace before decoding
                let filtered: Vec<u8> = input
                    .iter()
                    .filter(|&&c| !c.is_ascii_whitespace())
                    .cloned()
                    .collect();
                match general_purpose::STANDARD.decode(&filtered) {
                    Ok(decoded) => {
                        let _ = stdout.write_all(&decoded).await;
                    }
                    Err(e) => {
                        let _ = stderr
                            .write_all(format!("base64: {}\n", e).as_bytes())
                            .await;
                        return 1;
                    }
                }
            } else {
                // Encode base64
                let encoded = general_purpose::STANDARD.encode(&input);
                let _ = stdout.write_all(encoded.as_bytes()).await;
                let _ = stdout.write_all(b"\n").await;
            }

            0
        })
    }

    /// md5sum - compute MD5 message digest
    #[shell_command(
        name = "md5sum",
        usage = "md5sum [FILE]...",
        description = "Compute and check MD5 message digest."
    )]
    pub fn cmd_md5sum(
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
                let help = EncodingCommands::show_help("md5sum").unwrap_or("");
                let _ = stdout.write_all(help.as_bytes()).await;
                return 0;
            }

            let mut exit_code = 0;

            if remaining.is_empty() {
                // Read from stdin
                let mut data = Vec::new();
                let mut reader = BufReader::new(stdin);
                let mut line = String::new();
                while reader.read_line(&mut line).await.unwrap_or(0) > 0 {
                    data.extend_from_slice(line.as_bytes());
                    line.clear();
                }
                let hash = format!("{:x}", Md5::digest(&data));
                let _ = stdout.write_all(format!("{}  -\n", hash).as_bytes()).await;
            } else {
                for file in &remaining {
                    let path = if file.starts_with('/') {
                        file.clone()
                    } else {
                        format!("{}/{}", cwd, file)
                    };

                    match std::fs::read(&path) {
                        Ok(data) => {
                            let hash = format!("{:x}", Md5::digest(&data));
                            let _ = stdout
                                .write_all(format!("{}  {}\n", hash, file).as_bytes())
                                .await;
                        }
                        Err(e) => {
                            let _ = stderr
                                .write_all(format!("md5sum: {}: {}\n", file, e).as_bytes())
                                .await;
                            exit_code = 1;
                        }
                    }
                }
            }

            exit_code
        })
    }

    /// sha256sum - compute SHA256 message digest
    #[shell_command(
        name = "sha256sum",
        usage = "sha256sum [FILE]...",
        description = "Compute and check SHA256 message digest."
    )]
    pub fn cmd_sha256sum(
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
                let help = EncodingCommands::show_help("sha256sum").unwrap_or("");
                let _ = stdout.write_all(help.as_bytes()).await;
                return 0;
            }

            let mut exit_code = 0;

            if remaining.is_empty() {
                // Read from stdin
                let mut data = Vec::new();
                let mut reader = BufReader::new(stdin);
                let mut line = String::new();
                while reader.read_line(&mut line).await.unwrap_or(0) > 0 {
                    data.extend_from_slice(line.as_bytes());
                    line.clear();
                }
                let hash = format!("{:x}", Sha256::digest(&data));
                let _ = stdout.write_all(format!("{}  -\n", hash).as_bytes()).await;
            } else {
                for file in &remaining {
                    let path = if file.starts_with('/') {
                        file.clone()
                    } else {
                        format!("{}/{}", cwd, file)
                    };

                    match std::fs::read(&path) {
                        Ok(data) => {
                            let hash = format!("{:x}", Sha256::digest(&data));
                            let _ = stdout
                                .write_all(format!("{}  {}\n", hash, file).as_bytes())
                                .await;
                        }
                        Err(e) => {
                            let _ = stderr
                                .write_all(format!("sha256sum: {}: {}\n", file, e).as_bytes())
                                .await;
                            exit_code = 1;
                        }
                    }
                }
            }

            exit_code
        })
    }

    /// xxd - make a hexdump
    #[shell_command(
        name = "xxd",
        usage = "xxd [-r] [FILE]",
        description = "Make a hexdump or reverse.\n\
        -r: Reverse operation (hexdump to binary)"
    )]
    pub fn cmd_xxd(
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
                let help = EncodingCommands::show_help("xxd").unwrap_or("");
                let _ = stdout.write_all(help.as_bytes()).await;
                return 0;
            }

            let mut reverse = false;
            let mut file = None;

            for arg in &remaining {
                match arg.as_str() {
                    "-r" => reverse = true,
                    s if !s.starts_with('-') => file = Some(s.to_string()),
                    _ => {}
                }
            }

            // Read input
            let input = if let Some(f) = file {
                let path = if f.starts_with('/') {
                    f
                } else {
                    format!("{}/{}", cwd, f)
                };
                match std::fs::read(&path) {
                    Ok(data) => data,
                    Err(e) => {
                        let _ = stderr
                            .write_all(format!("xxd: {}: {}\n", path, e).as_bytes())
                            .await;
                        return 1;
                    }
                }
            } else {
                // Read from stdin
                let mut data = Vec::new();
                let mut reader = BufReader::new(stdin);
                let mut line = String::new();
                while reader.read_line(&mut line).await.unwrap_or(0) > 0 {
                    data.extend_from_slice(line.as_bytes());
                    line.clear();
                }
                data
            };

            if reverse {
                // Reverse hexdump to binary (simplified)
                let hex_str: String = String::from_utf8_lossy(&input)
                    .chars()
                    .filter(|c| c.is_ascii_hexdigit())
                    .collect();

                let mut bytes = Vec::new();
                let mut chars = hex_str.chars().peekable();
                while chars.peek().is_some() {
                    let hi = chars.next().and_then(|c| c.to_digit(16)).unwrap_or(0);
                    let lo = chars.next().and_then(|c| c.to_digit(16)).unwrap_or(0);
                    bytes.push((hi * 16 + lo) as u8);
                }
                let _ = stdout.write_all(&bytes).await;
            } else {
                // Create hexdump
                for (offset, chunk) in input.chunks(16).enumerate() {
                    // Offset
                    let _ = stdout
                        .write_all(format!("{:08x}: ", offset * 16).as_bytes())
                        .await;

                    // Hex bytes
                    for (i, byte) in chunk.iter().enumerate() {
                        let _ = stdout.write_all(format!("{:02x}", byte).as_bytes()).await;
                        if i % 2 == 1 {
                            let _ = stdout.write_all(b" ").await;
                        }
                    }

                    // Padding for incomplete lines
                    for i in chunk.len()..16 {
                        let _ = stdout.write_all(b"  ").await;
                        if i % 2 == 1 {
                            let _ = stdout.write_all(b" ").await;
                        }
                    }

                    // ASCII representation
                    let _ = stdout.write_all(b" ").await;
                    for byte in chunk {
                        let c = if *byte >= 0x20 && *byte < 0x7f {
                            *byte as char
                        } else {
                            '.'
                        };
                        let _ = stdout.write_all(&[c as u8]).await;
                    }
                    let _ = stdout.write_all(b"\n").await;
                }
            }

            0
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Test that crate-based implementations produce correct hashes
    #[test]
    fn test_md5() {
        let hash = format!("{:x}", Md5::digest(b"hello"));
        assert_eq!(hash, "5d41402abc4b2a76b9719d911017c592");
    }

    #[test]
    fn test_md5_empty() {
        let hash = format!("{:x}", Md5::digest(b""));
        assert_eq!(hash, "d41d8cd98f00b204e9800998ecf8427e");
    }

    #[test]
    fn test_sha256() {
        let hash = format!("{:x}", Sha256::digest(b"hello"));
        assert_eq!(
            hash,
            "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
        );
    }

    #[test]
    fn test_sha256_empty() {
        let hash = format!("{:x}", Sha256::digest(b""));
        assert_eq!(
            hash,
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }

    #[test]
    fn test_base64_encode() {
        assert_eq!(general_purpose::STANDARD.encode(b"Hello"), "SGVsbG8=");
    }

    #[test]
    fn test_base64_decode() {
        assert_eq!(
            general_purpose::STANDARD.decode(b"SGVsbG8=").unwrap(),
            b"Hello"
        );
    }

    #[test]
    fn test_base64_roundtrip() {
        let data = b"The quick brown fox";
        let encoded = general_purpose::STANDARD.encode(data);
        let decoded = general_purpose::STANDARD.decode(encoded).unwrap();
        assert_eq!(decoded, data);
    }
}
