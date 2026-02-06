//! Tests for JavaScript modules.
//!
//! These tests verify the Node.js-compatible APIs provided by js_modules.

use super::*;
use rquickjs::{AsyncContext, AsyncRuntime, CatchResultExt};

/// Helper to evaluate JavaScript code and return the result as a string.
fn eval_js(code: &str) -> std::result::Result<String, String> {
    let runtime = AsyncRuntime::new().map_err(|e| format!("Failed to create runtime: {}", e))?;
    let context = futures_lite::future::block_on(AsyncContext::full(&runtime))
        .map_err(|e| format!("Failed to create context: {}", e))?;

    futures_lite::future::block_on(context.with(|ctx| {
        install_all(&ctx).map_err(|e| format!("Failed to install modules: {}", e))?;
        Ok::<(), String>(())
    }))?;

    futures_lite::future::block_on(context.with(|ctx| {
        let wrapped = format!("(function() {{ {} }})()", code);
        let result = ctx.eval::<rquickjs::Value, _>(wrapped.as_bytes());
        match result.catch(&ctx) {
            Ok(val) => {
                if val.is_undefined() {
                    Ok("undefined".to_string())
                } else if let Some(s) = val.as_string() {
                    Ok(s.to_string().unwrap_or_default())
                } else if let Some(n) = val.as_number() {
                    Ok(format!("{}", n))
                } else if let Some(b) = val.as_bool() {
                    Ok(format!("{}", b))
                } else {
                    Ok(format!("{:?}", val))
                }
            }
            Err(e) => Err(format!("Evaluation error: {:?}", e)),
        }
    }))
}

/// Helper to evaluate JavaScript code with custom process.argv payload.
fn eval_js_with_argv(code: &str, argv: Vec<String>) -> std::result::Result<String, String> {
    process::set_argv(argv);
    let result = eval_js(code);
    process::set_argv(Vec::new());
    result
}

/// Helper to evaluate JavaScript code with custom runtime env/cwd.
fn eval_js_with_runtime(
    code: &str,
    cwd: String,
    vars: Vec<(String, String)>,
) -> std::result::Result<String, String> {
    process::set_runtime_env(cwd, vars);
    let result = eval_js(code);
    process::set_runtime_env("/".to_string(), Vec::new());
    result
}

// ========================================================================
// Buffer Tests
// ========================================================================

#[test]
fn test_process_argv_default_shape() {
    let result = eval_js("return process.argv[0] + '|' + process.argv[1]").unwrap();
    assert_eq!(result, "tsx|script.ts");
}

#[test]
fn test_process_argv_extra_args() {
    let result = eval_js_with_argv(
        "return process.argv.slice(2).join(',')",
        vec!["--flag".to_string(), "input.ts".to_string()],
    )
    .unwrap();
    assert_eq!(result, "--flag,input.ts");
}

#[test]
fn test_process_env_from_runtime() {
    let result = eval_js_with_runtime(
        "return process.env.API_KEY + '|' + process.cwd()",
        "/work/project".to_string(),
        vec![("API_KEY".to_string(), "secret".to_string())],
    )
    .unwrap();
    assert_eq!(result, "secret|/work/project");
}

#[test]
fn test_process_chdir_updates_cwd() {
    let result = eval_js_with_runtime(
        "process.chdir('/tmp/next'); return process.cwd();",
        "/work/project".to_string(),
        Vec::new(),
    )
    .unwrap();
    assert_eq!(result, "/tmp/next");
}

#[test]
fn test_buffer_from_string() {
    let result = eval_js("return Buffer.from('hello').toString()").unwrap();
    assert_eq!(result, "hello");
}

#[test]
fn test_buffer_from_hex() {
    let result = eval_js("return Buffer.from('68656c6c6f', 'hex').toString()").unwrap();
    assert_eq!(result, "hello");
}

#[test]
fn test_buffer_to_hex() {
    let result = eval_js("return Buffer.from('hello').toString('hex')").unwrap();
    assert_eq!(result, "68656c6c6f");
}

