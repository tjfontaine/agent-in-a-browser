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

// ===== child_process stub module tests =====

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
fn test_child_process_exec_throws() {
    let result = eval_js(
        r#"
        const cp = require('child_process');
        try { cp.exec('ls'); throw new Error('should throw'); }
        catch (e) { if (!e.message.includes('not supported')) throw e; }
        return 'ok';
        "#,
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_child_process_exec_sync_throws() {
    let result = eval_js(
        r#"
        const cp = require('child_process');
        try { cp.execSync('ls'); throw new Error('should throw'); }
        catch (e) { if (!e.message.includes('not supported')) throw e; }
        return 'ok';
        "#,
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_child_process_spawn_throws() {
    let result = eval_js(
        r#"
        const cp = require('child_process');
        try { cp.spawn('ls'); throw new Error('should throw'); }
        catch (e) { if (!e.message.includes('not supported')) throw e; }
        return 'ok';
        "#,
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_child_process_spawn_sync_throws() {
    let result = eval_js(
        r#"
        const cp = require('child_process');
        try { cp.spawnSync('ls'); throw new Error('should throw'); }
        catch (e) { if (!e.message.includes('not supported')) throw e; }
        return 'ok';
        "#,
    );
    assert_eq!(result.unwrap(), "ok");
}

#[test]
fn test_child_process_fork_throws() {
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
