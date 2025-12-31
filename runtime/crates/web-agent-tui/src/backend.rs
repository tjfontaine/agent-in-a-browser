//! Custom WASI backend for ratatui
//!
//! Implements ratatui::backend::Backend for WASIP2 stdout streams.

use ratatui::backend::{Backend, ClearType, WindowSize};
use ratatui::buffer::Cell;
use ratatui::layout::{Position, Size};
use ratatui::style::{Color, Modifier, Style};
use std::io::{Error as IOError, Result as IOResult, Write};

/// A backend that writes ANSI escape codes to any Write implementor
pub struct WasiBackend<W: Write> {
    writer: W,
    width: u16,
    height: u16,
}

impl<W: Write> WasiBackend<W> {
    pub fn new(writer: W, width: u16, height: u16) -> Self {
        Self {
            writer,
            width,
            height,
        }
    }

    pub fn set_size(&mut self, width: u16, height: u16) {
        self.width = width;
        self.height = height;
    }

    /// Get mutable reference to the writer
    pub fn writer_mut(&mut self) -> &mut W {
        &mut self.writer
    }

    fn write_ansi(&mut self, s: &str) -> IOResult<()> {
        self.writer.write_all(s.as_bytes())
    }

    fn apply_style(&mut self, style: Style) -> IOResult<()> {
        // Reset first
        self.write_ansi("\x1b[0m")?;

        // Apply foreground color
        if let Some(fg) = style.fg {
            self.write_ansi(&color_to_ansi_fg(fg))?;
        }

        // Apply background color
        if let Some(bg) = style.bg {
            self.write_ansi(&color_to_ansi_bg(bg))?;
        }

        // Apply modifiers
        let mods = style.add_modifier;
        if mods.contains(Modifier::BOLD) {
            self.write_ansi("\x1b[1m")?;
        }
        if mods.contains(Modifier::DIM) {
            self.write_ansi("\x1b[2m")?;
        }
        if mods.contains(Modifier::ITALIC) {
            self.write_ansi("\x1b[3m")?;
        }
        if mods.contains(Modifier::UNDERLINED) {
            self.write_ansi("\x1b[4m")?;
        }

        Ok(())
    }
}

impl<W: Write> Backend for WasiBackend<W> {
    type Error = IOError;

