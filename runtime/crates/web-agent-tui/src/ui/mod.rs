//! UI rendering components
//!
//! Uses ratatui widgets for the TUI interface.

mod agent_mode;
pub mod app_widget;
pub mod input_box;
pub mod messages;
mod overlays;
pub mod panels;
pub mod server_manager;
mod shell_mode;
pub mod status_bar;
pub mod theme;

use ratatui::prelude::*;

pub use crate::app::AppState;
pub use crate::servers::{RemoteServerEntry, ServerConnectionStatus};
pub use crate::Message;
pub use input_box::InputBoxWidget;
pub use messages::MessagesWidget;
pub use panels::{
    render_aux_panel, AuxContent, AuxContentKind, AuxPanelWidget, RemoteServer, ServerStatus,
};
pub use server_manager::{render_overlay, Overlay, ProviderWizardStep, ServerManagerView};
pub use status_bar::StatusBarWidget;
pub use theme::Theme;

/// Application mode
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Mode {
    Agent,
    Shell,
    Plan,
}

/// UI state for scrollable widgets
#[derive(Default)]
pub struct UiState {
    /// Scroll offset for messages list
    pub messages_scroll: usize,
    /// Cursor position in input
    pub cursor_pos: usize,
}

/// Main render function with split layout
pub fn render_ui(
    frame: &mut Frame,
    mode: Mode,
    state: AppState,
    input: &str,
    cursor_pos: usize,
    messages: &[Message],
    timeline: &[crate::display::TimelineEntry],
    aux_content: &AuxContent,
    server_status: &ServerStatus,
    model_name: &str,
    overlay: Option<&Overlay>,
    remote_servers: &[RemoteServerEntry],
    theme: &Theme,
) {
    let area = frame.area();

    // Check if we have enough width for split layout (min 80 cols)
    let use_split = area.width >= 80;

    // Split into main area and status bar
    let v_chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Min(3),    // Main content
            Constraint::Length(1), // Status bar
        ])
        .split(area);

    if use_split {
        // Horizontal split: main (70%) | aux (30%)
        let h_chunks = Layout::default()
            .direction(Direction::Horizontal)
            .constraints([Constraint::Percentage(70), Constraint::Percentage(30)])
            .split(v_chunks[0]);

        render_main_panel(
            frame,
            h_chunks[0],
            mode,
            state,
            input,
            cursor_pos,
            messages,
            timeline,
            theme,
        );
        render_aux_panel(frame, h_chunks[1], aux_content, server_status);
    } else {
        // Single column layout for narrow terminals
        render_main_panel(
            frame,
            v_chunks[0],
            mode,
            state,
            input,
            cursor_pos,
            messages,
            timeline,
            theme,
        );
    }

    // Status bar
    frame.render_widget(
        StatusBarWidget::new(mode, state, server_status, model_name),
        v_chunks[1],
    );

    // Render overlay on top if present
    if let Some(overlay) = overlay {
        render_overlay(
            frame,
            area,
            overlay,
            server_status.local_tool_count,
            remote_servers,
        );
    }
}

/// Render the main panel (messages + input)
fn render_main_panel(
    frame: &mut Frame,
    area: Rect,
    mode: Mode,
    state: AppState,
    input: &str,
    cursor_pos: usize,
    messages: &[Message],
    timeline: &[crate::display::TimelineEntry],
    theme: &Theme,
) {
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Min(3),    // Messages/output
            Constraint::Length(3), // Input box
        ])
        .split(area);

    // Messages
    frame.render_widget(
        MessagesWidget::new(messages, timeline, state, theme),
        chunks[0],
    );

    // Input Box
    let mut cursor_state = None;
    frame.render_stateful_widget(
        InputBoxWidget::new(mode, state, input, cursor_pos),
        chunks[1],
        &mut cursor_state,
    );

    // Set cursor position if returned by widget
    if let Some(pos) = cursor_state {
        frame.set_cursor_position(pos);
    }
}

