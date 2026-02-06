# TSX Engine Compatibility Matrix

This matrix tracks what `tsx-engine` supports today and where that support is proven by tests.

## Status Legend

- `SUPPORTED`: implemented and covered by automated tests.
- `PARTIAL`: implemented but intentionally limited vs Node.js/tsx behavior.
- `UNSUPPORTED`: not implemented yet.

## Module Resolution

| Capability | Status | Proof |
|---|---|---|
| Absolute HTTP(S) URL passthrough | SUPPORTED | `resolver::tests::test_url_passthrough` |
| Relative path resolution (`./`, `../`) | SUPPORTED | `resolver::tests::test_relative_import`, `resolver::tests::test_relative_import_preserves_query_string` |
| Root-relative URL handling on same origin | SUPPORTED | `resolver::tests::test_root_relative_non_esm_sh_resolves_same_origin` |
| Root-relative local absolute path preservation | SUPPORTED | `resolver::tests::test_root_relative_local_path_is_preserved` |
| Extension fallback (`.ts/.tsx/.js/.mjs/.cjs/.json`) | SUPPORTED | `resolver::tests::test_relative_extension_fallback_to_ts` |
| Directory `index.*` resolution | SUPPORTED | `resolver::tests::test_relative_directory_index_resolution` |
| Local `node_modules` package main export | SUPPORTED | `resolver::tests::test_node_modules_package_json_exports_main`, `integration_tests::test_integration_module_mode_resolves_node_modules_exports` |
| Local `node_modules` package subpath export | SUPPORTED | `resolver::tests::test_node_modules_package_json_exports_subpath` |
| Local `node_modules` wildcard export (`"./*"`) | SUPPORTED | `resolver::tests::test_node_modules_package_json_exports_wildcard_subpath`, `integration_tests::test_integration_module_mode_resolves_exports_wildcard_subpath` |
| Conditional exports (`import` / `require` / `default`) | SUPPORTED | `resolver::tests::test_node_modules_package_json_exports_conditions_import_and_require`, `integration_tests::test_integration_cjs_require_uses_require_condition_from_exports` |
| Nested conditional exports objects | SUPPORTED | `resolver::tests::test_node_modules_exports_nested_conditions_import_and_require` |
| Package imports alias (`"#x"`) | SUPPORTED | `resolver::tests::test_package_imports_hash_alias`, `integration_tests::test_integration_module_mode_resolves_package_imports_alias` |
| Package imports wildcard alias (`"#x/*"`) | SUPPORTED | `resolver::tests::test_package_imports_wildcard_alias`, `integration_tests::test_integration_module_mode_resolves_package_imports_wildcard_alias` |
| Bare specifier fallback to esm.sh | SUPPORTED | `resolver::tests::test_bare_specifier` |
| `file://` base resolution for relative imports | SUPPORTED | `resolver::tests::test_file_url_base_relative_import_resolves_to_local_path`, `integration_tests::test_integration_module_mode_supports_file_url_source_name` |
| `file://` base package resolution for `require()` | SUPPORTED | `resolver::tests::test_file_url_base_require_node_modules_package` |
| `file://` URL percent-decoding and Windows-drive style path parsing | SUPPORTED | `resolver::tests::test_file_url_percent_decoding_for_local_path`, `resolver::tests::test_file_url_windows_drive_format_is_preserved_as_local_path` |

## TypeScript Transpilation

| Capability | Status | Proof |
|---|---|---|
| Type stripping | SUPPORTED | `transpiler::tests::test_simple_transpile`, `transpiler::tests::test_arrow_function` |
| Async IIFE wrapping for script-style execution | SUPPORTED | `transpiler::tests::test_async_iife_wrapping` |
| Module declaration detection (`import`/`export`) | SUPPORTED | `transpiler::tests::test_transpile_marks_module_declarations` |
| Preserve module declarations without script wrapping | SUPPORTED | `transpiler::tests::test_transpile_preserves_import_export_without_iife` |
| Parse error context formatting | SUPPORTED | `transpiler::tests::test_parse_error_shows_context` |
| Runtime line/column remapping from generated JS to TS via sourcemap | SUPPORTED | `integration_tests::test_integration_runtime_error_reports_mapped_line`, `integration_tests::test_integration_runtime_error_uses_source_map_when_line_map_absent`, `integration_tests::test_integration_runtime_error_remaps_multiple_stack_frames` |
| Source map JSON artifact emission | SUPPORTED | `transpiler::tests::test_transpile_emits_source_map_json` |
| SWC resolver + fixer pass chain | SUPPORTED | covered by `transpiler::tests::*` and integration suite stability |

