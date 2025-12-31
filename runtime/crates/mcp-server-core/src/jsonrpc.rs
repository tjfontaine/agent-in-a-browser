//! JSON-RPC 2.0 types for MCP protocol

use serde::{Deserialize, Serialize};

/// JSON-RPC 2.0 Request
#[derive(Debug, Deserialize)]
pub struct JsonRpcRequest {
    #[allow(dead_code)] // part of JSON-RPC protocol but validated by serde
    pub jsonrpc: String,
    pub id: Option<serde_json::Value>,
    pub method: String,
    #[serde(default)]
    pub params: serde_json::Value,
}

/// JSON-RPC 2.0 Response
#[derive(Debug, Serialize)]
pub struct JsonRpcResponse {
    pub jsonrpc: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<JsonRpcError>,
}

#[derive(Debug, Serialize)]
pub struct JsonRpcError {
    pub code: i32,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<serde_json::Value>,
}

impl JsonRpcResponse {
    pub fn success(id: Option<serde_json::Value>, result: serde_json::Value) -> Self {
        Self {
            jsonrpc: "2.0".to_string(),
            id,
            result: Some(result),
            error: None,
        }
    }

    pub fn error(id: Option<serde_json::Value>, code: i32, message: String) -> Self {
        Self {
            jsonrpc: "2.0".to_string(),
            id,
            result: None,
            error: Some(JsonRpcError {
                code,
                message,
                data: None,
            }),
        }
    }
}

/// JSON-RPC Notification (no id, no response expected)
#[derive(Debug, Serialize)]
pub struct JsonRpcNotification {
    pub jsonrpc: String,
    pub method: String,
    pub params: serde_json::Value,
}

impl JsonRpcNotification {
    /// Create a notifications/message notification
    pub fn log_message(message: super::LogMessage) -> Self {
        Self {
            jsonrpc: "2.0".to_string(),
            method: "notifications/message".to_string(),
            params: serde_json::to_value(message).unwrap_or_default(),
        }
    }

    /// Create a notifications/progress notification
    pub fn progress(
        progress_token: impl Into<String>,
        progress: f64,
        total: Option<f64>,
        message: Option<String>,
    ) -> Self {
        let mut params = serde_json::json!({
            "progressToken": progress_token.into(),
            "progress": progress
        });
        if let Some(t) = total {
            params["total"] = serde_json::json!(t);
        }
        if let Some(m) = message {
            params["message"] = serde_json::json!(m);
        }
        Self {
            jsonrpc: "2.0".to_string(),
            method: "notifications/progress".to_string(),
            params,
        }
    }

    /// Serialize to SSE event format
    pub fn to_sse_event(&self) -> String {
        let data = serde_json::to_string(self).unwrap_or_default();
        format!("event: message\ndata: {}\n\n", data)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_json_rpc_request_parsing() {
        let json = r#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"test"}}"#;
        let req: JsonRpcRequest = serde_json::from_str(json).unwrap();
        assert_eq!(req.method, "tools/call");
        assert_eq!(req.params["name"], "test");
    }

    #[test]
    fn test_json_rpc_response_success() {
        let resp = JsonRpcResponse::success(Some(json!(1)), json!({"result": "ok"}));
        let json = serde_json::to_string(&resp).unwrap();
        assert!(json.contains("\"jsonrpc\":\"2.0\""));
        assert!(json.contains("\"id\":1"));
        assert!(json.contains("\"result\""));
        assert!(!json.contains("\"error\""));
    }

    #[test]
    fn test_json_rpc_response_error() {
        let resp = JsonRpcResponse::error(Some(json!(1)), -32600, "Invalid Request".to_string());
        let json = serde_json::to_string(&resp).unwrap();
        assert!(json.contains("\"error\""));
        assert!(json.contains("-32600"));
        assert!(!json.contains("\"result\""));
    }
}
