//! Parser module - wraps brush-parser for shell command parsing.
//!
//! This module provides a clean interface for parsing shell commands using
//! the brush-parser crate, converting its AST into structures we can execute.

use brush_parser::ast;
use brush_parser::{Parser, ParserOptions, SourceInfo};
use std::io::Cursor;

/// A parsed shell command ready for execution.
#[derive(Debug, Clone)]
pub enum ParsedCommand {
    /// A simple command with name, args, and redirections
    Simple {
        name: String,
        args: Vec<String>,
        redirects: Vec<ParsedRedirect>,
        env_vars: Vec<(String, String)>,
    },
    /// A pipeline of commands
    Pipeline {
        commands: Vec<ParsedCommand>,
        negate: bool,
    },
    /// Conditional: cmd1 && cmd2
    And(Box<ParsedCommand>, Box<ParsedCommand>),
    /// Conditional: cmd1 || cmd2
    Or(Box<ParsedCommand>, Box<ParsedCommand>),
    /// For loop
    For {
        var: String,
        words: Vec<String>,
        body: Vec<ParsedCommand>,
    },
    /// While loop
    While {
        condition: Vec<ParsedCommand>,
        body: Vec<ParsedCommand>,
    },
    /// If/then/else
    If {
        conditionals: Vec<(Vec<ParsedCommand>, Vec<ParsedCommand>)>,
        else_branch: Option<Vec<ParsedCommand>>,
    },
    /// Case statement
    Case {
        word: String,
        cases: Vec<(Vec<String>, Vec<ParsedCommand>)>,
    },
    /// Subshell (commands)
    Subshell(Vec<ParsedCommand>),
    /// Brace group { commands; }
    Brace(Vec<ParsedCommand>),
    /// Function definition
    FunctionDef {
        name: String,
        body: Box<ParsedCommand>,
    },
    /// Background job (cmd &)
    Background(Box<ParsedCommand>),
}

/// A parsed I/O redirection.
#[derive(Debug, Clone)]
pub enum ParsedRedirect {
    /// stdin from file
    Read { fd: Option<u32>, target: String },
    /// stdout to file (truncate)
    Write { fd: Option<u32>, target: String },
    /// stdout to file (append)
    Append { fd: Option<u32>, target: String },
    /// Here-document
    Heredoc { fd: Option<u32>, content: String },
    /// Here-string
    HereString { fd: Option<u32>, content: String },
    /// Duplicate fd (e.g., 2>&1)
    DupWrite { fd: Option<u32>, target: String },
    /// Duplicate fd for read
    DupRead { fd: Option<u32>, target: String },
}

/// Parse a shell command string into a ParsedCommand.
pub fn parse_command(input: &str) -> Result<Vec<ParsedCommand>, String> {
    let input_with_newline = format!("{}\n", input);
    let cursor = Cursor::new(input_with_newline);
    
    let options = ParserOptions::default();
    let source_info = SourceInfo::default();
    let mut parser = Parser::new(cursor, &options, &source_info);
    
    match parser.parse_program() {
        Ok(program) => {
            let commands: Vec<ParsedCommand> = program
                .complete_commands
                .into_iter()
                .flat_map(convert_compound_list)
                .collect();
            Ok(commands)
        }
        Err(e) => Err(format!("Parse error: {:?}", e)),
    }
}

/// Convert a CompoundList to ParsedCommands.
fn convert_compound_list(list: ast::CompoundList) -> Vec<ParsedCommand> {
    list.0.into_iter().filter_map(convert_compound_list_item).collect()
}

/// Convert a CompoundListItem to ParsedCommand.
fn convert_compound_list_item(item: ast::CompoundListItem) -> Option<ParsedCommand> {
    let and_or_list = item.0;
    let separator = item.1;
    
    let cmd = convert_and_or_list(and_or_list)?;
    
    // If it's async (background), wrap it
    match separator {
        ast::SeparatorOperator::Async => Some(ParsedCommand::Background(Box::new(cmd))),
        _ => Some(cmd),
    }
}

/// Convert an AndOrList to ParsedCommand.
fn convert_and_or_list(list: ast::AndOrList) -> Option<ParsedCommand> {
    let first = convert_pipeline(list.first)?;
    
    if list.additional.is_empty() {
        return Some(first);
    }
    
    // Build chain of And/Or
    let mut result = first;
    for and_or in list.additional {
        match and_or {
            ast::AndOr::And(pipeline) => {
                let right = convert_pipeline(pipeline)?;
                result = ParsedCommand::And(Box::new(result), Box::new(right));
            }
            ast::AndOr::Or(pipeline) => {
                let right = convert_pipeline(pipeline)?;
                result = ParsedCommand::Or(Box::new(result), Box::new(right));
            }
        }
    }
    
    Some(result)
}

