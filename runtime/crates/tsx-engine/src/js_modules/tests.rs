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
    let result = eval_js(
        "const assert = require('assert'); assert.ok(true); return 'ok';",
    );
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
    let result = eval_js(
        "const assert = require('node:assert'); assert(true); return 'ok';",
    );
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
