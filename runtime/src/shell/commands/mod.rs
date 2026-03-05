//! Shell command implementations.
//!
//! All commands write to async writers (not println!) and return exit codes.
//! Commands support `--help` for busybox-style usage information.
//!
//! Uses `lexopt` for minimal argument parsing in the busybox style.

mod core;
mod encoding;
mod env;
mod file;
pub mod helpers;
mod json;
mod misc;
mod path;
mod string;
mod test;
mod text;
mod util;

// Feature-gated modules for modular WASM builds
// Note: tsx commands are now in tsx-engine (lazy-loaded)
#[cfg(feature = "archive")]
mod archive;
mod git;
#[cfg(feature = "sqlite")]
mod sql;
#[cfg(feature = "sqlite")]
mod wasi_io;

pub use self::core::CoreCommands;
pub use self::encoding::EncodingCommands;
pub use self::env::EnvCommands;
pub use self::file::FileCommands;
pub use self::git::GitCommands;
pub use self::json::JsonCommands;
pub use self::misc::MiscCommands;
pub use self::path::PathCommands;
pub use self::string::StringCommands;
pub use self::test::TestCommands;
pub use self::text::TextCommands;
pub use self::util::UtilCommands;

// TsxCommands moved to tsx-engine module (lazy-loaded)
#[cfg(feature = "archive")]
pub use self::archive::ArchiveCommands;
#[cfg(feature = "sqlite")]
pub use self::sql::SqlCommands;

use super::ShellEnv;

/// Trait for command category structs.
///
/// Each command category (FileCommands, TextCommands, etc.) implements this
/// trait via the `#[shell_commands]` proc macro to provide command dispatch.
pub trait CommandCategory {
    /// Look up a command function by name.
    fn get_command(name: &str) -> Option<CommandFn>;
    /// Get help text for a command by name.
    fn show_help(name: &str) -> Option<&'static str>;
    /// List all command names in this category.
    fn list_commands() -> &'static [&'static str];
}

/// Command function type.
/// Takes arguments, environment, and stdin/stdout/stderr pipes.
/// Returns exit code.
pub type CommandFn = fn(
    args: Vec<String>,
    env: &ShellEnv,
    stdin: piper::Reader,
    stdout: piper::Writer,
    stderr: piper::Writer,
) -> futures_lite::future::Boxed<i32>;

/// Create a lexopt parser from a Vec<String> of arguments.
pub fn make_parser(args: Vec<String>) -> lexopt::Parser {
    lexopt::Parser::from_args(args)
}

/// Common parsed options that many commands share.
#[derive(Default)]
pub struct CommonOpts {
    #[allow(dead_code)]
    pub help: bool,
}

/// Parse common options (--help, -h) from argument list.
pub fn parse_common(args: &[String]) -> (CommonOpts, Vec<String>) {
    let help = args.iter().any(|a| a == "--help" || a == "-h");
    let remaining: Vec<String> = args
        .iter()
        .filter(|a| *a != "--help" && *a != "-h")
        .cloned()
        .collect();
    (CommonOpts { help }, remaining)
}

/// Dispatches across all command categories, calling `$method` on each in order
/// and returning the first `Some` result.
macro_rules! dispatch_categories {
    ($method:ident, $arg:expr) => {{
        None.or_else(|| <CoreCommands as CommandCategory>::$method($arg))
            .or_else(|| <FileCommands as CommandCategory>::$method($arg))
            .or_else(|| <TextCommands as CommandCategory>::$method($arg))
            .or_else(|| <PathCommands as CommandCategory>::$method($arg))
            .or_else(|| <EnvCommands as CommandCategory>::$method($arg))
            .or_else(|| <MiscCommands as CommandCategory>::$method($arg))
            .or_else(|| <JsonCommands as CommandCategory>::$method($arg))
            .or_else(|| <TestCommands as CommandCategory>::$method($arg))
            .or_else(|| <UtilCommands as CommandCategory>::$method($arg))
            .or_else(|| <EncodingCommands as CommandCategory>::$method($arg))
            .or_else(|| <StringCommands as CommandCategory>::$method($arg))
            .or_else(|| <GitCommands as CommandCategory>::$method($arg))
            .or_else(|| {
                #[cfg(feature = "sqlite")]
                {
                    return <SqlCommands as CommandCategory>::$method($arg);
                }
                #[cfg(not(feature = "sqlite"))]
                {
                    None
                }
            })
            .or_else(|| {
                #[cfg(feature = "archive")]
                {
                    return <ArchiveCommands as CommandCategory>::$method($arg);
                }
                #[cfg(not(feature = "archive"))]
                {
                    None
                }
            })
    }};
}

/// Collects `list_commands()` from all categories.
macro_rules! collect_all_commands {
    () => {{
        let mut cmds = Vec::new();
        cmds.extend_from_slice(<CoreCommands as CommandCategory>::list_commands());
        cmds.extend_from_slice(<FileCommands as CommandCategory>::list_commands());
        cmds.extend_from_slice(<TextCommands as CommandCategory>::list_commands());
        cmds.extend_from_slice(<PathCommands as CommandCategory>::list_commands());
        cmds.extend_from_slice(<EnvCommands as CommandCategory>::list_commands());
        cmds.extend_from_slice(<MiscCommands as CommandCategory>::list_commands());
        cmds.extend_from_slice(<JsonCommands as CommandCategory>::list_commands());
        cmds.extend_from_slice(<TestCommands as CommandCategory>::list_commands());
        cmds.extend_from_slice(<UtilCommands as CommandCategory>::list_commands());
        cmds.extend_from_slice(<EncodingCommands as CommandCategory>::list_commands());
        cmds.extend_from_slice(<StringCommands as CommandCategory>::list_commands());
        cmds.extend_from_slice(<GitCommands as CommandCategory>::list_commands());
        #[cfg(feature = "sqlite")]
        cmds.extend_from_slice(<SqlCommands as CommandCategory>::list_commands());
        #[cfg(feature = "archive")]
        cmds.extend_from_slice(<ArchiveCommands as CommandCategory>::list_commands());
        cmds.sort();
        cmds
    }};
}

