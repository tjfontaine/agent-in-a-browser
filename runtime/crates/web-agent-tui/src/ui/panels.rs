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

/// Render the auxiliary panel (right side of split layout) - legacy function
pub fn render_aux_panel(
    frame: &mut Frame,
    area: Rect,
    content: &AuxContent,
    servers: &ServerStatus,
) {
    frame.render_widget(AuxPanelWidget::new(content, servers), area);
}

/// Widget for the entire auxiliary panel
pub struct AuxPanelWidget<'a> {
    content: &'a AuxContent,
    servers: &'a ServerStatus,
}

impl<'a> AuxPanelWidget<'a> {
    pub fn new(content: &'a AuxContent, servers: &'a ServerStatus) -> Self {
        Self { content, servers }
    }
}

impl<'a> Widget for AuxPanelWidget<'a> {
    fn render(self, area: Rect, buf: &mut Buffer) {
        // Split aux panel into: server status (top) + content (bottom)
        let chunks = Layout::default()
            .direction(Direction::Vertical)
            .constraints([
                Constraint::Length(5 + self.servers.remote_servers.len() as u16),
                Constraint::Min(3),
            ])
            .split(area);

        ServerStatusWidget::new(self.servers).render(chunks[0], buf);
        AuxContentWidget::new(self.content).render(chunks[1], buf);
    }
}

/// Widget for MCP server connection status
pub struct ServerStatusWidget<'a> {
    servers: &'a ServerStatus,
}

impl<'a> ServerStatusWidget<'a> {
    pub fn new(servers: &'a ServerStatus) -> Self {
        Self { servers }
    }
}

impl<'a> Widget for ServerStatusWidget<'a> {
    fn render(self, area: Rect, buf: &mut Buffer) {
        let mut lines = vec![Line::from(vec![
            Span::styled(
                if self.servers.local_connected {
                    "● "
                } else {
                    "○ "
                },
                Style::default().fg(if self.servers.local_connected {
                    Color::Green
                } else {
                    Color::DarkGray
                }),
            ),
            Span::raw("Local (sandbox)"),
            Span::styled(
                format!(" [{} tools]", self.servers.local_tool_count),
                Style::default().fg(Color::DarkGray),
            ),
        ])];

        for remote in &self.servers.remote_servers {
            lines.push(Line::from(vec![
                Span::styled(
                    if remote.connected { "● " } else { "○ " },
                    Style::default().fg(if remote.connected {
                        Color::Cyan
                    } else {
                        Color::DarkGray
                    }),
                ),
                Span::raw(&remote.name),
                Span::styled(
                    format!(" [{} tools]", remote.tool_count),
                    Style::default().fg(Color::DarkGray),
                ),
            ]));
        }

        if self.servers.remote_servers.is_empty() {
            lines.push(Line::from(vec![
                Span::styled("○ ", Style::default().fg(Color::DarkGray)),
                Span::styled("No remote servers", Style::default().fg(Color::DarkGray)),
            ]));
        }

        let paragraph = Paragraph::new(lines)
            .block(Block::default().borders(Borders::ALL).title("MCP Servers"));

        paragraph.render(area, buf);
    }
}

/// Widget for auxiliary content (tool output, tasks, etc.)
pub struct AuxContentWidget<'a> {
    content: &'a AuxContent,
}

impl<'a> AuxContentWidget<'a> {
    pub fn new(content: &'a AuxContent) -> Self {
        Self { content }
    }
}

impl<'a> Widget for AuxContentWidget<'a> {
    fn render(self, area: Rect, buf: &mut Buffer) {
        let title = if self.content.title.is_empty() {
            match self.content.kind {
                AuxContentKind::Empty => "Auxiliary",
                AuxContentKind::ToolOutput => "Tool Output",
                AuxContentKind::FilePreview => "File Preview",
                AuxContentKind::TaskList => "Tasks",
            }
        } else {
            &self.content.title
        };

        let style = match self.content.kind {
            AuxContentKind::ToolOutput => Style::default().fg(Color::Magenta),
            AuxContentKind::FilePreview => Style::default().fg(Color::Cyan),
            AuxContentKind::TaskList => Style::default().fg(Color::Yellow),
            AuxContentKind::Empty => Style::default().fg(Color::DarkGray),
        };

        let text = if self.content.content.is_empty() {
            match self.content.kind {
                AuxContentKind::Empty => {
                    "Tool output will appear here.\n\nTry running a command!".to_string()
                }
                _ => self.content.content.clone(),
            }
        } else {
            self.content.content.clone()
        };

        let paragraph = Paragraph::new(text)
            .style(style)
            .block(Block::default().borders(Borders::ALL).title(title))
            .wrap(Wrap { trim: false });

        paragraph.render(area, buf);
    }
}
