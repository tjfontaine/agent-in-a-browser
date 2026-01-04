//! Server Manager Overlay UI
//!
//! Wizard-style interface for managing MCP servers.
//! Uses ratatui List, Paragraph, and Block widgets.

use ratatui::{prelude::*, widgets::*};

use crate::bridge::mcp_client::ToolDefinition;
use crate::servers::{RemoteServerEntry, ServerConnectionStatus};

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
        /// Models fetched from API (None = not fetched yet, Some([]) = empty/failed)
        fetched_models: Option<Vec<(String, String)>>,
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
        selected_model: usize,
        /// Which field is selected in ProviderConfig view (0=Model, 1=BaseURL, 2=ApiKey, 3=Apply&Save, 4=Save, 5=Back)
        selected_field: usize,
        base_url_input: String,
        model_input: String,
        api_key_input: String,
        /// Models fetched from API (None = not fetched, Some([]) = empty/failed)
        fetched_models: Option<Vec<(String, String)>>,
    },
}

/// Steps in the provider wizard
#[derive(Clone, Debug, PartialEq)]
pub enum ProviderWizardStep {
    /// Select provider from list
    SelectProvider,
    /// View/edit provider configuration (new main step)
    ProviderConfig,
    /// Edit model (text input or list selection)
    EditModel,
    /// Edit base URL (text input)
    EditBaseUrl,
    /// Edit API key (masked text input)
    EditApiKey,
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
        "https://api.anthropic.com", // rig-core adds /v1/messages
        "claude-haiku-4-5-20251015", // Claude Haiku 4.5
    ),
    (
        "google",
        "Google (Gemini)",
        "https://generativelanguage.googleapis.com/v1beta",
        "gemini-3-flash-preview", // Gemini 3 Flash Preview
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
        Overlay::ModelSelector {
            selected,
            provider,
            fetched_models,
        } => {
            render_model_selector(frame, area, provider, *selected, fetched_models.as_ref());
        }
        Overlay::ProviderSelector { selected } => {
            render_provider_selector(frame, area, *selected);
        }
        Overlay::ProviderWizard {
            step,
            selected_provider,
            selected_api_format,
            selected_model,
            selected_field,
            base_url_input,
            model_input,
            api_key_input,
            fetched_models,
        } => {
            render_provider_wizard(
                frame,
                area,
                step,
                *selected_provider,
                *selected_api_format,
                *selected_model,
                *selected_field,
                base_url_input,
                model_input,
                api_key_input,
                fetched_models.as_ref(),
            );
        }
    }
}

/// Model options for each provider (static fallback when API refresh not used)
/// Updated January 2026 with latest available models
pub fn get_models_for_provider(provider: &str) -> Vec<(&'static str, &'static str)> {
    match provider {
        "anthropic" => vec![
            // Claude 4 series (latest as of late 2025)
            (
                "claude-haiku-4-5-20251015",
                "Claude Haiku 4.5 (Fast, Default)",
            ),
            ("claude-sonnet-4-5-20250929", "Claude Sonnet 4.5"),
            (
                "claude-opus-4-5-20251124",
                "Claude Opus 4.5 (Most Powerful)",
            ),
            ("claude-opus-4-1-20250805", "Claude Opus 4.1"),
            ("claude-sonnet-4-20250522", "Claude Sonnet 4"),
            // Claude 3 series (legacy)
            ("claude-3-7-sonnet-20250224", "Claude 3.7 Sonnet"),
        ],
        "openai" => vec![
            // GPT-5 series (latest as of late 2025)
            ("gpt-5.2", "GPT-5.2 (Latest)"),
            ("gpt-5.1", "GPT-5.1"),
            ("gpt-5", "GPT-5"),
            // o-series reasoning models
            ("o4-mini", "o4-mini (Fast Reasoning)"),
            ("o3-pro", "o3-pro (Deep Reasoning)"),
            ("o3", "o3 (Reasoning)"),
            // GPT-4 series
            ("gpt-4.1", "GPT-4.1 (Coding)"),
            ("gpt-4o", "GPT-4o"),
            ("gpt-4o-mini", "GPT-4o Mini (Fast)"),
            // Specialized
            ("codex-max", "Codex-Max (Software Dev)"),
        ],
        "google" | "gemini" => vec![
            // Gemini 3 series (preview, launched late 2025)
            (
                "gemini-3-flash-preview",
                "Gemini 3 Flash Preview (Fast, Default)",
            ),
            (
                "gemini-3-pro-preview",
                "Gemini 3 Pro Preview (Most Powerful)",
            ),
            // Gemini 2.5 series
            ("gemini-2.5-flash", "Gemini 2.5 Flash"),
            ("gemini-2.5-pro-preview-06-05", "Gemini 2.5 Pro Preview"),
            // Gemini 2.0 series
            ("gemini-2.0-flash", "Gemini 2.0 Flash"),
            ("gemini-2.0-flash-lite", "Gemini 2.0 Flash Lite (Fastest)"),
        ],
        "openrouter" => vec![
            ("anthropic/claude-haiku-4-5", "Claude Haiku 4.5"),
            ("anthropic/claude-sonnet-4-5", "Claude Sonnet 4.5"),
            ("anthropic/claude-opus-4-5", "Claude Opus 4.5"),
            ("openai/gpt-5.2", "GPT-5.2"),
            ("openai/o4-mini", "o4-mini"),
            ("google/gemini-3-flash", "Gemini 3 Flash"),
        ],
        _ => vec![],
    }
}

