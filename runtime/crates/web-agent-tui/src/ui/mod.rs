//! UI rendering components
//!
//! Uses ratatui widgets for the TUI interface.

mod agent_mode;
mod overlays;
pub mod panels;
mod shell_mode;
mod status_bar;

use ratatui::prelude::*;
use ratatui::widgets::*;

pub use crate::app::{AppState, Message};
pub use panels::{render_aux_panel, AuxContent, AuxContentKind, RemoteServer, ServerStatus};

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
    messages: &[Message],
    aux_content: &AuxContent,
    server_status: &ServerStatus,
    model_name: &str,
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

        render_main_panel(frame, h_chunks[0], mode, state, input, messages);
        render_aux_panel(frame, h_chunks[1], aux_content, server_status);
    } else {
        // Single column layout for narrow terminals
        render_main_panel(frame, v_chunks[0], mode, state, input, messages);
    }

    // Status bar
    render_status_bar(frame, v_chunks[1], mode, state, server_status, model_name);
}

/// Render the main panel (messages + input)
fn render_main_panel(
    frame: &mut Frame,
    area: Rect,
    mode: Mode,
    state: AppState,
    input: &str,
    messages: &[Message],
) {
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Min(3),    // Messages/output
            Constraint::Length(3), // Input box
        ])
        .split(area);

    render_messages(frame, chunks[0], messages, state);
    render_input(frame, chunks[1], mode, state, input);
}

/// Render messages with proper text wrapping and scrolling
fn render_messages(frame: &mut Frame, area: Rect, messages: &[Message], state: AppState) {
    let inner_width = area.width.saturating_sub(4) as usize; // Account for borders + prefix
    let visible_height = area.height.saturating_sub(2) as usize;

    // Build wrapped lines with styling
    let mut lines: Vec<Line> = Vec::new();

    for msg in messages {
        let (prefix, style) = match msg.role {
            crate::app::Role::User => (
                "› ",
                Style::default()
                    .fg(Color::Cyan)
                    .add_modifier(Modifier::BOLD),
            ),
            crate::app::Role::Assistant => ("◆ ", Style::default().fg(Color::Green)),
            crate::app::Role::System => (
                "• ",
                Style::default()
                    .fg(Color::Yellow)
                    .add_modifier(Modifier::DIM),
            ),
            crate::app::Role::Tool => (
                "⚙ ",
                Style::default()
                    .fg(Color::Magenta)
                    .add_modifier(Modifier::ITALIC),
            ),
        };

        // Word-wrap the content manually for better control
        let content = &msg.content;
        let wrapped = wrap_text(content, inner_width.saturating_sub(2));

        for (i, line_text) in wrapped.iter().enumerate() {
            let line_prefix = if i == 0 { prefix } else { "  " };
            lines.push(Line::from(vec![
                Span::styled(line_prefix, style),
                Span::styled(line_text.clone(), style.remove_modifier(Modifier::BOLD)),
            ]));
        }
    }

    // Add processing indicator
    if state == AppState::Processing {
        lines.push(Line::from(vec![
            Span::styled(
                "⏳ ",
                Style::default()
                    .fg(Color::Blue)
                    .add_modifier(Modifier::SLOW_BLINK),
            ),
            Span::styled(
                "Thinking...",
                Style::default().fg(Color::Blue).add_modifier(Modifier::DIM),
            ),
        ]));
    }

    // Calculate scroll offset to show latest
    let scroll_offset = if lines.len() > visible_height {
        lines.len() - visible_height
    } else {
        0
    };

    // Use Paragraph with scroll for wrapped text
    let text = Text::from(lines);
    let paragraph = Paragraph::new(text)
        .block(
            Block::default()
                .borders(Borders::ALL)
                .title(Span::styled(
                    " Messages ",
                    Style::default().add_modifier(Modifier::BOLD),
                ))
                .border_type(BorderType::Rounded),
        )
        .scroll((scroll_offset as u16, 0));

    frame.render_widget(paragraph, area);
}

/// Simple word wrap implementation
fn wrap_text(text: &str, max_width: usize) -> Vec<String> {
    if max_width == 0 {
        return vec![text.to_string()];
    }

    let mut lines = Vec::new();

    for paragraph in text.split('\n') {
        if paragraph.is_empty() {
            lines.push(String::new());
            continue;
        }

        let words: Vec<&str> = paragraph.split_whitespace().collect();
        if words.is_empty() {
            lines.push(String::new());
            continue;
        }

        let mut current_line = String::new();

        for word in words {
            if current_line.is_empty() {
                current_line = word.to_string();
            } else if current_line.len() + 1 + word.len() <= max_width {
                current_line.push(' ');
                current_line.push_str(word);
            } else {
                lines.push(current_line);
                current_line = word.to_string();
            }
        }

        if !current_line.is_empty() {
            lines.push(current_line);
        }
    }

    if lines.is_empty() {
        lines.push(String::new());
    }

    lines
}

