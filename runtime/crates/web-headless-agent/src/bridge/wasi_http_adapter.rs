//! WASI HTTP Adapter for rig-core
//!
//! Uses the shared macro from agent_bridge to generate the WasiHttpClient
//! implementation using this component's WIT bindings.

// Generate WasiHttpClient using our component's bindings
// We must pass the full path to the http and io modules separately to satisfy the macro
agent_bridge::define_wasi_http_client!(crate::bindings::wasi::http, crate::bindings::wasi::io);
