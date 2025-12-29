//! UI rendering components

mod agent_mode;
mod shell_mode;
mod status_bar;
mod panels;
mod overlays;

use ratatui::prelude::*;
use ratatui::widgets::*;

pub use crate::app::Message;

/// Application mode
#[derive(Clone, Copy, PartialEq)]
pub enum Mode {
    Agent,
    Shell,
    Plan,
}

/// Main render function
pub fn render_ui(
    frame: &mut Frame,
    mode: Mode,
    input: &str,
    messages: &[Message],
) {
    let area = frame.area();
    
    // Split into main area and status bar
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Min(3),    // Main content
            Constraint::Length(1), // Status bar
        ])
        .split(area);
    
    // Render main content based on mode
    let main_chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Min(3),    // Messages/output
            Constraint::Length(3), // Input box
        ])
        .split(chunks[0]);
    
    // Messages area
    render_messages(frame, main_chunks[0], messages);
    
    // Input box
    render_input(frame, main_chunks[1], mode, input);
    
    // Status bar
    render_status_bar(frame, chunks[1], mode);
}

fn render_messages(frame: &mut Frame, area: Rect, messages: &[Message]) {
    let items: Vec<ListItem> = messages
        .iter()
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

fn render_input(frame: &mut Frame, area: Rect, mode: Mode, input: &str) {
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
    
    let paragraph = Paragraph::new(format!("{}{}", prompt, input))
        .block(Block::default().borders(Borders::ALL).title(title));
    
    frame.render_widget(paragraph, area);
}

fn render_status_bar(frame: &mut Frame, area: Rect, mode: Mode) {
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
    
    let status = Line::from(vec![
        Span::styled(mode_str, mode_style),
        Span::raw(" | "),
        Span::styled("anthropic:claude-sonnet", Style::default().fg(Color::Cyan)),
        Span::raw(" | "),
        Span::styled("Ctrl+C to quit", Style::default().fg(Color::DarkGray)),
    ]);
    
    let paragraph = Paragraph::new(status)
        .style(Style::default().bg(Color::Rgb(20, 20, 30)));
    
    frame.render_widget(paragraph, area);
}
