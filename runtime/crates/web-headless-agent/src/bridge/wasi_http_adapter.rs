//! WASI HTTP Adapter for rig-core
//!
//! Implements rig-core's `HttpClientExt` trait using WASI HTTP bindings.

use bytes::Bytes;
use futures::stream::Stream;
use http::{Request, Response};
use rig::http_client::{
    sse::BoxedStream, Error as RigError, HttpClientExt, LazyBody, MultipartForm,
    Result as RigResult, StreamingResponse,
};
use rig::wasm_compat::WasmCompatSend;
use std::future::Future;
use std::pin::Pin;
use std::task::{Context, Poll};

use crate::bindings::wasi::http::{
    outgoing_handler,
    types::{Fields, IncomingBody, Method, OutgoingBody, OutgoingRequest, RequestOptions, Scheme},
};
use crate::bindings::wasi::io::streams::{InputStream, StreamError};

/// WASI HTTP Client that implements rig-core's HttpClientExt trait
#[derive(Clone, Copy, Default, Debug)]
pub struct WasiHttpClient;

impl WasiHttpClient {
    pub fn new() -> Self {
        Self
    }

    fn parse_url(url: &str) -> RigResult<(Scheme, String, String)> {
        let (scheme_str, rest) = if url.starts_with("https://") {
            ("https", &url[8..])
        } else if url.starts_with("http://") {
            ("http", &url[7..])
        } else {
            return Err(instance_error("Invalid URL scheme"));
        };

        let scheme = if scheme_str == "https" {
            Scheme::Https
        } else {
            Scheme::Http
        };

        let (authority, path) = if let Some(slash_pos) = rest.find('/') {
            (rest[..slash_pos].to_string(), rest[slash_pos..].to_string())
        } else {
            (rest.to_string(), "/".to_string())
        };

        Ok((scheme, authority, path))
    }

    fn convert_method(method: &http::Method) -> Method {
        match method.as_str() {
            "GET" => Method::Get,
            "POST" => Method::Post,
            "PUT" => Method::Put,
            "DELETE" => Method::Delete,
            "HEAD" => Method::Head,
            "OPTIONS" => Method::Options,
            "PATCH" => Method::Patch,
            other => Method::Other(other.to_string()),
        }
    }

    fn execute_request<T: Into<Bytes>>(&self, req: Request<T>) -> RigResult<(u16, Bytes)> {
        let (parts, body) = req.into_parts();
        let body_bytes: Bytes = body.into();
        let url = parts.uri.to_string();

        let (scheme, authority, path) = Self::parse_url(&url)?;

        let fields = Fields::new();
        for (name, value) in parts.headers.iter() {
            let _ = fields.append(&name.to_string(), value.as_bytes());
        }

        let request = OutgoingRequest::new(fields);
        let _ = request.set_method(&Self::convert_method(&parts.method));
        let _ = request.set_scheme(Some(&scheme));
        let _ = request.set_authority(Some(&authority));
        let _ = request.set_path_with_query(Some(&path));

        if !body_bytes.is_empty() {
            let out_body = request
                .body()
                .map_err(|_| instance_error("Failed to get body"))?;
            let stream = out_body
                .write()
                .map_err(|_| instance_error("Failed to get body stream"))?;

            stream
                .blocking_write_and_flush(&body_bytes)
                .map_err(|e| instance_error(format!("Write failed: {:?}", e)))?;

            drop(stream);
            OutgoingBody::finish(out_body, None)
                .map_err(|e| instance_error(format!("Finish failed: {:?}", e)))?;
        }

        let options = RequestOptions::new();
        let future_response = outgoing_handler::handle(request, Some(options))
            .map_err(|e| instance_error(format!("Handle failed: {:?}", e)))?;

        let pollable = future_response.subscribe();
        pollable.block();

        let response_result = future_response
            .get()
            .ok_or_else(|| instance_error("No response"))?
            .map_err(|_| instance_error("Response error"))?
            .map_err(|e| instance_error(format!("HTTP error: {:?}", e)))?;

        let status = response_result.status();

        let body = response_result
            .consume()
            .map_err(|_| instance_error("Failed to consume body"))?;

        let stream = body
            .stream()
            .map_err(|_| instance_error("Failed to get stream"))?;

        let mut result = Vec::new();
        loop {
            match stream.blocking_read(64 * 1024) {
                Ok(chunk) => {
                    if chunk.is_empty() {
                        break;
                    }
                    result.extend_from_slice(&chunk);
                }
                Err(StreamError::Closed) => break,
                Err(e) => {
                    return Err(instance_error(format!("Read error: {:?}", e)));
                }
            }
        }

        Ok((status, Bytes::from(result)))
    }