    fn draw<'a, I>(&mut self, content: I) -> IOResult<()>
    where
        I: Iterator<Item = (u16, u16, &'a Cell)>,
    {
        let mut last_pos: Option<(u16, u16)> = None;
        let mut last_style: Option<Style> = None;

        for (x, y, cell) in content {
            // Move cursor if not sequential
            if last_pos.map_or(true, |(lx, ly)| y != ly || x != lx + 1) {
                // Move cursor to (x, y) - ANSI is 1-indexed
                self.write_ansi(&format!("\x1b[{};{}H", y + 1, x + 1))?;
            }

            // Apply style if changed
            if last_style != Some(cell.style()) {
                self.apply_style(cell.style())?;
                last_style = Some(cell.style());
            }

            // Write character
            self.writer.write_all(cell.symbol().as_bytes())?;

            last_pos = Some((x, y));
        }

        // Reset style
        self.write_ansi("\x1b[0m")?;
        self.writer.flush()?;

        Ok(())
    }

    fn hide_cursor(&mut self) -> IOResult<()> {
        self.write_ansi("\x1b[?25l")?;
        self.writer.flush()
    }

    fn show_cursor(&mut self) -> IOResult<()> {
        self.write_ansi("\x1b[?25h")?;
        self.writer.flush()
    }

    fn get_cursor_position(&mut self) -> IOResult<Position> {
        Ok(Position::new(0, 0))
    }

    fn set_cursor_position<P: Into<Position>>(&mut self, position: P) -> IOResult<()> {
        let pos = position.into();
        self.write_ansi(&format!("\x1b[{};{}H", pos.y + 1, pos.x + 1))?;
        self.writer.flush()
    }

    fn clear(&mut self) -> IOResult<()> {
        self.write_ansi("\x1b[2J\x1b[H")?;
        self.writer.flush()
    }

    fn size(&self) -> IOResult<Size> {
        // Poll terminal size from JS via WIT import
        use crate::bindings::terminal::info::size::get_terminal_size;
        let dims = get_terminal_size();
        Ok(Size::new(dims.cols, dims.rows))
    }

    fn flush(&mut self) -> IOResult<()> {
        self.writer.flush()
    }

    fn window_size(&mut self) -> IOResult<WindowSize> {
        Ok(WindowSize {
            columns_rows: Size::new(self.width, self.height),
            pixels: Size::new(0, 0),
        })
    }

    fn clear_region(&mut self, clear_type: ClearType) -> IOResult<()> {
        match clear_type {
            ClearType::All => self.write_ansi("\x1b[2J"),
            ClearType::AfterCursor => self.write_ansi("\x1b[0J"),
            ClearType::BeforeCursor => self.write_ansi("\x1b[1J"),
            ClearType::CurrentLine => self.write_ansi("\x1b[2K"),
            ClearType::UntilNewLine => self.write_ansi("\x1b[0K"),
        }
    }
}

fn color_to_ansi_fg(color: Color) -> String {
    match color {
        Color::Black => "\x1b[30m".to_string(),
        Color::Red => "\x1b[31m".to_string(),
        Color::Green => "\x1b[32m".to_string(),
        Color::Yellow => "\x1b[33m".to_string(),
        Color::Blue => "\x1b[34m".to_string(),
        Color::Magenta => "\x1b[35m".to_string(),
        Color::Cyan => "\x1b[36m".to_string(),
        Color::White => "\x1b[37m".to_string(),
        Color::Gray => "\x1b[90m".to_string(),
        Color::DarkGray => "\x1b[90m".to_string(),
        Color::LightRed => "\x1b[91m".to_string(),
        Color::LightGreen => "\x1b[92m".to_string(),
        Color::LightYellow => "\x1b[93m".to_string(),
        Color::LightBlue => "\x1b[94m".to_string(),
        Color::LightMagenta => "\x1b[95m".to_string(),
        Color::LightCyan => "\x1b[96m".to_string(),
        Color::Rgb(r, g, b) => format!("\x1b[38;2;{};{};{}m", r, g, b),
        Color::Indexed(n) => format!("\x1b[38;5;{}m", n),
        Color::Reset => "\x1b[39m".to_string(),
    }
}

fn color_to_ansi_bg(color: Color) -> String {
    match color {
        Color::Black => "\x1b[40m".to_string(),
        Color::Red => "\x1b[41m".to_string(),
        Color::Green => "\x1b[42m".to_string(),
        Color::Yellow => "\x1b[43m".to_string(),
        Color::Blue => "\x1b[44m".to_string(),
        Color::Magenta => "\x1b[45m".to_string(),
        Color::Cyan => "\x1b[46m".to_string(),
        Color::White => "\x1b[47m".to_string(),
        Color::Gray => "\x1b[100m".to_string(),
        Color::DarkGray => "\x1b[100m".to_string(),
        Color::LightRed => "\x1b[101m".to_string(),
        Color::LightGreen => "\x1b[102m".to_string(),
        Color::LightYellow => "\x1b[103m".to_string(),
        Color::LightBlue => "\x1b[104m".to_string(),
        Color::LightMagenta => "\x1b[105m".to_string(),
        Color::LightCyan => "\x1b[106m".to_string(),
        Color::Rgb(r, g, b) => format!("\x1b[48;2;{};{};{}m", r, g, b),
        Color::Indexed(n) => format!("\x1b[48;5;{}m", n),
        Color::Reset => "\x1b[49m".to_string(),
    }
}

/// Enter alternate screen mode
pub fn enter_alternate_screen<W: Write>(writer: &mut W) -> IOResult<()> {
    writer.write_all(b"\x1b[?1049h")?;
    writer.flush()
}

/// Leave alternate screen mode
pub fn leave_alternate_screen<W: Write>(writer: &mut W) -> IOResult<()> {
    writer.write_all(b"\x1b[?1049l")?;
    writer.flush()
}
