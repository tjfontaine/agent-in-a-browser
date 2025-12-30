//! Server Manager Overlay UI
//!
//! Wizard-style interface for managing MCP servers.
//! Uses ratatui List, Paragraph, and Block widgets.

use ratatui::{prelude::*, widgets::*};

use crate::bridge::mcp_client::ToolDefinition;

/// Remote server connection status
#[derive(Clone, PartialEq, Debug)]
pub enum ServerConnectionStatus {
    Disconnected,
    Connecting,
    Connected,
    AuthRequired,
    Error(String),
}

impl std::fmt::Display for ServerConnectionStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ServerConnectionStatus::Disconnected => write!(f, "disconnected"),
            ServerConnectionStatus::Connecting => write!(f, "connecting"),
            ServerConnectionStatus::Connected => write!(f, "connected"),
            ServerConnectionStatus::AuthRequired => write!(f, "auth required"),
            ServerConnectionStatus::Error(msg) => write!(f, "error: {}", msg),
        }
    }
}

/// A remote MCP server entry
#[derive(Clone)]
pub struct RemoteServerEntry {
    pub id: String,
    pub name: String,
    pub url: String,
    pub status: ServerConnectionStatus,
    pub tools: Vec<ToolDefinition>,
    pub bearer_token: Option<String>,
}

/// Server manager wizard view modes
#[derive(Clone)]
pub enum ServerManagerView {
    /// List of all servers (local + remote)
    ServerList { selected: usize },
    /// Actions for selected server
    ServerActions { server_id: String, selected: usize },
    /// URL input for adding new server
    AddServer {
        url_input: String,
        error: Option<String>,
    },
    /// Token input for API key auth
    SetToken {
        server_id: String,
        token_input: String,
        error: Option<String>,
    },
}

impl Default for ServerManagerView {
    fn default() -> Self {
        ServerManagerView::ServerList { selected: 0 }
    }
}

/// Current overlay (if any)
#[derive(Clone)]
pub enum Overlay {
    ServerManager(ServerManagerView),
}

/// Create a centered rectangle for popups
pub fn centered_rect(percent_x: u16, percent_y: u16, area: Rect) -> Rect {
    let popup_width = area.width * percent_x / 100;
    let popup_height = area.height * percent_y / 100;
    let popup_x = (area.width - popup_width) / 2;
    let popup_y = (area.height - popup_height) / 2;

    Rect::new(
        area.x + popup_x,
        area.y + popup_y,
        popup_width,
        popup_height,
    )
}

/// Render the server list view
pub fn render_server_list(
    frame: &mut Frame,
    area: Rect,
    local_tool_count: usize,
    remote_servers: &[RemoteServerEntry],
    selected: usize,
) {
    let popup = centered_rect(60, 70, area);
    frame.render_widget(Clear, popup);

    // Build list items
    let mut items = vec![];

    // Local server (always first)
    items.push(ListItem::new(Line::from(vec![
        Span::styled("● ", Style::default().fg(Color::Green)),
        Span::raw("📦 Local (sandbox)"),
        Span::styled(
            format!(" [{} tools]", local_tool_count),
            Style::default().fg(Color::DarkGray),
        ),
    ])));

    // Add new option (second)
    items.push(ListItem::new(Line::from(vec![
        Span::styled("➕ ", Style::default().fg(Color::Blue)),
        Span::raw("Add new server..."),
    ])));

    // Remote servers
    for server in remote_servers {
        let (icon, color) = match &server.status {
            ServerConnectionStatus::Connected => ("● ", Color::Green),
            ServerConnectionStatus::Connecting => ("◐ ", Color::Yellow),
            ServerConnectionStatus::AuthRequired => ("🔒 ", Color::Yellow),
            ServerConnectionStatus::Error(_) => ("✗ ", Color::Red),
            ServerConnectionStatus::Disconnected => ("○ ", Color::DarkGray),
        };

        items.push(ListItem::new(Line::from(vec![
            Span::styled(icon, Style::default().fg(color)),
            Span::raw(format!("🌐 {}", server.name)),
            Span::styled(
                format!(" [{} tools]", server.tools.len()),
                Style::default().fg(Color::DarkGray),
            ),
        ])));
    }

    let list = List::new(items)
        .block(
            Block::default()
                .title("🌐 MCP Servers")
                .borders(Borders::ALL)
                .border_type(BorderType::Rounded),
        )
        .highlight_style(
            Style::default()
                .add_modifier(Modifier::REVERSED)
                .fg(Color::Cyan),
        )
        .highlight_symbol("▶ ");

    // State for selection
    let mut state = ListState::default();
    state.select(Some(selected));

    frame.render_stateful_widget(list, popup, &mut state);

    // Hints at bottom
    let hints = Paragraph::new("↑↓ Navigate │ Enter Select │ Esc Close")
        .style(Style::default().fg(Color::DarkGray))
        .alignment(Alignment::Center);
    let hint_area = Rect::new(popup.x, popup.y + popup.height, popup.width, 1);
    if hint_area.y < area.height {
        frame.render_widget(hints, hint_area);
    }
}