/// Render model selection overlay
fn render_model_selector(
    frame: &mut Frame,
    area: Rect,
    provider: &str,
    selected: usize,
    fetched_models: Option<&Vec<(String, String)>>,
) {
    let popup = centered_rect(55, 60, area);
    frame.render_widget(Clear, popup);

    // Build items list: Refresh option + models
    let mut items: Vec<ListItem> = Vec::new();

    // First item: Refresh from API
    items.push(ListItem::new(Line::from(vec![
        Span::styled("🔄 ", Style::default().fg(Color::Yellow)),
        Span::styled("Refresh from API", Style::default().fg(Color::Yellow)),
    ])));

    // Models: use fetched if available, otherwise static
    if let Some(models) = fetched_models {
        if models.is_empty() {
            items.push(ListItem::new(Span::styled(
                "  (No models fetched - try refresh)",
                Style::default().fg(Color::DarkGray),
            )));
        } else {
            for (id, name) in models {
                items.push(ListItem::new(Line::from(vec![
                    Span::styled(name.as_str(), Style::default().fg(Color::White)),
                    Span::styled(format!(" ({})", id), Style::default().fg(Color::DarkGray)),
                ])));
            }
        }
    } else {
        // Static fallback models
        let static_models = get_models_for_provider(provider);
        for (id, name) in static_models {
            items.push(ListItem::new(Line::from(vec![
                Span::styled(name, Style::default().fg(Color::White)),
                Span::styled(format!(" ({})", id), Style::default().fg(Color::DarkGray)),
            ])));
        }
    }

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
/// If base_url is None, rig-core uses its built-in default (recommended for standard providers)
pub const PROVIDERS: &[(&str, &str, Option<&str>)] = &[
    ("anthropic", "Anthropic (Claude)", None), // rig-core default: api.anthropic.com
    ("openai", "OpenAI (GPT)", None),          // rig-core default: api.openai.com
    (
        "gemini",
        "Google (Gemini)",
        None, // rig-core default: generativelanguage.googleapis.com
    ),
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
    _selected_api_format: usize,
    selected_model: usize,
    selected_field: usize,
    base_url_input: &str,
    model_input: &str,
    api_key_input: &str,
    fetched_models: Option<&Vec<(String, String)>>,
) {
    match step {
        ProviderWizardStep::SelectProvider => {
            render_provider_selector(frame, area, selected_provider);
        }
        ProviderWizardStep::ProviderConfig => {
            let popup = centered_rect(55, 45, area);
            frame.render_widget(Clear, popup);

            let (_provider_id, provider_name, _) = PROVIDERS
                .get(selected_provider)
                .unwrap_or(&("custom", "Custom", None));

            let block = Block::default()
                .title(format!("⚙️  Configure: {}", provider_name))
                .borders(Borders::ALL)
                .border_type(BorderType::Rounded);

            let inner = block.inner(popup);
            frame.render_widget(block, popup);

            // Build list items for config fields
            let mut items: Vec<ListItem> = Vec::new();

            // 0: Model field
            let model_display = if model_input.is_empty() {
                "(not set)"
            } else {
                model_input
            };
            items.push(ListItem::new(Line::from(vec![
                Span::styled("Model:    ", Style::default().fg(Color::DarkGray)),
                Span::styled(model_display, Style::default().fg(Color::Yellow)),
            ])));

            // 1: Base URL field
            let base_url_display = if base_url_input.is_empty() {
                "(default)"
            } else {
                base_url_input
            };
            items.push(ListItem::new(Line::from(vec![
                Span::styled("Base URL: ", Style::default().fg(Color::DarkGray)),
                Span::styled(base_url_display, Style::default().fg(Color::Cyan)),
            ])));

            // 2: API Key field
            let api_key_status = if api_key_input.is_empty() {
                "✗ not set"
            } else {
                "✓ configured"
            };
            let api_key_color = if api_key_input.is_empty() {
                Color::Red
            } else {
                Color::Green
            };
            items.push(ListItem::new(Line::from(vec![
                Span::styled("API Key:  ", Style::default().fg(Color::DarkGray)),
                Span::styled(api_key_status, Style::default().fg(api_key_color)),
            ])));

            // Separator
            items.push(ListItem::new(Line::from("")));

            // 3: Apply & Save action
            items.push(ListItem::new(Line::from(vec![
                Span::styled(
                    "[Apply & Save]",
                    Style::default()
                        .fg(Color::Green)
                        .add_modifier(Modifier::BOLD),
                ),
                Span::styled("  set as default", Style::default().fg(Color::DarkGray)),
            ])));

            // 4: Save action
            items.push(ListItem::new(Line::from(vec![
                Span::styled(
                    "[Save]",
                    Style::default()
                        .fg(Color::Blue)
                        .add_modifier(Modifier::BOLD),
                ),
                Span::styled(
                    "          keep settings",
                    Style::default().fg(Color::DarkGray),
                ),
            ])));

            // 5: Back action
            items.push(ListItem::new(Line::from(vec![Span::styled(
                "[Back]",
                Style::default().fg(Color::DarkGray),
            )])));

            let list = List::new(items)
                .highlight_style(
                    Style::default()
                        .add_modifier(Modifier::REVERSED)
                        .fg(Color::Cyan),
                )
                .highlight_symbol("▶ ");

            let mut state = ListState::default();
            // Map selected_field to actual list index (skip separator at index 3)
            let list_idx = if selected_field >= 3 {
                selected_field + 1
            } else {
                selected_field
            };
            state.select(Some(list_idx));
            frame.render_stateful_widget(list, inner, &mut state);

            // Hints at bottom
            let hints = Paragraph::new("↑↓ Navigate │ Enter Edit/Select │ Esc Close")
                .style(Style::default().fg(Color::DarkGray))
                .alignment(Alignment::Center);
            let hint_area = Rect::new(popup.x, popup.y + popup.height, popup.width, 1);
            if hint_area.y < area.height {
                frame.render_widget(hints, hint_area);
            }
        }
        ProviderWizardStep::EditModel => {
            let popup = centered_rect(55, 50, area);
            frame.render_widget(Clear, popup);

            let (provider_id, _, _) = PROVIDERS
                .get(selected_provider)
                .unwrap_or(&("openai", "OpenAI", None));

            // Use fetched models if available, otherwise use static fallback
            let static_models = get_models_for_provider(provider_id);
            let model_count = if let Some(models) = fetched_models {
                models.len()
            } else {
                static_models.len()
            };

            // Build items from fetched or static models
            let mut items: Vec<ListItem> = if let Some(models) = fetched_models {
                models
                    .iter()
                    .map(|(id, name)| {
                        ListItem::new(Line::from(vec![
                            Span::styled(name.as_str(), Style::default().fg(Color::White)),
                            Span::styled(
                                format!(" ({})", id),
                                Style::default().fg(Color::DarkGray),
                            ),
                        ]))
                    })
                    .collect()
            } else {
                static_models
                    .iter()
                    .map(|(id, name)| {
                        ListItem::new(Line::from(vec![
                            Span::styled(*name, Style::default().fg(Color::White)),
                            Span::styled(
                                format!(" ({})", id),
                                Style::default().fg(Color::DarkGray),
                            ),
                        ]))
                    })
                    .collect()
            };

            // Add [Refresh from API] at the top when not yet fetched
            if fetched_models.is_none() {
                items.insert(
                    0,
                    ListItem::new(Line::from(vec![
                        Span::styled("🔄 ", Style::default().fg(Color::Cyan)),
                        Span::styled(
                            "[Refresh from API]",
                            Style::default()
                                .fg(Color::Cyan)
                                .add_modifier(Modifier::BOLD),
                        ),
                    ])),
                );
            }

            // Add custom input option at the end
            items.push(ListItem::new(Line::from(vec![
                Span::styled("✏️  ", Style::default().fg(Color::Yellow)),
                Span::styled("Custom: ", Style::default().fg(Color::Yellow)),
                Span::styled(
                    if model_input.is_empty() {
                        "(type to enter)"
                    } else {
                        model_input
                    },
                    Style::default().fg(if model_input.is_empty() {
                        Color::DarkGray
                    } else {
                        Color::Cyan
                    }),
                ),
            ])));

            // Title shows if using API or static models
            let title = if fetched_models.is_some() {
                format!("🤖 {} Models (API)", provider_id)
            } else {
                format!("🤖 {} Models", provider_id)
            };

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
            state.select(Some(selected_model));
            frame.render_stateful_widget(list, popup, &mut state);

            // Hints - show refresh option when not yet fetched
            let hints = if selected_model == model_count {
                if fetched_models.is_none() {
                    "Type model │ r Refresh │ Enter Save │ Esc Cancel"
                } else {
                    "Type model name │ Enter to save │ Esc to cancel"
                }
            } else if fetched_models.is_none() {
                "↑↓ Navigate │ r Refresh │ Enter Save │ Esc Cancel"
            } else {
                "↑↓ Navigate │ Enter to save │ Esc to cancel"
            };
            let hints_widget = Paragraph::new(hints)
                .style(Style::default().fg(Color::DarkGray))
                .alignment(Alignment::Center);
            let hint_area = Rect::new(popup.x, popup.y + popup.height, popup.width, 1);
            if hint_area.y < area.height {
                frame.render_widget(hints_widget, hint_area);
            }
        }
        ProviderWizardStep::EditBaseUrl => {
            let popup = centered_rect(60, 25, area);
            frame.render_widget(Clear, popup);

            let block = Block::default()
                .title("🔗 Edit Base URL")
                .borders(Borders::ALL)
                .border_type(BorderType::Rounded);

            let inner = block.inner(popup);
            frame.render_widget(block, popup);

            // Instructions
            let instructions = Paragraph::new(vec![
                Line::from("Enter base URL (leave empty for default)."),
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
            let hints = Paragraph::new("Enter to save │ Esc to cancel")
                .style(Style::default().fg(Color::DarkGray))
                .alignment(Alignment::Center);
            let hint_area = Rect::new(popup.x, popup.y + popup.height, popup.width, 1);
            if hint_area.y < area.height {
                frame.render_widget(hints, hint_area);
            }
        }
        ProviderWizardStep::EditApiKey => {
            let popup = centered_rect(60, 25, area);
            frame.render_widget(Clear, popup);

            let block = Block::default()
                .title("🔑 Edit API Key")
                .borders(Borders::ALL)
                .border_type(BorderType::Rounded);

            let inner = block.inner(popup);
            frame.render_widget(block, popup);

            // Instructions
            let (provider_id, _, _) = PROVIDERS
                .get(selected_provider)
                .unwrap_or(&("custom", "Custom", None));

            let instructions = Paragraph::new(vec![
                Line::from(format!("Enter API key for {}.", provider_id)),
                Line::from(""),
            ])
            .style(Style::default().fg(Color::DarkGray));
            frame.render_widget(instructions, Rect::new(inner.x, inner.y, inner.width, 2));

            // Input field (masked)
            let input_area = Rect::new(inner.x, inner.y + 2, inner.width, 3);
            let input_block = Block::default()
                .borders(Borders::ALL)
                .border_type(BorderType::Rounded)
                .border_style(Style::default().fg(Color::Cyan));
            let input_inner = input_block.inner(input_area);
            frame.render_widget(input_block, input_area);

            // Show masked key
            let masked = "*".repeat(api_key_input.len().min(40));
            let input_text = Paragraph::new(format!("{}▋", masked));
            frame.render_widget(input_text, input_inner);

            // Hints
            let hints = Paragraph::new("Enter to save │ Esc to cancel")
                .style(Style::default().fg(Color::DarkGray))
                .alignment(Alignment::Center);
            let hint_area = Rect::new(popup.x, popup.y + popup.height, popup.width, 1);
            if hint_area.y < area.height {
                frame.render_widget(hints, hint_area);
            }
        }
    }
}
