use ratatui::{
    prelude::*,
    widgets::{Block, BorderType, Borders, Paragraph},
};

use crate::app::AppState;
use crate::ui::Mode;

pub struct InputBoxWidget<'a> {
    pub mode: Mode,
    pub state: AppState,
    pub input: &'a str,
    pub cursor_pos: usize,
}

impl<'a> InputBoxWidget<'a> {
    pub fn new(mode: Mode, state: AppState, input: &'a str, cursor_pos: usize) -> Self {
        Self {
            mode,
            state,
            input,
            cursor_pos,
        }
    }
}

impl<'a> StatefulWidget for InputBoxWidget<'a> {
    type State = Option<(u16, u16)>; // Output cursor position

    fn render(self, area: Rect, buf: &mut Buffer, cursor_state: &mut Self::State) {
        let (prompt, title, display_input) = match self.state {
            AppState::NeedsApiKey => {
                let masked: String = "•".repeat(self.input.len());
                ("🔑 ", " API Key ", masked)
            }
            AppState::Processing => ("⏳ ", " Processing ", self.input.to_string()),
            AppState::Ready => {
                let prompt = match self.mode {
                    Mode::Agent => "› ",
                    Mode::Shell => "$ ",
                    Mode::Plan => "📋 ",
                };
                let title = match self.mode {
                    Mode::Agent => " Agent ",
                    Mode::Shell => " Shell ",
                    Mode::Plan => " Plan (read-only) ",
                };
                (prompt, title, self.input.to_string())
            }
        };

        let (border_style, border_type) = match self.state {
            AppState::NeedsApiKey => (Style::default().fg(Color::Yellow), BorderType::Double),
            AppState::Processing => (Style::default().fg(Color::Blue), BorderType::Rounded),
            AppState::Ready => (Style::default().fg(Color::White), BorderType::Rounded),
        };

        let paragraph = Paragraph::new(Line::from(vec![
            Span::styled(prompt, Style::default().add_modifier(Modifier::BOLD)),
            Span::raw(&display_input),
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

        paragraph.render(area, buf);

        // Calculate cursor position if needed
        if self.state != AppState::Processing {
            // Calculate cursor X position: border(1) + prompt_width + cursor_pos
            let prompt_width = prompt.chars().count() as u16;
            let cursor_x = area.x + 1 + prompt_width + self.cursor_pos.min(self.input.len()) as u16;
            let cursor_y = area.y + 1; // Inside the border

            // We can't set the cursor directly on the frame here because we only have the buffer.
            // But we can report it back via state if needed, or we rely on the caller to calculate it.
            // The original code called frame.set_cursor_position inside render_input.
            // Widgets typically don't set global cursor.
            // However, we can return the calculated position via the mutable state.
            *cursor_state = Some((cursor_x, cursor_y));
        } else {
            *cursor_state = None;
        }
    }
}
