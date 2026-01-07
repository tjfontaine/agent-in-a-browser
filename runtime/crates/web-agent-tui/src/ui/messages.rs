use ratatui::{
    prelude::*,
    widgets::{Block, BorderType, Borders, Paragraph},
};

use crate::app::AppState;
use crate::display::{DisplayItem, TimelineEntry};
use crate::{Message, Role};

pub struct MessagesWidget<'a> {
    pub messages: &'a [Message],
    pub timeline: &'a [TimelineEntry],
    pub state: AppState,
}

impl<'a> MessagesWidget<'a> {
    pub fn new(messages: &'a [Message], timeline: &'a [TimelineEntry], state: AppState) -> Self {
        Self {
            messages,
            timeline,
            state,
        }
    }
}

impl<'a> Widget for MessagesWidget<'a> {
    fn render(self, area: Rect, buf: &mut Buffer) {
        let inner_width = area.width.saturating_sub(4) as usize; // Account for borders + prefix
        let visible_height = area.height.saturating_sub(2) as usize;

        // Build wrapped lines with styling from the unified timeline
        let mut lines: Vec<Line> = Vec::new();

        // Render timeline entries in chronological order (unified messages + display items)
        for entry in self.timeline {
            match entry {
                TimelineEntry::Message(msg) => {
                    let (prefix, style) = match msg.role {
                        Role::User => (
                            "› ",
                            Style::default()
                                .fg(Color::Cyan)
                                .add_modifier(Modifier::BOLD),
                        ),
                        Role::Assistant => ("◆ ", Style::default().fg(Color::Green)),
                    };

                    // Word-wrap the content manually for better control
                    let wrapped = wrap_text(&msg.content, inner_width.saturating_sub(2));

                    for (i, line_text) in wrapped.iter().enumerate() {
                        let line_prefix = if i == 0 { prefix } else { "  " };
                        lines.push(Line::from(vec![
                            Span::styled(line_prefix, style),
                            Span::styled(line_text.clone(), style.remove_modifier(Modifier::BOLD)),
                        ]));
                    }
                }
                TimelineEntry::Display(display_item) => {
                    let text = display_item.display_text();
                    let style = match display_item {
                        DisplayItem::ToolActivity { .. } => Style::default()
                            .fg(Color::Magenta)
                            .add_modifier(Modifier::ITALIC),
                        DisplayItem::ToolResult { is_error, .. } => {
                            if *is_error {
                                Style::default().fg(Color::Red)
                            } else {
                                Style::default().fg(Color::Green)
                            }
                        }
                        DisplayItem::Notice { kind, .. } => match kind {
                            crate::display::NoticeKind::Info => Style::default().fg(Color::Blue),
                            crate::display::NoticeKind::Warning => {
                                Style::default().fg(Color::Yellow)
                            }
                            crate::display::NoticeKind::Error => Style::default().fg(Color::Red),
                        },
                    };
                    lines.push(Line::from(Span::styled(text, style)));
                }
            }
        }

        // Add processing indicator
        if self.state == AppState::Processing {
            lines.push(Line::from(vec![
                Span::styled(
                    "⏳ ",
                    Style::default()
                        .fg(Color::Blue)
                        .add_modifier(Modifier::SLOW_BLINK),
                ),
                Span::styled(
                    "Thinking...",
                    Style::default().fg(Color::Blue).add_modifier(Modifier::DIM),
                ),
            ]));
        }

        // Calculate scroll offset to show latest
        let scroll_offset = if lines.len() > visible_height {
            lines.len() - visible_height
        } else {
            0
        };

        // Use Paragraph with scroll for wrapped text
        let text = Text::from(lines);
        let paragraph = Paragraph::new(text)
            .block(
                Block::default()
                    .borders(Borders::ALL)
                    .title(Span::styled(
                        " Messages ",
                        Style::default().add_modifier(Modifier::BOLD),
                    ))
                    .border_type(BorderType::Rounded),
            )
            .scroll((scroll_offset as u16, 0));

        paragraph.render(area, buf);
    }
}

/// Simple word wrap implementation
fn wrap_text(text: &str, max_width: usize) -> Vec<String> {
    if max_width == 0 {
        return vec![text.to_string()];
    }

    let mut lines = Vec::new();

    for paragraph in text.split('\n') {
        if paragraph.is_empty() {
            lines.push(String::new());
            continue;
        }

        let words: Vec<&str> = paragraph.split_whitespace().collect();
        if words.is_empty() {
            lines.push(String::new());
            continue;
        }

        let mut current_line = String::new();

        for word in words {
            if current_line.is_empty() {
                current_line = word.to_string();
            } else if current_line.len() + 1 + word.len() <= max_width {
                current_line.push(' ');
                current_line.push_str(word);
            } else {
                lines.push(current_line);
                current_line = word.to_string();
            }
        }

        if !current_line.is_empty() {
            lines.push(current_line);
        }
    }

    if lines.is_empty() {
        lines.push(String::new());
    }

    lines
}
