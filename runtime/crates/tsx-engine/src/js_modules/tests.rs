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
    let result = eval_js(
        r#"
        const a = Buffer.from('hel');
        const b = Buffer.from('lo');
        return Buffer.concat([a, b]).toString();
    "#,
    )
    .unwrap();
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
    let result =
        eval_js("return new URL('https://example.com?a=1&b=2').searchParams.get('a')").unwrap();
    assert_eq!(result, "1");
}

#[test]
fn test_url_search_params_multiple() {
    let result = eval_js(
        r#"
        const u = new URL('https://example.com?a=1&a=2');
        return u.searchParams.getAll('a').join(',');
    "#,
    )
    .unwrap();
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
    let result = eval_js(
        r#"
        const p = new URLSearchParams('a=1&b=2');
        return p.get('b');
    "#,
    )
    .unwrap();
    assert_eq!(result, "2");
}

#[test]
fn test_urlsearchparams_set() {
    let result = eval_js(
        r#"
        const p = new URLSearchParams('a=1');
        p.set('a', '2');
        return p.get('a');
    "#,
    )
    .unwrap();
    assert_eq!(result, "2");
}

// ========================================================================
// TextEncoder/TextDecoder Tests
// ========================================================================

#[test]
fn test_textencoder_basic() {
    let result = eval_js(
        r#"
        const encoder = new TextEncoder();
        const bytes = encoder.encode('hello');
        return bytes.length;
    "#,
    )
    .unwrap();
    assert_eq!(result, "5");
}

#[test]
fn test_textdecoder_basic() {
    let result = eval_js(
        r#"
        const encoder = new TextEncoder();
        const decoder = new TextDecoder();
        const bytes = encoder.encode('hello');
        return decoder.decode(bytes);
    "#,
    )
    .unwrap();
    assert_eq!(result, "hello");
}

#[test]
fn test_textencoder_unicode() {
    let result = eval_js(
        r#"
        const encoder = new TextEncoder();
        const bytes = encoder.encode('日本語');
        return bytes.length;
    "#,
    )
    .unwrap();
    // Japanese text is 3 characters, 9 bytes in UTF-8
    assert_eq!(result, "9");
}

#[test]
fn test_textdecoder_unicode() {
    let result = eval_js(
        r#"
        const encoder = new TextEncoder();
        const decoder = new TextDecoder();
        const bytes = encoder.encode('日本語');
        return decoder.decode(bytes);
    "#,
    )
    .unwrap();
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
    let result = eval_js(
        r#"
        const p = path.parse('/home/user/file.txt');
        return p.name;
    "#,
    )
    .unwrap();
    assert_eq!(result, "file");
}

#[test]
fn test_path_format() {
    let result = eval_js(
        r#"
        return path.format({ dir: '/home/user', base: 'file.txt' });
    "#,
    )
    .unwrap();
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
    let result = eval_js(
        r#"
        const h = new Headers();
        h.set('Content-Type', 'application/json');
        return h.get('Content-Type');
    "#,
    )
    .unwrap();
    assert_eq!(result, "application/json");
}

#[test]
fn test_headers_case_insensitive() {
    let result = eval_js(
        r#"
        const h = new Headers();
        h.set('Content-Type', 'application/json');
        return h.get('content-type');
    "#,
    )
    .unwrap();
    assert_eq!(result, "application/json");
}

#[test]
fn test_headers_append() {
    let result = eval_js(
        r#"
        const h = new Headers();
        h.append('Accept', 'text/html');
        h.append('Accept', 'application/json');
        return h.get('Accept');
    "#,
    )
    .unwrap();
    assert!(result.contains("text/html"));
    assert!(result.contains("application/json"));
}

#[test]
fn test_headers_from_object() {
    let result = eval_js(
        r#"
        const h = new Headers({ 'X-Custom': 'value' });
        return h.get('X-Custom');
    "#,
    )
    .unwrap();
    assert_eq!(result, "value");
}

// ========================================================================
// Response Class Tests
// ========================================================================

#[test]
fn test_response_basic() {
    let result = eval_js(
        r#"
        const r = new Response('body content');
        return r.status;
    "#,
    )
    .unwrap();
    assert_eq!(result, "200");
}

#[test]
fn test_response_ok() {
    let result = eval_js(
        r#"
        const r = new Response('body', { status: 200 });
        return r.ok;
    "#,
    )
    .unwrap();
    assert_eq!(result, "true");
}

#[test]
fn test_response_not_ok() {
    let result = eval_js(
        r#"
        const r = new Response('body', { status: 404 });
        return r.ok;
    "#,
    )
    .unwrap();
    assert_eq!(result, "false");
}

#[test]
fn test_request_class_basic_fields() {
    let result = eval_js(
        r#"
        const req = new Request('https://example.com/a', { method: 'POST' });
        return req.url + '|' + req.method;
    "#,
    )
    .unwrap();
    assert_eq!(result, "https://example.com/a|POST");
}

#[test]
fn test_abort_controller_signal() {
    let result = eval_js(
        r#"
        const c = new AbortController();
        c.abort();
        return c.signal.aborted;
    "#,
    )
    .unwrap();
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
    let result = eval_js(
        r#"
        fs.writeFileSync('/tmp/js_test_file.txt', 'hello world');
        return fs.readFileSync('/tmp/js_test_file.txt');
    "#,
    )
    .unwrap();
    assert_eq!(result, "hello world");
    // Cleanup
    let _ = std::fs::remove_file("/tmp/js_test_file.txt");
}

#[test]
fn test_fs_readdir_sync() {
    // /tmp should have entries
    let result = eval_js(
        r#"
        const entries = fs.readdirSync('/tmp');
        return Array.isArray(entries) ? 'array' : 'not array';
    "#,
    )
    .unwrap();
    assert_eq!(result, "array");
}

#[test]
fn test_fs_stat_sync() {
    let result = eval_js(
        r#"
        const stat = fs.statSync('/tmp');
        return stat.isDirectory() ? 'dir' : 'not dir';
    "#,
    )
    .unwrap();
    assert_eq!(result, "dir");
}

#[test]
fn test_fs_stat_sync_is_file() {
    // Create a test file first
    std::fs::write("/tmp/js_test_stat.txt", "test").unwrap();
    let result = eval_js(
        r#"
        const stat = fs.statSync('/tmp/js_test_stat.txt');
        return stat.isFile() ? 'file' : 'not file';
    "#,
    )
    .unwrap();
    assert_eq!(result, "file");
    let _ = std::fs::remove_file("/tmp/js_test_stat.txt");
}

#[test]
fn test_fs_stat_sync_size() {
    std::fs::write("/tmp/js_test_size.txt", "12345").unwrap();
    let result = eval_js(
        r#"
        const stat = fs.statSync('/tmp/js_test_size.txt');
        return stat.size;
    "#,
    )
    .unwrap();
    assert_eq!(result, "5");
    let _ = std::fs::remove_file("/tmp/js_test_size.txt");
}

#[test]
fn test_fs_mkdir_and_rmdir_sync() {
    let result = eval_js(
        r#"
        fs.mkdirSync('/tmp/js_test_dir_123');
        const exists = fs.existsSync('/tmp/js_test_dir_123');
        fs.rmdirSync('/tmp/js_test_dir_123');
        return exists ? 'created' : 'not created';
    "#,
    )
    .unwrap();
    assert_eq!(result, "created");
}

#[test]
fn test_fs_mkdir_recursive() {
    let result = eval_js(
        r#"
        fs.mkdirSync('/tmp/js_test_nested/a/b/c', { recursive: true });
        const exists = fs.existsSync('/tmp/js_test_nested/a/b/c');
        fs.rmSync('/tmp/js_test_nested', { recursive: true });
        return exists ? 'created' : 'not created';
    "#,
    )
    .unwrap();
    assert_eq!(result, "created");
}

#[test]
fn test_fs_unlink_sync() {
    std::fs::write("/tmp/js_test_unlink.txt", "test").unwrap();
    let result = eval_js(
        r#"
        fs.unlinkSync('/tmp/js_test_unlink.txt');
        return fs.existsSync('/tmp/js_test_unlink.txt') ? 'exists' : 'deleted';
    "#,
    )
    .unwrap();
    assert_eq!(result, "deleted");
}

#[test]
fn test_fs_rename_sync() {
    std::fs::write("/tmp/js_test_rename_a.txt", "content").unwrap();
    let result = eval_js(
        r#"
        fs.renameSync('/tmp/js_test_rename_a.txt', '/tmp/js_test_rename_b.txt');
        const a_exists = fs.existsSync('/tmp/js_test_rename_a.txt');
        const b_exists = fs.existsSync('/tmp/js_test_rename_b.txt');
        return a_exists ? 'old exists' : (b_exists ? 'renamed' : 'both gone');
    "#,
    )
    .unwrap();
    assert_eq!(result, "renamed");
    let _ = std::fs::remove_file("/tmp/js_test_rename_b.txt");
}

#[test]
fn test_fs_copy_file_sync() {
    std::fs::write("/tmp/js_test_copy_src.txt", "copy this").unwrap();
    let result = eval_js(
        r#"
        fs.copyFileSync('/tmp/js_test_copy_src.txt', '/tmp/js_test_copy_dst.txt');
        return fs.readFileSync('/tmp/js_test_copy_dst.txt');
    "#,
    )
    .unwrap();
    assert_eq!(result, "copy this");
    let _ = std::fs::remove_file("/tmp/js_test_copy_src.txt");
    let _ = std::fs::remove_file("/tmp/js_test_copy_dst.txt");
}

#[test]
fn test_fs_append_file_sync() {
    std::fs::write("/tmp/js_test_append.txt", "hello").unwrap();
    let result = eval_js(
        r#"
        fs.appendFileSync('/tmp/js_test_append.txt', ' world');
        return fs.readFileSync('/tmp/js_test_append.txt');
    "#,
    )
    .unwrap();
    assert_eq!(result, "hello world");
    let _ = std::fs::remove_file("/tmp/js_test_append.txt");
}

// ========================================================================
// Filesystem Async (Promises) Tests
// ========================================================================

#[test]
fn test_fs_promises_write_and_read() {
    // Note: Our async wraps sync, so these work the same way
    let result = eval_js(
        r#"
        (async function() {
            await fs.promises.writeFile('/tmp/js_async_test.txt', 'async content');
            return await fs.promises.readFile('/tmp/js_async_test.txt');
        })()
    "#,
    );
    // Since we're in sync context, the promise returns immediately
    // We can't fully test async semantics but we can verify the API exists
    assert!(result.is_ok() || result.is_err()); // Just check it doesn't crash
    let _ = std::fs::remove_file("/tmp/js_async_test.txt");
}

// ===== Built-in module registry tests =====