## Runtime Behavior

| Capability | Status | Proof |
|---|---|---|
| Script mode async execution + console capture | SUPPORTED | `integration_tests::test_integration_script_mode_runs_async_and_captures_console` |
| Module mode local TS dependency import | SUPPORTED | `integration_tests::test_integration_module_mode_imports_typescript_dependency` |
| `process.argv` propagation | SUPPORTED | `js_modules::tests::test_process_argv_default_shape`, `js_modules::tests::test_process_argv_extra_args`, `integration_tests::test_integration_module_mode_reads_process_argv` |
| `process.env` runtime injection | SUPPORTED | `js_modules::tests::test_process_env_from_runtime` |
| `process.cwd()` / `process.chdir()` runtime semantics | SUPPORTED | `js_modules::tests::test_process_chdir_updates_cwd` |
| Node-like JS shims (`Buffer`, `path`, `URL`, `Headers`, `Response`, fs sync/promises) | SUPPORTED | `js_modules::tests::*` suite |
| CommonJS `require` + `module.exports` + `exports` + `__filename` + `__dirname` | SUPPORTED | `integration_tests::test_integration_cjs_require_local_file_and_json`, `integration_tests::test_integration_cjs_require_uses_require_condition_from_exports` |
| CommonJS module cache behavior (`require()` single load) | SUPPORTED | `integration_tests::test_integration_cjs_require_caches_module_once` |
| CommonJS `require()` of ESM default/named exports | SUPPORTED | `integration_tests::test_integration_cjs_require_esm_default_export`, `integration_tests::test_integration_cjs_require_esm_named_export` |
| CommonJS `require()` of ESM with static import dependencies | SUPPORTED | `integration_tests::test_integration_cjs_require_esm_with_import_dependency` |
| ESM importing CommonJS (`default` and namespace via `default`) | SUPPORTED | `integration_tests::test_integration_module_mode_imports_commonjs_default`, `integration_tests::test_integration_module_mode_imports_commonjs_namespace` |
| ESM importing CommonJS with top-level `return` | SUPPORTED | `integration_tests::test_integration_module_mode_imports_commonjs_with_top_level_return` |
| `setTimeout` / `clearTimeout` / `setInterval` / `clearInterval` / `setImmediate` / `nextTick` | SUPPORTED | `integration_tests::test_integration_timers_and_immediate_callbacks` |
| Strict Node parity for full process/runtime API surface | PARTIAL | implemented compatibility subset only |

## HTTP/Fetch Plumbing

| Capability | Status | Proof |
|---|---|---|
| URL parsing with query-only paths | SUPPORTED | `http_client::tests::test_parse_url_with_query_and_no_explicit_path` |
| URL fragment stripping | SUPPORTED | `http_client::tests::test_parse_url_strips_fragment` |
| Header JSON parsing with commas/colons in values | SUPPORTED | `http_client::tests::test_parse_headers_json_preserves_complex_values` |
| Ignore non-scalar header values | SUPPORTED | `http_client::tests::test_parse_headers_json_ignores_non_scalar_values` |
| Request timeout support (`timeoutMs`) | SUPPORTED | `integration_tests::test_integration_fetch_timeout_zero_ms` |
| Abort preflight support (`AbortController` + `signal`) | SUPPORTED | `js_modules::tests::test_abort_controller_signal`, `integration_tests::test_integration_fetch_abort_preflight` |
| Mid-flight transport cancellation | PARTIAL | preflight abort supported; in-flight cancellation depends on host transport |

## Known Gaps for Future Work

1. Mid-flight fetch cancellation in all host transports.
2. Full Node parity for every ESM/CJS edge (live bindings, full re-export matrix, and all loader hooks) remains partial.
3. Optional richer stack parser for engine-specific formats beyond current location matcher heuristics.
