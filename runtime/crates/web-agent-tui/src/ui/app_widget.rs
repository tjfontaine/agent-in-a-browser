//! AppWidget - Top-level widget for rendering the entire application UI
//!
//! This widget composes all sub-widgets (Messages, Input, StatusBar, AuxPanel, Overlay)
//! and handles the main layout.

use ratatui::prelude::*;
use std::io::{Read, Write};

use crate::app::App;
use crate::ui::panels::AuxPanelWidget;
use crate::ui::{InputBoxWidget, MessagesWidget, StatusBarWidget};

/// Widget wrapper for rendering the entire App UI
pub struct AppWidget<'a, R: Read, W: Write> {
    app: &'a App<R, W>,
}

impl<'a, R: Read, W: Write> AppWidget<'a, R, W> {
    pub fn new(app: &'a App<R, W>) -> Self {
        Self { app }
    }
}

impl<'a, R: Read, W: Write> Widget for AppWidget<'a, R, W> {
    fn render(self, area: Rect, buf: &mut Buffer) {
        // Check if we have enough width for split layout (min 80 cols)
        let use_split = area.width >= 80;

        // Split into main area and status bar
        let v_chunks = Layout::default()
            .direction(Direction::Vertical)
            .constraints([
                Constraint::Min(3),    // Main content
                Constraint::Length(1), // Status bar
            ])
            .split(area);

        if use_split {
            // Horizontal split: main (70%) | aux (30%)
            let h_chunks = Layout::default()
                .direction(Direction::Horizontal)
                .constraints([Constraint::Percentage(70), Constraint::Percentage(30)])
                .split(v_chunks[0]);

            self.render_main_panel(h_chunks[0], buf);
            AuxPanelWidget::new(&self.app.aux_content, &self.app.server_status)
                .render(h_chunks[1], buf);
        } else {
            // Single column layout for narrow terminals
            self.render_main_panel(v_chunks[0], buf);
        }

        // Status bar
        StatusBarWidget::new(
            self.app.mode,
            self.app.state,
            &self.app.server_status,
            self.app.model_name(),
        )
        .render(v_chunks[1], buf);

        // Note: Overlay rendering requires frame.render_widget for layering.
        // This is a limitation - overlays need special handling.
        // For now, we'll skip overlay rendering in the pure Widget impl.
        // The caller (App::render) will handle overlays separately.
    }
}

impl<'a, R: Read, W: Write> AppWidget<'a, R, W> {
    fn render_main_panel(&self, area: Rect, buf: &mut Buffer) {
        let chunks = Layout::default()
            .direction(Direction::Vertical)
            .constraints([
                Constraint::Min(3),    // Messages/output
                Constraint::Length(3), // Input box
            ])
            .split(area);

        // Messages
        MessagesWidget::new(&self.app.messages, self.app.state).render(chunks[0], buf);

        // Input Box - we can't set cursor here, caller must handle it
        let mut cursor_state = None;
        InputBoxWidget::new(
            self.app.mode,
            self.app.state,
            self.app.input.text(),
            self.app.input.cursor_pos(),
        )
        .render(chunks[1], buf, &mut cursor_state);

        // Note: cursor_state is lost here. Caller must recalculate or we need a different approach.
    }
}
