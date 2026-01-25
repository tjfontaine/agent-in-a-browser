use ratatui::{prelude::*, widgets::Paragraph};

use crate::app::AppState;
use crate::ui::{Mode, ServerStatus};

pub struct StatusBarWidget<'a> {
    pub mode: Mode,
    pub state: AppState,
    pub server_status: &'a ServerStatus,
    pub model_name: &'a str,
}

impl<'a> StatusBarWidget<'a> {
    pub fn new(
        mode: Mode,
        state: AppState,
        server_status: &'a ServerStatus,
        model_name: &'a str,
    ) -> Self {
        Self {
            mode,
            state,
            server_status,
            model_name,
        }
    }
}

impl<'a> Widget for StatusBarWidget<'a> {
    fn render(self, area: Rect, buf: &mut Buffer) {
        let mode_str = match self.mode {
            Mode::Agent => " AGENT ",
            Mode::Shell => " SHELL ",
            Mode::Plan => " PLAN ",
        };

        let mode_style = match self.mode {
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
        // Using single-width symbols to avoid column alignment issues
        let (state_str, state_style) = match self.state {
            AppState::Ready => ("", Style::default()),
            AppState::NeedsApiKey => (
                " ⚿ KEY ", // U+26BF KEY (1 cell wide)
                Style::default().bg(Color::Yellow).fg(Color::Black),
            ),
            AppState::Processing => (
                " ⧖ WORKING ", // U+29D6 WHITE HOURGLASS (1 cell)
                Style::default()
                    .bg(Color::Magenta)
                    .fg(Color::White)
                    .add_modifier(Modifier::BOLD),
            ),
            AppState::Streaming => (
                " ◉ STREAMING ", // U+25C9 FISHEYE (1 cell wide)
                Style::default()
                    .bg(Color::Cyan)
                    .fg(Color::Black)
                    .add_modifier(Modifier::BOLD),
            ),
        };

        // Server status
        let local_indicator = if self.server_status.local_connected {
            "●"
        } else {
            "○"
        };
        let local_style = if self.server_status.local_connected {
            Style::default().fg(Color::Green)
        } else {
            Style::default().fg(Color::DarkGray)
        };

        let remote_count = self
            .server_status
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
            Span::styled(self.model_name, Style::default().fg(Color::Cyan)),
            Span::raw(" │ L:"),
            Span::styled(local_indicator, local_style),
            Span::raw(" R:"),
            Span::styled(&remote_indicator, remote_style),
            Span::raw(" │ "),
            Span::styled("^C quit  /help", Style::default().fg(Color::DarkGray)),
        ]);

        let status = Line::from(spans);

        let paragraph = Paragraph::new(status).style(Style::default().bg(Color::Rgb(25, 25, 35)));

        paragraph.render(area, buf);
    }
}
