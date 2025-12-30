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
    /// Model selection overlay
    ModelSelector {
        selected: usize,
        provider: String,
    },
    /// Provider selection overlay (simple quick-select)
    ProviderSelector {
        selected: usize,
    },
    /// Provider configuration wizard (multi-step)
    ProviderWizard {
        step: ProviderWizardStep,
        selected_provider: usize,
        selected_api_format: usize,
        base_url_input: String,
        model_input: String,
    },
}

/// Steps in the provider wizard
#[derive(Clone, Debug, PartialEq)]
pub enum ProviderWizardStep {
    /// Select provider from list
    SelectProvider,
    /// Select API format type for custom provider
    SelectApiFormat,
    /// Enter custom base URL (for custom providers)
    EnterBaseUrl,
    /// Enter model name
    EnterModel,
    /// Review and confirm
    Confirm,
}

/// Available API format types for custom providers
/// (id, name, default_url, example_model)
pub const API_FORMATS: &[(&str, &str, &str, &str)] = &[
    (
        "openai",
        "OpenAI Compatible",
        "https://api.openai.com/v1",
        "codex-mini-latest", // OpenAI's Codex model (o4-mini fine-tuned)
    ),
    (
        "anthropic",
        "Anthropic (Claude)",
        "https://api.anthropic.com/v1",
        "claude-haiku-4-5-20251001", // Claude Haiku 4.5
    ),
    (
        "google",
        "Google (Gemini)",
        "https://generativelanguage.googleapis.com/v1beta",
        "gemini-3-flash-preview", // Gemini 3 Flash
    ),
    (
        "openrouter",
        "OpenRouter (Multi-Provider)",
        "https://openrouter.ai/api/v1",
        "anthropic/claude-haiku-4-5", // Haiku 4.5 via OpenRouter
    ),
];

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
        Overlay::ModelSelector { selected, provider } => {
            render_model_selector(frame, area, provider, *selected);
        }
        Overlay::ProviderSelector { selected } => {
            render_provider_selector(frame, area, *selected);
        }
        Overlay::ProviderWizard {
            step,
            selected_provider,
            selected_api_format,
            base_url_input,
            model_input,
        } => {
            render_provider_wizard(
                frame,
                area,
                step,
                *selected_provider,
                *selected_api_format,
                base_url_input,
                model_input,
            );
        }
    }
}

/// Model options for each provider
pub fn get_models_for_provider(provider: &str) -> Vec<(&'static str, &'static str)> {
    match provider {
        "anthropic" => vec![
            ("claude-sonnet-4-20250514", "Claude Sonnet 4 (Latest)"),
            ("claude-3-5-sonnet-20241022", "Claude 3.5 Sonnet"),
            ("claude-3-5-haiku-20241022", "Claude 3.5 Haiku (Fast)"),
            ("claude-3-opus-20240229", "Claude 3 Opus"),
        ],
        "openai" => vec![
            ("gpt-4o", "GPT-4o (Latest)"),
            ("gpt-4o-mini", "GPT-4o Mini (Fast)"),
            ("gpt-4-turbo", "GPT-4 Turbo"),
            ("o1-preview", "o1 Preview (Reasoning)"),
        ],
        _ => vec![],
    }
}

