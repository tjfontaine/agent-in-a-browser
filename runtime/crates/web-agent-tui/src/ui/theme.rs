//! Color themes for the TUI
//!
//! Provides predefined color schemes that can be selected in config.

use ratatui::style::Color;

/// Color theme for the TUI
#[derive(Debug, Clone)]
pub struct Theme {
    /// Primary text color
    pub fg: Color,
    /// Background color
    pub bg: Color,
    /// Accent/highlight color (cyan, blue, etc.)
    pub accent: Color,
    /// Secondary/muted text
    pub muted: Color,
    /// Success color (green)
    pub success: Color,
    /// Error color (red)
    pub error: Color,
    /// Warning color (yellow)
    pub warning: Color,
    /// User message color
    pub user_msg: Color,
    /// Assistant message color
    pub assistant_msg: Color,
    /// System message color
    pub system_msg: Color,
}

impl Theme {
    /// Get theme by name
    pub fn by_name(name: &str) -> Self {
        match name.to_lowercase().as_str() {
            "light" => Self::light(),
            "tokyo-night" | "tokyonight" => Self::tokyo_night(),
            "gruvbox" => Self::gruvbox(),
            "catppuccin" => Self::catppuccin(),
            _ => Self::dark(), // Default to dark
        }
    }

    /// Dark theme (default) - Tokyo Night inspired
    pub fn dark() -> Self {
        Self {
            fg: Color::Rgb(169, 177, 214),      // #a9b1d6
            bg: Color::Rgb(26, 27, 38),         // #1a1b26
            accent: Color::Rgb(122, 162, 247),  // #7aa2f7
            muted: Color::Rgb(86, 95, 137),     // #565f89
            success: Color::Rgb(158, 206, 106), // #9ece6a
            error: Color::Rgb(247, 118, 142),   // #f7768e
            warning: Color::Rgb(224, 175, 104), // #e0af68
            user_msg: Color::Green,
            assistant_msg: Color::Cyan,
            system_msg: Color::Yellow,
        }
    }

    /// Light theme
    pub fn light() -> Self {
        Self {
            fg: Color::Rgb(52, 59, 88),        // #343b58
            bg: Color::Rgb(213, 214, 219),     // #d5d6db
            accent: Color::Rgb(52, 84, 138),   // #34548a
            muted: Color::Rgb(150, 150, 160),  // #9696a0
            success: Color::Rgb(72, 132, 76),  // #48844c
            error: Color::Rgb(139, 59, 69),    // #8b3b45
            warning: Color::Rgb(150, 100, 50), // #966432
            user_msg: Color::Rgb(0, 100, 0),
            assistant_msg: Color::Rgb(0, 80, 120),
            system_msg: Color::Rgb(120, 80, 0),
        }
    }

    /// Tokyo Night theme
    pub fn tokyo_night() -> Self {
        Self::dark() // Same as dark for now
    }

    /// Gruvbox dark theme
    pub fn gruvbox() -> Self {
        Self {
            fg: Color::Rgb(235, 219, 178),            // #ebdbb2
            bg: Color::Rgb(40, 40, 40),               // #282828
            accent: Color::Rgb(131, 165, 152),        // #83a598
            muted: Color::Rgb(146, 131, 116),         // #928374
            success: Color::Rgb(184, 187, 38),        // #b8bb26
            error: Color::Rgb(251, 73, 52),           // #fb4934
            warning: Color::Rgb(250, 189, 47),        // #fabd2f
            user_msg: Color::Rgb(184, 187, 38),       // green
            assistant_msg: Color::Rgb(131, 165, 152), // aqua
            system_msg: Color::Rgb(250, 189, 47),     // yellow
        }
    }

    /// Catppuccin Mocha theme
    pub fn catppuccin() -> Self {
        Self {
            fg: Color::Rgb(205, 214, 244),            // #cdd6f4
            bg: Color::Rgb(30, 30, 46),               // #1e1e2e
            accent: Color::Rgb(137, 180, 250),        // #89b4fa
            muted: Color::Rgb(127, 132, 156),         // #7f849c
            success: Color::Rgb(166, 227, 161),       // #a6e3a1
            error: Color::Rgb(243, 139, 168),         // #f38ba8
            warning: Color::Rgb(249, 226, 175),       // #f9e2af
            user_msg: Color::Rgb(166, 227, 161),      // green
            assistant_msg: Color::Rgb(137, 180, 250), // blue
            system_msg: Color::Rgb(249, 226, 175),    // yellow
        }
    }
}

impl Default for Theme {
    fn default() -> Self {
        Self::dark()
    }
}