/// Convert a Pipeline to ParsedCommand.
fn convert_pipeline(pipeline: ast::Pipeline) -> Option<ParsedCommand> {
    let commands: Vec<ParsedCommand> = pipeline
        .seq
        .into_iter()
        .filter_map(convert_command)
        .collect();
    
    if commands.is_empty() {
        return None;
    }
    
    if commands.len() == 1 && !pipeline.bang {
        Some(commands.into_iter().next().unwrap())
    } else {
        Some(ParsedCommand::Pipeline {
            commands,
            negate: pipeline.bang,
        })
    }
}

/// Convert a Command to ParsedCommand.
fn convert_command(cmd: ast::Command) -> Option<ParsedCommand> {
    match cmd {
        ast::Command::Simple(simple) => convert_simple_command(simple),
        ast::Command::Compound(compound, _redirects) => {
            convert_compound_command(compound)
        }
        ast::Command::Function(func_def) => {
            let body = convert_function_body(func_def.body)?;
            Some(ParsedCommand::FunctionDef {
                name: format!("{}", func_def.fname),
                body: Box::new(body),
            })
        }
        ast::Command::ExtendedTest(test) => {
            Some(ParsedCommand::Simple {
                name: "[[".to_string(),
                args: vec![format!("{}", test.expr), "]]".to_string()],
                redirects: vec![],
                env_vars: vec![],
            })
        }
    }
}

/// Convert a SimpleCommand to ParsedCommand.
fn convert_simple_command(cmd: ast::SimpleCommand) -> Option<ParsedCommand> {
    let mut name = String::new();
    let mut args = Vec::new();
    let mut env_vars = Vec::new();
    let mut redirects = Vec::new();
    
    // Process prefix (assignments and redirects before command)
    if let Some(prefix) = cmd.prefix {
        for item in prefix.0 {
            match item {
                ast::CommandPrefixOrSuffixItem::AssignmentWord(assignment, _word) => {
                    let key = format!("{}", assignment.name);
                    let value = match &assignment.value {
                        ast::AssignmentValue::Scalar(word) => format!("{}", word),
                        ast::AssignmentValue::Array(words) => {
                            words.iter().map(|w| format!("{}", w.1)).collect::<Vec<_>>().join(" ")
                        }
                    };
                    env_vars.push((key, value));
                }
                ast::CommandPrefixOrSuffixItem::IoRedirect(redir) => {
                    if let Some(r) = convert_io_redirect(redir) {
                        redirects.push(r);
                    }
                }
                ast::CommandPrefixOrSuffixItem::Word(w) => {
                    // Word in prefix treated as part of name/args
                    if name.is_empty() {
                        name = format!("{}", w);
                    } else {
                        args.push(format!("{}", w));
                    }
                }
                ast::CommandPrefixOrSuffixItem::ProcessSubstitution(_, _) => {
                    // Process substitution in prefix - skip for now
                }
            }
        }
    }
    
    // Process command word (name)
    if let Some(word) = cmd.word_or_name {
        name = format!("{}", word);
    }
    
    // Process suffix (args and redirects after command)
    if let Some(suffix) = cmd.suffix {
        for item in suffix.0 {
            match item {
                ast::CommandPrefixOrSuffixItem::AssignmentWord(assignment, _word) => {
                    // In suffix, assignments become args
                    args.push(format!("{}", assignment));
                }
                ast::CommandPrefixOrSuffixItem::IoRedirect(redir) => {
                    if let Some(r) = convert_io_redirect(redir) {
                        redirects.push(r);
                    }
                }
                ast::CommandPrefixOrSuffixItem::Word(w) => {
                    args.push(format!("{}", w));
                }
                ast::CommandPrefixOrSuffixItem::ProcessSubstitution(_, _) => {
                    // Process substitution in suffix - skip for now
                }
            }
        }
    }
    
    // If we only have env vars, no command
    if name.is_empty() && !env_vars.is_empty() {
        return Some(ParsedCommand::Simple {
            name: String::new(),
            args: vec![],
            redirects,
            env_vars,
        });
    }
    
    if name.is_empty() {
        return None;
    }
    
    Some(ParsedCommand::Simple {
        name,
        args,
        redirects,
        env_vars,
    })
}