    fn execute_streaming_request<T: Into<Bytes>>(
        &self,
        req: Request<T>,
    ) -> RigResult<(u16, http::HeaderMap, WasiBodyStream)> {
        let (parts, body) = req.into_parts();
        let body_bytes: Bytes = body.into();
        let url = parts.uri.to_string();

        let (scheme, authority, path) = Self::parse_url(&url)?;

        let fields = Fields::new();
        for (name, value) in parts.headers.iter() {
            let _ = fields.append(&name.to_string(), value.as_bytes());
        }

        let request = OutgoingRequest::new(fields);
        let _ = request.set_method(&Self::convert_method(&parts.method));
        let _ = request.set_scheme(Some(&scheme));
        let _ = request.set_authority(Some(&authority));
        let _ = request.set_path_with_query(Some(&path));

        if !body_bytes.is_empty() {
            let out_body = request
                .body()
                .map_err(|_| instance_error("Failed to get body"))?;
            let stream = out_body
                .write()
                .map_err(|_| instance_error("Failed to get body stream"))?;

            stream
                .blocking_write_and_flush(&body_bytes)
                .map_err(|e| instance_error(format!("Write failed: {:?}", e)))?;

            drop(stream);
            OutgoingBody::finish(out_body, None)
                .map_err(|e| instance_error(format!("Finish failed: {:?}", e)))?;
        }

        let options = RequestOptions::new();
        let future_response = outgoing_handler::handle(request, Some(options))
            .map_err(|e| instance_error(format!("Handle failed: {:?}", e)))?;

        let pollable = future_response.subscribe();
        pollable.block();

        let response_result = future_response
            .get()
            .ok_or_else(|| instance_error("No response"))?
            .map_err(|_| instance_error("Response error"))?
            .map_err(|e| instance_error(format!("HTTP error: {:?}", e)))?;

        let status = response_result.status();

        let wasi_headers = response_result.headers();
        let mut headers = http::HeaderMap::new();
        for (name, value) in wasi_headers.entries() {
            if let Ok(header_name) = http::header::HeaderName::try_from(name.as_str()) {
                if let Ok(header_value) = http::header::HeaderValue::from_bytes(&value) {
                    headers.insert(header_name, header_value);
                }
            }
        }

        let incoming_body = response_result
            .consume()
            .map_err(|_| instance_error("Failed to consume body"))?;

        let stream = incoming_body
            .stream()
            .map_err(|_| instance_error("Failed to get stream"))?;

        Ok((
            status,
            headers,
            WasiBodyStream {
                stream,
                _body: incoming_body,
            },
        ))
    }
}

fn instance_error<E: std::fmt::Display>(msg: E) -> RigError {
    RigError::Instance(Box::new(SimpleError(msg.to_string())))
}

#[derive(Debug)]
struct SimpleError(String);

impl std::fmt::Display for SimpleError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl std::error::Error for SimpleError {}

pub struct WasiBodyStream {
    stream: InputStream,
    _body: IncomingBody,
}

unsafe impl Send for WasiBodyStream {}

impl Stream for WasiBodyStream {
    type Item = RigResult<Bytes>;

    fn poll_next(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        match self.stream.blocking_read(8192) {
            Ok(chunk) => {
                if chunk.is_empty() {
                    Poll::Ready(None)
                } else {
                    Poll::Ready(Some(Ok(Bytes::from(chunk))))
                }
            }
            Err(StreamError::Closed) => Poll::Ready(None),
            Err(e) => Poll::Ready(Some(Err(instance_error(format!("Read error: {:?}", e))))),
        }
    }
}

impl HttpClientExt for WasiHttpClient {
    fn send<T, U>(
        &self,
        req: Request<T>,
    ) -> impl Future<Output = RigResult<Response<LazyBody<U>>>> + WasmCompatSend + 'static
    where
        T: Into<Bytes> + WasmCompatSend,
        U: From<Bytes> + WasmCompatSend + 'static,
    {
        let result = self.execute_request(req);

        async move {
            let (status, body_bytes) = result?;

            let status_code = http::StatusCode::from_u16(status)
                .map_err(|e| instance_error(format!("Invalid status: {}", e)))?;

            if !status_code.is_success() {
                let body_text = String::from_utf8_lossy(&body_bytes).to_string();
                return Err(RigError::InvalidStatusCodeWithMessage(
                    status_code,
                    body_text,
                ));
            }

            let lazy_body: LazyBody<U> = Box::pin(async move { Ok(U::from(body_bytes)) });

            Response::builder()
                .status(status_code)
                .body(lazy_body)
                .map_err(RigError::Protocol)
        }
    }

    fn send_multipart<U>(
        &self,
        req: Request<MultipartForm>,
    ) -> impl Future<Output = RigResult<Response<LazyBody<U>>>> + WasmCompatSend + 'static
    where
        U: From<Bytes> + WasmCompatSend + 'static,
    {
        let (parts, _multipart) = req.into_parts();
        let new_req = Request::from_parts(parts, Bytes::new());
        let result = self.execute_request(new_req);

        async move {
            let (status, body_bytes) = result?;

            let status_code = http::StatusCode::from_u16(status)
                .map_err(|e| instance_error(format!("Invalid status: {}", e)))?;

            if !status_code.is_success() {
                let body_text = String::from_utf8_lossy(&body_bytes).to_string();
                return Err(RigError::InvalidStatusCodeWithMessage(
                    status_code,
                    body_text,
                ));
            }

            let lazy_body: LazyBody<U> = Box::pin(async move { Ok(U::from(body_bytes)) });

            Response::builder()
                .status(status_code)
                .body(lazy_body)
                .map_err(RigError::Protocol)
        }
    }

    fn send_streaming<T>(
        &self,
        req: Request<T>,
    ) -> impl Future<Output = RigResult<StreamingResponse>> + WasmCompatSend
    where
        T: Into<Bytes>,
    {
        let result = self.execute_streaming_request(req);

        async move {
            let (status, headers, wasi_stream) = result?;

            let status_code = http::StatusCode::from_u16(status)
                .map_err(|e| instance_error(format!("Invalid status: {}", e)))?;

            if !status_code.is_success() {
                return Err(RigError::InvalidStatusCode(status_code));
            }

            let boxed_stream: BoxedStream = Box::pin(wasi_stream);

            let mut response = Response::builder().status(status_code);

            if let Some(hs) = response.headers_mut() {
                *hs = headers;
            }

            response.body(boxed_stream).map_err(RigError::Protocol)
        }
    }
}
