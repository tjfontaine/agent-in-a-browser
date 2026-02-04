// WASISignatures.swift
// WASI ABI signature definitions for WasmKit hosts
// Originally auto-generated from ts-runtime-mcp.core.wasm

import WasmKit

/// WASI module import signature definitions.
/// Use these to define imports with correct signatures.
///
/// Kept as `MCPSignatures` typealias for backwards compatibility.
public enum WASISignatures {
    
    public typealias Signature = (parameters: [ValueType], results: [ValueType])
        // MARK: - mcp:module-loader/loader@0.1.0
    public enum module_loader_loader_0_1_0 {
        /// `get-lazy-module`: (i32, i32, i32) -> ()
        public static let get_lazy_module: Signature = ([.i32, .i32, .i32], [])
        /// `is-interactive-command`: (i32, i32) -> (i32)
        public static let is_interactive_command: Signature = ([.i32, .i32], [.i32])
        /// `has-jspi`: () -> (i32)
        public static let has_jspi: Signature = ([], [.i32])
        /// `spawn-interactive`: (i32, i32, i32, i32, i32, i32, i32, i32, i32, i32, i32, i32) -> (i32)
        public static let spawn_interactive: Signature = ([.i32, .i32, .i32, .i32, .i32, .i32, .i32, .i32, .i32, .i32, .i32, .i32], [.i32])
        /// `spawn-worker-command`: (i32, i32, i32, i32, i32, i32, i32, i32) -> (i32)
        public static let spawn_worker_command: Signature = ([.i32, .i32, .i32, .i32, .i32, .i32, .i32, .i32], [.i32])
        /// `spawn-lazy-command`: (i32, i32, i32, i32, i32, i32, i32, i32, i32, i32) -> (i32)
        public static let spawn_lazy_command: Signature = ([.i32, .i32, .i32, .i32, .i32, .i32, .i32, .i32, .i32, .i32], [.i32])
        /// `[method]lazy-process.set-raw-mode`: (i32, i32) -> ()
        public static let methodlazy_process_set_raw_mode: Signature = ([.i32, .i32], [])
        /// `[method]lazy-process.write-stdin`: (i32, i32, i32) -> (i64)
        public static let methodlazy_process_write_stdin: Signature = ([.i32, .i32, .i32], [.i64])
        /// `[method]lazy-process.close-stdin`: (i32) -> ()
        public static let methodlazy_process_close_stdin: Signature = ([.i32], [])
        /// `[method]lazy-process.read-stderr`: (i32, i64, i32) -> ()
        public static let methodlazy_process_read_stderr: Signature = ([.i32, .i64, .i32], [])
        /// `[method]lazy-process.read-stdout`: (i32, i64, i32) -> ()
        public static let methodlazy_process_read_stdout: Signature = ([.i32, .i64, .i32], [])
        /// `[method]lazy-process.get-ready-pollable`: (i32) -> (i32)
        public static let methodlazy_process_get_ready_pollable: Signature = ([.i32], [.i32])
        /// `[method]lazy-process.is-ready`: (i32) -> (i32)
        public static let methodlazy_process_is_ready: Signature = ([.i32], [.i32])
        /// `[method]lazy-process.try-wait`: (i32, i32) -> ()
        public static let methodlazy_process_try_wait: Signature = ([.i32, .i32], [])
        /// `[resource-drop]lazy-process`: (i32) -> ()
        public static let resource_droplazy_process: Signature = ([.i32], [])
    }

    // MARK: - wasi:cli/stderr@0.2.4
    public enum cli_stderr_0_2_4 {
        /// `get-stderr`: () -> (i32)
        public static let get_stderr: Signature = ([], [.i32])
    }

    // MARK: - wasi:cli/terminal-output@0.2.9
    public enum cli_terminal_output_0_2_9 {
        /// `[resource-drop]terminal-output`: (i32) -> ()
        public static let resource_dropterminal_output: Signature = ([.i32], [])
    }

