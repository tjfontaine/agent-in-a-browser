//! Server Manager Overlay UI
//!
//! Wizard-style interface for managing MCP servers.
//! Uses ratatui List, Paragraph, and Block widgets.

use ratatui::{prelude::*, widgets::*};

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
    /// Provider selection overlay (simple quick-select)
    ProviderSelector {
        selected: usize,
    },
    /// Provider configuration wizard (multi-step)
    /// Also used for standalone model selection via /model command
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
        /// If true, opened from /model command - select model and close on completion
        /// If false, opened from /provider wizard - return to ProviderConfig on completion
        standalone: bool,
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
        Span::raw("☐ Local (sandbox)"), // U+2610 BALLOT BOX (1 cell)
        Span::styled(
            format!(" [{} tools]", local_tool_count),
            Style::default().fg(Color::DarkGray),
        ),
    ])));

    // Add new option (second)
    items.push(ListItem::new(Line::from(vec![
        Span::styled("+ ", Style::default().fg(Color::Blue)), // ASCII plus (1 cell)
        Span::raw("Add new server..."),
    ])));

    // Remote servers
    for server in remote_servers {
        let (icon, color) = match &server.status {
            ServerConnectionStatus::Connected => ("● ", Color::Green),
            ServerConnectionStatus::Connecting => ("◐ ", Color::Yellow),
            ServerConnectionStatus::AuthRequired => ("⚿ ", Color::Yellow), // U+26BF KEY (1 cell)
            ServerConnectionStatus::Error(_) => ("✗ ", Color::Red),
            ServerConnectionStatus::Disconnected => ("○ ", Color::DarkGray),
        };

        items.push(ListItem::new(Line::from(vec![
            Span::styled(icon, Style::default().fg(color)),
            Span::raw(format!("◎ {}", server.name)), // U+25CE BULLSEYE (1 cell)
            Span::styled(
                format!(" [{} tools]", server.tools.len()),
                Style::default().fg(Color::DarkGray),
            ),
        ])));
    }

    let list = List::new(items)
        .block(
            Block::default()
                .title("◎ MCP Servers") // U+25CE BULLSEYE (1 cell)
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
        actions.push(ListItem::new("⚡ Connect")); // U+26A1 (1 cell)
    }
    actions.push(ListItem::new("⚿ Set API Key")); // U+26BF KEY (1 cell)
    actions.push(ListItem::new("✗ Remove")); // U+2717 BALLOT X (1 cell)
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
                .title("⚿ Set API Key") // U+26BF KEY (1 cell)
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
            standalone: _,
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
        "webllm" => vec![
            // HuggingFace models for transformers.js (browser)
            ("onnx-community/Qwen3-0.6B-ONNX", "Qwen3 0.6B (Recommended)"),
            ("HuggingFaceTB/SmolLM2-360M-Instruct", "SmolLM2 360M (Fast)"),
            ("HuggingFaceTB/SmolLM2-1.7B-Instruct", "SmolLM2 1.7B"),
            ("Qwen/Qwen2.5-0.5B-Instruct", "Qwen 2.5 0.5B (Tiny)"),
        ],
        _ => vec![],
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
    (
        "webllm",
        "WebLLM (Local Browser)",
        Some("http://webllm.local/v1"), // Intercepted by wasi-http transport
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
                .title("⚙ Select Provider") // U+2699 GEAR (1 cell)
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
                .title("⚿ Edit API Key") // U+26BF KEY (1 cell)
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

#[cfg(test)]
mod tests {
    use super::*;

    // === API Key Masking Tests ===

    #[test]
    fn test_api_key_mask_length() {
        // The mask logic: "*".repeat(api_key_input.len().min(40))
        assert_eq!("*".repeat(0), "");
        assert_eq!("*".repeat(5), "*****");
        assert_eq!("*".repeat(10), "**********");
    }

    #[test]
    fn test_api_key_mask_caps_at_40() {
        // Keys longer than 40 chars should cap at 40 asterisks
        let long_key = "x".repeat(100);
        let masked = "*".repeat(long_key.len().min(40));
        assert_eq!(masked.len(), 40);
        assert_eq!(masked, "*".repeat(40));
    }

    #[test]
    fn test_api_key_mask_short_key() {
        let short_key = "sk-abc123";
        let masked = "*".repeat(short_key.len().min(40));
        assert_eq!(masked.len(), 9);
    }

    // === ProviderWizardStep Tests ===

    #[test]
    fn test_provider_wizard_step_variants() {
        // Verify all step variants exist and can be created
        let _ = ProviderWizardStep::SelectProvider;
        let _ = ProviderWizardStep::ProviderConfig;
        let _ = ProviderWizardStep::EditModel;
        let _ = ProviderWizardStep::EditBaseUrl;
        let _ = ProviderWizardStep::EditApiKey;
    }

    #[test]
    fn test_provider_wizard_step_equality() {
        assert_eq!(
            ProviderWizardStep::EditApiKey,
            ProviderWizardStep::EditApiKey
        );
        assert_ne!(
            ProviderWizardStep::EditApiKey,
            ProviderWizardStep::EditModel
        );
        assert_ne!(
            ProviderWizardStep::SelectProvider,
            ProviderWizardStep::ProviderConfig
        );
    }

    #[test]
    fn test_provider_wizard_step_debug() {
        // Test Debug trait
        assert_eq!(
            format!("{:?}", ProviderWizardStep::EditApiKey),
            "EditApiKey"
        );
        assert_eq!(
            format!("{:?}", ProviderWizardStep::SelectProvider),
            "SelectProvider"
        );
    }

    // === Centered Rect Tests ===

    #[test]
    fn test_centered_rect_calculation() {
        let area = Rect::new(0, 0, 100, 50);
        let popup = centered_rect(50, 50, area);

        // 50% of 100 = 50, centered = (100-50)/2 = 25
        assert_eq!(popup.width, 50);
        assert_eq!(popup.x, 25);

        // 50% of 50 = 25, centered = (50-25)/2 = 12
        assert_eq!(popup.height, 25);
        assert_eq!(popup.y, 12);
    }

    #[test]
    fn test_centered_rect_small_popup() {
        let area = Rect::new(0, 0, 80, 24);
        let popup = centered_rect(60, 35, area);

        // 60% of 80 = 48, centered = (80-48)/2 = 16
        assert_eq!(popup.width, 48);
        assert_eq!(popup.x, 16);

        // 35% of 24 = 8, centered = (24-8)/2 = 8
        assert_eq!(popup.height, 8);
        assert_eq!(popup.y, 8);
    }

    #[test]
    fn test_centered_rect_with_offset() {
        let area = Rect::new(10, 5, 100, 50);
        let popup = centered_rect(50, 50, area);

        // Should be centered within the area, plus the area offset
        assert_eq!(popup.x, 10 + 25); // area.x + centering offset
        assert_eq!(popup.y, 5 + 12); // area.y + centering offset
    }

    // === Provider/Model Helper Tests ===

    #[test]
    fn test_get_models_for_known_providers() {
        let anthropic_models = get_models_for_provider("anthropic");
        assert!(!anthropic_models.is_empty());
        assert!(anthropic_models.iter().any(|(id, _)| id.contains("claude")));

        let openai_models = get_models_for_provider("openai");
        assert!(!openai_models.is_empty());
        assert!(openai_models.iter().any(|(id, _)| id.contains("gpt")));

        let gemini_models = get_models_for_provider("gemini");
        assert!(!gemini_models.is_empty());
        assert!(gemini_models.iter().any(|(id, _)| id.contains("gemini")));
    }

    #[test]
    fn test_get_models_for_unknown_provider() {
        let models = get_models_for_provider("nonexistent");
        assert!(models.is_empty());
    }

    #[test]
    fn test_providers_constant() {
        // PROVIDERS should have expected entries
        assert!(PROVIDERS.len() >= 4);

        // Check expected providers exist
        assert!(PROVIDERS.iter().any(|(id, _, _)| *id == "anthropic"));
        assert!(PROVIDERS.iter().any(|(id, _, _)| *id == "openai"));
        assert!(PROVIDERS.iter().any(|(id, _, _)| *id == "gemini"));
    }

    #[test]
    fn test_api_formats_constant() {
        // API_FORMATS should have OpenAI-compatible formats
        assert!(API_FORMATS.len() >= 3);
        assert!(API_FORMATS.iter().any(|(id, _, _, _)| *id == "openai"));
        assert!(API_FORMATS.iter().any(|(id, _, _, _)| *id == "anthropic"));
    }

    // === Overlay Enum Tests ===

    #[test]
    fn test_overlay_variants() {
        // Test that all overlay variants can be created
        let _ = Overlay::ServerManager(ServerManagerView::default());
        let _ = Overlay::ProviderSelector { selected: 0 };
        let _ = Overlay::ProviderWizard {
            step: ProviderWizardStep::SelectProvider,
            selected_provider: 0,
            selected_api_format: 0,
            selected_model: 0,
            selected_field: 0,
            base_url_input: String::new(),
            model_input: String::new(),
            api_key_input: String::new(),
            fetched_models: None,
            standalone: false,
        };
    }

    #[test]
    fn test_provider_wizard_overlay_api_key_storage() {
        // Test that API key is stored in the overlay
        let overlay = Overlay::ProviderWizard {
            step: ProviderWizardStep::EditApiKey,
            selected_provider: 0,
            selected_api_format: 0,
            selected_model: 0,
            selected_field: 0,
            base_url_input: String::new(),
            model_input: String::new(),
            api_key_input: "sk-test-key-123".to_string(),
            fetched_models: None,
            standalone: false,
        };

        if let Overlay::ProviderWizard { api_key_input, .. } = overlay {
            assert_eq!(api_key_input, "sk-test-key-123");
        } else {
            panic!("Expected ProviderWizard variant");
        }
    }

    // === ServerManagerView Tests ===

    #[test]
    fn test_server_manager_view_default() {
        let view = ServerManagerView::default();
        if let ServerManagerView::ServerList { selected } = view {
            assert_eq!(selected, 0);
        } else {
            panic!("Expected ServerList variant");
        }
    }

    #[test]
    fn test_set_token_view() {
        let view = ServerManagerView::SetToken {
            server_id: "test-server".to_string(),
            token_input: "my-secret-token".to_string(),
            error: None,
        };

        if let ServerManagerView::SetToken {
            server_id,
            token_input,
            error,
        } = view
        {
            assert_eq!(server_id, "test-server");
            assert_eq!(token_input, "my-secret-token");
            assert!(error.is_none());
        } else {
            panic!("Expected SetToken variant");
        }
    }

    #[test]
    fn test_set_token_view_with_error() {
        let view = ServerManagerView::SetToken {
            server_id: "test-server".to_string(),
            token_input: String::new(),
            error: Some("Invalid token format".to_string()),
        };

        if let ServerManagerView::SetToken { error, .. } = view {
            assert_eq!(error, Some("Invalid token format".to_string()));
        } else {
            panic!("Expected SetToken variant");
        }
    }
}
