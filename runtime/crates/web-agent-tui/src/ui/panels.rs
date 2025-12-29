//! Panel components for split layout
//!
//! Provides auxiliary panel rendering for tool output, MCP servers, and tasks.

use ratatui::prelude::*;
use ratatui::widgets::*;

/// Content to display in the auxiliary panel
#[derive(Clone, Default)]
pub struct AuxContent {
    pub kind: AuxContentKind,
    pub title: String,
    pub content: String,
}

/// Type of content in aux panel
#[derive(Clone, Default, PartialEq)]
pub enum AuxContentKind {
    #[default]
    Empty,
    ToolOutput,
    FilePreview,
    TaskList,
}

/// Status of MCP server connections
#[derive(Clone, Default)]
pub struct ServerStatus {
    pub local_connected: bool,
    pub local_tool_count: usize,
    pub remote_servers: Vec<RemoteServer>,
}

/// A remote MCP server connection
#[derive(Clone)]
pub struct RemoteServer {
    pub name: String,
    pub url: String,
    pub connected: bool,
    pub tool_count: usize,
}

/// Render the auxiliary panel (right side of split layout)
pub fn render_aux_panel(
    frame: &mut Frame,
    area: Rect,
    content: &AuxContent,
    servers: &ServerStatus,
) {
    // Split aux panel into: server status (top) + content (bottom)
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(5 + servers.remote_servers.len() as u16),
            Constraint::Min(3),
        ])
        .split(area);
    
    render_server_status(frame, chunks[0], servers);
    render_aux_content(frame, chunks[1], content);
}

/// Render MCP server connection status
fn render_server_status(frame: &mut Frame, area: Rect, servers: &ServerStatus) {
    let mut lines = vec![
        Line::from(vec![
            Span::styled(
                if servers.local_connected { "● " } else { "○ " },
                Style::default().fg(if servers.local_connected { Color::Green } else { Color::DarkGray }),
            ),
            Span::raw("Local (sandbox)"),
            Span::styled(
                format!(" [{} tools]", servers.local_tool_count),
                Style::default().fg(Color::DarkGray),
            ),
        ]),
    ];
    
    for remote in &servers.remote_servers {
        lines.push(Line::from(vec![
            Span::styled(
                if remote.connected { "● " } else { "○ " },
                Style::default().fg(if remote.connected { Color::Cyan } else { Color::DarkGray }),
            ),
            Span::raw(&remote.name),
            Span::styled(
                format!(" [{} tools]", remote.tool_count),
                Style::default().fg(Color::DarkGray),
            ),
        ]));
    }
    
    if servers.remote_servers.is_empty() {
        lines.push(Line::from(vec![
            Span::styled("○ ", Style::default().fg(Color::DarkGray)),
            Span::styled("No remote servers", Style::default().fg(Color::DarkGray)),
        ]));
    }
    
    let paragraph = Paragraph::new(lines)
        .block(Block::default().borders(Borders::ALL).title("MCP Servers"));
    
    frame.render_widget(paragraph, area);
}

/// Render auxiliary content (tool output, tasks, etc.)
fn render_aux_content(frame: &mut Frame, area: Rect, content: &AuxContent) {
    let title = if content.title.is_empty() {
        match content.kind {
            AuxContentKind::Empty => "Auxiliary",
            AuxContentKind::ToolOutput => "Tool Output",
            AuxContentKind::FilePreview => "File Preview",
            AuxContentKind::TaskList => "Tasks",
        }
    } else {
        &content.title
    };
    
    let style = match content.kind {
        AuxContentKind::ToolOutput => Style::default().fg(Color::Magenta),
        AuxContentKind::FilePreview => Style::default().fg(Color::Cyan),
        AuxContentKind::TaskList => Style::default().fg(Color::Yellow),
        AuxContentKind::Empty => Style::default().fg(Color::DarkGray),
    };
    
    let text = if content.content.is_empty() {
        match content.kind {
            AuxContentKind::Empty => "Tool output will appear here.\n\nTry running a command!".to_string(),
            _ => content.content.clone(),
        }
    } else {
        content.content.clone()
    };
    
    let paragraph = Paragraph::new(text)
        .style(style)
        .block(Block::default().borders(Borders::ALL).title(title))
        .wrap(Wrap { trim: false });
    
    frame.render_widget(paragraph, area);
}