    // MARK: - wasi:cli/terminal-stdout@0.2.9
    public enum cli_terminal_stdout_0_2_9 {
        /// `get-terminal-stdout`: (i32) -> ()
        public static let get_terminal_stdout: Signature = ([.i32], [])
    }

    // MARK: - wasi:clocks/monotonic-clock@0.2.4
    public enum clocks_monotonic_clock_0_2_4 {
        /// `now`: () -> (i64)
        public static let now: Signature = ([], [.i64])
    }

    // MARK: - wasi:clocks/monotonic-clock@0.2.9
    public enum clocks_monotonic_clock_0_2_9 {
        /// `subscribe-duration`: (i64) -> (i32)
        public static let subscribe_duration: Signature = ([.i64], [.i32])
    }

    // MARK: - wasi:clocks/wall-clock@0.2.9
    public enum clocks_wall_clock_0_2_9 {
        /// `now`: (i32) -> ()
        public static let now: Signature = ([.i32], [])
    }

    // MARK: - wasi:http/outgoing-handler@0.2.9
    public enum http_outgoing_handler_0_2_9 {
        /// `handle`: (i32, i32, i32, i32) -> ()
        public static let handle: Signature = ([.i32, .i32, .i32, .i32], [])
    }

    // MARK: - wasi:http/types@0.2.9
    public enum http_types_0_2_9 {
        /// `[constructor]fields`: () -> (i32)
        public static let constructorfields: Signature = ([], [.i32])
        /// `[method]fields.append`: (i32, i32, i32, i32, i32, i32) -> ()
        public static let methodfields_append: Signature = ([.i32, .i32, .i32, .i32, .i32, .i32], [])
        /// `[constructor]outgoing-request`: (i32) -> (i32)
        public static let constructoroutgoing_request: Signature = ([.i32], [.i32])
        /// `[method]outgoing-request.set-method`: (i32, i32, i32, i32) -> (i32)
        public static let methodoutgoing_request_set_method: Signature = ([.i32, .i32, .i32, .i32], [.i32])
        /// `[method]outgoing-request.set-scheme`: (i32, i32, i32, i32, i32) -> (i32)
        public static let methodoutgoing_request_set_scheme: Signature = ([.i32, .i32, .i32, .i32, .i32], [.i32])
        /// `[method]outgoing-request.set-authority`: (i32, i32, i32, i32) -> (i32)
        public static let methodoutgoing_request_set_authority: Signature = ([.i32, .i32, .i32, .i32], [.i32])
        /// `[method]outgoing-request.set-path-with-query`: (i32, i32, i32, i32) -> (i32)
        public static let methodoutgoing_request_set_path_with_query: Signature = ([.i32, .i32, .i32, .i32], [.i32])
        /// `[method]outgoing-request.body`: (i32, i32) -> ()
        public static let methodoutgoing_request_body: Signature = ([.i32, .i32], [])
        /// `[method]future-incoming-response.get`: (i32, i32) -> ()
        public static let methodfuture_incoming_response_get: Signature = ([.i32, .i32], [])
        /// `[method]incoming-response.status`: (i32) -> (i32)
        public static let methodincoming_response_status: Signature = ([.i32], [.i32])
        /// `[method]incoming-response.consume`: (i32, i32) -> ()
        public static let methodincoming_response_consume: Signature = ([.i32, .i32], [])
        /// `[resource-drop]incoming-response`: (i32) -> ()
        public static let resource_dropincoming_response: Signature = ([.i32], [])
        /// `[resource-drop]future-incoming-response`: (i32) -> ()
        public static let resource_dropfuture_incoming_response: Signature = ([.i32], [])
        /// `[method]incoming-body.stream`: (i32, i32) -> ()
        public static let methodincoming_body_stream: Signature = ([.i32, .i32], [])
        /// `[method]outgoing-body.write`: (i32, i32) -> ()
        public static let methodoutgoing_body_write: Signature = ([.i32, .i32], [])
        /// `[static]outgoing-body.finish`: (i32, i32, i32, i32) -> ()
        public static let staticoutgoing_body_finish: Signature = ([.i32, .i32, .i32, .i32], [])
        /// `[method]fields.set`: (i32, i32, i32, i32, i32, i32) -> ()
        public static let methodfields_set: Signature = ([.i32, .i32, .i32, .i32, .i32, .i32], [])
        /// `[resource-drop]fields`: (i32) -> ()
        public static let resource_dropfields: Signature = ([.i32], [])
        /// `[resource-drop]incoming-body`: (i32) -> ()
        public static let resource_dropincoming_body: Signature = ([.i32], [])
        /// `[resource-drop]outgoing-body`: (i32) -> ()
        public static let resource_dropoutgoing_body: Signature = ([.i32], [])
        /// `[resource-drop]outgoing-request`: (i32) -> ()
        public static let resource_dropoutgoing_request: Signature = ([.i32], [])
        /// `[method]incoming-request.headers`: (i32) -> (i32)
        public static let methodincoming_request_headers: Signature = ([.i32], [.i32])
        /// `[method]incoming-request.path-with-query`: (i32, i32) -> ()
        public static let methodincoming_request_path_with_query: Signature = ([.i32, .i32], [])
        /// `[method]incoming-request.consume`: (i32, i32) -> ()
        public static let methodincoming_request_consume: Signature = ([.i32, .i32], [])
        /// `[static]incoming-body.finish`: (i32) -> (i32)
        public static let staticincoming_body_finish: Signature = ([.i32], [.i32])
        /// `[resource-drop]future-trailers`: (i32) -> ()
        public static let resource_dropfuture_trailers: Signature = ([.i32], [])
        /// `[method]fields.entries`: (i32, i32) -> ()
        public static let methodfields_entries: Signature = ([.i32, .i32], [])
        /// `[constructor]outgoing-response`: (i32) -> (i32)
        public static let constructoroutgoing_response: Signature = ([.i32], [.i32])
        /// `[method]outgoing-response.set-status-code`: (i32, i32) -> (i32)
        public static let methodoutgoing_response_set_status_code: Signature = ([.i32, .i32], [.i32])
        /// `[method]outgoing-response.body`: (i32, i32) -> ()
        public static let methodoutgoing_response_body: Signature = ([.i32, .i32], [])
        /// `[static]response-outparam.set`: (i32, i32, i32, i32, i64, i32, i32, i32, i32) -> ()
        public static let staticresponse_outparam_set: Signature = ([.i32, .i32, .i32, .i32, .i64, .i32, .i32, .i32, .i32], [])
        /// `[resource-drop]outgoing-response`: (i32) -> ()
        public static let resource_dropoutgoing_response: Signature = ([.i32], [])
        /// `[resource-drop]response-outparam`: (i32) -> ()
        public static let resource_dropresponse_outparam: Signature = ([.i32], [])
        /// `[resource-drop]incoming-request`: (i32) -> ()
        public static let resource_dropincoming_request: Signature = ([.i32], [])
        /// `[resource-drop]request-options`: (i32) -> ()
        public static let resource_droprequest_options: Signature = ([.i32], [])
    }