fn render_input(frame: &mut Frame, area: Rect, mode: Mode, state: AppState, input: &str) {
    let (prompt, title, display_input) = match state {
        AppState::NeedsApiKey => {
            let masked: String = "•".repeat(input.len());
            ("🔑 ", " API Key ", masked)
        }
        AppState::Processing => ("⏳ ", " Processing ", input.to_string()),
        AppState::Ready => {
            let prompt = match mode {
                Mode::Agent => "› ",
                Mode::Shell => "$ ",
                Mode::Plan => "📋 ",
            };
            let title = match mode {
                Mode::Agent => " Agent ",
                Mode::Shell => " Shell ",
                Mode::Plan => " Plan (read-only) ",
            };
            (prompt, title, input.to_string())
        }
    };

    let (border_style, border_type) = match state {
        AppState::NeedsApiKey => (Style::default().fg(Color::Yellow), BorderType::Double),
        AppState::Processing => (Style::default().fg(Color::Blue), BorderType::Rounded),
        AppState::Ready => (Style::default().fg(Color::White), BorderType::Rounded),
    };

    // Show cursor with blinking block
    let cursor = if state != AppState::Processing {
        "▋"
    } else {
        ""
    };

    let paragraph = Paragraph::new(Line::from(vec![
        Span::styled(prompt, Style::default().add_modifier(Modifier::BOLD)),
        Span::raw(&display_input),
        Span::styled(
            cursor,
            Style::default()
                .fg(Color::White)
                .add_modifier(Modifier::SLOW_BLINK),
        ),
    ]))
    .block(
        Block::default()
            .borders(Borders::ALL)
            .title(Span::styled(
                title,
                Style::default().add_modifier(Modifier::BOLD),
            ))
            .border_style(border_style)
            .border_type(border_type),
    );

    frame.render_widget(paragraph, area);
}

fn render_status_bar(
    frame: &mut Frame,
    area: Rect,
    mode: Mode,
    state: AppState,
    servers: &ServerStatus,
    model_name: &str,
) {
    let mode_str = match mode {
        Mode::Agent => " AGENT ",
        Mode::Shell => " SHELL ",
        Mode::Plan => " PLAN ",
    };

    let mode_style = match mode {
        Mode::Agent => Style::default()
            .bg(Color::Blue)
            .fg(Color::White)
            .add_modifier(Modifier::BOLD),
        Mode::Shell => Style::default()
            .bg(Color::Green)
            .fg(Color::Black)
            .add_modifier(Modifier::BOLD),
        Mode::Plan => Style::default()
            .bg(Color::Yellow)
            .fg(Color::Black)
            .add_modifier(Modifier::BOLD),
    };

    // State indicator with animation hint
    let (state_str, state_style) = match state {
        AppState::Ready => ("", Style::default()),
        AppState::NeedsApiKey => (
            " 🔑 KEY ",
            Style::default().bg(Color::Yellow).fg(Color::Black),
        ),
        AppState::Processing => (
            " ⏳ WORKING ",
            Style::default()
                .bg(Color::Magenta)
                .fg(Color::White)
                .add_modifier(Modifier::BOLD),
        ),
    };

    // Server status
    let local_indicator = if servers.local_connected {
        "●"
    } else {
        "○"
    };
    let local_style = if servers.local_connected {
        Style::default().fg(Color::Green)
    } else {
        Style::default().fg(Color::DarkGray)
    };

    let remote_count = servers
        .remote_servers
        .iter()
        .filter(|s| s.connected)
        .count();
    let remote_indicator = if remote_count > 0 {
        format!("●{}", remote_count)
    } else {
        "○".to_string()
    };
    let remote_style = if remote_count > 0 {
        Style::default().fg(Color::Cyan)
    } else {
        Style::default().fg(Color::DarkGray)
    };

    let mut spans = vec![Span::styled(mode_str, mode_style)];

    if !state_str.is_empty() {
        spans.push(Span::styled(state_str, state_style));
    }

    spans.extend([
        Span::raw(" │ "),
        Span::styled(model_name, Style::default().fg(Color::Cyan)),
        Span::raw(" │ L:"),
        Span::styled(local_indicator, local_style),
        Span::raw(" R:"),
        Span::styled(&remote_indicator, remote_style),
        Span::raw(" │ "),
        Span::styled("^C quit  /help", Style::default().fg(Color::DarkGray)),
    ]);

    let status = Line::from(spans);

    let paragraph = Paragraph::new(status).style(Style::default().bg(Color::Rgb(25, 25, 35)));

    frame.render_widget(paragraph, area);
}
