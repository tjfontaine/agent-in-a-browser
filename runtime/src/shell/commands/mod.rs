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
mod json;
mod misc;
mod path;
mod string;
mod test;
mod text;
mod tsx;
mod util;
mod sql;
mod wasi_io;
mod archive;
mod git;

pub use self::core::CoreCommands;
pub use self::encoding::EncodingCommands;
pub use self::env::EnvCommands;
pub use self::file::FileCommands;
pub use self::json::JsonCommands;
pub use self::misc::MiscCommands;
pub use self::path::PathCommands;
pub use self::string::StringCommands;
pub use self::test::TestCommands;
pub use self::text::TextCommands;
pub use self::tsx::TsxCommands;
pub use self::util::UtilCommands;
pub use self::sql::SqlCommands;
pub use self::archive::ArchiveCommands;
pub use self::git::GitCommands;

use super::ShellEnv;

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
    pub help: bool,
}

/// Parse common options (--help, -h) from argument list.
pub fn parse_common(args: &[String]) -> (CommonOpts, Vec<String>) {
    let help = args.iter().any(|a| a == "--help" || a == "-h");
    let remaining: Vec<String> = args.iter()
        .filter(|a| *a != "--help" && *a != "-h")
        .cloned()
        .collect();
    (CommonOpts { help }, remaining)
}

/// Unified shell commands interface.
/// 
/// This struct provides a single entry point to dispatch commands from
/// multiple category modules.
pub struct ShellCommands;

impl ShellCommands {
    pub fn get_command(name: &str) -> Option<CommandFn> {
        // Try each category in order
        CoreCommands::get_command(name)
            .or_else(|| FileCommands::get_command(name))
            .or_else(|| TextCommands::get_command(name))
            .or_else(|| PathCommands::get_command(name))
            .or_else(|| EnvCommands::get_command(name))
            .or_else(|| MiscCommands::get_command(name))
            .or_else(|| TsxCommands::get_command(name))
            .or_else(|| JsonCommands::get_command(name))
            .or_else(|| TestCommands::get_command(name))
            .or_else(|| UtilCommands::get_command(name))
            .or_else(|| EncodingCommands::get_command(name))
            .or_else(|| StringCommands::get_command(name))
            .or_else(|| SqlCommands::get_command(name))
            .or_else(|| ArchiveCommands::get_command(name))
            .or_else(|| GitCommands::get_command(name))
    }
    
    pub fn show_help(name: &str) -> Option<&'static str> {
        CoreCommands::show_help(name)
            .or_else(|| FileCommands::show_help(name))
            .or_else(|| TextCommands::show_help(name))
            .or_else(|| PathCommands::show_help(name))
            .or_else(|| EnvCommands::show_help(name))
            .or_else(|| MiscCommands::show_help(name))
            .or_else(|| TsxCommands::show_help(name))
            .or_else(|| JsonCommands::show_help(name))
            .or_else(|| TestCommands::show_help(name))
            .or_else(|| UtilCommands::show_help(name))
            .or_else(|| EncodingCommands::show_help(name))
            .or_else(|| StringCommands::show_help(name))
            .or_else(|| SqlCommands::show_help(name))
            .or_else(|| ArchiveCommands::show_help(name))
            .or_else(|| GitCommands::show_help(name))
    }
    
    pub fn list_commands() -> Vec<&'static str> {
        let mut cmds = Vec::new();
        cmds.extend_from_slice(CoreCommands::list_commands());
        cmds.extend_from_slice(FileCommands::list_commands());
        cmds.extend_from_slice(TextCommands::list_commands());
        cmds.extend_from_slice(PathCommands::list_commands());
        cmds.extend_from_slice(EnvCommands::list_commands());
        cmds.extend_from_slice(MiscCommands::list_commands());
        cmds.extend_from_slice(TsxCommands::list_commands());
        cmds.extend_from_slice(JsonCommands::list_commands());
        cmds.extend_from_slice(TestCommands::list_commands());
        cmds.extend_from_slice(UtilCommands::list_commands());
        cmds.extend_from_slice(EncodingCommands::list_commands());
        cmds.extend_from_slice(StringCommands::list_commands());
        cmds.extend_from_slice(SqlCommands::list_commands());
        cmds.extend_from_slice(ArchiveCommands::list_commands());
        cmds.extend_from_slice(GitCommands::list_commands());
        cmds.sort();
        cmds
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
        // New commands
        assert!(commands.contains(&"sed"));
        assert!(commands.contains(&"cut"));
        assert!(commands.contains(&"tr"));
        assert!(commands.contains(&"find"));
        assert!(commands.contains(&"diff"));
        assert!(commands.contains(&"curl"));
        assert!(commands.contains(&"jq"));
        assert!(commands.contains(&"xargs"));
        assert!(commands.contains(&"tsc"));
        assert!(commands.contains(&"tsx"));
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
}