    // MARK: - wasi:io/error@0.2.4
    public enum io_error_0_2_4 {
        /// `[resource-drop]error`: (i32) -> ()
        public static let resource_droperror: Signature = ([.i32], [])
        /// `[method]error.to-debug-string`: (i32, i32) -> ()
        public static let methoderror_to_debug_string: Signature = ([.i32, .i32], [])
    }

    // MARK: - wasi:io/error@0.2.9
    public enum io_error_0_2_9 {
        /// `[resource-drop]error`: (i32) -> ()
        public static let resource_droperror: Signature = ([.i32], [])
    }

    // MARK: - wasi:io/poll@0.2.0
    public enum io_poll_0_2_0 {
        /// `[resource-drop]pollable`: (i32) -> ()
        public static let resource_droppollable: Signature = ([.i32], [])
    }

    // MARK: - wasi:io/poll@0.2.9
    public enum io_poll_0_2_9 {
        /// `[method]pollable.block`: (i32) -> ()
        public static let methodpollable_block: Signature = ([.i32], [])
        /// `[resource-drop]pollable`: (i32) -> ()
        public static let resource_droppollable: Signature = ([.i32], [])
    }

    // MARK: - wasi:io/streams@0.2.0
    public enum io_streams_0_2_0 {
        /// `[resource-drop]input-stream`: (i32) -> ()
        public static let resource_dropinput_stream: Signature = ([.i32], [])
        /// `[resource-drop]output-stream`: (i32) -> ()
        public static let resource_dropoutput_stream: Signature = ([.i32], [])
    }

