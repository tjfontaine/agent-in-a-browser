//! Encoding and crypto commands: base64, md5sum, sha256sum, xxd

use futures_lite::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use runtime_macros::shell_commands;

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
                        let _ = stderr.write_all(format!("base64: {}: {}\n", path, e).as_bytes()).await;
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
                // Decode base64
                match base64_decode(&input) {
                    Ok(decoded) => {
                        let _ = stdout.write_all(&decoded).await;
                    }
                    Err(e) => {
                        let _ = stderr.write_all(format!("base64: {}\n", e).as_bytes()).await;
                        return 1;
                    }
                }
            } else {
                // Encode base64
                let encoded = base64_encode(&input);
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

            // cwd already cloned above
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
                let hash = md5_hash(&data);
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
                            let hash = md5_hash(&data);
                            let _ = stdout.write_all(format!("{}  {}\n", hash, file).as_bytes()).await;
                        }
                        Err(e) => {
                            let _ = stderr.write_all(format!("md5sum: {}: {}\n", file, e).as_bytes()).await;
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

            // cwd already cloned above
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
                let hash = sha256_hash(&data);
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
                            let hash = sha256_hash(&data);
                            let _ = stdout.write_all(format!("{}  {}\n", hash, file).as_bytes()).await;
                        }
                        Err(e) => {
                            let _ = stderr.write_all(format!("sha256sum: {}: {}\n", file, e).as_bytes()).await;
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
                        let _ = stderr.write_all(format!("xxd: {}: {}\n", path, e).as_bytes()).await;
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
                    let _ = stdout.write_all(format!("{:08x}: ", offset * 16).as_bytes()).await;
                    
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

// ============================================================================
// Base64 encoding/decoding (simple implementation)
// ============================================================================

const BASE64_CHARS: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

fn base64_encode(data: &[u8]) -> String {
    let mut result = String::new();
    let mut i = 0;

    while i < data.len() {
        let b0 = data[i];
        let b1 = if i + 1 < data.len() { data[i + 1] } else { 0 };
        let b2 = if i + 2 < data.len() { data[i + 2] } else { 0 };

        result.push(BASE64_CHARS[(b0 >> 2) as usize] as char);
        result.push(BASE64_CHARS[(((b0 & 0x03) << 4) | (b1 >> 4)) as usize] as char);

        if i + 1 < data.len() {
            result.push(BASE64_CHARS[(((b1 & 0x0f) << 2) | (b2 >> 6)) as usize] as char);
        } else {
            result.push('=');
        }

        if i + 2 < data.len() {
            result.push(BASE64_CHARS[(b2 & 0x3f) as usize] as char);
        } else {
            result.push('=');
        }

        i += 3;
    }

    result
}

fn base64_decode(data: &[u8]) -> Result<Vec<u8>, String> {
    let input: Vec<u8> = data.iter()
        .filter(|&&c| !c.is_ascii_whitespace())
        .cloned()
        .collect();

    if input.len() % 4 != 0 {
        return Err("invalid base64 length".to_string());
    }

    let mut result = Vec::new();
    
    for chunk in input.chunks(4) {
        let mut vals = [0u8; 4];
        for (i, &c) in chunk.iter().enumerate() {
            vals[i] = if c == b'=' {
                0
            } else if let Some(pos) = BASE64_CHARS.iter().position(|&x| x == c) {
                pos as u8
            } else {
                return Err(format!("invalid base64 character: {}", c as char));
            };
        }

        result.push((vals[0] << 2) | (vals[1] >> 4));
        if chunk[2] != b'=' {
            result.push((vals[1] << 4) | (vals[2] >> 2));
        }
        if chunk[3] != b'=' {
            result.push((vals[2] << 6) | vals[3]);
        }
    }

    Ok(result)
}

// ============================================================================
// MD5 hash (simple implementation)
// ============================================================================

fn md5_hash(data: &[u8]) -> String {
    // Simple MD5 implementation
    let mut h0: u32 = 0x67452301;
    let mut h1: u32 = 0xefcdab89;
    let mut h2: u32 = 0x98badcfe;
    let mut h3: u32 = 0x10325476;

    // Pre-processing: adding padding bits
    let bit_len = (data.len() as u64) * 8;
    let mut msg = data.to_vec();
    msg.push(0x80);
    while (msg.len() % 64) != 56 {
        msg.push(0);
    }
    msg.extend_from_slice(&bit_len.to_le_bytes());

    // Constants
    let s: [u32; 64] = [
        7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
        5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
        4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
        6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
    ];

    let k: [u32; 64] = [
        0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee,
        0xf57c0faf, 0x4787c62a, 0xa8304613, 0xfd469501,
        0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be,
        0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821,
        0xf61e2562, 0xc040b340, 0x265e5a51, 0xe9b6c7aa,
        0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8,
        0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed,
        0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a,
        0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c,
        0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70,
        0x289b7ec6, 0xeaa127fa, 0xd4ef3085, 0x04881d05,
        0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665,
        0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039,
        0x655b59c3, 0x8f0ccc92, 0xffeff47d, 0x85845dd1,
        0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1,
        0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391,
    ];

    for chunk in msg.chunks(64) {
        let mut m = [0u32; 16];
        for (i, bytes) in chunk.chunks(4).enumerate() {
            m[i] = u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]);
        }

        let mut a = h0;
        let mut b = h1;
        let mut c = h2;
        let mut d = h3;

        for i in 0..64 {
            let (f, g) = match i {
                0..=15 => ((b & c) | ((!b) & d), i),
                16..=31 => ((d & b) | ((!d) & c), (5 * i + 1) % 16),
                32..=47 => (b ^ c ^ d, (3 * i + 5) % 16),
                _ => (c ^ (b | (!d)), (7 * i) % 16),
            };

            let temp = d;
            d = c;
            c = b;
            b = b.wrapping_add(
                (a.wrapping_add(f).wrapping_add(k[i]).wrapping_add(m[g]))
                    .rotate_left(s[i]),
            );
            a = temp;
        }

        h0 = h0.wrapping_add(a);
        h1 = h1.wrapping_add(b);
        h2 = h2.wrapping_add(c);
        h3 = h3.wrapping_add(d);
    }

    format!("{:08x}{:08x}{:08x}{:08x}",
        h0.swap_bytes(), h1.swap_bytes(), h2.swap_bytes(), h3.swap_bytes())
}