/// Simplified render function that takes &App directly
///
/// This is the preferred API for rendering the application UI.
pub fn render_app<R: crate::PollableRead, W: std::io::Write>(
    frame: &mut Frame,
    app: &crate::app::App<R, W>,
) {
    let theme = Theme::by_name(&app.agent.config().ui.theme);
    render_ui(
        frame,
        app.mode,
        app.state,
        app.input.text(),
        app.input.cursor_pos(),
        &app.agent.messages(),
        &app.timeline,
        &app.aux_content,
        &app.server_status,
        app.agent.model(),
        app.overlay.as_ref(),
        app.agent.remote_servers(),
        &theme,
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::display::TimelineEntry;
    use insta::assert_snapshot;
    use ratatui::{backend::TestBackend, Terminal};

    fn render_to_string(
        mode: Mode,
        state: AppState,
        input: &str,
        cursor_pos: usize,
        timeline: &[TimelineEntry],
        width: u16,
        height: u16,
    ) -> String {
        let backend = TestBackend::new(width, height);
        let mut terminal = Terminal::new(backend).unwrap();
        let theme = Theme::dark(); // Default theme for tests

        terminal
            .draw(|frame| {
                render_ui(
                    frame,
                    mode,
                    state,
                    input,
                    cursor_pos,
                    &[], // No messages for simple tests
                    timeline,
                    &AuxContent::default(),
                    &ServerStatus {
                        local_connected: true,
                        local_tool_count: 5,
                        remote_servers: vec![],
                    },
                    "claude-sonnet-4",
                    None,
                    &[],
                    &theme,
                );
            })
            .unwrap();

        terminal.backend().to_string()
    }

    #[test]
    fn ui_welcome_screen() {
        let output = render_to_string(
            Mode::Agent,
            AppState::Ready,
            "",
            0,
            &[TimelineEntry::info(
                "Welcome to Agent in a Browser! Type /help for commands.",
            )],
            80,
            24,
        );
        assert_snapshot!(output);
    }

    #[test]
    fn ui_shell_mode() {
        let output = render_to_string(
            Mode::Shell,
            AppState::Ready,
            "ls -la",
            6,
            &[
                TimelineEntry::info("Entered shell mode. Type 'exit' to return."),
                TimelineEntry::user_message("pwd"),
                TimelineEntry::assistant_message("/home/user"),
            ],
            80,
            24,
        );
        assert_snapshot!(output);
    }

    #[test]
    fn ui_streaming_state() {
        let output = render_to_string(
            Mode::Agent,
            AppState::Streaming,
            "",
            0,
            &[
                TimelineEntry::user_message("Tell me about Rust"),
                TimelineEntry::Display(crate::display::DisplayItem::ToolActivity {
                    tool_name: "thinking".to_string(),
                    status: crate::display::ToolStatus::Calling,
                }),
            ],
            80,
            24,
        );
        assert_snapshot!(output);
    }

    #[test]
    fn ui_long_message_wrapping() {
        let long_msg = "This is a very long message that should wrap across multiple lines when displayed in the terminal. It contains enough text to test the wrapping behavior of the messages widget.";
        let output = render_to_string(
            Mode::Agent,
            AppState::Ready,
            "",
            0,
            &[
                TimelineEntry::user_message("What is Rust?"),
                TimelineEntry::assistant_message(long_msg),
            ],
            80,
            24,
        );
        assert_snapshot!(output);
    }

    #[test]
    fn ui_narrow_terminal() {
        // 40 columns - should hide aux panel
        let output = render_to_string(
            Mode::Agent,
            AppState::Ready,
            "hello",
            5,
            &[TimelineEntry::info("Welcome!")],
            40,
            20,
        );
        assert_snapshot!(output);
    }

    #[test]
    fn ui_tool_results() {
        let output = render_to_string(
            Mode::Agent,
            AppState::Ready,
            "",
            0,
            &[
                TimelineEntry::user_message("List files"),
                TimelineEntry::tool_activity("shell_eval"),
                TimelineEntry::tool_result("shell_eval", "file1.txt\nfile2.txt\nfile3.txt", false),
                TimelineEntry::assistant_message("Found 3 files."),
            ],
            80,
            24,
        );
        assert_snapshot!(output);
    }

    #[test]
    fn ui_large_terminal() {
        // 120x40 - more realistic modern terminal size
        let output = render_to_string(
            Mode::Agent,
            AppState::Ready,
            "",
            0,
            &[
                TimelineEntry::info("Welcome to Agent in a Browser! Type /help for commands."),
                TimelineEntry::user_message("List all files in the current directory"),
                TimelineEntry::tool_activity("shell_eval"),
                TimelineEntry::tool_result("shell_eval", "total 24\n-rw-r--r-- 1 user user  156 Jan 25 10:00 Cargo.toml\n-rw-r--r-- 1 user user  892 Jan 25 10:00 README.md\ndrwxr-xr-x 3 user user 4096 Jan 25 10:00 src/", false),
                TimelineEntry::assistant_message("The directory contains 3 items: Cargo.toml, README.md, and a src/ directory."),
            ],
            120,
            40,
        );
        assert_snapshot!(output);
    }

    #[test]
    fn ui_mcp_servers_panel_text() {
        // Test that MCP servers panel shows full text
        let backend = TestBackend::new(100, 30);
        let mut terminal = Terminal::new(backend).unwrap();
        let theme = Theme::dark();

        terminal
            .draw(|frame| {
                render_ui(
                    frame,
                    Mode::Agent,
                    AppState::Ready,
                    "",
                    0,
                    &[],
                    &[TimelineEntry::info("Testing MCP panel display")],
                    &AuxContent::default(),
                    &ServerStatus {
                        local_connected: true,
                        local_tool_count: 15,
                        remote_servers: vec![],
                    },
                    "claude-sonnet-4",
                    None,
                    &[],
                    &theme,
                );
            })
            .unwrap();

        let output = terminal.backend().to_string();
        assert_snapshot!(output);
    }

    #[test]
    fn ui_overlay_server_manager() {
        // Test with ServerManager overlay visible
        let backend = TestBackend::new(100, 30);
        let mut terminal = Terminal::new(backend).unwrap();
        let theme = Theme::dark();

        terminal
            .draw(|frame| {
                render_ui(
                    frame,
                    Mode::Agent,
                    AppState::Ready,
                    "",
                    0,
                    &[],
                    &[TimelineEntry::info("Welcome")],
                    &AuxContent::default(),
                    &ServerStatus {
                        local_connected: true,
                        local_tool_count: 5,
                        remote_servers: vec![],
                    },
                    "claude-sonnet-4",
                    Some(&Overlay::ServerManager(ServerManagerView::ServerList {
                        selected: 0,
                    })),
                    &[],
                    &theme,
                );
            })
            .unwrap();

        let output = terminal.backend().to_string();
        assert_snapshot!(output);
    }

    #[test]
    fn ui_overlay_provider_selector() {
        // Test with ProviderSelector overlay visible
        let backend = TestBackend::new(100, 30);
        let mut terminal = Terminal::new(backend).unwrap();
        let theme = Theme::dark();

        terminal
            .draw(|frame| {
                render_ui(
                    frame,
                    Mode::Agent,
                    AppState::Ready,
                    "",
                    0,
                    &[],
                    &[TimelineEntry::info("Welcome")],
                    &AuxContent::default(),
                    &ServerStatus {
                        local_connected: true,
                        local_tool_count: 5,
                        remote_servers: vec![],
                    },
                    "claude-sonnet-4",
                    Some(&Overlay::ProviderSelector { selected: 0 }),
                    &[],
                    &theme,
                );
            })
            .unwrap();

        let output = terminal.backend().to_string();
        assert_snapshot!(output);
    }

    #[test]
    fn ui_needs_api_key_state() {
        // Test NeedsApiKey state display
        let output = render_to_string(
            Mode::Agent,
            AppState::NeedsApiKey,
            "sk-ant-",
            7,
            &[TimelineEntry::info("Enter your API key:")],
            100,
            24,
        );
        assert_snapshot!(output);
    }

    #[test]
    fn ui_processing_state() {
        // Test Processing state display
        let output = render_to_string(
            Mode::Agent,
            AppState::Processing,
            "",
            0,
            &[TimelineEntry::user_message("What is 2+2?")],
            100,
            24,
        );
        assert_snapshot!(output);
    }

    // === ProviderWizard Overlay Tests ===
    // These tests verify security and UX requirements for API key handling

    #[test]
    fn ui_overlay_provider_wizard_edit_api_key_empty() {
        // Test EditApiKey step with empty input
        // SHOULD: Show clear instructions and masked input field
        let mut terminal = ratatui::Terminal::new(TestBackend::new(100, 30)).unwrap();
        let theme = Theme::dark();

        terminal
            .draw(|frame| {
                render_ui(
                    frame,
                    Mode::Agent,
                    AppState::Ready,
                    "",
                    0,
                    &[],
                    &[],
                    &AuxContent::default(),
                    &ServerStatus::default(),
                    "test-model",
                    Some(&Overlay::ProviderWizard {
                        step: ProviderWizardStep::EditApiKey,
                        selected_provider: 0,
                        selected_api_format: 0,
                        selected_model: 0,
                        selected_field: 2,
                        base_url_input: String::new(),
                        model_input: "claude-haiku".to_string(),
                        api_key_input: String::new(), // Empty
                        fetched_models: None,
                        standalone: false,
                    }),
                    &[],
                    &theme,
                );
            })
            .unwrap();

        let output = terminal.backend().to_string();
        // SECURITY: Output should NOT contain any API key text
        assert!(!output.contains("sk-"));
        // UX: Should show the Edit API Key title
        assert!(output.contains("Edit API Key") || output.contains("API Key"));
        assert_snapshot!(output);
    }

    #[test]
    fn ui_overlay_provider_wizard_edit_api_key_with_input() {
        // Test EditApiKey step with masked input
        // SECURITY: API key MUST be masked, not shown in plaintext
        let mut terminal = ratatui::Terminal::new(TestBackend::new(100, 30)).unwrap();
        let theme = Theme::dark();

        terminal
            .draw(|frame| {
                render_ui(
                    frame,
                    Mode::Agent,
                    AppState::Ready,
                    "",
                    0,
                    &[],
                    &[],
                    &AuxContent::default(),
                    &ServerStatus::default(),
                    "test-model",
                    Some(&Overlay::ProviderWizard {
                        step: ProviderWizardStep::EditApiKey,
                        selected_provider: 0,
                        selected_api_format: 0,
                        selected_model: 0,
                        selected_field: 2,
                        base_url_input: String::new(),
                        model_input: "claude-haiku".to_string(),
                        api_key_input: "sk-ant-secret123456".to_string(), // 19 chars
                        fetched_models: None,
                        standalone: false,
                    }),
                    &[],
                    &theme,
                );
            })
            .unwrap();

        let output = terminal.backend().to_string();
        // SECURITY: The actual API key MUST NOT appear in the output
        assert!(
            !output.contains("sk-ant-secret123456"),
            "API key should be masked, not shown in plaintext"
        );
        assert!(
            !output.contains("secret"),
            "API key content should not be visible"
        );
        // SECURITY: Asterisks should appear (masking indicator)
        assert!(output.contains("*"), "Masked input should show asterisks");
        assert_snapshot!(output);
    }

    #[test]
    fn ui_overlay_provider_wizard_config_no_api_key() {
        // Test ProviderConfig step when API key is NOT set
        // SHOULD: Show "not set" status with error color indication
        let mut terminal = ratatui::Terminal::new(TestBackend::new(100, 30)).unwrap();
        let theme = Theme::dark();

        terminal
            .draw(|frame| {
                render_ui(
                    frame,
                    Mode::Agent,
                    AppState::Ready,
                    "",
                    0,
                    &[],
                    &[],
                    &AuxContent::default(),
                    &ServerStatus::default(),
                    "test-model",
                    Some(&Overlay::ProviderWizard {
                        step: ProviderWizardStep::ProviderConfig,
                        selected_provider: 0,
                        selected_api_format: 0,
                        selected_model: 0,
                        selected_field: 0,
                        base_url_input: String::new(),
                        model_input: "claude-haiku".to_string(),
                        api_key_input: String::new(), // Not set
                        fetched_models: None,
                        standalone: false,
                    }),
                    &[],
                    &theme,
                );
            })
            .unwrap();

        let output = terminal.backend().to_string();
        // UX: Should indicate API key is not configured
        assert!(
            output.contains("not set") || output.contains("✗"),
            "Should show API key is not configured"
        );
        assert_snapshot!(output);
    }

    #[test]
    fn ui_overlay_provider_wizard_config_with_api_key() {
        // Test ProviderConfig step when API key IS set
        // SHOULD: Show "configured" status, NOT the actual key
        let mut terminal = ratatui::Terminal::new(TestBackend::new(100, 30)).unwrap();
        let theme = Theme::dark();

        terminal
            .draw(|frame| {
                render_ui(
                    frame,
                    Mode::Agent,
                    AppState::Ready,
                    "",
                    0,
                    &[],
                    &[],
                    &AuxContent::default(),
                    &ServerStatus::default(),
                    "test-model",
                    Some(&Overlay::ProviderWizard {
                        step: ProviderWizardStep::ProviderConfig,
                        selected_provider: 0,
                        selected_api_format: 0,
                        selected_model: 0,
                        selected_field: 0,
                        base_url_input: String::new(),
                        model_input: "claude-haiku".to_string(),
                        api_key_input: "sk-ant-secret-key-12345".to_string(),
                        fetched_models: None,
                        standalone: false,
                    }),
                    &[],
                    &theme,
                );
            })
            .unwrap();

        let output = terminal.backend().to_string();
        // SECURITY: The actual API key MUST NOT appear
        assert!(
            !output.contains("sk-ant-secret-key-12345"),
            "API key should never be shown in ProviderConfig"
        );
        // UX: Should indicate API key is configured
        assert!(
            output.contains("configured") || output.contains("✓"),
            "Should show API key is configured"
        );
        assert_snapshot!(output);
    }

    #[test]
    fn ui_overlay_provider_wizard_edit_model() {
        // Test EditModel step
        let mut terminal = ratatui::Terminal::new(TestBackend::new(100, 30)).unwrap();
        let theme = Theme::dark();

        terminal
            .draw(|frame| {
                render_ui(
                    frame,
                    Mode::Agent,
                    AppState::Ready,
                    "",
                    0,
                    &[],
                    &[],
                    &AuxContent::default(),
                    &ServerStatus::default(),
                    "test-model",
                    Some(&Overlay::ProviderWizard {
                        step: ProviderWizardStep::EditModel,
                        selected_provider: 0,
                        selected_api_format: 0,
                        selected_model: 0,
                        selected_field: 0,
                        base_url_input: String::new(),
                        model_input: "claude-sonnet-4".to_string(),
                        api_key_input: String::new(),
                        fetched_models: None,
                        standalone: false,
                    }),
                    &[],
                    &theme,
                );
            })
            .unwrap();

        let output = terminal.backend().to_string();
        // UX: Should show model selection/editing interface
        assert!(
            output.contains("Model") || output.contains("model"),
            "Should show model editing interface"
        );
        assert_snapshot!(output);
    }
}
