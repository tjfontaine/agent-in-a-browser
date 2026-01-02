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

pub use crate::app::{AppState, Message};
pub use input_box::InputBoxWidget;
pub use messages::MessagesWidget;
pub use panels::{
    render_aux_panel, AuxContent, AuxContentKind, AuxPanelWidget, RemoteServer, ServerStatus,
};
pub use server_manager::{
    render_overlay, Overlay, RemoteServerEntry, ServerConnectionStatus, ServerManagerView,
};
pub use status_bar::StatusBarWidget;

/// Application mode
#[derive(Clone, Copy, PartialEq)]
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
    aux_content: &AuxContent,
    server_status: &ServerStatus,
    model_name: &str,
    overlay: Option<&Overlay>,
    remote_servers: &[RemoteServerEntry],
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

        render_main_panel(frame, h_chunks[0], mode, state, input, cursor_pos, messages);
        render_aux_panel(frame, h_chunks[1], aux_content, server_status);
    } else {
        // Single column layout for narrow terminals
        render_main_panel(frame, v_chunks[0], mode, state, input, cursor_pos, messages);
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
) {
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Min(3),    // Messages/output
            Constraint::Length(3), // Input box
        ])
        .split(area);

    // Messages
    frame.render_widget(MessagesWidget::new(messages, state), chunks[0]);

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
    render_ui(
        frame,
        app.mode,
        app.state,
        app.input.text(),
        app.input.cursor_pos(),
        &app.messages,
        &app.aux_content,
        &app.server_status,
        app.model_name(),
        app.overlay.as_ref(),
        &app.remote_servers,
    );
}