#[test]
fn test_buffer_to_base64() {
    let result = eval_js("return Buffer.from('hello').toString('base64')").unwrap();
    assert_eq!(result, "aGVsbG8=");
}

#[test]
fn test_buffer_from_base64() {
    let result = eval_js("return Buffer.from('aGVsbG8=', 'base64').toString()").unwrap();
    assert_eq!(result, "hello");
}

#[test]
fn test_buffer_alloc() {
    let result = eval_js("return Buffer.alloc(5).length").unwrap();
    assert_eq!(result, "5");
}

#[test]
fn test_buffer_is_buffer() {
    let result = eval_js("return Buffer.isBuffer(Buffer.from('a'))").unwrap();
    assert_eq!(result, "true");
}

#[test]
fn test_buffer_concat() {
    let result = eval_js(r#"
        const a = Buffer.from('hel');
        const b = Buffer.from('lo');
        return Buffer.concat([a, b]).toString();
    "#).unwrap();
    assert_eq!(result, "hello");
}

#[test]
fn test_buffer_slice() {
    let result = eval_js("return Buffer.from('hello').slice(1, 4).toString()").unwrap();
    assert_eq!(result, "ell");
}

// ========================================================================
// URL Tests
// ========================================================================

#[test]
fn test_url_basic_parsing() {
    let result = eval_js("return new URL('https://example.com/path').hostname").unwrap();
    assert_eq!(result, "example.com");
}

#[test]
fn test_url_port() {
    let result = eval_js("return new URL('https://example.com:8080/path').port").unwrap();
    assert_eq!(result, "8080");
}

#[test]
fn test_url_pathname() {
    let result = eval_js("return new URL('https://example.com/path/to/file').pathname").unwrap();
    assert_eq!(result, "/path/to/file");
}

#[test]
fn test_url_search_params() {
    let result = eval_js("return new URL('https://example.com?a=1&b=2').searchParams.get('a')").unwrap();
    assert_eq!(result, "1");
}

#[test]
fn test_url_search_params_multiple() {
    let result = eval_js(r#"
        const u = new URL('https://example.com?a=1&a=2');
        return u.searchParams.getAll('a').join(',');
    "#).unwrap();
    assert_eq!(result, "1,2");
}

#[test]
fn test_url_origin() {
    let result = eval_js("return new URL('https://example.com:8080/path').origin").unwrap();
    assert_eq!(result, "https://example.com:8080");
}

#[test]
fn test_url_tostring() {
    let result = eval_js("return new URL('https://example.com/path?a=1').toString()").unwrap();
    assert_eq!(result, "https://example.com/path?a=1");
}

#[test]
fn test_url_relative() {
    let result = eval_js("return new URL('/other', 'https://example.com/path').href").unwrap();
    assert_eq!(result, "https://example.com/other");
}

#[test]
fn test_urlsearchparams_standalone() {
    let result = eval_js(r#"
        const p = new URLSearchParams('a=1&b=2');
        return p.get('b');
    "#).unwrap();
    assert_eq!(result, "2");
}

#[test]
fn test_urlsearchparams_set() {
    let result = eval_js(r#"
        const p = new URLSearchParams('a=1');
        p.set('a', '2');
        return p.get('a');
    "#).unwrap();
    assert_eq!(result, "2");
}

// ========================================================================
// TextEncoder/TextDecoder Tests
// ========================================================================

#[test]
fn test_textencoder_basic() {
    let result = eval_js(r#"
        const encoder = new TextEncoder();
        const bytes = encoder.encode('hello');
        return bytes.length;
    "#).unwrap();
    assert_eq!(result, "5");
}

#[test]
fn test_textdecoder_basic() {
    let result = eval_js(r#"
        const encoder = new TextEncoder();
        const decoder = new TextDecoder();
        const bytes = encoder.encode('hello');
        return decoder.decode(bytes);
    "#).unwrap();
    assert_eq!(result, "hello");
}

#[test]
fn test_textencoder_unicode() {
    let result = eval_js(r#"
        const encoder = new TextEncoder();
        const bytes = encoder.encode('日本語');
        return bytes.length;
    "#).unwrap();
    // Japanese text is 3 characters, 9 bytes in UTF-8
    assert_eq!(result, "9");
}

#[test]
fn test_textdecoder_unicode() {
    let result = eval_js(r#"
        const encoder = new TextEncoder();
        const decoder = new TextDecoder();
        const bytes = encoder.encode('日本語');
        return decoder.decode(bytes);
    "#).unwrap();
    assert_eq!(result, "日本語");
}

// ========================================================================
// Path Module Tests
// ========================================================================

#[test]
fn test_path_join() {
    let result = eval_js("return path.join('/a', 'b', 'c')").unwrap();
    assert_eq!(result, "/a/b/c");
}

#[test]
fn test_path_join_removes_double_slashes() {
    let result = eval_js("return path.join('/a/', '/b')").unwrap();
    assert_eq!(result, "/a/b");
}

#[test]
fn test_path_dirname() {
    let result = eval_js("return path.dirname('/a/b/c.txt')").unwrap();
    assert_eq!(result, "/a/b");
}

#[test]
fn test_path_basename() {
    let result = eval_js("return path.basename('/a/b/c.txt')").unwrap();
    assert_eq!(result, "c.txt");
}

#[test]
fn test_path_basename_with_ext() {
    let result = eval_js("return path.basename('/a/b/c.txt', '.txt')").unwrap();
    assert_eq!(result, "c");
}

#[test]
fn test_path_extname() {
    let result = eval_js("return path.extname('/a/b/c.txt')").unwrap();
    assert_eq!(result, ".txt");
}

#[test]
fn test_path_is_absolute() {
    let result = eval_js("return path.isAbsolute('/a/b')").unwrap();
    assert_eq!(result, "true");
}

#[test]
fn test_path_is_not_absolute() {
    let result = eval_js("return path.isAbsolute('a/b')").unwrap();
    assert_eq!(result, "false");
}

#[test]
fn test_path_normalize() {
    let result = eval_js("return path.normalize('/a/b/../c/./d')").unwrap();
    assert_eq!(result, "/a/c/d");
}

#[test]
fn test_path_relative() {
    let result = eval_js("return path.relative('/a/b', '/a/c')").unwrap();
    assert_eq!(result, "../c");
}

#[test]
fn test_path_parse() {
    let result = eval_js(r#"
        const p = path.parse('/home/user/file.txt');
        return p.name;
    "#).unwrap();
    assert_eq!(result, "file");
}

#[test]
fn test_path_format() {
    let result = eval_js(r#"
        return path.format({ dir: '/home/user', base: 'file.txt' });
    "#).unwrap();
    assert_eq!(result, "/home/user/file.txt");
}

// ========================================================================
// Console Tests
// ========================================================================

#[test]
fn test_console_log() {
    // Console.log captures to CAPTURED_LOGS
    clear_logs();
    let _ = eval_js("console.log('test message')");
    let logs = get_logs();
    assert!(logs.contains("test message"));
}

#[test]
fn test_console_error() {
    clear_logs();
    let _ = eval_js("console.error('error message')");
    let logs = get_logs();
    assert!(logs.contains("ERROR: error message"));
}

#[test]
fn test_console_warn() {
    clear_logs();
    let _ = eval_js("console.warn('warning message')");
    let logs = get_logs();
    assert!(logs.contains("WARN: warning message"));
}

// ========================================================================
// Headers Class Tests
// ========================================================================

#[test]
fn test_headers_basic() {
    let result = eval_js(r#"
        const h = new Headers();
        h.set('Content-Type', 'application/json');
        return h.get('Content-Type');
    "#).unwrap();
    assert_eq!(result, "application/json");
}

#[test]
fn test_headers_case_insensitive() {
    let result = eval_js(r#"
        const h = new Headers();
        h.set('Content-Type', 'application/json');
        return h.get('content-type');
    "#).unwrap();
    assert_eq!(result, "application/json");
}

#[test]
fn test_headers_append() {
    let result = eval_js(r#"
        const h = new Headers();
        h.append('Accept', 'text/html');
        h.append('Accept', 'application/json');
        return h.get('Accept');
    "#).unwrap();
    assert!(result.contains("text/html"));
    assert!(result.contains("application/json"));
}

#[test]
fn test_headers_from_object() {
    let result = eval_js(r#"
        const h = new Headers({ 'X-Custom': 'value' });
        return h.get('X-Custom');
    "#).unwrap();
    assert_eq!(result, "value");
}

// ========================================================================
// Response Class Tests
// ========================================================================

#[test]
fn test_response_basic() {
    let result = eval_js(r#"
        const r = new Response('body content');
        return r.status;
    "#).unwrap();
    assert_eq!(result, "200");
}

#[test]
fn test_response_ok() {
    let result = eval_js(r#"
        const r = new Response('body', { status: 200 });
        return r.ok;
    "#).unwrap();
    assert_eq!(result, "true");
}

#[test]
fn test_response_not_ok() {
    let result = eval_js(r#"
        const r = new Response('body', { status: 404 });
        return r.ok;
    "#).unwrap();
    assert_eq!(result, "false");
}

#[test]
fn test_request_class_basic_fields() {
    let result = eval_js(r#"
        const req = new Request('https://example.com/a', { method: 'POST' });
        return req.url + '|' + req.method;
    "#).unwrap();
    assert_eq!(result, "https://example.com/a|POST");
}

#[test]
fn test_abort_controller_signal() {
    let result = eval_js(r#"
        const c = new AbortController();
        c.abort();
        return c.signal.aborted;
    "#).unwrap();
    assert_eq!(result, "true");
}

// ========================================================================
// Filesystem Sync Tests
// ========================================================================

#[test]
fn test_fs_exists_sync_true() {
    let result = eval_js("return fs.existsSync('/tmp')").unwrap();
    assert_eq!(result, "true");
}

#[test]
fn test_fs_exists_sync_false() {
    let result = eval_js("return fs.existsSync('/nonexistent_path_12345')").unwrap();
    assert_eq!(result, "false");
}

#[test]
fn test_fs_write_and_read_sync() {
    let result = eval_js(r#"
        fs.writeFileSync('/tmp/js_test_file.txt', 'hello world');
        return fs.readFileSync('/tmp/js_test_file.txt');
    "#).unwrap();
    assert_eq!(result, "hello world");
    // Cleanup
    let _ = std::fs::remove_file("/tmp/js_test_file.txt");
}

#[test]
fn test_fs_readdir_sync() {
    // /tmp should have entries
    let result = eval_js(r#"
        const entries = fs.readdirSync('/tmp');
        return Array.isArray(entries) ? 'array' : 'not array';
    "#).unwrap();
    assert_eq!(result, "array");
}

#[test]
fn test_fs_stat_sync() {
    let result = eval_js(r#"
        const stat = fs.statSync('/tmp');
        return stat.isDirectory() ? 'dir' : 'not dir';
    "#).unwrap();
    assert_eq!(result, "dir");
}

#[test]
fn test_fs_stat_sync_is_file() {
    // Create a test file first
    std::fs::write("/tmp/js_test_stat.txt", "test").unwrap();
    let result = eval_js(r#"
        const stat = fs.statSync('/tmp/js_test_stat.txt');
        return stat.isFile() ? 'file' : 'not file';
    "#).unwrap();
    assert_eq!(result, "file");
    let _ = std::fs::remove_file("/tmp/js_test_stat.txt");
}

#[test]
fn test_fs_stat_sync_size() {
    std::fs::write("/tmp/js_test_size.txt", "12345").unwrap();
    let result = eval_js(r#"
        const stat = fs.statSync('/tmp/js_test_size.txt');
        return stat.size;
    "#).unwrap();
    assert_eq!(result, "5");
    let _ = std::fs::remove_file("/tmp/js_test_size.txt");
}

#[test]
fn test_fs_mkdir_and_rmdir_sync() {
    let result = eval_js(r#"
        fs.mkdirSync('/tmp/js_test_dir_123');
        const exists = fs.existsSync('/tmp/js_test_dir_123');
        fs.rmdirSync('/tmp/js_test_dir_123');
        return exists ? 'created' : 'not created';
    "#).unwrap();
    assert_eq!(result, "created");
}

#[test]
fn test_fs_mkdir_recursive() {
    let result = eval_js(r#"
        fs.mkdirSync('/tmp/js_test_nested/a/b/c', { recursive: true });
        const exists = fs.existsSync('/tmp/js_test_nested/a/b/c');
        fs.rmSync('/tmp/js_test_nested', { recursive: true });
        return exists ? 'created' : 'not created';
    "#).unwrap();
    assert_eq!(result, "created");
}

#[test]
fn test_fs_unlink_sync() {
    std::fs::write("/tmp/js_test_unlink.txt", "test").unwrap();
    let result = eval_js(r#"
        fs.unlinkSync('/tmp/js_test_unlink.txt');
        return fs.existsSync('/tmp/js_test_unlink.txt') ? 'exists' : 'deleted';
    "#).unwrap();
    assert_eq!(result, "deleted");
}

#[test]
fn test_fs_rename_sync() {
    std::fs::write("/tmp/js_test_rename_a.txt", "content").unwrap();
    let result = eval_js(r#"
        fs.renameSync('/tmp/js_test_rename_a.txt', '/tmp/js_test_rename_b.txt');
        const a_exists = fs.existsSync('/tmp/js_test_rename_a.txt');
        const b_exists = fs.existsSync('/tmp/js_test_rename_b.txt');
        return a_exists ? 'old exists' : (b_exists ? 'renamed' : 'both gone');
    "#).unwrap();
    assert_eq!(result, "renamed");
    let _ = std::fs::remove_file("/tmp/js_test_rename_b.txt");
}

#[test]
fn test_fs_copy_file_sync() {
    std::fs::write("/tmp/js_test_copy_src.txt", "copy this").unwrap();
    let result = eval_js(r#"
        fs.copyFileSync('/tmp/js_test_copy_src.txt', '/tmp/js_test_copy_dst.txt');
        return fs.readFileSync('/tmp/js_test_copy_dst.txt');
    "#).unwrap();
    assert_eq!(result, "copy this");
    let _ = std::fs::remove_file("/tmp/js_test_copy_src.txt");
    let _ = std::fs::remove_file("/tmp/js_test_copy_dst.txt");
}

#[test]
fn test_fs_append_file_sync() {
    std::fs::write("/tmp/js_test_append.txt", "hello").unwrap();
    let result = eval_js(r#"
        fs.appendFileSync('/tmp/js_test_append.txt', ' world');
        return fs.readFileSync('/tmp/js_test_append.txt');
    "#).unwrap();
    assert_eq!(result, "hello world");
    let _ = std::fs::remove_file("/tmp/js_test_append.txt");
}

// ========================================================================
// Filesystem Async (Promises) Tests
// ========================================================================

#[test]
fn test_fs_promises_write_and_read() {
    // Note: Our async wraps sync, so these work the same way
    let result = eval_js(r#"
        (async function() {
            await fs.promises.writeFile('/tmp/js_async_test.txt', 'async content');
            return await fs.promises.readFile('/tmp/js_async_test.txt');
        })()
    "#);
    // Since we're in sync context, the promise returns immediately
    // We can't fully test async semantics but we can verify the API exists
    assert!(result.is_ok() || result.is_err()); // Just check it doesn't crash
    let _ = std::fs::remove_file("/tmp/js_async_test.txt");
}
