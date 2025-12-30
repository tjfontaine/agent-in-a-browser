//! System prompt for the AI agent
//!
//! Prompts are stored as embedded markdown resources for maintainability.

/// Default system prompt for the agent (embedded from SYSTEM_PROMPT.md)
pub const SYSTEM_PROMPT: &str = include_str!("SYSTEM_PROMPT.md");

/// Plan mode system prompt addition (embedded from PLAN_MODE.md)
pub const PLAN_MODE_SYSTEM_PROMPT: &str = include_str!("PLAN_MODE.md");

/// Get the system prompt message
pub fn get_system_message() -> super::ai_client::Message {
    super::ai_client::Message::system(SYSTEM_PROMPT)
}

/// Get system message with plan mode addition if in plan mode
pub fn get_system_message_for_mode(is_plan_mode: bool) -> super::ai_client::Message {
    if is_plan_mode {
        let prompt = format!("{}\n{}", SYSTEM_PROMPT, PLAN_MODE_SYSTEM_PROMPT);
        super::ai_client::Message::system(&prompt)
    } else {
        get_system_message()
    }
}