/// Render the server actions view
pub fn render_server_actions(
    frame: &mut Frame,
    area: Rect,
    server: &RemoteServerEntry,
    selected: usize,
) {
    let popup = centered_rect(50, 60, area);
    frame.render_widget(Clear, popup);

    // Split popup: header info + actions
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Length(7), Constraint::Min(1)])
        .split(popup);

    // Server info header
    let status_color = match &server.status {
        ServerConnectionStatus::Connected => Color::Green,
        ServerConnectionStatus::Error(_) => Color::Red,
        _ => Color::Yellow,
    };

    let header_lines = vec![
        Line::from(vec![
            Span::styled(
                &server.name,
                Style::default()
                    .fg(Color::Yellow)
                    .add_modifier(Modifier::BOLD),
            ),
            Span::styled(
                format!(" ({})", server.status),
                Style::default().fg(status_color),
            ),
        ]),
        Line::from(Span::styled(
            &server.url,
            Style::default().fg(Color::DarkGray),
        )),
        Line::from(Span::styled(
            format!(
                "Auth: {} │ {} tools",
                if server.bearer_token.is_some() {
                    "API Key"
                } else {
                    "none"
                },
                server.tools.len()
            ),
            Style::default().fg(Color::DarkGray),
        )),
    ];

    frame.render_widget(
        Paragraph::new(header_lines).block(
            Block::default()
                .title(&*server.name)
                .borders(Borders::ALL)
                .border_type(BorderType::Rounded),
        ),
        chunks[0],
    );

    // Actions based on server status
    let mut actions: Vec<ListItem> = vec![];
    if server.status == ServerConnectionStatus::Connected {
        actions.push(ListItem::new("⏹ Disconnect"));
    } else {
        actions.push(ListItem::new("🔌 Connect"));
    }
    actions.push(ListItem::new("🔑 Set API Key"));
    actions.push(ListItem::new("🗑 Remove"));
    actions.push(ListItem::new("← Back"));

    let action_list = List::new(actions)
        .block(
            Block::default()
                .title("Actions")
                .borders(Borders::ALL)
                .border_type(BorderType::Rounded),
        )
        .highlight_style(
            Style::default()
                .add_modifier(Modifier::REVERSED)
                .fg(Color::Cyan),
        )
        .highlight_symbol("▶ ");

    let mut state = ListState::default();
    state.select(Some(selected));
    frame.render_stateful_widget(action_list, chunks[1], &mut state);
}

/// Render the local server view (tools only, no actions)
pub fn render_local_server(frame: &mut Frame, area: Rect, tool_count: usize) {
    let popup = centered_rect(50, 50, area);
    frame.render_widget(Clear, popup);

    let lines = vec![
        Line::from(vec![Span::styled(
            "📦 Local Sandbox",
            Style::default()
                .fg(Color::Green)
                .add_modifier(Modifier::BOLD),
        )]),
        Line::from(""),
        Line::from(Span::styled(
            "Built-in WASM MCP server",
            Style::default().fg(Color::DarkGray),
        )),
        Line::from(vec![
            Span::styled(
                format!("{} tools", tool_count),
                Style::default().fg(Color::Green),
            ),
            Span::raw(" available"),
        ]),
        Line::from(""),
        Line::from(Span::styled(
            "Press Esc to go back",
            Style::default().fg(Color::DarkGray),
        )),
    ];

    frame.render_widget(
        Paragraph::new(lines).block(
            Block::default()
                .title("Local Server")
                .borders(Borders::ALL)
                .border_type(BorderType::Rounded),
        ),
        popup,
    );
}