/// Convert a CompoundCommand to ParsedCommand.
fn convert_compound_command(cmd: ast::CompoundCommand) -> Option<ParsedCommand> {
    match cmd {
        ast::CompoundCommand::BraceGroup(brace) => {
            let commands = convert_compound_list(brace.list);
            Some(ParsedCommand::Brace(commands))
        }
        ast::CompoundCommand::Subshell(subshell) => {
            let commands = convert_compound_list(subshell.list);
            Some(ParsedCommand::Subshell(commands))
        }
        ast::CompoundCommand::ForClause(for_clause) => {
            let words = for_clause.values
                .map(|ws| ws.into_iter().map(|w| format!("{}", w)).collect())
                .unwrap_or_default();
            let body = convert_do_group(&for_clause.body);
            Some(ParsedCommand::For {
                var: for_clause.variable_name,
                words,
                body,
            })
        }
        ast::CompoundCommand::WhileClause(while_clause) => {
            // WhileOrUntilClauseCommand is a tuple: (condition, body, loc)
            let condition = convert_compound_list(while_clause.0);
            let body = convert_do_group(&while_clause.1);
            Some(ParsedCommand::While { condition, body })
        }
        ast::CompoundCommand::UntilClause(until_clause) => {
            // Same tuple struct
            let condition = convert_compound_list(until_clause.0);
            let body = convert_do_group(&until_clause.1);
            Some(ParsedCommand::While {
                condition: vec![ParsedCommand::Pipeline {
                    commands: condition,
                    negate: true,
                }],
                body,
            })
        }
        ast::CompoundCommand::IfClause(if_clause) => {
            let mut conditionals = Vec::new();
            let mut else_branch_result = None;
            
            // First if condition
            let guard = convert_compound_list(if_clause.condition);
            let then_body = convert_compound_list(if_clause.then);
            conditionals.push((guard, then_body));
            
            // elif clauses
            if let Some(elses) = if_clause.elses {
                for else_clause in elses {
                    if let Some(condition) = else_clause.condition {
                        let elif_guard = convert_compound_list(condition);
                        let elif_body = convert_compound_list(else_clause.body);
                        conditionals.push((elif_guard, elif_body));
                    } else {
                        // else branch (no condition)
                        else_branch_result = Some(convert_compound_list(else_clause.body));
                    }
                }
            }
            
            
            Some(ParsedCommand::If {
                conditionals,
                else_branch: else_branch_result,
            })
        }
        ast::CompoundCommand::CaseClause(case_clause) => {
            let word = format!("{}", case_clause.value);
            let cases: Vec<(Vec<String>, Vec<ParsedCommand>)> = case_clause
                .cases
                .into_iter()
                .map(|case_item| {
                    let patterns: Vec<String> = case_item
                        .patterns
                        .into_iter()
                        .map(|p| format!("{}", p))
                        .collect();
                    let body = case_item.cmd.map(convert_compound_list).unwrap_or_default();
                    (patterns, body)
                })
                .collect();
            Some(ParsedCommand::Case { word, cases })
        }
        ast::CompoundCommand::Arithmetic(arith) => {
            Some(ParsedCommand::Simple {
                name: "((".to_string(),
                args: vec![format!("{}", arith.expr), "))".to_string()],
                redirects: vec![],
                env_vars: vec![],
            })
        }
        ast::CompoundCommand::ArithmeticForClause(arith_for) => {
            let body = convert_do_group(&arith_for.body);
            Some(ParsedCommand::While {
                condition: vec![ParsedCommand::Simple {
                    name: "true".to_string(),
                    args: vec![],
                    redirects: vec![],
                    env_vars: vec![],
                }],
                body,
            })
        }
    }
}

/// Convert a DoGroupCommand to Vec<ParsedCommand>.
fn convert_do_group(do_group: &ast::DoGroupCommand) -> Vec<ParsedCommand> {
    convert_compound_list(do_group.list.clone())
}

/// Convert a FunctionBody to ParsedCommand.
fn convert_function_body(body: ast::FunctionBody) -> Option<ParsedCommand> {
    convert_compound_command(body.0)
}

