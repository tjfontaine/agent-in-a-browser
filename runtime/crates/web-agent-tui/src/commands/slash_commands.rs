//! Slash command definitions

/// Slash command handler result
pub enum CommandResult {
    /// Command executed successfully
    Ok,
    /// Show message to user
    Message(String),
    /// Switch mode
    SwitchMode(crate::ui::Mode),
    /// Quit application
    Quit,
    /// Unknown command
    Unknown(String),
}

/// Handle a slash command
pub fn handle_command(cmd: &str) -> CommandResult {
    let parts: Vec<&str> = cmd.trim().split_whitespace().collect();
    let command = parts.first().map(|s| *s).unwrap_or("");
    let _args = &parts[1..];

    match command {
        "/help" | "/h" => CommandResult::Message(
            "Commands:\n\
             /help, /h     - Show this help\n\
             /shell, /sh   - Enter shell mode\n\
             /agent        - Return to agent mode\n\
             /model        - Select AI model\n\
             /clear        - Clear message history\n\
             /quit, /q     - Exit application"
                .to_string(),
        ),
        "/shell" | "/sh" => CommandResult::SwitchMode(crate::ui::Mode::Shell),
        "/agent" => CommandResult::SwitchMode(crate::ui::Mode::Agent),
        "/plan" => CommandResult::SwitchMode(crate::ui::Mode::Plan),
        "/clear" => CommandResult::Ok, // Caller handles clearing
        "/quit" | "/q" => CommandResult::Quit,
        _ => CommandResult::Unknown(command.to_string()),
    }
}