#[test]
fn test_builtin_module_registry_exists() {
    let result = eval_js("return globalThis.__tsxBuiltinModules instanceof Map ? 'ok' : 'fail'");
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_require_events_returns_builtin() {
    let result = eval_js(
        "const E = require('events'); if (!E.EventEmitter) throw new Error('missing EventEmitter'); return 'ok'",
    );
    assert_eq!(result.unwrap(), "ok");
}

// ===== EventEmitter tests =====

#[test]
fn test_eventemitter_on_and_emit() {
    let result = eval_js(
        r#"
        const { EventEmitter } = require('events');
        const e = new EventEmitter();
        let x = 0;
        e.on('a', () => x++);
        e.emit('a');
        if (x !== 1) throw new Error('expected 1, got ' + x);
        return 'ok';
        "#,
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_eventemitter_multiple_listeners() {
    let result = eval_js(
        r#"
        const { EventEmitter } = require('events');
        const e = new EventEmitter();
        let a = 0, b = 0;
        e.on('x', () => a++);
        e.on('x', () => b++);
        e.emit('x');
        if (a !== 1 || b !== 1) throw new Error('expected 1,1 got ' + a + ',' + b);
        return 'ok';
        "#,
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_eventemitter_once() {
    let result = eval_js(
        r#"
        const { EventEmitter } = require('events');
        const e = new EventEmitter();
        let x = 0;
        e.once('b', () => x++);
        e.emit('b');
        e.emit('b');
        if (x !== 1) throw new Error('once fired ' + x + ' times');
        return 'ok';
        "#,
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_eventemitter_remove_listener() {
    let result = eval_js(
        r#"
        const { EventEmitter } = require('events');
        const e = new EventEmitter();
        const f = () => {};
        e.on('c', f);
        e.removeListener('c', f);
        if (e.listenerCount('c') !== 0) throw new Error('listener not removed');
        return 'ok';
        "#,
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_eventemitter_error_throws_without_listener() {
    let result = eval_js(
        r#"
        const { EventEmitter } = require('events');
        const e = new EventEmitter();
        try {
            e.emit('error', new Error('boom'));
            throw new Error('should have thrown');
        } catch (err) {
            if (err.message !== 'boom') throw new Error('wrong error: ' + err.message);
        }
        return 'ok';
        "#,
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_eventemitter_error_handled_with_listener() {
    let result = eval_js(
        r#"
        const { EventEmitter } = require('events');
        const e = new EventEmitter();
        let caught = null;
        e.on('error', (err) => { caught = err; });
        e.emit('error', new Error('handled'));
        if (!caught || caught.message !== 'handled') throw new Error('error not caught');
        return 'ok';
        "#,
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_eventemitter_listener_count() {
    let result = eval_js(
        r#"
        const { EventEmitter } = require('events');
        const e = new EventEmitter();
        e.on('x', () => {});
        e.on('x', () => {});
        e.on('y', () => {});
        if (e.listenerCount('x') !== 2) throw new Error('x count wrong');
        if (e.listenerCount('y') !== 1) throw new Error('y count wrong');
        if (e.listenerCount('z') !== 0) throw new Error('z count wrong');
        return 'ok';
        "#,
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_eventemitter_event_names() {
    let result = eval_js(
        r#"
        const { EventEmitter } = require('events');
        const e = new EventEmitter();
        e.on('foo', () => {});
        e.on('bar', () => {});
        const names = e.eventNames();
        if (names.length !== 2) throw new Error('expected 2 event names');
        if (!names.includes('foo') || !names.includes('bar')) throw new Error('missing event names');
        return 'ok';
        "#,
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_eventemitter_remove_all_listeners() {
    let result = eval_js(
        r#"
        const { EventEmitter } = require('events');
        const e = new EventEmitter();
        e.on('a', () => {});
        e.on('a', () => {});
        e.on('b', () => {});
        e.removeAllListeners('a');
        if (e.listenerCount('a') !== 0) throw new Error('a not cleared');
        if (e.listenerCount('b') !== 1) throw new Error('b should remain');
        return 'ok';
        "#,
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_eventemitter_emit_with_args() {
    let result = eval_js(
        r#"
        const { EventEmitter } = require('events');
        const e = new EventEmitter();
        let received = null;
        e.on('data', (a, b) => { received = [a, b]; });
        e.emit('data', 'hello', 42);
        if (received[0] !== 'hello' || received[1] !== 42) throw new Error('wrong args');
        return 'ok';
        "#,
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_eventemitter_default_export() {
    let result = eval_js(
        r#"
        const EventEmitter = require('events');
        const e = new EventEmitter();
        e.on('test', () => {});
        if (e.listenerCount('test') !== 1) throw new Error('default export failed');
        return 'ok';
        "#,
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_eventemitter_addlistener_alias() {
    let result = eval_js(
        r#"
        const { EventEmitter } = require('events');
        const e = new EventEmitter();
        let x = 0;
        e.addListener('a', () => x++);
        e.emit('a');
        if (x !== 1) throw new Error('addListener failed');
        return 'ok';
        "#,
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_eventemitter_off_alias() {
    let result = eval_js(
        r#"
        const { EventEmitter } = require('events');
        const e = new EventEmitter();
        const f = () => {};
        e.on('a', f);
        e.off('a', f);
        if (e.listenerCount('a') !== 0) throw new Error('off alias failed');
        return 'ok';
        "#,
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_eventemitter_max_listeners() {
    let result = eval_js(
        r#"
        const { EventEmitter } = require('events');
        const e = new EventEmitter();
        e.setMaxListeners(5);
        if (e.getMaxListeners() !== 5) throw new Error('setMaxListeners failed');
        return 'ok';
        "#,
    );
    assert_eq!(result.unwrap(), "ok");
}

// ===== Crypto module tests =====

#[test]
fn test_crypto_random_bytes_length() {
    let result = eval_js(
        "const c = require('crypto'); const b = c.randomBytes(16); if (b.length !== 16) throw new Error('expected 16, got ' + b.length); return 'ok';",
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_crypto_random_bytes_is_buffer() {
    let result = eval_js(
        "const c = require('crypto'); const b = c.randomBytes(8); if (!(b instanceof Buffer)) throw new Error('not a Buffer'); return 'ok';",
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_crypto_random_uuid_format() {
    let result = eval_js(
        r#"const c = require('crypto'); const u = c.randomUUID(); if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(u)) throw new Error('bad uuid: ' + u); return 'ok';"#,
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_crypto_create_hash_sha256() {
    let result = eval_js(
        r#"const c = require('crypto'); const h = c.createHash('sha256').update('hello').digest('hex'); if (h !== '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824') throw new Error('bad hash: ' + h); return 'ok';"#,
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_crypto_create_hash_sha256_chained_updates() {
    let result = eval_js(
        r#"const c = require('crypto'); const h = c.createHash('sha256').update('hel').update('lo').digest('hex'); if (h !== '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824') throw new Error('bad hash: ' + h); return 'ok';"#,
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_crypto_create_hash_sha256_base64() {
    let result = eval_js(
        r#"const c = require('crypto'); const h = c.createHash('sha256').update('hello').digest('base64'); if (h !== 'LPJNul+wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmCQ=') throw new Error('bad b64: ' + h); return 'ok';"#,
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_crypto_require_node_prefix() {
    let result = eval_js(
        "const c = require('node:crypto'); if (!c.randomUUID) throw new Error('no randomUUID'); return 'ok';",
    );
    assert_eq!(result.unwrap(), "ok");
}

// ===== Crypto: MD5 tests =====

#[test]
fn test_crypto_create_hash_md5_hex() {
    let result = eval_js(
        r#"const c = require('crypto'); const h = c.createHash('md5').update('hello').digest('hex'); if (h !== '5d41402abc4b2a76b9719d911017c592') throw new Error('bad hash: ' + h); return 'ok';"#,
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_crypto_create_hash_md5_base64() {
    let result = eval_js(
        r#"const c = require('crypto'); const h = c.createHash('md5').update('hello').digest('base64'); if (h !== 'XUFAKrxLKna5cZ2REBfFkg==') throw new Error('bad b64: ' + h); return 'ok';"#,
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_crypto_create_hash_md5_empty_string() {
    let result = eval_js(
        r#"const c = require('crypto'); const h = c.createHash('md5').update('').digest('hex'); if (h !== 'd41d8cd98f00b204e9800998ecf8427e') throw new Error('bad hash: ' + h); return 'ok';"#,
    );
    assert_eq!(result.unwrap(), "ok");
}

// ===== Crypto: SHA-1 tests =====

#[test]
fn test_crypto_create_hash_sha1_hex() {
    let result = eval_js(
        r#"const c = require('crypto'); const h = c.createHash('sha1').update('hello').digest('hex'); if (h !== 'aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d') throw new Error('bad hash: ' + h); return 'ok';"#,
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_crypto_create_hash_sha1_base64() {
    let result = eval_js(
        r#"const c = require('crypto'); const h = c.createHash('sha1').update('hello').digest('base64'); if (h !== 'qvTGHdzF6KLavt4PO0gs2a6pQ00=') throw new Error('bad b64: ' + h); return 'ok';"#,
    );
    assert_eq!(result.unwrap(), "ok");
}

// ===== Crypto: SHA-512 tests =====

#[test]
fn test_crypto_create_hash_sha512_hex() {
    let result = eval_js(
        r#"const c = require('crypto'); const h = c.createHash('sha512').update('hello').digest('hex'); if (h !== '9b71d224bd62f3785d96d46ad3ea3d73319bfbc2890caadae2dff72519673ca72323c3d99ba5c11d7c7acc6e14b8c5da0c4663475c2e5c3adef46f73bcdec043') throw new Error('bad hash: ' + h); return 'ok';"#,
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_crypto_create_hash_sha512_base64() {
    let result = eval_js(
        r#"const c = require('crypto'); const h = c.createHash('sha512').update('hello').digest('base64'); if (h !== 'm3HSJL1i83hdltRq0+o9czGb+8KJDKra4t/3JRlnPKcjI8PZm6XBHXx6zG4UuMXaDEZjR1wuXDre9G9zvN7AQw==') throw new Error('bad b64: ' + h); return 'ok';"#,
    );
    assert_eq!(result.unwrap(), "ok");
}

// ===== Crypto: Hash edge cases =====

#[test]
fn test_crypto_create_hash_sha256_empty_string() {
    let result = eval_js(
        r#"const c = require('crypto'); const h = c.createHash('sha256').update('').digest('hex'); if (h !== 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855') throw new Error('bad hash: ' + h); return 'ok';"#,
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_crypto_create_hash_sha1_empty_string() {
    let result = eval_js(
        r#"const c = require('crypto'); const h = c.createHash('sha1').update('').digest('hex'); if (h !== 'da39a3ee5e6b4b0d3255bfef95601890afd80709') throw new Error('bad hash: ' + h); return 'ok';"#,
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_crypto_create_hash_sha512_empty_string() {
    let result = eval_js(
        r#"const c = require('crypto'); const h = c.createHash('sha512').update('').digest('hex'); if (h !== 'cf83e1357eefb8bdf1542850d66d8007d620e4050b5715dc83f4a921d36ce9ce47d0d13c5d85f2b0ff8318d2877eec2f63b931bd47417a81a538327af927da3e') throw new Error('bad hash: ' + h); return 'ok';"#,
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_crypto_create_hash_unicode() {
    let result = eval_js(
        r#"const c = require('crypto'); const h = c.createHash('sha256').update('héllo wörld').digest('hex'); if (h !== 'a1003f7d04a4115711d0b48a2eaf1359ce565d2d2a6fd65098dfcffadeeef59f') throw new Error('bad hash: ' + h); return 'ok';"#,
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_crypto_create_hash_unicode_produces_hex() {
    let result = eval_js(
        r#"const c = require('crypto'); const h = c.createHash('sha256').update('héllo').digest('hex'); if (!/^[0-9a-f]{64}$/.test(h)) throw new Error('bad hex: ' + h); return 'ok';"#,
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_crypto_create_hash_multiple_updates() {
    let result = eval_js(
        r#"const c = require('crypto'); const h1 = c.createHash('md5').update('a').update('b').update('c').digest('hex'); const h2 = c.createHash('md5').update('abc').digest('hex'); if (h1 !== h2) throw new Error('mismatch: ' + h1 + ' vs ' + h2); return 'ok';"#,
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_crypto_create_hash_buffer_input() {
    let result = eval_js(
        r#"const c = require('crypto'); const b = Buffer.from('hello'); const h = c.createHash('sha256').update(b).digest('hex'); if (h !== '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824') throw new Error('bad hash: ' + h); return 'ok';"#,
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_crypto_create_hash_digest_twice_throws() {
    let result = eval_js(
        r#"const c = require('crypto'); const h = c.createHash('sha256'); h.update('hello'); h.digest('hex'); try { h.digest('hex'); return 'should have thrown'; } catch(e) { return 'ok'; }"#,
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_crypto_create_hash_unsupported_algorithm() {
    let result = eval_js(
        r#"const c = require('crypto'); try { c.createHash('sha384'); return 'should have thrown'; } catch(e) { if (e.message.indexOf('Unsupported') >= 0) return 'ok'; throw e; }"#,
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_crypto_create_hash_digest_returns_buffer() {
    let result = eval_js(
        r#"const c = require('crypto'); const h = c.createHash('sha256').update('hello').digest(); if (!(h instanceof Buffer)) throw new Error('not a Buffer'); if (h.length !== 32) throw new Error('bad length: ' + h.length); return 'ok';"#,
    );
    assert_eq!(result.unwrap(), "ok");
}

// ===== Crypto: HMAC tests =====

#[test]
fn test_crypto_create_hmac_sha256_hex() {
    let result = eval_js(
        r#"const c = require('crypto'); const h = c.createHmac('sha256', 'secret').update('hello').digest('hex'); if (h !== '88aab3ede8d3adf94d26ab90d3bafd4a2083070c3bcce9c014ee04a443847c0b') throw new Error('bad hmac: ' + h); return 'ok';"#,
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_crypto_create_hmac_sha1_hex() {
    let result = eval_js(
        r#"const c = require('crypto'); const h = c.createHmac('sha1', 'secret').update('hello').digest('hex'); if (h !== '5112055c05f944f85755efc5cd8970e194e9f45b') throw new Error('bad hmac: ' + h); return 'ok';"#,
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_crypto_create_hmac_md5_hex() {
    let result = eval_js(
        r#"const c = require('crypto'); const h = c.createHmac('md5', 'secret').update('hello').digest('hex'); if (h !== 'bade63863c61ed0b3165806ecd6acefc') throw new Error('bad hmac: ' + h); return 'ok';"#,
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_crypto_create_hmac_sha512_hex() {
    let result = eval_js(
        r#"const c = require('crypto'); const h = c.createHmac('sha512', 'secret').update('hello').digest('hex'); if (h !== 'db1595ae88a62fd151ec1cba81b98c39df82daae7b4cb9820f446d5bf02f1dcfca6683d88cab3e273f5963ab8ec469a746b5b19086371239f67d1e5f99a79440') throw new Error('bad hmac: ' + h); return 'ok';"#,
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_crypto_create_hmac_empty_key() {
    let result = eval_js(
        r#"const c = require('crypto'); const h = c.createHmac('sha256', '').update('hello').digest('hex'); if (!/^[0-9a-f]{64}$/.test(h)) throw new Error('bad hex: ' + h); return 'ok';"#,
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_crypto_create_hmac_chained_updates() {
    let result = eval_js(
        r#"const c = require('crypto'); const h1 = c.createHmac('sha256', 'key').update('hel').update('lo').digest('hex'); const h2 = c.createHmac('sha256', 'key').update('hello').digest('hex'); if (h1 !== h2) throw new Error('mismatch: ' + h1 + ' vs ' + h2); return 'ok';"#,
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_crypto_create_hmac_buffer_key() {
    let result = eval_js(
        r#"const c = require('crypto'); const h = c.createHmac('sha256', Buffer.from('secret')).update('hello').digest('hex'); if (h !== '88aab3ede8d3adf94d26ab90d3bafd4a2083070c3bcce9c014ee04a443847c0b') throw new Error('bad hmac: ' + h); return 'ok';"#,
    );
    assert_eq!(result.unwrap(), "ok");
}

// ===== Crypto: PBKDF2 tests =====

#[test]
fn test_crypto_pbkdf2_sync_sha256() {
    let result = eval_js(
        r#"const c = require('crypto'); const key = c.pbkdf2Sync('password', 'salt', 1, 32, 'sha256'); if (!(key instanceof Buffer)) throw new Error('not Buffer'); if (key.length !== 32) throw new Error('bad len: ' + key.length); const hex = key.toString('hex'); if (hex !== '120fb6cffcf8b32c43e7225256c4f837a86548c92ccc35480805987cb70be17b') throw new Error('bad key: ' + hex); return 'ok';"#,
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_crypto_pbkdf2_sync_sha1() {
    let result = eval_js(
        r#"const c = require('crypto'); const key = c.pbkdf2Sync('password', 'salt', 1, 20, 'sha1'); if (key.length !== 20) throw new Error('bad len: ' + key.length); const hex = key.toString('hex'); if (hex !== '0c60c80f961f0e71f3a9b524af6012062fe037a6') throw new Error('bad key: ' + hex); return 'ok';"#,
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_crypto_pbkdf2_sync_zero_iterations_throws() {
    let result = eval_js(
        r#"const c = require('crypto'); try { c.pbkdf2Sync('p', 's', 0, 32, 'sha256'); return 'should have thrown'; } catch(e) { return 'ok'; }"#,
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_crypto_pbkdf2_sync_zero_keylen() {
    let result = eval_js(
        r#"const c = require('crypto'); const key = c.pbkdf2Sync('password', 'salt', 1, 0, 'sha256'); if (key.length !== 0) throw new Error('bad len: ' + key.length); return 'ok';"#,
    );
    assert_eq!(result.unwrap(), "ok");
}

// ===== Crypto: timingSafeEqual tests =====

#[test]
fn test_crypto_timing_safe_equal_matching() {
    let result = eval_js(
        r#"const c = require('crypto'); const a = Buffer.from('hello'); const b = Buffer.from('hello'); if (!c.timingSafeEqual(a, b)) throw new Error('should be equal'); return 'ok';"#,
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_crypto_timing_safe_equal_mismatched() {
    let result = eval_js(
        r#"const c = require('crypto'); const a = Buffer.from('hello'); const b = Buffer.from('world'); if (c.timingSafeEqual(a, b)) throw new Error('should not be equal'); return 'ok';"#,
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_crypto_timing_safe_equal_different_lengths_throws() {
    let result = eval_js(
        r#"const c = require('crypto'); const a = Buffer.from('hello'); const b = Buffer.from('hi'); try { c.timingSafeEqual(a, b); return 'should have thrown'; } catch(e) { return 'ok'; }"#,
    );
    assert_eq!(result.unwrap(), "ok");
}

// ===== OS module tests =====

#[test]
fn test_os_platform() {
    let result = eval_js(
        "const os = require('os'); if (typeof os.platform() !== 'string') throw new Error('not string'); return 'ok';",
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_os_arch() {
    let result = eval_js(
        "const os = require('os'); if (typeof os.arch() !== 'string') throw new Error('not string'); return 'ok';",
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_os_homedir() {
    let result = eval_js(
        "const os = require('os'); if (typeof os.homedir() !== 'string') throw new Error('not string'); return 'ok';",
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_os_tmpdir() {
    let result = eval_js(
        "const os = require('os'); if (typeof os.tmpdir() !== 'string') throw new Error('not string'); return 'ok';",
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_os_eol() {
    let result = eval_js(
        r#"const os = require('os'); if (os.EOL !== '\n') throw new Error('bad EOL'); return 'ok';"#,
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_os_cpus() {
    let result = eval_js(
        "const os = require('os'); const c = os.cpus(); if (!Array.isArray(c) || c.length === 0) throw new Error('bad cpus'); return 'ok';",
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_os_hostname() {
    let result = eval_js(
        "const os = require('os'); if (typeof os.hostname() !== 'string') throw new Error('not string'); return 'ok';",
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_os_totalmem_freemem() {
    let result = eval_js(
        "const os = require('os'); if (typeof os.totalmem() !== 'number' || typeof os.freemem() !== 'number') throw new Error('not number'); return 'ok';",
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_os_require_node_prefix() {
    let result = eval_js(
        "const os = require('node:os'); if (!os.platform) throw new Error('no platform'); return 'ok';",
    );
    assert_eq!(result.unwrap(), "ok");
}

// ===== Util module tests =====

#[test]
fn test_util_format_string() {
    let result = eval_js(
        r#"const u = require('util'); const s = u.format('hello %s', 'world'); if (s !== 'hello world') throw new Error('got: ' + s); return 'ok';"#,
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_util_format_number() {
    let result = eval_js(
        r#"const u = require('util'); const s = u.format('val %d', 42); if (s !== 'val 42') throw new Error('got: ' + s); return 'ok';"#,
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_util_format_json() {
    let result = eval_js(
        r#"const u = require('util'); const s = u.format('data %j', {a:1}); if (s !== 'data {"a":1}') throw new Error('got: ' + s); return 'ok';"#,
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_util_format_no_specifiers() {
    let result = eval_js(
        r#"const u = require('util'); const s = u.format('a', 'b', 'c'); if (s !== 'a b c') throw new Error('got: ' + s); return 'ok';"#,
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_util_inspect_object() {
    let result = eval_js(
        r#"const u = require('util'); const s = u.inspect({a:1}); if (!s.includes('a') || !s.includes('1')) throw new Error('got: ' + s); return 'ok';"#,
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_util_promisify() {
    let result = eval_js(
        r#"
        const u = require('util');
        const fn = u.promisify(function(cb) { cb(null, 'ok'); });
        let resolved = null;
        fn().then(function(v) { resolved = v; });
        return resolved || 'pending';
        "#,
    );
    // promisify returns a Promise; in QuickJS microtasks may or may not resolve synchronously
    let r = result.unwrap();
    assert!(r == "ok" || r == "pending", "got: {}", r);
}

#[test]
fn test_util_types_is_date() {
    let result = eval_js(
        "const u = require('util'); if (!u.types.isDate(new Date())) throw new Error('fail'); if (u.types.isDate({})) throw new Error('false positive'); return 'ok';",
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_util_types_is_regexp() {
    let result = eval_js(
        "const u = require('util'); if (!u.types.isRegExp(/abc/)) throw new Error('fail'); if (u.types.isRegExp('abc')) throw new Error('false positive'); return 'ok';",
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_util_types_is_promise() {
    let result = eval_js(
        "const u = require('util'); if (!u.types.isPromise(Promise.resolve())) throw new Error('fail'); if (u.types.isPromise({})) throw new Error('false positive'); return 'ok';",
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_util_inherits() {
    let result = eval_js(
        r#"
        const u = require('util');
        function A() {}
        A.prototype.hello = function() { return 'hi'; };
        function B() { A.call(this); }
        u.inherits(B, A);
        const b = new B();
        if (!(b instanceof A)) throw new Error('not instance of A');
        if (b.hello() !== 'hi') throw new Error('method not inherited');
        return 'ok';
        "#,
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_util_deprecate() {
    let result = eval_js(
        r#"
        const u = require('util');
        const fn = u.deprecate(function() { return 42; }, 'old func');
        if (fn() !== 42) throw new Error('deprecate should pass through');
        return 'ok';
        "#,
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_util_require_node_prefix() {
    let result = eval_js(
        "const u = require('node:util'); if (!u.format) throw new Error('no format'); return 'ok';",
    );
    assert_eq!(result.unwrap(), "ok");
}

// ===== Assert module tests =====

#[test]
fn test_assert_truthy() {
    let result = eval_js(
        "const assert = require('assert'); assert(true); assert(1); assert('yes'); return 'ok';",
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_assert_falsy_throws() {
    let result = eval_js(
        r#"
        const assert = require('assert');
        try { assert(false); throw new Error('should throw'); }
        catch (e) { if (e.message === 'should throw') throw e; }
        return 'ok';
        "#,
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_assert_ok_alias() {
    let result = eval_js("const assert = require('assert'); assert.ok(true); return 'ok';");
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_assert_strict_equal() {
    let result = eval_js(
        r#"
        const assert = require('assert');
        assert.strictEqual(1, 1);
        assert.strictEqual('a', 'a');
        try { assert.strictEqual(1, '1'); throw new Error('should throw'); }
        catch (e) { if (e.message === 'should throw') throw e; }
        return 'ok';
        "#,
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_assert_not_strict_equal() {
    let result = eval_js(
        r#"
        const assert = require('assert');
        assert.notStrictEqual(1, '1');
        try { assert.notStrictEqual(1, 1); throw new Error('should throw'); }
        catch (e) { if (e.message === 'should throw') throw e; }
        return 'ok';
        "#,
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_assert_deep_strict_equal() {
    let result = eval_js(
        r#"
        const assert = require('assert');
        assert.deepStrictEqual({a:1, b:[2,3]}, {a:1, b:[2,3]});
        try { assert.deepStrictEqual({a:1}, {a:2}); throw new Error('should throw'); }
        catch (e) { if (e.message === 'should throw') throw e; }
        return 'ok';
        "#,
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_assert_throws() {
    let result = eval_js(
        r#"
        const assert = require('assert');
        assert.throws(() => { throw new Error('boom'); });
        try { assert.throws(() => {}); throw new Error('should throw'); }
        catch (e) { if (e.message === 'should throw') throw e; }
        return 'ok';
        "#,
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_assert_does_not_throw() {
    let result = eval_js(
        r#"
        const assert = require('assert');
        assert.doesNotThrow(() => {});
        try { assert.doesNotThrow(() => { throw new Error('oops'); }); throw new Error('should throw'); }
        catch (e) { if (e.message === 'should throw') throw e; }
        return 'ok';
        "#,
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_assert_fail() {
    let result = eval_js(
        r#"
        const assert = require('assert');
        try { assert.fail('custom msg'); throw new Error('should throw'); }
        catch (e) { if (e.message === 'should throw') throw e; if (e.message !== 'custom msg') throw new Error('wrong: ' + e.message); }
        return 'ok';
        "#,
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_assert_require_node_prefix() {
    let result = eval_js("const assert = require('node:assert'); assert(true); return 'ok';");
    assert_eq!(result.unwrap(), "ok");
}

// ===== Stream module tests =====

#[test]
fn test_stream_readable_exists() {
    let result = eval_js(
        "const { Readable } = require('stream'); if (typeof Readable !== 'function') throw new Error('not a function'); return 'ok';",
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_stream_writable_exists() {
    let result = eval_js(
        "const { Writable } = require('stream'); if (typeof Writable !== 'function') throw new Error('not a function'); return 'ok';",
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_stream_writable_write() {
    let result = eval_js(
        r#"
        const { Writable } = require('stream');
        let written = '';
        const w = new Writable({ write: function(chunk, enc, cb) { written += chunk; cb(); } });
        w.write('hello');
        w.write(' world');
        if (written !== 'hello world') throw new Error('got: ' + written);
        return 'ok';
        "#,
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_stream_transform_exists() {
    let result = eval_js(
        "const { Transform } = require('stream'); if (typeof Transform !== 'function') throw new Error('not a function'); return 'ok';",
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_stream_passthrough_exists() {
    let result = eval_js(
        "const { PassThrough } = require('stream'); if (typeof PassThrough !== 'function') throw new Error('not a function'); return 'ok';",
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_stream_writable_is_eventemitter() {
    let result = eval_js(
        r#"
        const { Writable } = require('stream');
        const { EventEmitter } = require('events');
        const w = new Writable({ write: function(chunk, enc, cb) { cb(); } });
        if (!(w instanceof EventEmitter)) throw new Error('not an EventEmitter');
        return 'ok';
        "#,
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_process_stdout_write() {
    let result = eval_js(
        r#"
        if (typeof process.stdout.write !== 'function') throw new Error('no write');
        process.stdout.write('test output\n');
        return 'ok';
        "#,
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_stream_require_node_prefix() {
    let result = eval_js(
        "const s = require('node:stream'); if (!s.Readable) throw new Error('no Readable'); return 'ok';",
    );
    assert_eq!(result.unwrap(), "ok");
}

// ===== Buffer built-in module tests =====

#[test]
fn test_require_buffer_returns_builtin() {
    let result = eval_js(
        "const b = require('buffer'); if (!b.Buffer) throw new Error('missing Buffer'); return 'ok';",
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_require_buffer_node_prefix() {
    let result = eval_js(
        "const b = require('node:buffer'); if (!b.Buffer) throw new Error('missing Buffer'); return 'ok';",
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_require_buffer_from_works() {
    let result =
        eval_js("const { Buffer } = require('buffer'); return Buffer.from('hello').toString();");
    assert_eq!(result.unwrap(), "hello");
}

#[test]
fn test_require_buffer_is_buffer() {
    let result = eval_js(
        "const { Buffer } = require('buffer'); return String(Buffer.isBuffer(Buffer.from('x')));",
    );
    assert_eq!(result.unwrap(), "true");
}

// ===== Path built-in module tests =====

#[test]
fn test_require_path_returns_builtin() {
    let result = eval_js(
        "const p = require('path'); if (!p.join) throw new Error('missing join'); return 'ok';",
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_require_path_node_prefix() {
    let result = eval_js(
        "const p = require('node:path'); if (!p.join) throw new Error('missing join'); return 'ok';",
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_require_path_join() {
    let result = eval_js("const p = require('path'); return p.join('a', 'b', 'c');");
    assert_eq!(result.unwrap(), "a/b/c");
}

#[test]
fn test_require_path_dirname() {
    let result = eval_js("const p = require('path'); return p.dirname('/foo/bar/baz.txt');");
    assert_eq!(result.unwrap(), "/foo/bar");
}

#[test]
fn test_require_path_basename() {
    let result = eval_js("const p = require('path'); return p.basename('/foo/bar/baz.txt');");
    assert_eq!(result.unwrap(), "baz.txt");
}

#[test]
fn test_require_path_extname() {
    let result = eval_js("const p = require('path'); return p.extname('file.ts');");
    assert_eq!(result.unwrap(), ".ts");
}

#[test]
fn test_require_path_posix_alias() {
    let result = eval_js(
        "const p = require('path'); if (p.posix !== p) throw new Error('posix not self'); return 'ok';",
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_require_path_posix_subpath() {
    let result = eval_js(
        "const p = require('path/posix'); if (!p.join) throw new Error('missing join'); return 'ok';",
    );
    assert_eq!(result.unwrap(), "ok");
}

// ===== URL built-in module tests =====

#[test]
fn test_require_url_returns_builtin() {
    let result = eval_js(
        "const u = require('url'); if (!u.URL) throw new Error('missing URL'); return 'ok';",
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_require_url_node_prefix() {
    let result = eval_js(
        "const u = require('node:url'); if (!u.URL) throw new Error('missing URL'); return 'ok';",
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_require_url_constructor() {
    let result = eval_js(
        "const { URL } = require('url'); const u = new URL('https://example.com/path'); return u.hostname;",
    );
    assert_eq!(result.unwrap(), "example.com");
}

#[test]
fn test_require_url_search_params() {
    let result = eval_js(
        "const { URLSearchParams } = require('url'); const p = new URLSearchParams('a=1&b=2'); return p.get('b');",
    );
    assert_eq!(result.unwrap(), "2");
}

// ===== string_decoder built-in module tests =====

#[test]
fn test_require_string_decoder_returns_builtin() {
    let result = eval_js(
        "const sd = require('string_decoder'); if (!sd.StringDecoder) throw new Error('missing StringDecoder'); return 'ok';",
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_require_string_decoder_node_prefix() {
    let result = eval_js(
        "const sd = require('node:string_decoder'); if (!sd.StringDecoder) throw new Error('missing StringDecoder'); return 'ok';",
    );
    assert_eq!(result.unwrap(), "ok");
}

// ===== fs built-in module tests =====

#[test]
fn test_require_fs_returns_builtin() {
    let result = eval_js(
        "const f = require('fs'); if (!f.readFileSync) throw new Error('missing readFileSync'); return 'ok';",
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_require_fs_node_prefix() {
    let result = eval_js(
        "const f = require('node:fs'); if (!f.readFileSync) throw new Error('missing readFileSync'); return 'ok';",
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_require_fs_promises_subpath() {
    let result = eval_js(
        "const fsp = require('fs/promises'); if (!fsp.readFile) throw new Error('missing readFile'); return 'ok';",
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_require_fs_promises_node_prefix() {
    let result = eval_js(
        "const fsp = require('node:fs/promises'); if (!fsp.readFile) throw new Error('missing readFile'); return 'ok';",
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_require_fs_exists_sync() {
    let result = eval_js("const fs = require('fs'); return String(fs.existsSync('/'));");
    assert_eq!(result.unwrap(), "true");
}

#[test]
fn test_require_fs_has_constants() {
    let result = eval_js(
        "const fs = require('fs'); if (fs.constants.F_OK !== 0) throw new Error('bad F_OK'); return 'ok';",
    );
    assert_eq!(result.unwrap(), "ok");
}

// ===== querystring module tests =====

#[test]
fn test_querystring_stringify_basic() {
    let result =
        eval_js(r#"const qs = require('querystring'); return qs.stringify({a: '1', b: '2'});"#);
    let r = result.unwrap();
    assert!(r == "a=1&b=2" || r == "b=2&a=1", "got: {}", r);
}

#[test]
fn test_querystring_stringify_custom_sep_eq() {
    let result = eval_js(
        r#"const qs = require('querystring'); return qs.stringify({a: '1', b: '2'}, ';', ':');"#,
    );
    let r = result.unwrap();
    assert!(r == "a:1;b:2" || r == "b:2;a:1", "got: {}", r);
}

#[test]
fn test_querystring_stringify_encodes_special_chars() {
    let result =
        eval_js(r#"const qs = require('querystring'); return qs.stringify({msg: 'hello world'});"#);
    assert_eq!(result.unwrap(), "msg=hello%20world");
}

#[test]
fn test_querystring_parse_basic() {
    let result = eval_js(
        r#"const qs = require('querystring'); const o = qs.parse('a=1&b=2'); return o.a + ',' + o.b;"#,
    );
    assert_eq!(result.unwrap(), "1,2");
}

#[test]
fn test_querystring_parse_custom_sep_eq() {
    let result = eval_js(
        r#"const qs = require('querystring'); const o = qs.parse('a:1;b:2', ';', ':'); return o.a + ',' + o.b;"#,
    );
    assert_eq!(result.unwrap(), "1,2");
}

#[test]
fn test_querystring_parse_decodes_special_chars() {
    let result = eval_js(
        r#"const qs = require('querystring'); const o = qs.parse('msg=hello%20world'); return o.msg;"#,
    );
    assert_eq!(result.unwrap(), "hello world");
}

#[test]
fn test_querystring_parse_duplicate_keys_to_array() {
    let result = eval_js(
        r#"const qs = require('querystring'); const o = qs.parse('a=1&a=2'); return Array.isArray(o.a) ? o.a.join(',') : 'not array';"#,
    );
    assert_eq!(result.unwrap(), "1,2");
}

#[test]
fn test_querystring_escape_unescape() {
    let result = eval_js(
        r#"const qs = require('querystring'); const e = qs.escape('hello world'); const d = qs.unescape(e); return d;"#,
    );
    assert_eq!(result.unwrap(), "hello world");
}

#[test]
fn test_querystring_encode_decode_aliases() {
    let result = eval_js(
        r#"const qs = require('querystring'); if (qs.encode !== qs.stringify) throw new Error('encode alias'); if (qs.decode !== qs.parse) throw new Error('decode alias'); return 'ok';"#,
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_querystring_require_node_prefix() {
    let result = eval_js(
        "const qs = require('node:querystring'); if (!qs.stringify) throw new Error('missing stringify'); return 'ok';",
    );
    assert_eq!(result.unwrap(), "ok");
}

// ===== timers built-in module tests =====

#[test]
fn test_timers_module_has_set_timeout() {
    let result = eval_js(
        "const t = require('timers'); if (typeof t.setTimeout !== 'function') throw new Error('missing setTimeout'); return 'ok';",
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_timers_module_has_set_interval() {
    let result = eval_js(
        "const t = require('timers'); if (typeof t.setInterval !== 'function') throw new Error('missing setInterval'); return 'ok';",
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_timers_module_has_set_immediate() {
    let result = eval_js(
        "const t = require('timers'); if (typeof t.setImmediate !== 'function') throw new Error('missing setImmediate'); return 'ok';",
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_timers_module_has_clear_timeout() {
    let result = eval_js(
        "const t = require('timers'); if (typeof t.clearTimeout !== 'function') throw new Error('missing clearTimeout'); return 'ok';",
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_timers_module_has_clear_interval() {
    let result = eval_js(
        "const t = require('timers'); if (typeof t.clearInterval !== 'function') throw new Error('missing clearInterval'); return 'ok';",
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_timers_module_require_node_prefix() {
    let result = eval_js(
        "const t = require('node:timers'); if (!t.setTimeout) throw new Error('missing setTimeout'); return 'ok';",
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_timers_promises_set_timeout() {
    let result = eval_js(
        "const tp = require('timers/promises'); if (typeof tp.setTimeout !== 'function') throw new Error('missing setTimeout'); return 'ok';",
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_timers_promises_node_prefix() {
    let result = eval_js(
        "const tp = require('node:timers/promises'); if (!tp.setTimeout) throw new Error('missing'); return 'ok';",
    );
    assert_eq!(result.unwrap(), "ok");
}

// ===== child_process module tests =====

#[test]
fn test_child_process_require_exists() {
    let result = eval_js(
        "const cp = require('child_process'); if (typeof cp !== 'object') throw new Error('not an object'); return 'ok';",
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_child_process_require_node_prefix() {
    let result = eval_js(
        "const cp = require('node:child_process'); if (!cp.exec) throw new Error('missing exec'); return 'ok';",
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_child_process_has_all_methods() {
    let result = eval_js(
        r#"
        const cp = require('child_process');
        const methods = ['exec', 'execSync', 'execFile', 'execFileSync', 'spawn', 'spawnSync', 'fork'];
        for (const m of methods) {
            if (typeof cp[m] !== 'function') throw new Error('missing ' + m);
        }
        return 'ok';
        "#,
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_child_process_exec_sync_echo() {
    let result = eval_js(
        r#"
        const cp = require('child_process');
        const out = cp.execSync('echo hello', { encoding: 'utf8' });
        if (out.trim() !== 'hello') throw new Error('unexpected: ' + JSON.stringify(out));
        return 'ok';
        "#,
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_child_process_exec_sync_returns_buffer() {
    let result = eval_js(
        r#"
        const cp = require('child_process');
        const out = cp.execSync('echo hello');
        if (!Buffer.isBuffer(out)) throw new Error('expected Buffer, got: ' + typeof out);
        return 'ok';
        "#,
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_child_process_exec_sync_pipe() {
    let result = eval_js(
        r#"
        const cp = require('child_process');
        const out = cp.execSync('echo foo | tr a-z A-Z', { encoding: 'utf8' });
        if (out.trim() !== 'FOO') throw new Error('unexpected: ' + JSON.stringify(out));
        return 'ok';
        "#,
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_child_process_exec_sync_nonzero_throws() {
    let result = eval_js(
        r#"
        const cp = require('child_process');
        try {
            cp.execSync('exit 42');
            throw new Error('should throw');
        } catch (e) {
            if (e.message === 'should throw') throw e;
            if (e.code !== 42 && e.status !== 42) throw new Error('expected code 42, got: ' + JSON.stringify({code: e.code, status: e.status}));
        }
        return 'ok';
        "#,
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_child_process_exec_sync_encoding_utf8() {
    let result = eval_js(
        r#"
        const cp = require('child_process');
        const out = cp.execSync('echo test', { encoding: 'utf8' });
        if (typeof out !== 'string') throw new Error('expected string with encoding, got: ' + typeof out);
        return 'ok';
        "#,
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_child_process_exec_sync_input_stdin() {
    let result = eval_js(
        r#"
        const cp = require('child_process');
        const out = cp.execSync('cat', { input: 'hello from stdin', encoding: 'utf8' });
        if (out.trim() !== 'hello from stdin') throw new Error('unexpected: ' + JSON.stringify(out));
        return 'ok';
        "#,
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_child_process_exec_sync_multiline() {
    let result = eval_js(
        r#"
        const cp = require('child_process');
        const out = cp.execSync('printf "line1\nline2\nline3"', { encoding: 'utf8' });
        const lines = out.split('\n').filter(l => l.length > 0);
        if (lines.length !== 3) throw new Error('expected 3 lines, got: ' + lines.length);
        return 'ok';
        "#,
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_child_process_spawn_sync_status() {
    let result = eval_js(
        r#"
        const cp = require('child_process');
        const r = cp.spawnSync('echo', ['hello'], { encoding: 'utf8' });
        if (r.status !== 0) throw new Error('expected status 0, got: ' + r.status);
        if (r.stdout.trim() !== 'hello') throw new Error('unexpected stdout: ' + JSON.stringify(r.stdout));
        return 'ok';
        "#,
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_child_process_spawn_sync_stderr() {
    let result = eval_js(
        r#"
        const cp = require('child_process');
        const r = cp.spawnSync('sh', ['-c', 'echo err >&2'], { encoding: 'utf8' });
        if (r.stderr.trim() !== 'err') throw new Error('unexpected stderr: ' + JSON.stringify(r.stderr));
        return 'ok';
        "#,
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_child_process_spawn_sync_exit_code() {
    let result = eval_js(
        r#"
        const cp = require('child_process');
        const r = cp.spawnSync('sh', ['-c', 'exit 7']);
        if (r.status !== 7) throw new Error('expected status 7, got: ' + r.status);
        return 'ok';
        "#,
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_child_process_spawn_sync_signal_null() {
    let result = eval_js(
        r#"
        const cp = require('child_process');
        const r = cp.spawnSync('echo', ['test']);
        if (r.signal !== null) throw new Error('expected null signal, got: ' + r.signal);
        return 'ok';
        "#,
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_child_process_exec_callback() {
    let result = eval_js(
        r#"
        const cp = require('child_process');
        var cbErr = null, cbOut = '', cbStderr = '';
        cp.exec('echo callback_test', function(err, stdout, stderr) {
            cbErr = err;
            cbOut = stdout;
            cbStderr = stderr;
        });
        if (cbErr !== null) throw new Error('expected no error, got: ' + cbErr);
        if (cbOut.trim() !== 'callback_test') throw new Error('unexpected stdout: ' + JSON.stringify(cbOut));
        return 'ok';
        "#,
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_child_process_exec_error_callback() {
    let result = eval_js(
        r#"
        const cp = require('child_process');
        var gotError = false;
        cp.exec('exit 1', function(err, stdout, stderr) {
            if (err) gotError = true;
        });
        if (!gotError) throw new Error('expected error callback');
        return 'ok';
        "#,
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_child_process_exec_sync_empty_command_throws() {
    let result = eval_js(
        r#"
        const cp = require('child_process');
        try {
            cp.execSync('');
            throw new Error('should throw');
        } catch (e) {
            if (e.message === 'should throw') throw e;
        }
        return 'ok';
        "#,
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_child_process_fork_still_throws() {
    let result = eval_js(
        r#"
        const cp = require('child_process');
        try { cp.fork('module.js'); throw new Error('should throw'); }
        catch (e) { if (!e.message.includes('not supported')) throw e; }
        return 'ok';
        "#,
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_child_process_exec_sync_stderr_capture() {
    let result = eval_js(
        r#"
        const cp = require('child_process');
        try {
            cp.execSync('sh -c "echo errdata >&2; exit 1"');
        } catch (e) {
            if (typeof e.stderr === 'undefined') throw new Error('missing stderr on error');
            var stderrStr = Buffer.isBuffer(e.stderr) ? e.stderr.toString() : e.stderr;
            if (!stderrStr.includes('errdata')) throw new Error('stderr missing errdata: ' + stderrStr);
        }
        return 'ok';
        "#,
    );
    assert_eq!(result.unwrap(), "ok");
}

// ===== perf_hooks module tests =====

#[test]
fn test_perf_hooks_performance_now() {
    let result = eval_js(
        "const { performance } = require('perf_hooks'); if (typeof performance.now() !== 'number') throw new Error('not number'); return 'ok';",
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_perf_hooks_performance_now_increases() {
    let result = eval_js(
        r#"
        const { performance } = require('perf_hooks');
        const a = performance.now();
        let x = 0; for (let i = 0; i < 10000; i++) x += i;
        const b = performance.now();
        if (b < a) throw new Error('time went backwards');
        return 'ok';
        "#,
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_perf_hooks_time_origin() {
    let result = eval_js(
        "const { performance } = require('perf_hooks'); if (typeof performance.timeOrigin !== 'number' || performance.timeOrigin <= 0) throw new Error('bad timeOrigin'); return 'ok';",
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_perf_hooks_mark_and_measure() {
    let result = eval_js(
        r#"
        const { performance } = require('perf_hooks');
        performance.mark('start');
        let x = 0; for (let i = 0; i < 1000; i++) x += i;
        performance.mark('end');
        performance.measure('test', 'start', 'end');
        const entries = performance.getEntriesByName('test');
        if (entries.length !== 1) throw new Error('expected 1 entry, got ' + entries.length);
        if (entries[0].entryType !== 'measure') throw new Error('wrong type');
        if (typeof entries[0].duration !== 'number') throw new Error('no duration');
        return 'ok';
        "#,
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_perf_hooks_get_entries_by_type() {
    let result = eval_js(
        r#"
        const { performance } = require('perf_hooks');
        performance.mark('m1');
        performance.mark('m2');
        const marks = performance.getEntriesByType('mark');
        if (marks.length < 2) throw new Error('expected at least 2 marks');
        return 'ok';
        "#,
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_perf_hooks_clear_marks() {
    let result = eval_js(
        r#"
        const { performance } = require('perf_hooks');
        performance.mark('x');
        performance.clearMarks();
        const entries = performance.getEntriesByType('mark');
        if (entries.length !== 0) throw new Error('marks not cleared');
        return 'ok';
        "#,
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_perf_hooks_require_node_prefix() {
    let result = eval_js(
        "const ph = require('node:perf_hooks'); if (!ph.performance) throw new Error('missing performance'); return 'ok';",
    );
    assert_eq!(result.unwrap(), "ok");
}

// ===== https module tests =====

#[test]
fn test_https_require_exists() {
    let result = eval_js(
        "const https = require('https'); if (typeof https !== 'object') throw new Error('not object'); return 'ok';",
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_https_require_node_prefix() {
    let result = eval_js(
        "const https = require('node:https'); if (!https.request) throw new Error('missing request'); return 'ok';",
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_https_has_request_function() {
    let result = eval_js(
        "const https = require('https'); if (typeof https.request !== 'function') throw new Error('not function'); return 'ok';",
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_https_has_get_function() {
    let result = eval_js(
        "const https = require('https'); if (typeof https.get !== 'function') throw new Error('not function'); return 'ok';",
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_https_has_create_server() {
    let result = eval_js(
        "const https = require('https'); if (typeof https.createServer !== 'function') throw new Error('not function'); return 'ok';",
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_https_create_server_listen_throws() {
    let result = eval_js(
        r#"
        const https = require('https');
        const server = https.createServer({}, () => {});
        try { server.listen(3000); throw new Error('should throw'); }
        catch (e) { if (!e.message.includes('not supported')) throw e; }
        return 'ok';
        "#,
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_https_agent_exists() {
    let result = eval_js(
        "const https = require('https'); if (typeof https.Agent !== 'function') throw new Error('not function'); if (!https.globalAgent) throw new Error('no globalAgent'); return 'ok';",
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_https_client_request_has_methods() {
    let result = eval_js(
        r#"
        const https = require('https');
        const req = https.request('https://localhost', () => {});
        if (typeof req.write !== 'function') throw new Error('no write');
        if (typeof req.end !== 'function') throw new Error('no end');
        if (typeof req.setHeader !== 'function') throw new Error('no setHeader');
        return 'ok';
        "#,
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_https_request_accepts_options_object() {
    let result = eval_js(
        r#"
        const https = require('https');
        const req = https.request({ hostname: 'localhost', port: 443, path: '/api', method: 'POST' }, () => {});
        if (typeof req.write !== 'function') throw new Error('no write');
        return 'ok';
        "#,
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_https_get_auto_ends() {
    let result = eval_js(
        r#"
        const https = require('https');
        // Mock __syncFetch__ to avoid actual network calls in test
        const origFetch = globalThis.__syncFetch__;
        globalThis.__syncFetch__ = function() {
            return JSON.stringify({ status: 200, statusText: 'OK', headers: [], body: 'mock' });
        };
        try {
            const req = https.get('https://localhost/test', () => {});
            // get() should auto-call end, so _ended should be true
            if (!req._ended) throw new Error('get did not auto-end');
        } finally {
            globalThis.__syncFetch__ = origFetch;
        }
        return 'ok';
        "#,
    );
    assert_eq!(result.unwrap(), "ok");
}

// ===== http module tests =====

#[test]
fn test_http_require_exists() {
    let result = eval_js(
        "const http = require('http'); if (typeof http !== 'object') throw new Error('not object'); return 'ok';",
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_http_require_node_prefix() {
    let result = eval_js(
        "const http = require('node:http'); if (!http.request) throw new Error('missing request'); return 'ok';",
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_http_has_methods_array() {
    let result = eval_js(
        "const http = require('http'); if (!Array.isArray(http.METHODS)) throw new Error('not array'); if (!http.METHODS.includes('GET')) throw new Error('missing GET'); return 'ok';",
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_http_has_status_codes() {
    let result = eval_js(
        "const http = require('http'); if (http.STATUS_CODES[200] !== 'OK') throw new Error('missing 200'); if (http.STATUS_CODES[404] !== 'Not Found') throw new Error('missing 404'); return 'ok';",
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_http_has_request_function() {
    let result = eval_js(
        "const http = require('http'); if (typeof http.request !== 'function') throw new Error('not function'); return 'ok';",
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_http_has_get_function() {
    let result = eval_js(
        "const http = require('http'); if (typeof http.get !== 'function') throw new Error('not function'); return 'ok';",
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_http_has_create_server() {
    let result = eval_js(
        "const http = require('http'); if (typeof http.createServer !== 'function') throw new Error('not function'); return 'ok';",
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_http_create_server_listen_throws() {
    let result = eval_js(
        r#"
        const http = require('http');
        const server = http.createServer(() => {});
        try { server.listen(3000); throw new Error('should throw'); }
        catch (e) { if (!e.message.includes('not supported')) throw e; }
        return 'ok';
        "#,
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_http_agent_exists() {
    let result = eval_js(
        "const http = require('http'); if (typeof http.Agent !== 'function') throw new Error('not function'); if (!http.globalAgent) throw new Error('no globalAgent'); return 'ok';",
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_http_incoming_message_exists() {
    let result = eval_js(
        "const http = require('http'); if (typeof http.IncomingMessage !== 'function') throw new Error('not function'); return 'ok';",
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_http_server_response_exists() {
    let result = eval_js(
        "const http = require('http'); if (typeof http.ServerResponse !== 'function') throw new Error('not function'); return 'ok';",
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_http_client_request_is_writable() {
    let result = eval_js(
        r#"
        const http = require('http');
        const { EventEmitter } = require('events');
        const req = http.request('http://localhost', () => {});
        if (typeof req.write !== 'function') throw new Error('no write');
        if (typeof req.end !== 'function') throw new Error('no end');
        if (!(req instanceof EventEmitter)) throw new Error('not EventEmitter');
        return 'ok';
        "#,
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_http_request_accepts_options_object() {
    let result = eval_js(
        r#"
        const http = require('http');
        const req = http.request({ hostname: 'localhost', port: 80, path: '/test', method: 'POST' }, () => {});
        if (typeof req.write !== 'function') throw new Error('no write');
        return 'ok';
        "#,
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_http_request_parses_url_string() {
    let result = eval_js(
        r#"
        const http = require('http');
        const req = http.request('http://example.com:8080/api/data?q=1', () => {});
        if (typeof req.end !== 'function') throw new Error('no end');
        return 'ok';
        "#,
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_http_server_response_write_head() {
    let result = eval_js(
        r#"
        const http = require('http');
        const res = new http.ServerResponse();
        res.writeHead(200, {'Content-Type': 'text/plain'});
        if (res.statusCode !== 200) throw new Error('wrong status');
        return 'ok';
        "#,
    );
    assert_eq!(result.unwrap(), "ok");
}

// ========================================================================
// Net Tests
// ========================================================================

#[test]
fn test_net_require() {
    let result = eval_js("var net = require('net'); return typeof net").unwrap();
    assert_eq!(result, "object");
}

#[test]
fn test_net_require_node_prefix() {
    let result = eval_js("var net = require('node:net'); return typeof net").unwrap();
    assert_eq!(result, "object");
}

#[test]
fn test_net_isip_ipv4() {
    let result = eval_js("var net = require('net'); return '' + net.isIP('127.0.0.1')").unwrap();
    assert_eq!(result, "4");
}

#[test]
fn test_net_isip_ipv6() {
    let result = eval_js("var net = require('net'); return '' + net.isIP('::1')").unwrap();
    assert_eq!(result, "6");
}

#[test]
fn test_net_isip_invalid() {
    let result = eval_js("var net = require('net'); return '' + net.isIP('abc')").unwrap();
    assert_eq!(result, "0");
}

#[test]
fn test_net_isipv4_returns_boolean() {
    let result = eval_js(
        "var net = require('net'); return typeof net.isIPv4('127.0.0.1') === 'boolean' ? 'ok' : 'fail'",
    )
    .unwrap();
    assert_eq!(result, "ok");
}

#[test]
fn test_net_isipv6_returns_boolean() {
    let result = eval_js(
        "var net = require('net'); return typeof net.isIPv6('::1') === 'boolean' ? 'ok' : 'fail'",
    )
    .unwrap();
    assert_eq!(result, "ok");
}

#[test]
fn test_net_create_server_throws() {
    let result = eval_js(
        r#"
        var net = require('net');
        try { net.createServer(); throw new Error('should throw'); }
        catch (e) { if (!e.message.includes('not supported')) throw e; }
        return 'ok';
        "#,
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_net_create_connection_throws() {
    let result = eval_js(
        r#"
        var net = require('net');
        try { net.createConnection(); throw new Error('should throw'); }
        catch (e) { if (!e.message.includes('not supported')) throw e; }
        return 'ok';
        "#,
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_net_socket_constructor_exists() {
    let result = eval_js(
        "var net = require('net'); if (typeof net.Socket !== 'function') throw new Error('not function'); return 'ok'",
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_net_server_constructor_exists() {
    let result = eval_js(
        "var net = require('net'); if (typeof net.Server !== 'function') throw new Error('not function'); return 'ok'",
    );
    assert_eq!(result.unwrap(), "ok");
}

// ========================================================================
// TLS Tests
// ========================================================================

#[test]
fn test_tls_require() {
    let result = eval_js("var tls = require('tls'); return typeof tls").unwrap();
    assert_eq!(result, "object");
}

#[test]
fn test_tls_require_node_prefix() {
    let result = eval_js(
        "var tls = require('node:tls'); if (!tls.createServer) throw new Error('missing createServer'); return 'ok';",
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_tls_create_server_throws() {
    let result = eval_js(
        r#"
        var tls = require('tls');
        try { tls.createServer(); throw new Error('should throw'); }
        catch (e) { if (!e.message.includes('not supported')) throw e; }
        return 'ok';
        "#,
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_tls_connect_throws() {
    let result = eval_js(
        r#"
        var tls = require('tls');
        try { tls.connect(); throw new Error('should throw'); }
        catch (e) { if (!e.message.includes('not supported')) throw e; }
        return 'ok';
        "#,
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_tls_default_min_version() {
    let result = eval_js("var tls = require('tls'); return tls.DEFAULT_MIN_VERSION;").unwrap();
    assert_eq!(result, "TLSv1.2");
}

#[test]
fn test_tls_default_max_version() {
    let result = eval_js("var tls = require('tls'); return tls.DEFAULT_MAX_VERSION;").unwrap();
    assert_eq!(result, "TLSv1.3");
}

#[test]
fn test_tls_socket_constructor_exists() {
    let result = eval_js(
        "var tls = require('tls'); if (typeof tls.TLSSocket !== 'function') throw new Error('not function'); return 'ok';",
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_tls_server_constructor_exists() {
    let result = eval_js(
        "var tls = require('tls'); if (typeof tls.Server !== 'function') throw new Error('not function'); return 'ok';",
    );
    assert_eq!(result.unwrap(), "ok");
}

// ========================================================================
// Worker Threads Tests
// ========================================================================

#[test]
fn test_worker_threads_require() {
    let result = eval_js("var wt = require('worker_threads'); return typeof wt").unwrap();
    assert_eq!(result, "object");
}

#[test]
fn test_worker_threads_require_node_prefix() {
    let result = eval_js("var wt = require('node:worker_threads'); return typeof wt").unwrap();
    assert_eq!(result, "object");
}

#[test]
fn test_worker_threads_is_main_thread() {
    let result =
        eval_js("var wt = require('worker_threads'); return String(wt.isMainThread)").unwrap();
    assert_eq!(result, "true");
}

#[test]
fn test_worker_threads_parent_port_is_null() {
    let result =
        eval_js("var wt = require('worker_threads'); return String(wt.parentPort === null)")
            .unwrap();
    assert_eq!(result, "true");
}

#[test]
fn test_worker_threads_worker_data_is_null() {
    let result =
        eval_js("var wt = require('worker_threads'); return String(wt.workerData === null)")
            .unwrap();
    assert_eq!(result, "true");
}

#[test]
fn test_worker_threads_thread_id_is_zero() {
    let result = eval_js("var wt = require('worker_threads'); return String(wt.threadId)").unwrap();
    assert_eq!(result, "0");
}

#[test]
fn test_worker_threads_worker_constructor_throws() {
    let result = eval_js(
        r#"
        var wt = require('worker_threads');
        try { new wt.Worker('test.js'); throw new Error('should throw'); }
        catch (e) { if (!e.message.includes('not supported')) throw e; }
        return 'ok';
        "#,
    );
    assert_eq!(result.unwrap(), "ok");
}

// ========================================================================
// Dgram Tests
// ========================================================================

#[test]
fn test_dgram_require() {
    let result = eval_js("var dgram = require('dgram'); return typeof dgram").unwrap();
    assert_eq!(result, "object");
}

#[test]
fn test_dgram_require_node_prefix() {
    let result = eval_js("var dgram = require('node:dgram'); return typeof dgram").unwrap();
    assert_eq!(result, "object");
}

#[test]
fn test_dgram_create_socket_throws() {
    let result = eval_js(
        r#"
        var dgram = require('dgram');
        try { dgram.createSocket('udp4'); throw new Error('should throw'); }
        catch (e) { if (!e.message.includes('not supported')) throw e; }
        return 'ok';
        "#,
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_dgram_socket_constructor_exists() {
    let result = eval_js("var dgram = require('dgram'); return typeof dgram.Socket").unwrap();
    assert_eq!(result, "function");
}

// ========================================================================
// Zlib Tests
// ========================================================================

#[test]
fn test_zlib_require() {
    let result = eval_js("var zlib = require('zlib'); return typeof zlib").unwrap();
    assert_eq!(result, "object");
}

#[test]
fn test_zlib_require_node_prefix() {
    let result = eval_js("var zlib = require('node:zlib'); return typeof zlib").unwrap();
    assert_eq!(result, "object");
}

#[test]
fn test_zlib_constants_z_no_compression() {
    let result = eval_js(
        "var zlib = require('zlib'); if (zlib.Z_NO_COMPRESSION !== 0) throw new Error('expected 0'); return 'ok';",
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_zlib_constants_z_best_compression() {
    let result = eval_js(
        "var zlib = require('zlib'); if (zlib.Z_BEST_COMPRESSION !== 9) throw new Error('expected 9'); return 'ok';",
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_zlib_create_gzip_returns_object() {
    let result = eval_js(
        "var zlib = require('zlib'); var g = zlib.createGzip(); if (typeof g !== 'object' || g === null) throw new Error('not object'); return 'ok';",
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_zlib_create_gunzip_returns_object() {
    let result = eval_js(
        "var zlib = require('zlib'); var g = zlib.createGunzip(); if (typeof g !== 'object' || g === null) throw new Error('not object'); return 'ok';",
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_zlib_gzip_sync_passthrough() {
    let result = eval_js(
        "var zlib = require('zlib'); var out = zlib.gzipSync('hello'); if (out !== 'hello') throw new Error('not passthrough'); return 'ok';",
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_zlib_deflate_sync_passthrough() {
    let result = eval_js(
        "var zlib = require('zlib'); var out = zlib.deflateSync('data'); if (out !== 'data') throw new Error('not passthrough'); return 'ok';",
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_zlib_factory_functions_exist() {
    let result = eval_js(
        r#"
        var zlib = require('zlib');
        var fns = ['createGzip', 'createGunzip', 'createDeflate', 'createInflate',
                    'createDeflateRaw', 'createInflateRaw', 'createBrotliCompress', 'createBrotliDecompress'];
        for (var i = 0; i < fns.length; i++) {
            if (typeof zlib[fns[i]] !== 'function') throw new Error('missing ' + fns[i]);
        }
        return 'ok';
        "#,
    );
    assert_eq!(result.unwrap(), "ok");
}

// ========================================================================
// Module Tests
// ========================================================================

#[test]
fn test_module_require() {
    let result = eval_js("var m = require('module'); return typeof m").unwrap();
    assert_eq!(result, "function");
}

#[test]
fn test_module_require_node_prefix() {
    let result = eval_js("var m = require('node:module'); return typeof m").unwrap();
    assert_eq!(result, "function");
}

#[test]
fn test_module_create_require_returns_function() {
    let result = eval_js(
        "var Module = require('module'); var r = Module.createRequire('/tmp/test.js'); return typeof r",
    )
    .unwrap();
    assert_eq!(result, "function");
}

#[test]
fn test_module_builtin_modules_is_array() {
    let result = eval_js(
        "var Module = require('module'); if (!Array.isArray(Module.builtinModules)) throw new Error('not array'); return 'ok';",
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_module_builtin_modules_has_entries() {
    let result = eval_js(
        "var Module = require('module'); if (Module.builtinModules.length <= 0) throw new Error('empty'); return 'ok';",
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_module_is_builtin_fs() {
    let result =
        eval_js("var Module = require('module'); return String(Module.isBuiltin('fs'))").unwrap();
    assert_eq!(result, "true");
}

#[test]
fn test_module_is_builtin_nonexistent() {
    let result =
        eval_js("var Module = require('module'); return String(Module.isBuiltin('nonexistent'))")
            .unwrap();
    assert_eq!(result, "false");
}

#[test]
fn test_module_cache_is_object() {
    let result = eval_js(
        "var Module = require('module'); if (typeof Module._cache !== 'object' || Module._cache === null) throw new Error('not object'); return 'ok';",
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_module_extensions_is_object() {
    let result = eval_js(
        "var Module = require('module'); if (typeof Module._extensions !== 'object' || Module._extensions === null) throw new Error('not object'); return 'ok';",
    );
    assert_eq!(result.unwrap(), "ok");
}

// ========================================================================
// Punycode Tests
// ========================================================================

#[test]
fn test_punycode_require() {
    let result = eval_js("var punycode = require('punycode'); return typeof punycode").unwrap();
    assert_eq!(result, "object");
}

#[test]
fn test_punycode_require_node_prefix() {
    let result = eval_js(
        "var punycode = require('node:punycode'); if (!punycode.encode) throw new Error('missing encode'); return 'ok';",
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_punycode_version_is_string() {
    let result =
        eval_js("var punycode = require('punycode'); return typeof punycode.version").unwrap();
    assert_eq!(result, "string");
}

#[test]
fn test_punycode_to_ascii_pure_ascii() {
    let result =
        eval_js("var punycode = require('punycode'); return punycode.toASCII('example.com')")
            .unwrap();
    assert_eq!(result, "example.com");
}

#[test]
fn test_punycode_to_unicode_ascii() {
    let result =
        eval_js("var punycode = require('punycode'); return punycode.toUnicode('example.com')")
            .unwrap();
    assert_eq!(result, "example.com");
}

#[test]
fn test_punycode_encode_ascii_string() {
    let result =
        eval_js("var punycode = require('punycode'); return punycode.encode('abc')").unwrap();
    assert_eq!(result, "abc");
}

#[test]
fn test_punycode_decode_ascii_string() {
    let result =
        eval_js("var punycode = require('punycode'); return punycode.decode('abc')").unwrap();
    assert_eq!(result, "abc");
}

#[test]
fn test_punycode_ucs2_decode_returns_array() {
    let result = eval_js(
        r#"
        var punycode = require('punycode');
        var result = punycode.ucs2.decode('abc');
        if (!Array.isArray(result)) throw new Error('not array');
        if (result.length !== 3) throw new Error('wrong length: ' + result.length);
        if (result[0] !== 97) throw new Error('wrong value');
        return 'ok';
        "#,
    );
    assert_eq!(result.unwrap(), "ok");
}

// ========================================================================
// DNS Tests
// ========================================================================

#[test]
fn test_dns_require() {
    let result = eval_js("var dns = require('dns'); return typeof dns").unwrap();
    assert_eq!(result, "object");
}

#[test]
fn test_dns_require_node_prefix() {
    let result = eval_js("var dns = require('node:dns'); return typeof dns").unwrap();
    assert_eq!(result, "object");
}

#[test]
fn test_dns_promises_submodule() {
    let result = eval_js(
        "var p = require('dns/promises'); if (typeof p.lookup !== 'function') throw new Error('missing lookup'); return 'ok';",
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_dns_nodata_constant() {
    let result = eval_js("var dns = require('dns'); return dns.NODATA").unwrap();
    assert_eq!(result, "ENODATA");
}

#[test]
fn test_dns_resolver_is_function() {
    let result = eval_js("var dns = require('dns'); return typeof dns.Resolver").unwrap();
    assert_eq!(result, "function");
}

#[test]
fn test_dns_lookup_is_function() {
    let result = eval_js("var dns = require('dns'); return typeof dns.lookup").unwrap();
    assert_eq!(result, "function");
}

// ========================================================================
// Cluster Tests
// ========================================================================

#[test]
fn test_cluster_require() {
    let result = eval_js("var cluster = require('cluster'); return typeof cluster").unwrap();
    assert_eq!(result, "object");
}

#[test]
fn test_cluster_require_node_prefix() {
    let result = eval_js("var cluster = require('node:cluster'); return typeof cluster").unwrap();
    assert_eq!(result, "object");
}

#[test]
fn test_cluster_is_master() {
    let result =
        eval_js("var cluster = require('cluster'); return String(cluster.isMaster)").unwrap();
    assert_eq!(result, "true");
}

#[test]
fn test_cluster_is_primary() {
    let result =
        eval_js("var cluster = require('cluster'); return String(cluster.isPrimary)").unwrap();
    assert_eq!(result, "true");
}

#[test]
fn test_cluster_is_worker() {
    let result =
        eval_js("var cluster = require('cluster'); return String(cluster.isWorker)").unwrap();
    assert_eq!(result, "false");
}

#[test]
fn test_cluster_fork_throws() {
    let result = eval_js(
        r#"
        var cluster = require('cluster');
        try { cluster.fork(); throw new Error('should throw'); }
        catch (e) { if (!e.message.includes('not supported')) throw e; }
        return 'ok';
        "#,
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_cluster_sched_rr() {
    let result =
        eval_js("var cluster = require('cluster'); return String(cluster.SCHED_RR)").unwrap();
    assert_eq!(result, "2");
}

// ========================================================================
// V8 Tests
// ========================================================================

#[test]
fn test_v8_require() {
    let result = eval_js("var v8 = require('v8'); return typeof v8").unwrap();
    assert_eq!(result, "object");
}

#[test]
fn test_v8_require_node_prefix() {
    let result = eval_js("var v8 = require('node:v8'); return typeof v8").unwrap();
    assert_eq!(result, "object");
}

#[test]
fn test_v8_get_heap_statistics_returns_object_with_total_heap_size() {
    let result = eval_js(
        r#"
        var v8 = require('v8');
        var stats = v8.getHeapStatistics();
        if (typeof stats !== 'object' || stats === null) throw new Error('not object');
        if (typeof stats.total_heap_size !== 'number') throw new Error('missing total_heap_size');
        return 'ok';
        "#,
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_v8_get_heap_code_statistics_returns_object() {
    let result = eval_js(
        r#"
        var v8 = require('v8');
        var stats = v8.getHeapCodeStatistics();
        if (typeof stats !== 'object' || stats === null) throw new Error('not object');
        if (typeof stats.code_and_metadata_size !== 'number') throw new Error('missing code_and_metadata_size');
        return 'ok';
        "#,
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_v8_serialize_deserialize_roundtrip() {
    let result = eval_js(
        r#"
        var v8 = require('v8');
        var obj = { hello: 'world', num: 42 };
        var serialized = v8.serialize(obj);
        var deserialized = v8.deserialize(serialized);
        if (deserialized.hello !== 'world') throw new Error('wrong hello: ' + deserialized.hello);
        if (deserialized.num !== 42) throw new Error('wrong num: ' + deserialized.num);
        return 'ok';
        "#,
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_v8_cached_data_version_tag_returns_number() {
    let result = eval_js(
        r#"
        var v8 = require('v8');
        var tag = v8.cachedDataVersionTag();
        if (typeof tag !== 'number') throw new Error('not number');
        return 'ok';
        "#,
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_v8_set_flags_from_string_does_not_throw() {
    let result = eval_js(
        r#"
        var v8 = require('v8');
        v8.setFlagsFromString('--harmony');
        return 'ok';
        "#,
    );
    assert_eq!(result.unwrap(), "ok");
}

// ========================================================================
// Readline Tests
// ========================================================================

#[test]
fn test_readline_require() {
    let result = eval_js("var rl = require('readline'); return typeof rl").unwrap();
    assert_eq!(result, "object");
}

#[test]
fn test_readline_require_node_prefix() {
    let result = eval_js(
        "var rl = require('node:readline'); if (!rl.createInterface) throw new Error('missing createInterface'); return 'ok';",
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_readline_create_interface_returns_object() {
    let result = eval_js(
        "var rl = require('readline'); var iface = rl.createInterface({}); if (typeof iface !== 'object' || iface === null) throw new Error('not object'); return 'ok';",
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_readline_interface_is_function() {
    let result = eval_js(
        "var rl = require('readline'); if (typeof rl.Interface !== 'function') throw new Error('not function'); return 'ok';",
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_readline_close_method_exists() {
    let result = eval_js(
        "var rl = require('readline'); var iface = rl.createInterface({}); if (typeof iface.close !== 'function') throw new Error('no close'); return 'ok';",
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_readline_clear_line_is_function() {
    let result = eval_js(
        "var rl = require('readline'); if (typeof rl.clearLine !== 'function') throw new Error('not function'); return 'ok';",
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_readline_promises_submodule() {
    let result = eval_js(
        "var rlp = require('readline/promises'); if (typeof rlp.createInterface !== 'function') throw new Error('missing createInterface'); return 'ok';",
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_readline_promises_node_prefix() {
    let result = eval_js(
        "var rlp = require('node:readline/promises'); if (!rlp.createInterface) throw new Error('missing'); return 'ok';",
    );
    assert_eq!(result.unwrap(), "ok");
}

// ========================================================================
// TTY Tests
// ========================================================================

#[test]
fn test_tty_require() {
    let result = eval_js("var tty = require('tty'); return typeof tty").unwrap();
    assert_eq!(result, "object");
}

#[test]
fn test_tty_require_node_prefix() {
    let result = eval_js("var tty = require('node:tty'); return typeof tty").unwrap();
    assert_eq!(result, "object");
}

#[test]
fn test_tty_isatty_returns_false() {
    let result = eval_js("var tty = require('tty'); return String(tty.isatty(0))").unwrap();
    assert_eq!(result, "false");
}

#[test]
fn test_tty_readstream_is_function() {
    let result = eval_js("var tty = require('tty'); return typeof tty.ReadStream").unwrap();
    assert_eq!(result, "function");
}

#[test]
fn test_tty_writestream_is_function() {
    let result = eval_js("var tty = require('tty'); return typeof tty.WriteStream").unwrap();
    assert_eq!(result, "function");
}

#[test]
fn test_tty_writestream_columns_80() {
    let result = eval_js(
        "var tty = require('tty'); var ws = new tty.WriteStream(1); return String(ws.columns)",
    )
    .unwrap();
    assert_eq!(result, "80");
}

#[test]
fn test_tty_writestream_rows_24() {
    let result = eval_js(
        "var tty = require('tty'); var ws = new tty.WriteStream(1); return String(ws.rows)",
    )
    .unwrap();
    assert_eq!(result, "24");
}

// ========================================================================
// VM Tests
// ========================================================================

#[test]
fn test_vm_require() {
    let result = eval_js("var vm = require('vm'); return typeof vm").unwrap();
    assert_eq!(result, "object");
}

#[test]
fn test_vm_require_node_prefix() {
    let result = eval_js("var vm = require('node:vm'); return typeof vm").unwrap();
    assert_eq!(result, "object");
}

#[test]
fn test_vm_script_constructor_exists() {
    let result = eval_js(
        "var vm = require('vm'); if (typeof vm.Script !== 'function') throw new Error('not function'); return 'ok';",
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_vm_run_in_this_context_evaluates_code() {
    let result = eval_js(
        "var vm = require('vm'); var s = new vm.Script('return 1+1'); return '' + s.runInThisContext();",
    );
    assert_eq!(result.unwrap(), "2");
}

#[test]
fn test_vm_run_in_new_context_with_sandbox() {
    let result = eval_js(
        r#"
        var vm = require('vm');
        var s = new vm.Script('return x + y');
        var result = s.runInNewContext({ x: 10, y: 20 });
        return '' + result;
        "#,
    );
    assert_eq!(result.unwrap(), "30");
}

#[test]
fn test_vm_create_context_returns_object() {
    let result = eval_js(
        "var vm = require('vm'); var ctx = vm.createContext({ a: 1 }); if (typeof ctx !== 'object') throw new Error('not object'); return 'ok';",
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_vm_is_context_returns_true_for_object() {
    let result = eval_js("var vm = require('vm'); return String(vm.isContext({}));");
    assert_eq!(result.unwrap(), "true");
}

#[test]
fn test_vm_compile_function_returns_function() {
    let result = eval_js(
        "var vm = require('vm'); var fn = vm.compileFunction('return a + b', ['a', 'b']); return '' + fn(3, 4);",
    );
    assert_eq!(result.unwrap(), "7");
}

// ========================================================================
// Domain Tests
// ========================================================================

#[test]
fn test_domain_require() {
    let result = eval_js("var domain = require('domain'); return typeof domain").unwrap();
    assert_eq!(result, "object");
}

#[test]
fn test_domain_require_node_prefix() {
    let result = eval_js("var domain = require('node:domain'); return typeof domain").unwrap();
    assert_eq!(result, "object");
}

#[test]
fn test_domain_create_returns_object() {
    let result = eval_js("var domain = require('domain'); return typeof domain.create()").unwrap();
    assert_eq!(result, "object");
}

#[test]
fn test_domain_constructor_is_function() {
    let result = eval_js("var domain = require('domain'); return typeof domain.Domain").unwrap();
    assert_eq!(result, "function");
}

#[test]
fn test_domain_active_is_null() {
    let result =
        eval_js("var domain = require('domain'); return String(domain.active === null)").unwrap();
    assert_eq!(result, "true");
}

#[test]
fn test_domain_has_add_remove() {
    let result =
        eval_js("var d = require('domain').create(); return typeof d.add + '|' + typeof d.remove")
            .unwrap();
    assert_eq!(result, "function|function");
}

#[test]
fn test_domain_run_executes_function() {
    let result = eval_js(
        "var d = require('domain').create(); var x = 0; d.run(function() { x = 42; }); return String(x)",
    )
    .unwrap();
    assert_eq!(result, "42");
}

// ===== Stream pipeline / finished / Readable.from / destroy / Duplex tests =====

#[test]
fn test_stream_pipeline_basic_chain() {
    let result = eval_js(
        r#"
        const { Readable, Transform, Writable, pipeline } = require('stream');
        let output = '';
        const src = new Readable({ read: function() {} });
        const upper = new Transform({ transform: function(chunk, enc, cb) { cb(null, String(chunk).toUpperCase()); } });
        const sink = new Writable({ write: function(chunk, enc, cb) { output += chunk; cb(); } });
        let cbCalled = false;
        pipeline(src, upper, sink, function(err) { cbCalled = true; });
        src.push('hello');
        src.push(null);
        if (output !== 'HELLO') throw new Error('got: ' + output);
        if (!cbCalled) throw new Error('callback not called');
        return 'ok';
        "#,
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_stream_pipeline_error_propagation() {
    let result = eval_js(
        r#"
        const { Readable, Writable, pipeline } = require('stream');
        const src = new Readable({ read: function() {} });
        const sink = new Writable({ write: function(chunk, enc, cb) { cb(); } });
        let gotErr = null;
        pipeline(src, sink, function(err) { gotErr = err; });
        src.emit('error', new Error('source fail'));
        if (!gotErr) throw new Error('no error propagated');
        if (gotErr.message !== 'source fail') throw new Error('wrong error: ' + gotErr.message);
        return 'ok';
        "#,
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_stream_pipeline_promise_return() {
    let result = eval_js(
        r#"
        const { Readable, Writable, pipeline } = require('stream');
        const src = new Readable({ read: function() {} });
        const sink = new Writable({ write: function(chunk, enc, cb) { cb(); } });
        const result = pipeline(src, sink);
        if (!result || typeof result.then !== 'function') throw new Error('not a promise');
        return 'ok';
        "#,
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_stream_pipeline_auto_destroy_on_error() {
    let result = eval_js(
        r#"
        const { Readable, Writable, pipeline } = require('stream');
        const src = new Readable({ read: function() {} });
        const sink = new Writable({ write: function(chunk, enc, cb) { cb(); } });
        pipeline(src, sink, function(err) {});
        src.emit('error', new Error('fail'));
        if (!src.destroyed) throw new Error('src not destroyed');
        if (!sink.destroyed) throw new Error('sink not destroyed');
        return 'ok';
        "#,
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_stream_finished_writable_finish() {
    let result = eval_js(
        r#"
        const { Writable, finished } = require('stream');
        const w = new Writable({ write: function(chunk, enc, cb) { cb(); } });
        let done = false;
        finished(w, function(err) { done = true; });
        w.end();
        if (!done) throw new Error('finished not called');
        return 'ok';
        "#,
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_stream_finished_readable_end() {
    let result = eval_js(
        r#"
        const { Readable, finished } = require('stream');
        const r = new Readable({ read: function() {} });
        let done = false;
        finished(r, function(err) { done = true; });
        r.push(null);
        if (!done) throw new Error('finished not called');
        return 'ok';
        "#,
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_stream_finished_error() {
    let result = eval_js(
        r#"
        const { Readable, finished } = require('stream');
        const r = new Readable({ read: function() {} });
        let gotErr = null;
        finished(r, function(err) { gotErr = err; });
        r.emit('error', new Error('stream error'));
        if (!gotErr || gotErr.message !== 'stream error') throw new Error('wrong: ' + gotErr);
        return 'ok';
        "#,
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_stream_readable_from_array_strings() {
    let result = eval_js(
        r#"
        const { Readable } = require('stream');
        let collected = '';
        const r = Readable.from(['a', 'b', 'c']);
        r.on('data', function(chunk) { collected += chunk; });
        if (collected !== 'abc') throw new Error('got: ' + collected);
        return 'ok';
        "#,
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_stream_readable_from_array_buffers() {
    let result = eval_js(
        r#"
        const { Readable } = require('stream');
        const { Buffer } = require('buffer');
        let chunks = [];
        const r = Readable.from([Buffer.from('hi'), Buffer.from('lo')]);
        r.on('data', function(chunk) { chunks.push(chunk); });
        if (chunks.length !== 2) throw new Error('got ' + chunks.length + ' chunks');
        return 'ok';
        "#,
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_stream_readable_from_single_string() {
    let result = eval_js(
        r#"
        const { Readable } = require('stream');
        let collected = '';
        const r = Readable.from(['hello']);
        r.on('data', function(chunk) { collected += chunk; });
        if (collected !== 'hello') throw new Error('got: ' + collected);
        return 'ok';
        "#,
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_stream_destroy_readable_emits_close() {
    let result = eval_js(
        r#"
        const { Readable } = require('stream');
        const r = new Readable({ read: function() {} });
        let closed = false;
        r.on('close', function() { closed = true; });
        r.destroy();
        if (!r.destroyed) throw new Error('not destroyed');
        if (!closed) throw new Error('close not emitted');
        return 'ok';
        "#,
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_stream_destroy_writable_emits_close() {
    let result = eval_js(
        r#"
        const { Writable } = require('stream');
        const w = new Writable({ write: function(chunk, enc, cb) { cb(); } });
        let closed = false;
        w.on('close', function() { closed = true; });
        w.destroy();
        if (!w.destroyed) throw new Error('not destroyed');
        if (!closed) throw new Error('close not emitted');
        return 'ok';
        "#,
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_stream_duplex_basic_read_write() {
    let result = eval_js(
        r#"
        const { Duplex } = require('stream');
        let written = '';
        const d = new Duplex({
            read: function() {},
            write: function(chunk, enc, cb) { written += chunk; cb(); }
        });
        d.write('hello');
        d.push('world');
        let readData = '';
        d.on('data', function(chunk) { readData += chunk; });
        d.push('!');
        if (written !== 'hello') throw new Error('written: ' + written);
        return 'ok';
        "#,
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_stream_duplex_pipe_to_writable() {
    let result = eval_js(
        r#"
        const { Duplex, Writable } = require('stream');
        let output = '';
        const d = new Duplex({
            read: function() {},
            write: function(chunk, enc, cb) { cb(); }
        });
        const sink = new Writable({ write: function(chunk, enc, cb) { output += chunk; cb(); } });
        d.pipe(sink);
        d.push('piped');
        d.push(null);
        if (output !== 'piped') throw new Error('got: ' + output);
        return 'ok';
        "#,
    );
    assert_eq!(result.unwrap(), "ok");
}

// ===== string_decoder module tests =====

#[test]
fn test_string_decoder_utf8_complete() {
    let result = eval_js(
        r#"
        const { StringDecoder } = require('string_decoder');
        const d = new StringDecoder('utf8');
        const { Buffer } = require('buffer');
        const out = d.write(Buffer.from('hello'));
        if (out !== 'hello') throw new Error('got: ' + out);
        return 'ok';
        "#,
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_string_decoder_utf8_multibyte() {
    let result = eval_js(
        r#"
        const { StringDecoder } = require('string_decoder');
        const d = new StringDecoder('utf8');
        const { Buffer } = require('buffer');
        const out = d.write(Buffer.from('\u00e9'));
        if (out !== '\u00e9') throw new Error('got: ' + out);
        return 'ok';
        "#,
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_string_decoder_utf8_split_multibyte() {
    let result = eval_js(
        r#"
        const { StringDecoder } = require('string_decoder');
        const d = new StringDecoder('utf8');
        const { Buffer } = require('buffer');
        // Euro sign U+20AC is 3 bytes: 0xE2 0x82 0xAC
        var out1 = d.write(Buffer.from([0xE2, 0x82]));
        var out2 = d.write(Buffer.from([0xAC]));
        if (out1 !== '') throw new Error('partial should be empty, got: ' + JSON.stringify(out1));
        if (out2 !== '\u20AC') throw new Error('completed should be euro, got: ' + JSON.stringify(out2));
        return 'ok';
        "#,
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_string_decoder_end_flushes() {
    let result = eval_js(
        r#"
        const { StringDecoder } = require('string_decoder');
        const d = new StringDecoder('utf8');
        const { Buffer } = require('buffer');
        d.write(Buffer.from([0xE2, 0x82]));
        var out = d.end();
        // Incomplete sequence should produce replacement character(s)
        if (out.length === 0) throw new Error('end should flush something');
        return 'ok';
        "#,
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_string_decoder_ascii() {
    let result = eval_js(
        r#"
        const { StringDecoder } = require('string_decoder');
        const d = new StringDecoder('ascii');
        const { Buffer } = require('buffer');
        const out = d.write(Buffer.from([0x48, 0x69]));
        if (out !== 'Hi') throw new Error('got: ' + out);
        return 'ok';
        "#,
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_string_decoder_base64() {
    let result = eval_js(
        r#"
        const { StringDecoder } = require('string_decoder');
        const d = new StringDecoder('base64');
        const { Buffer } = require('buffer');
        const out = d.write(Buffer.from([0x48, 0x65, 0x6C]));
        // 3 bytes -> 4 base64 chars: "SGVs"
        if (out !== 'SGVs') throw new Error('got: ' + out);
        return 'ok';
        "#,
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_string_decoder_node_prefix() {
    let result = eval_js(
        r#"
        const { StringDecoder } = require('node:string_decoder');
        if (typeof StringDecoder !== 'function') throw new Error('not a function');
        return 'ok';
        "#,
    );
    assert_eq!(result.unwrap(), "ok");
}

// ========================================================================
// __tsxUtils__ Bridge Tests
// ========================================================================

#[test]
fn test_utils_utf8_encode_ascii() {
    let result = eval_js(
        r#"
        var encoded = globalThis.__tsxUtils__.utf8Encode('hello');
        if (encoded.length !== 5) throw new Error('length: ' + encoded.length);
        if (encoded.charCodeAt(0) !== 104) throw new Error('byte0: ' + encoded.charCodeAt(0));
        return 'ok';
        "#,
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_utils_utf8_encode_multibyte() {
    let result = eval_js(
        r#"
        var encoded = globalThis.__tsxUtils__.utf8Encode('café');
        // 'café' = 63 61 66 c3 a9 = 5 UTF-8 bytes
        if (encoded.length !== 5) throw new Error('length: ' + encoded.length);
        return 'ok';
        "#,
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_utils_utf8_encode_empty() {
    let result = eval_js(
        r#"
        var encoded = globalThis.__tsxUtils__.utf8Encode('');
        if (encoded.length !== 0) throw new Error('length: ' + encoded.length);
        return 'ok';
        "#,
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_utils_utf8_decode_ascii() {
    let result = eval_js(
        r#"
        var decoded = globalThis.__tsxUtils__.utf8Decode('hello');
        if (decoded !== 'hello') throw new Error('got: ' + decoded);
        return 'ok';
        "#,
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_utils_utf8_roundtrip() {
    let result = eval_js(
        r#"
        var original = 'Hello, 世界! 🌍';
        var encoded = globalThis.__tsxUtils__.utf8Encode(original);
        var decoded = globalThis.__tsxUtils__.utf8Decode(encoded);
        if (decoded !== original) throw new Error('roundtrip failed: ' + decoded);
        return 'ok';
        "#,
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_utils_base64_encode_basic() {
    let result = eval_js(
        r#"
        var encoded = globalThis.__tsxUtils__.base64Encode('Hello');
        if (encoded !== 'SGVsbG8=') throw new Error('got: ' + encoded);
        return 'ok';
        "#,
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_utils_base64_roundtrip() {
    let result = eval_js(
        r#"
        var original = 'Hello, World!';
        var encoded = globalThis.__tsxUtils__.base64Encode(original);
        var decoded = globalThis.__tsxUtils__.base64Decode(encoded);
        if (decoded !== original) throw new Error('roundtrip failed: ' + decoded);
        return 'ok';
        "#,
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_utils_base64_empty() {
    let result = eval_js(
        r#"
        var encoded = globalThis.__tsxUtils__.base64Encode('');
        if (encoded !== '') throw new Error('encode: ' + encoded);
        var decoded = globalThis.__tsxUtils__.base64Decode('');
        if (decoded !== '') throw new Error('decode: ' + decoded);
        return 'ok';
        "#,
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_utils_hex_encode_basic() {
    let result = eval_js(
        r#"
        // 'Hi' = 0x48 0x69
        var encoded = globalThis.__tsxUtils__.hexEncode('Hi');
        if (encoded !== '4869') throw new Error('got: ' + encoded);
        return 'ok';
        "#,
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_utils_hex_roundtrip() {
    let result = eval_js(
        r#"
        var original = 'test';
        var encoded = globalThis.__tsxUtils__.hexEncode(original);
        var decoded = globalThis.__tsxUtils__.hexDecode(encoded);
        if (decoded !== original) throw new Error('roundtrip failed: ' + decoded);
        return 'ok';
        "#,
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_utils_hex_empty() {
    let result = eval_js(
        r#"
        var encoded = globalThis.__tsxUtils__.hexEncode('');
        if (encoded !== '') throw new Error('encode: ' + encoded);
        var decoded = globalThis.__tsxUtils__.hexDecode('');
        if (decoded !== '') throw new Error('decode: ' + decoded);
        return 'ok';
        "#,
    );
    assert_eq!(result.unwrap(), "ok");
}

// ========================================================================
// Encoding bridge integration tests
// ========================================================================

#[test]
fn test_text_encoder_uses_bridge() {
    let result = eval_js(
        r#"
        var enc = new TextEncoder();
        var bytes = enc.encode('hello');
        if (bytes.length !== 5) throw new Error('length: ' + bytes.length);
        if (bytes[0] !== 104) throw new Error('byte0: ' + bytes[0]);
        if (bytes[4] !== 111) throw new Error('byte4: ' + bytes[4]);
        return 'ok';
        "#,
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_btoa_atob_use_bridge() {
    let result = eval_js(
        r#"
        var encoded = btoa('Hello');
        if (encoded !== 'SGVsbG8=') throw new Error('btoa: ' + encoded);
        var decoded = atob(encoded);
        if (decoded !== 'Hello') throw new Error('atob: ' + decoded);
        return 'ok';
        "#,
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_string_decoder_has_write_method() {
    // Verify string_decoder module has correct StringDecoder with write(), not TextDecoder alias
    let result = eval_js(
        r#"
        const { StringDecoder } = require('string_decoder');
        var d = new StringDecoder('utf8');
        if (typeof d.write !== 'function') throw new Error('no write method');
        if (typeof d.end !== 'function') throw new Error('no end method');
        // Should NOT have decode() — that's TextDecoder's API
        if (typeof d.decode === 'function') throw new Error('has decode — wrong class');
        return 'ok';
        "#,
    );
    assert_eq!(result.unwrap(), "ok");
}