/// Convert an IoRedirect to ParsedRedirect.
fn convert_io_redirect(redir: ast::IoRedirect) -> Option<ParsedRedirect> {
    match redir {
        ast::IoRedirect::File(fd, kind, target) => {
            let fd_num = fd.map(|f| f as u32);
            let target_str = match target {
                ast::IoFileRedirectTarget::Filename(w) => format!("{}", w),
                ast::IoFileRedirectTarget::Fd(n) => n.to_string(),
                ast::IoFileRedirectTarget::ProcessSubstitution(kind, cmd) => {
                    format!("{:?}({})", kind, cmd)
                }
                ast::IoFileRedirectTarget::Duplicate(w) => format!("{}", w),
            };
            
            match kind {
                ast::IoFileRedirectKind::Read => Some(ParsedRedirect::Read { fd: fd_num, target: target_str }),
                ast::IoFileRedirectKind::Write => Some(ParsedRedirect::Write { fd: fd_num, target: target_str }),
                ast::IoFileRedirectKind::Append => Some(ParsedRedirect::Append { fd: fd_num, target: target_str }),
                ast::IoFileRedirectKind::DuplicateInput => Some(ParsedRedirect::DupRead { fd: fd_num, target: target_str }),
                ast::IoFileRedirectKind::DuplicateOutput => Some(ParsedRedirect::DupWrite { fd: fd_num, target: target_str }),
                _ => None,
            }
        }
        ast::IoRedirect::HereDocument(fd, doc) => {
            let fd_num = fd.map(|f| f as u32);
            Some(ParsedRedirect::Heredoc {
                fd: fd_num,
                content: format!("{}", doc.doc),
            })
        }
        ast::IoRedirect::HereString(fd, word) => {
            let fd_num = fd.map(|f| f as u32);
            Some(ParsedRedirect::HereString {
                fd: fd_num,
                content: format!("{}", word),
            })
        }
        ast::IoRedirect::OutputAndError(word, append) => {
            // &> or &>> redirect both stdout and stderr
            Some(ParsedRedirect::Write {
                fd: Some(1),
                target: format!("{}", word),
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_simple_command() {
        let cmds = parse_command("echo hello world").unwrap();
        assert_eq!(cmds.len(), 1);
        match &cmds[0] {
            ParsedCommand::Simple { name, args, .. } => {
                assert_eq!(name, "echo");
                assert_eq!(args, &["hello", "world"]);
            }
            _ => panic!("Expected Simple command"),
        }
    }

    #[test]
    fn test_parse_pipeline() {
        let cmds = parse_command("echo hello | cat").unwrap();
        assert_eq!(cmds.len(), 1);
        match &cmds[0] {
            ParsedCommand::Pipeline { commands, negate } => {
                assert!(!negate);
                assert_eq!(commands.len(), 2);
            }
            _ => panic!("Expected Pipeline"),
        }
    }

    #[test]
    fn test_parse_and_chain() {
        let cmds = parse_command("echo a && echo b").unwrap();
        assert_eq!(cmds.len(), 1);
        match &cmds[0] {
            ParsedCommand::And(_, _) => {}
            _ => panic!("Expected And"),
        }
    }

    #[test]
    fn test_parse_for_loop() {
        let cmds = parse_command("for x in a b c; do echo $x; done").unwrap();
        assert_eq!(cmds.len(), 1);
        match &cmds[0] {
            ParsedCommand::For { var, words, body } => {
                assert_eq!(var, "x");
                assert_eq!(words, &["a", "b", "c"]);
                assert_eq!(body.len(), 1);
            }
            _ => panic!("Expected For loop"),
        }
    }

    #[test]
    fn test_parse_if_statement() {
        let cmds = parse_command("if true; then echo yes; else echo no; fi").unwrap();
        assert_eq!(cmds.len(), 1);
        match &cmds[0] {
            ParsedCommand::If { conditionals, else_branch } => {
                assert_eq!(conditionals.len(), 1);
                assert!(else_branch.is_some());
            }
            _ => panic!("Expected If"),
        }
    }

    #[test]
    fn test_parse_redirect() {
        let cmds = parse_command("echo hello > file.txt").unwrap();
        assert_eq!(cmds.len(), 1);
        match &cmds[0] {
            ParsedCommand::Simple { redirects, .. } => {
                assert_eq!(redirects.len(), 1);
                match &redirects[0] {
                    ParsedRedirect::Write { target, .. } => {
                        assert_eq!(target, "file.txt");
                    }
                    _ => panic!("Expected Write redirect"),
                }
            }
            _ => panic!("Expected Simple command"),
        }
    }
}