/// Unified shell commands interface.
///
/// This struct provides a single entry point to dispatch commands from
/// multiple category modules via the `CommandCategory` trait.
pub struct ShellCommands;

impl ShellCommands {
    pub fn get_command(name: &str) -> Option<CommandFn> {
        dispatch_categories!(get_command, name)
    }

    pub fn show_help(name: &str) -> Option<&'static str> {
        dispatch_categories!(show_help, name)
    }

    pub fn list_commands() -> Vec<&'static str> {
        collect_all_commands!()
    }
}

/// Helper function for recursive directory copy (used by cp command).
pub fn copy_dir_recursive(src: &str, dst: &str) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let src_path = entry.path();
        let dst_path = format!("{}/{}", dst, entry.file_name().to_string_lossy());

        if entry.file_type()?.is_dir() {
            copy_dir_recursive(&src_path.to_string_lossy(), &dst_path)?;
        } else {
            std::fs::copy(&src_path, &dst_path)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_get_command() {
        assert!(ShellCommands::get_command("echo").is_some());
        assert!(ShellCommands::get_command("ls").is_some());
        assert!(ShellCommands::get_command("grep").is_some());
        assert!(ShellCommands::get_command("basename").is_some());
        assert!(ShellCommands::get_command("nonexistent").is_none());
    }

    #[test]
    fn test_show_help() {
        let help = ShellCommands::show_help("echo");
        assert!(help.is_some());
        let text = help.unwrap();
        assert!(text.contains("Usage:"));
        assert!(text.contains("echo"));
    }

    #[test]
    fn test_list_commands() {
        let commands = ShellCommands::list_commands();
        assert!(commands.contains(&"echo"));
        assert!(commands.contains(&"ls"));
        assert!(commands.contains(&"cat"));
        assert!(commands.contains(&"grep"));
        assert!(commands.contains(&"sort"));
        assert!(commands.contains(&"basename"));
        assert!(commands.contains(&"env"));
        // Feature-gated commands - only test if feature enabled
        #[cfg(feature = "tsx")]
        {
            assert!(commands.contains(&"tsc"));
            assert!(commands.contains(&"tsx"));
        }
    }

    #[test]
    fn test_parse_common() {
        let (opts, remaining) = parse_common(&["--help".to_string(), "foo".to_string()]);
        assert!(opts.help);
        assert_eq!(remaining, vec!["foo"]);

        let (opts2, remaining2) = parse_common(&["bar".to_string()]);
        assert!(!opts2.help);
        assert_eq!(remaining2, vec!["bar"]);
    }

    #[test]
    fn test_all_listed_commands_are_reachable() {
        let commands = ShellCommands::list_commands();
        assert!(!commands.is_empty(), "command list should not be empty");
        for cmd in &commands {
            assert!(
                ShellCommands::get_command(cmd).is_some(),
                "command '{}' listed but not reachable via get_command",
                cmd
            );
        }
    }

    #[test]
    fn test_all_listed_commands_have_help() {
        let commands = ShellCommands::list_commands();
        for cmd in &commands {
            let help = ShellCommands::show_help(cmd);
            assert!(
                help.is_some(),
                "command '{}' listed but has no help text",
                cmd
            );
            let text = help.unwrap();
            assert!(
                text.contains("Usage:"),
                "help for '{}' should contain 'Usage:'",
                cmd
            );
        }
    }

    #[test]
    fn test_list_commands_is_sorted() {
        let commands = ShellCommands::list_commands();
        let mut sorted = commands.clone();
        sorted.sort();
        assert_eq!(
            commands, sorted,
            "list_commands() should return sorted list"
        );
    }

    #[test]
    fn test_list_commands_no_duplicates() {
        let commands = ShellCommands::list_commands();
        let mut seen = std::collections::HashSet::new();
        for cmd in &commands {
            assert!(
                seen.insert(cmd),
                "duplicate command name in list_commands: '{}'",
                cmd
            );
        }
    }

    #[test]
    fn test_category_trait_dispatch() {
        // Verify trait-based dispatch matches for commands from different categories
        assert_eq!(
            <CoreCommands as CommandCategory>::get_command("echo").is_some(),
            ShellCommands::get_command("echo").is_some()
        );
        assert_eq!(
            <FileCommands as CommandCategory>::get_command("ls").is_some(),
            ShellCommands::get_command("ls").is_some()
        );
        assert_eq!(
            <TextCommands as CommandCategory>::get_command("grep").is_some(),
            ShellCommands::get_command("grep").is_some()
        );
        assert_eq!(
            <PathCommands as CommandCategory>::get_command("basename").is_some(),
            ShellCommands::get_command("basename").is_some()
        );
    }
}
