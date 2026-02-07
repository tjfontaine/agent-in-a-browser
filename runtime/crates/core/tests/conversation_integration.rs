//! Integration tests for conversation pipeline
//!
//! These tests verify that the unified conversation model works correctly
//! across both streaming and non-streaming execution.

use agent_bridge::{ConversationHistory, ConversationRole, ConversationTurn};

#[test]
fn test_conversation_preserves_tool_traces() {
    // Simulate a conversation with tool calls
    let mut history = ConversationHistory::new();

    // User asks a question
    history.append_turn(ConversationTurn::user("What's the weather in SF?"));

    // Assistant decides to call a tool
    history.record_tool_call("weather_api", "call-1", r#"{"city": "San Francisco"}"#);

    // Tool returns result
    history.record_tool_result("call-1", "Temperature: 65°F, Clear skies", false);

    // Assistant responds with the formatted answer
    history.append_turn(ConversationTurn::assistant(
        "The weather in San Francisco is currently 65°F with clear skies.",
    ));

    // Verify all turns are preserved
    assert_eq!(history.turns().len(), 4);

    // Verify tool call is present
    let tool_call = &history.turns()[1];
    assert_eq!(tool_call.role, ConversationRole::ToolCall);
    assert_eq!(tool_call.metadata.tool_name, Some("weather_api".to_string()));
    assert_eq!(
        tool_call.metadata.tool_call_id,
        Some("call-1".to_string())
    );

    // Verify tool result is present
    let tool_result = &history.turns()[2];
    assert_eq!(tool_result.role, ConversationRole::ToolResult);
    assert_eq!(tool_result.content, "Temperature: 65°F, Clear skies");

    // But when building provider messages, only user/assistant should be included
    let provider_messages = history.snapshot_for_provider();
    assert_eq!(provider_messages.len(), 2); // Only user and assistant messages
}

#[test]
fn test_user_assistant_only_in_provider_snapshot() {
    let mut history = ConversationHistory::new();

    history.append_turn(ConversationTurn::user("First question"));
    history.append_turn(ConversationTurn::assistant("First answer"));

    // Add some tool activity
    history.record_tool_call("tool", "call-1", "{}");
    history.record_tool_result("call-1", "result", false);

    history.append_turn(ConversationTurn::user("Second question"));
    history.append_turn(ConversationTurn::assistant("Second answer"));

    // Provider snapshot should only have user/assistant
    let provider_messages = history.snapshot_for_provider();
    assert_eq!(provider_messages.len(), 4);

    // But full history has all turns including tools
    assert_eq!(history.turns().len(), 6);
}

#[test]
fn test_latest_user_prompt_always_in_view() {
    let mut history = ConversationHistory::new();
    history.append_turn(ConversationTurn::user("Hello"));
    history.append_turn(ConversationTurn::assistant("Hi"));

    let view = agent_bridge::ConversationView::from_history(history);
    let messages = view.build_messages(Some("How are you?"));

    // Should have history (2) + active prompt (1)
    assert_eq!(messages.len(), 3);
}
