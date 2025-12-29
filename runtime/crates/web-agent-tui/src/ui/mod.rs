//! UI rendering components

mod agent_mode;
mod shell_mode;
mod status_bar;
pub mod panels;
mod overlays;

use ratatui::prelude::*;
use ratatui::widgets::*;

pub use crate::app::{Message, AppState};
pub use panels::{AuxContent, AuxContentKind, ServerStatus, RemoteServer, render_aux_panel};

/// Application mode
#[derive(Clone, Copy, PartialEq)]
pub enum Mode {
    Agent,
    Shell,
    Plan,
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
            .constraints([
                Constraint::Percentage(70),
                Constraint::Percentage(30),
            ])
            .split(v_chunks[0]);
        
        render_main_panel(frame, h_chunks[0], mode, state, input, messages);
        render_aux_panel(frame, h_chunks[1], aux_content, server_status);
    } else {
        // Single column layout for narrow terminals
        render_main_panel(frame, v_chunks[0], mode, state, input, messages);
    }
    
    // Status bar
    render_status_bar(frame, v_chunks[1], mode, state, server_status);
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
    
    render_messages(frame, chunks[0], messages);
    render_input(frame, chunks[1], mode, state, input);
}

fn render_messages(frame: &mut Frame, area: Rect, messages: &[Message]) {
    // Calculate scroll position to show latest messages
    let visible_height = area.height.saturating_sub(2) as usize; // -2 for borders
    let scroll_offset = if messages.len() > visible_height {
        messages.len() - visible_height
    } else {
        0
    };
    
    let items: Vec<ListItem> = messages
        .iter()
        .skip(scroll_offset)
        .map(|msg| {
            let style = match msg.role {
                crate::app::Role::User => Style::default().fg(Color::Cyan),
                crate::app::Role::Assistant => Style::default().fg(Color::Green),
                crate::app::Role::System => Style::default().fg(Color::Yellow),
                crate::app::Role::Tool => Style::default().fg(Color::Magenta),
            };
            let prefix = match msg.role {
                crate::app::Role::User => "> ",
                crate::app::Role::Assistant => "◆ ",
                crate::app::Role::System => "• ",
                crate::app::Role::Tool => "⚙ ",
            };
            ListItem::new(Line::from(vec![
                Span::styled(prefix, style),
                Span::raw(&msg.content),
            ]))
        })
        .collect();
    
    let list = List::new(items)
        .block(Block::default().borders(Borders::ALL).title("Messages"));
    
    frame.render_widget(list, area);
}

fn render_input(frame: &mut Frame, area: Rect, mode: Mode, state: AppState, input: &str) {
    let (prompt, title, display_input) = match state {
        AppState::NeedsApiKey => {
            // Mask the API key input
            let masked: String = "*".repeat(input.len());
            ("🔑 ", "API Key (hidden)", masked)
        }
        AppState::Processing => {
            ("⏳ ", "Processing...", input.to_string())
        }
        AppState::Ready => {
            let prompt = match mode {
                Mode::Agent => "> ",
                Mode::Shell => "$ ",
                Mode::Plan => "📋 ",
            };
            let title = match mode {
                Mode::Agent => "Agent",
                Mode::Shell => "Shell",
                Mode::Plan => "Plan (read-only)",
            };
            (prompt, title, input.to_string())
        }
    };
    
    let border_style = match state {
        AppState::NeedsApiKey => Style::default().fg(Color::Yellow),
        AppState::Processing => Style::default().fg(Color::Blue),
        AppState::Ready => Style::default(),
    };
    
    let paragraph = Paragraph::new(format!("{}{}", prompt, display_input))
        .block(
            Block::default()
                .borders(Borders::ALL)
                .title(title)
                .border_style(border_style)
        );
    
    frame.render_widget(paragraph, area);
}

fn render_status_bar(frame: &mut Frame, area: Rect, mode: Mode, state: AppState, servers: &ServerStatus) {
    let mode_str = match mode {
        Mode::Agent => " AGENT ",
        Mode::Shell => " SHELL ",
        Mode::Plan => " PLAN ",
    };
    
    let mode_style = match mode {
        Mode::Agent => Style::default().bg(Color::Blue).fg(Color::White),
        Mode::Shell => Style::default().bg(Color::Green).fg(Color::Black),
        Mode::Plan => Style::default().bg(Color::Yellow).fg(Color::Black),
    };
    
    // State indicator
    let (state_str, state_style) = match state {
        AppState::Ready => ("", Style::default()),
        AppState::NeedsApiKey => (" 🔑 API KEY ", Style::default().bg(Color::Yellow).fg(Color::Black)),
        AppState::Processing => (" ⏳ WORKING ", Style::default().bg(Color::Magenta).fg(Color::White)),
    };
    
    // Server status indicator
    let local_indicator = if servers.local_connected { "●" } else { "○" };
    let local_style = if servers.local_connected {
        Style::default().fg(Color::Green)
    } else {
        Style::default().fg(Color::DarkGray)
    };
    
    let remote_count = servers.remote_servers.iter().filter(|s| s.connected).count();
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
    
    let mut spans = vec![
        Span::styled(mode_str, mode_style),
    ];
    
    if !state_str.is_empty() {
        spans.push(Span::styled(state_str, state_style));
    }
    
    spans.extend([
        Span::raw(" | "),
        Span::styled("gpt-4o", Style::default().fg(Color::Cyan)),
        Span::raw(" | L:"),
        Span::styled(local_indicator, local_style),
        Span::raw(" R:"),
        Span::styled(&remote_indicator, remote_style),
        Span::raw(" | "),
        Span::styled("/help", Style::default().fg(Color::DarkGray)),
    ]);
    
    let status = Line::from(spans);
    
    let paragraph = Paragraph::new(status)
        .style(Style::default().bg(Color::Rgb(20, 20, 30)));
    
    frame.render_widget(paragraph, area);
}