/// Render the add server view (URL input)
pub fn render_add_server(frame: &mut Frame, area: Rect, url_input: &str, error: Option<&str>) {
    let popup = centered_rect(60, 35, area);
    frame.render_widget(Clear, popup);

    let mut lines = vec![
        Line::from(Span::styled(
            "Enter MCP server URL:",
            Style::default().fg(Color::DarkGray),
        )),
        Line::from(""),
        Line::from(vec![
            Span::styled("URL: ", Style::default().fg(Color::Cyan)),
            Span::raw(url_input),
            Span::styled("█", Style::default().fg(Color::White)), // Cursor
        ]),
        Line::from(""),
        Line::from(Span::styled(
            "Examples:",
            Style::default().fg(Color::DarkGray),
        )),
        Line::from(Span::styled(
            "  • https://mcp.stripe.com",
            Style::default().fg(Color::DarkGray),
        )),
        Line::from(Span::styled(
            "  • https://your-server.com/mcp",
            Style::default().fg(Color::DarkGray),
        )),
    ];

    if let Some(err) = error {
        lines.push(Line::from(""));
        lines.push(Line::from(Span::styled(
            format!("✗ {}", err),
            Style::default().fg(Color::Red),
        )));
    }

    lines.push(Line::from(""));
    lines.push(Line::from(Span::styled(
        "Press Enter to add │ Esc to cancel",
        Style::default().fg(Color::DarkGray),
    )));

    frame.render_widget(
        Paragraph::new(lines).block(
            Block::default()
                .title("➕ Add Server")
                .borders(Borders::ALL)
                .border_type(BorderType::Rounded),
        ),
        popup,
    );
}

/// Render the set token view (API key input)
pub fn render_set_token(
    frame: &mut Frame,
    area: Rect,
    server_name: &str,
    server_url: &str,
    token_input: &str,
    error: Option<&str>,
) {
    let popup = centered_rect(60, 35, area);
    frame.render_widget(Clear, popup);

    let mut lines = vec![
        Line::from(vec![Span::styled(
            server_name,
            Style::default().fg(Color::Yellow),
        )]),
        Line::from(Span::styled(
            server_url,
            Style::default().fg(Color::DarkGray),
        )),
        Line::from(""),
        Line::from(Span::styled(
            "Enter your API key/token:",
            Style::default().fg(Color::DarkGray),
        )),
        Line::from(""),
        Line::from(vec![
            Span::styled("Token: ", Style::default().fg(Color::Cyan)),
            // Show masked token for security
            Span::raw("*".repeat(token_input.len().min(30))),
            Span::styled("█", Style::default().fg(Color::White)), // Cursor
        ]),
    ];

    // Special hint for Stripe
    if server_url.contains("stripe") {
        lines.push(Line::from(""));
        lines.push(Line::from(Span::styled(
            "Get your Stripe key from: https://dashboard.stripe.com/apikeys",
            Style::default().fg(Color::DarkGray),
        )));
    }

    if let Some(err) = error {
        lines.push(Line::from(""));
        lines.push(Line::from(Span::styled(
            format!("✗ {}", err),
            Style::default().fg(Color::Red),
        )));
    }

    lines.push(Line::from(""));
    lines.push(Line::from(Span::styled(
        "Press Enter to set │ Esc to cancel",
        Style::default().fg(Color::DarkGray),
    )));

    frame.render_widget(
        Paragraph::new(lines).block(
            Block::default()
                .title("🔑 Set API Key")
                .borders(Borders::ALL)
                .border_type(BorderType::Rounded),
        ),
        popup,
    );
}

/// Render the appropriate overlay based on state
pub fn render_overlay(
    frame: &mut Frame,
    area: Rect,
    overlay: &Overlay,
    local_tool_count: usize,
    remote_servers: &[RemoteServerEntry],
) {
    match overlay {
        Overlay::ServerManager(view) => match view {
            ServerManagerView::ServerList { selected } => {
                render_server_list(frame, area, local_tool_count, remote_servers, *selected);
            }
            ServerManagerView::ServerActions {
                server_id,
                selected,
            } => {
                // Find the server, or show error
                if server_id == "__local__" {
                    render_local_server(frame, area, local_tool_count);
                } else if let Some(server) = remote_servers.iter().find(|s| s.id == *server_id) {
                    render_server_actions(frame, area, server, *selected);
                }
            }
            ServerManagerView::AddServer { url_input, error } => {
                render_add_server(frame, area, url_input, error.as_deref());
            }
            ServerManagerView::SetToken {
                server_id,
                token_input,
                error,
            } => {
                if let Some(server) = remote_servers.iter().find(|s| s.id == *server_id) {
                    render_set_token(
                        frame,
                        area,
                        &server.name,
                        &server.url,
                        token_input,
                        error.as_deref(),
                    );
                }
            }
        },
    }
}