// ============================================================================
// SHA256 hash (simple implementation)
// ============================================================================

fn sha256_hash(data: &[u8]) -> String {
    let mut h: [u32; 8] = [
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
        0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
    ];

    let k: [u32; 64] = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5,
        0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
        0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
        0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
        0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
        0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
        0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
        0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
        0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
        0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
        0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3,
        0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
        0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5,
        0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
        0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
    ];

    // Pre-processing
    let bit_len = (data.len() as u64) * 8;
    let mut msg = data.to_vec();
    msg.push(0x80);
    while (msg.len() % 64) != 56 {
        msg.push(0);
    }
    msg.extend_from_slice(&bit_len.to_be_bytes());

    for chunk in msg.chunks(64) {
        let mut w = [0u32; 64];
        for (i, bytes) in chunk.chunks(4).enumerate() {
            w[i] = u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]);
        }

        for i in 16..64 {
            let s0 = w[i - 15].rotate_right(7) ^ w[i - 15].rotate_right(18) ^ (w[i - 15] >> 3);
            let s1 = w[i - 2].rotate_right(17) ^ w[i - 2].rotate_right(19) ^ (w[i - 2] >> 10);
            w[i] = w[i - 16].wrapping_add(s0).wrapping_add(w[i - 7]).wrapping_add(s1);
        }

        let mut a = h[0];
        let mut b = h[1];
        let mut c = h[2];
        let mut d = h[3];
        let mut e = h[4];
        let mut f = h[5];
        let mut g = h[6];
        let mut hh = h[7];

        for i in 0..64 {
            let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let ch = (e & f) ^ ((!e) & g);
            let temp1 = hh.wrapping_add(s1).wrapping_add(ch).wrapping_add(k[i]).wrapping_add(w[i]);
            let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let maj = (a & b) ^ (a & c) ^ (b & c);
            let temp2 = s0.wrapping_add(maj);

            hh = g;
            g = f;
            f = e;
            e = d.wrapping_add(temp1);
            d = c;
            c = b;
            b = a;
            a = temp1.wrapping_add(temp2);
        }

        h[0] = h[0].wrapping_add(a);
        h[1] = h[1].wrapping_add(b);
        h[2] = h[2].wrapping_add(c);
        h[3] = h[3].wrapping_add(d);
        h[4] = h[4].wrapping_add(e);
        h[5] = h[5].wrapping_add(f);
        h[6] = h[6].wrapping_add(g);
        h[7] = h[7].wrapping_add(hh);
    }

    h.iter().map(|v| format!("{:08x}", v)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    // ========================================================================
    // Base64 Tests
    // ========================================================================

    #[test]
    fn test_base64_encode() {
        assert_eq!(base64_encode(b"Hello"), "SGVsbG8=");
        assert_eq!(base64_encode(b"Hello!"), "SGVsbG8h");
    }

    #[test]
    fn test_base64_decode() {
        assert_eq!(base64_decode(b"SGVsbG8=").unwrap(), b"Hello");
        assert_eq!(base64_decode(b"SGVsbG8h").unwrap(), b"Hello!");
    }

    #[test]
    fn test_base64_empty() {
        assert_eq!(base64_encode(b""), "");
        assert_eq!(base64_decode(b"").unwrap(), b"");
    }

    #[test]
    fn test_base64_single_char() {
        assert_eq!(base64_encode(b"a"), "YQ==");
        assert_eq!(base64_decode(b"YQ==").unwrap(), b"a");
    }

    #[test]
    fn test_base64_two_chars() {
        assert_eq!(base64_encode(b"ab"), "YWI=");
        assert_eq!(base64_decode(b"YWI=").unwrap(), b"ab");
    }

    #[test]
    fn test_base64_three_chars() {
        assert_eq!(base64_encode(b"abc"), "YWJj");
        assert_eq!(base64_decode(b"YWJj").unwrap(), b"abc");
    }

    #[test]
    fn test_base64_binary_data() {
        let data: Vec<u8> = (0..=255).collect();
        let encoded = base64_encode(&data);
        let decoded = base64_decode(encoded.as_bytes()).unwrap();
        assert_eq!(decoded, data);
    }

    #[test]
    fn test_base64_roundtrip() {
        let test_strings = ["", "a", "ab", "abc", "hello world", "The quick brown fox"];
        for s in test_strings {
            let encoded = base64_encode(s.as_bytes());
            let decoded = base64_decode(encoded.as_bytes()).unwrap();
            assert_eq!(decoded, s.as_bytes());
        }
    }

    #[test]
    fn test_base64_with_whitespace() {
        // Should ignore whitespace
        let result = base64_decode(b"SGVs\nbG8=").unwrap();
        assert_eq!(result, b"Hello");
    }

    #[test]
    fn test_base64_invalid_length() {
        let result = base64_decode(b"abc");
        assert!(result.is_err());
    }

    #[test]
    fn test_base64_invalid_char() {
        let result = base64_decode(b"!!!!"); 
        assert!(result.is_err());
    }

    // ========================================================================
    // MD5 Tests
    // ========================================================================

    #[test]
    fn test_md5() {
        // "hello" should produce 5d41402abc4b2a76b9719d911017c592
        let hash = md5_hash(b"hello");
        assert_eq!(hash, "5d41402abc4b2a76b9719d911017c592");
    }

    #[test]
    fn test_md5_empty() {
        let hash = md5_hash(b"");
        assert_eq!(hash, "d41d8cd98f00b204e9800998ecf8427e");
    }

    #[test]
    fn test_md5_abc() {
        let hash = md5_hash(b"abc");
        assert_eq!(hash, "900150983cd24fb0d6963f7d28e17f72");
    }

    #[test]
    fn test_md5_long_string() {
        let hash = md5_hash(b"The quick brown fox jumps over the lazy dog");
        assert_eq!(hash, "9e107d9d372bb6826bd81d3542a419d6");
    }

    #[test]
    fn test_md5_message_digest() {
        let hash = md5_hash(b"message digest");
        assert_eq!(hash, "f96b697d7cb7938d525a2f31aaf161d0");
    }

    // ========================================================================
    // SHA256 Tests
    // ========================================================================

    #[test]
    fn test_sha256() {
        // "hello" should produce specific hash
        let hash = sha256_hash(b"hello");
        assert_eq!(hash, "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
    }

    #[test]
    fn test_sha256_empty() {
        let hash = sha256_hash(b"");
        assert_eq!(hash, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    }

    #[test]
    fn test_sha256_abc() {
        let hash = sha256_hash(b"abc");
        assert_eq!(hash, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    }

    #[test]
    fn test_sha256_fox() {
        let hash = sha256_hash(b"The quick brown fox jumps over the lazy dog");
        assert_eq!(hash, "d7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592");
    }

    #[test]
    fn test_sha256_long_input() {
        // Test with exactly 64 bytes (one block)
        let input = "a]";
        let hash = sha256_hash(&input.repeat(32).as_bytes()[..64]);
        // Just verify it produces a valid 64-char hex string
        assert_eq!(hash.len(), 64);
        assert!(hash.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn test_sha256_multi_block() {
        // Test with input spanning multiple blocks
        let input = "x".repeat(200);
        let hash = sha256_hash(input.as_bytes());
        assert_eq!(hash.len(), 64);
    }

    // ========================================================================
    // Hash Consistency
    // ========================================================================

    #[test]
    fn test_hash_deterministic() {
        // Same input should always produce same output
        let data = b"test data";
        let hash1 = md5_hash(data);
        let hash2 = md5_hash(data);
        assert_eq!(hash1, hash2);

        let sha1 = sha256_hash(data);
        let sha2 = sha256_hash(data);
        assert_eq!(sha1, sha2);
    }

    #[test]
    fn test_hash_different_for_different_input() {
        let hash1 = md5_hash(b"input1");
        let hash2 = md5_hash(b"input2");
        assert_ne!(hash1, hash2);

        let sha1 = sha256_hash(b"input1");
        let sha2 = sha256_hash(b"input2");
        assert_ne!(sha1, sha2);
    }
}