    // MARK: - wasi:io/streams@0.2.4
    public enum io_streams_0_2_4 {
        /// `[resource-drop]output-stream`: (i32) -> ()
        public static let resource_dropoutput_stream: Signature = ([.i32], [])
        /// `[method]output-stream.blocking-write-and-flush`: (i32, i32, i32, i32) -> ()
        public static let methodoutput_stream_blocking_write_and_flush: Signature = ([.i32, .i32, .i32, .i32], [])
    }

    // MARK: - wasi:io/streams@0.2.9
    public enum io_streams_0_2_9 {
        /// `[method]output-stream.subscribe`: (i32) -> (i32)
        public static let methodoutput_stream_subscribe: Signature = ([.i32], [.i32])
        /// `[method]output-stream.write`: (i32, i32, i32, i32) -> ()
        public static let methodoutput_stream_write: Signature = ([.i32, .i32, .i32, .i32], [])
        /// `[method]input-stream.subscribe`: (i32) -> (i32)
        public static let methodinput_stream_subscribe: Signature = ([.i32], [.i32])
        /// `[method]input-stream.read`: (i32, i64, i32) -> ()
        public static let methodinput_stream_read: Signature = ([.i32, .i64, .i32], [])
        /// `[method]input-stream.blocking-read`: (i32, i64, i32) -> ()
        public static let methodinput_stream_blocking_read: Signature = ([.i32, .i64, .i32], [])
        /// `[method]output-stream.blocking-write-and-flush`: (i32, i32, i32, i32) -> ()
        public static let methodoutput_stream_blocking_write_and_flush: Signature = ([.i32, .i32, .i32, .i32], [])
        /// `[resource-drop]input-stream`: (i32) -> ()
        public static let resource_dropinput_stream: Signature = ([.i32], [])
        /// `[resource-drop]output-stream`: (i32) -> ()
        public static let resource_dropoutput_stream: Signature = ([.i32], [])
    }

    // MARK: - wasi:random/insecure-seed@0.2.4
    public enum random_insecure_seed_0_2_4 {
        /// `insecure-seed`: (i32) -> ()
        public static let insecure_seed: Signature = ([.i32], [])
    }

    // MARK: - wasi:random/random@0.2.9
    public enum random_random_0_2_9 {
        /// `get-random-u64`: () -> (i64)
        public static let get_random_u64: Signature = ([], [.i64])
        /// `get-random-bytes`: (i64, i32) -> ()
        public static let get_random_bytes: Signature = ([.i64, .i32], [])
    }

    // MARK: - wasi:sockets/tcp@0.2.0
    public enum sockets_tcp_0_2_0 {
        /// `[resource-drop]tcp-socket`: (i32) -> ()
        public static let resource_droptcp_socket: Signature = ([.i32], [])
    }

    // MARK: - wasi:sockets/udp@0.2.0
    public enum sockets_udp_0_2_0 {
        /// `[resource-drop]udp-socket`: (i32) -> ()
        public static let resource_dropudp_socket: Signature = ([.i32], [])
        /// `[resource-drop]incoming-datagram-stream`: (i32) -> ()
        public static let resource_dropincoming_datagram_stream: Signature = ([.i32], [])
        /// `[resource-drop]outgoing-datagram-stream`: (i32) -> ()
        public static let resource_dropoutgoing_datagram_stream: Signature = ([.i32], [])
    }