/// Render model selection overlay
fn render_model_selector(frame: &mut Frame, area: Rect, provider: &str, selected: usize) {
    let popup = centered_rect(50, 50, area);
    frame.render_widget(Clear, popup);

    let models = get_models_for_provider(provider);

    let items: Vec<ListItem> = models
        .iter()
        .map(|(id, name)| {
            ListItem::new(Line::from(vec![
                Span::styled(*name, Style::default().fg(Color::White)),
                Span::styled(format!(" ({})", id), Style::default().fg(Color::DarkGray)),
            ]))
        })
        .collect();

    let title = format!("🤖 Select {} Model", provider);
    let list = List::new(items)
        .block(
            Block::default()
                .title(title)
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

/// Available AI providers (id, name, default_base_url)
/// If base_url is None, the user must provide one (custom provider)
pub const PROVIDERS: &[(&str, &str, Option<&str>)] = &[
    (
        "anthropic",
        "Anthropic (Claude)",
        Some("https://api.anthropic.com/v1"),
    ),
    ("openai", "OpenAI (GPT)", Some("https://api.openai.com/v1")),
    ("custom", "Custom (OpenAI-compatible)", None),
];

/// Render provider selection overlay
fn render_provider_selector(frame: &mut Frame, area: Rect, selected: usize) {
    let popup = centered_rect(50, 35, area);
    frame.render_widget(Clear, popup);

    let items: Vec<ListItem> = PROVIDERS
        .iter()
        .map(|(id, name, base_url)| {
            let url_hint = match base_url {
                Some(_) => "",
                None => " (enter URL)",
            };
            ListItem::new(Line::from(vec![
                Span::styled(*name, Style::default().fg(Color::White)),
                Span::styled(
                    format!(" ({}){}", id, url_hint),
                    Style::default().fg(Color::DarkGray),
                ),
            ]))
        })
        .collect();

    let list = List::new(items)
        .block(
            Block::default()
                .title("🔧 Select Provider")
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

/// Render provider configuration wizard
pub fn render_provider_wizard(
    frame: &mut Frame,
    area: Rect,
    step: &ProviderWizardStep,
    selected_provider: usize,
    selected_api_format: usize,
    base_url_input: &str,
    model_input: &str,
) {
    match step {
        ProviderWizardStep::SelectProvider => {
            render_provider_selector(frame, area, selected_provider);
        }
        ProviderWizardStep::SelectApiFormat => {
            let popup = centered_rect(50, 30, area);
            frame.render_widget(Clear, popup);

            let items: Vec<ListItem> = API_FORMATS
                .iter()
                .map(|(id, name, default_url, example_model)| {
                    ListItem::new(vec![
                        Line::from(vec![
                            Span::styled(*name, Style::default().fg(Color::White)),
                            Span::styled(
                                format!(" ({})", id),
                                Style::default().fg(Color::DarkGray),
                            ),
                        ]),
                        Line::from(vec![
                            Span::styled("  URL: ", Style::default().fg(Color::DarkGray)),
                            Span::styled(*default_url, Style::default().fg(Color::Cyan)),
                        ]),
                        Line::from(vec![
                            Span::styled("  Model: ", Style::default().fg(Color::DarkGray)),
                            Span::styled(*example_model, Style::default().fg(Color::Yellow)),
                        ]),
                    ])
                })
                .collect();

            let list = List::new(items)
                .block(
                    Block::default()
                        .title("🔌 Select API Format")
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
            state.select(Some(selected_api_format));
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
        ProviderWizardStep::EnterBaseUrl => {
            let popup = centered_rect(60, 25, area);
            frame.render_widget(Clear, popup);

            let block = Block::default()
                .title("🔗 Enter Base URL")
                .borders(Borders::ALL)
                .border_type(BorderType::Rounded);

            let inner = block.inner(popup);
            frame.render_widget(block, popup);

            // Instructions
            let instructions = Paragraph::new(vec![
                Line::from("Enter the base URL for your OpenAI-compatible API."),
                Line::from("Examples: http://localhost:11434/v1 (Ollama)"),
                Line::from("         https://api.groq.com/openai/v1 (Groq)"),
                Line::from(""),
            ])
            .style(Style::default().fg(Color::DarkGray));
            frame.render_widget(instructions, Rect::new(inner.x, inner.y, inner.width, 4));

            // Input field
            let input_area = Rect::new(inner.x, inner.y + 4, inner.width, 3);
            let input_block = Block::default()
                .borders(Borders::ALL)
                .border_type(BorderType::Rounded)
                .border_style(Style::default().fg(Color::Cyan));
            let input_inner = input_block.inner(input_area);
            frame.render_widget(input_block, input_area);

            let input_text = Paragraph::new(format!("{}▋", base_url_input));
            frame.render_widget(input_text, input_inner);

            // Hints
            let hints = Paragraph::new("Enter to continue │ Esc to cancel")
                .style(Style::default().fg(Color::DarkGray))
                .alignment(Alignment::Center);
            let hint_area = Rect::new(popup.x, popup.y + popup.height, popup.width, 1);
            if hint_area.y < area.height {
                frame.render_widget(hints, hint_area);
            }
        }
        ProviderWizardStep::EnterModel => {
            let popup = centered_rect(60, 25, area);
            frame.render_widget(Clear, popup);

            let block = Block::default()
                .title("🤖 Enter Model Name")
                .borders(Borders::ALL)
                .border_type(BorderType::Rounded);

            let inner = block.inner(popup);
            frame.render_widget(block, popup);

            // Get provider name for hint
            let provider_name = PROVIDERS
                .get(selected_provider)
                .map(|p| p.1)
                .unwrap_or("Custom");

            // Instructions
            let instructions = Paragraph::new(vec![
                Line::from(format!("Enter the model name for {}.", provider_name)),
                Line::from("Examples: gpt-4o, llama3.1, mixtral-8x7b"),
                Line::from(""),
            ])
            .style(Style::default().fg(Color::DarkGray));
            frame.render_widget(instructions, Rect::new(inner.x, inner.y, inner.width, 3));

            // Input field
            let input_area = Rect::new(inner.x, inner.y + 3, inner.width, 3);
            let input_block = Block::default()
                .borders(Borders::ALL)
                .border_type(BorderType::Rounded)
                .border_style(Style::default().fg(Color::Cyan));
            let input_inner = input_block.inner(input_area);
            frame.render_widget(input_block, input_area);

            let input_text = Paragraph::new(format!("{}▋", model_input));
            frame.render_widget(input_text, input_inner);

            // Hints
            let hints = Paragraph::new("Enter to continue │ Esc to cancel")
                .style(Style::default().fg(Color::DarkGray))
                .alignment(Alignment::Center);
            let hint_area = Rect::new(popup.x, popup.y + popup.height, popup.width, 1);
            if hint_area.y < area.height {
                frame.render_widget(hints, hint_area);
            }
        }
        ProviderWizardStep::Confirm => {
            let popup = centered_rect(50, 30, area);
            frame.render_widget(Clear, popup);

            let block = Block::default()
                .title("✓ Confirm Configuration")
                .borders(Borders::ALL)
                .border_type(BorderType::Rounded);

            let inner = block.inner(popup);
            frame.render_widget(block, popup);

            let (provider_id, provider_name, _) = PROVIDERS
                .get(selected_provider)
                .unwrap_or(&("custom", "Custom", None));

            let summary = Paragraph::new(vec![
                Line::from(vec![
                    Span::styled("Provider: ", Style::default().fg(Color::DarkGray)),
                    Span::styled(*provider_name, Style::default().fg(Color::White)),
                ]),
                Line::from(vec![
                    Span::styled("ID: ", Style::default().fg(Color::DarkGray)),
                    Span::styled(*provider_id, Style::default().fg(Color::Cyan)),
                ]),
                Line::from(vec![
                    Span::styled("Base URL: ", Style::default().fg(Color::DarkGray)),
                    Span::styled(base_url_input, Style::default().fg(Color::Green)),
                ]),
                Line::from(vec![
                    Span::styled("Model: ", Style::default().fg(Color::DarkGray)),
                    Span::styled(model_input, Style::default().fg(Color::Yellow)),
                ]),
                Line::from(""),
                Line::from(Span::styled(
                    "Press Enter to apply, Esc to cancel",
                    Style::default().fg(Color::DarkGray),
                )),
            ]);
            frame.render_widget(summary, inner);
        }
    }
}