    // MARK: - wasi_snapshot_preview1
    public enum wasi_snapshot_preview1 {
        /// `path_rename`: (i32, i32, i32, i32, i32, i32) -> (i32)
        public static let path_rename: Signature = ([.i32, .i32, .i32, .i32, .i32, .i32], [.i32])
        /// `fd_seek`: (i32, i64, i32, i32) -> (i32)
        public static let fd_seek: Signature = ([.i32, .i64, .i32, .i32], [.i32])
        /// `fd_filestat_set_size`: (i32, i64) -> (i32)
        public static let fd_filestat_set_size: Signature = ([.i32, .i64], [.i32])
        /// `path_create_directory`: (i32, i32, i32) -> (i32)
        public static let path_create_directory: Signature = ([.i32, .i32, .i32], [.i32])
        /// `fd_readdir`: (i32, i32, i32, i64, i32) -> (i32)
        public static let fd_readdir: Signature = ([.i32, .i32, .i32, .i64, .i32], [.i32])
        /// `path_link`: (i32, i32, i32, i32, i32, i32, i32) -> (i32)
        public static let path_link: Signature = ([.i32, .i32, .i32, .i32, .i32, .i32, .i32], [.i32])
        /// `path_readlink`: (i32, i32, i32, i32, i32, i32) -> (i32)
        public static let path_readlink: Signature = ([.i32, .i32, .i32, .i32, .i32, .i32], [.i32])
        /// `fd_filestat_get`: (i32, i32) -> (i32)
        public static let fd_filestat_get: Signature = ([.i32, .i32], [.i32])
        /// `path_unlink_file`: (i32, i32, i32) -> (i32)
        public static let path_unlink_file: Signature = ([.i32, .i32, .i32], [.i32])
        /// `path_filestat_get`: (i32, i32, i32, i32, i32) -> (i32)
        public static let path_filestat_get: Signature = ([.i32, .i32, .i32, .i32, .i32], [.i32])
        /// `path_remove_directory`: (i32, i32, i32) -> (i32)
        public static let path_remove_directory: Signature = ([.i32, .i32, .i32], [.i32])
        /// `fd_read`: (i32, i32, i32, i32) -> (i32)
        public static let fd_read: Signature = ([.i32, .i32, .i32, .i32], [.i32])
        /// `fd_tell`: (i32, i32) -> (i32)
        public static let fd_tell: Signature = ([.i32, .i32], [.i32])
        /// `fd_write`: (i32, i32, i32, i32) -> (i32)
        public static let fd_write: Signature = ([.i32, .i32, .i32, .i32], [.i32])
        /// `path_open`: (i32, i32, i32, i32, i32, i64, i64, i32, i32) -> (i32)
        public static let path_open: Signature = ([.i32, .i32, .i32, .i32, .i32, .i64, .i64, .i32, .i32], [.i32])
        /// `environ_get`: (i32, i32) -> (i32)
        public static let environ_get: Signature = ([.i32, .i32], [.i32])
        /// `environ_sizes_get`: (i32, i32) -> (i32)
        public static let environ_sizes_get: Signature = ([.i32, .i32], [.i32])
        /// `fd_close`: (i32) -> (i32)
        public static let fd_close: Signature = ([.i32], [.i32])
        /// `fd_prestat_get`: (i32, i32) -> (i32)
        public static let fd_prestat_get: Signature = ([.i32, .i32], [.i32])
        /// `fd_prestat_dir_name`: (i32, i32, i32) -> (i32)
        public static let fd_prestat_dir_name: Signature = ([.i32, .i32, .i32], [.i32])
        /// `proc_exit`: (i32) -> ()
        public static let proc_exit: Signature = ([.i32], [])
        /// `adapter_close_badfd`: (i32) -> (i32)
        public static let adapter_close_badfd: Signature = ([.i32], [.i32])
    }

}

// Backwards compatibility typealias
public typealias MCPSignatures = WASISignatures
