//! Brace expansion module - integrates with brush_parser's brace expression parsing.
//!
//! This module is adapted from brush-core's braceexpansion.rs to work with
//! brush_parser::word::BraceExpressionOrText types.

use brush_parser::word;
use itertools::Itertools;

/// Generate brace expansions from brush_parser's BraceExpressionOrText pieces.
///
/// This function takes the parsed brace expression pieces and generates all
/// combinations using the cartesian product.
pub fn generate_and_combine_brace_expansions(
    pieces: Vec<word::BraceExpressionOrText>,
) -> impl IntoIterator<Item = String> {
    let expansions: Vec<Vec<String>> = pieces
        .into_iter()
        .map(|piece| expand_brace_expr_or_text(piece).collect())
        .collect();

    expansions
        .into_iter()
        .multi_cartesian_product()
        .map(|v| v.join(""))
}

fn expand_brace_expr_or_text(
    beot: word::BraceExpressionOrText,
) -> Box<dyn Iterator<Item = String>> {
    match beot {
        word::BraceExpressionOrText::Expr(members) => {
            // Chain all member iterators together
            Box::new(members.into_iter().flat_map(expand_brace_expr_member))
        }
        word::BraceExpressionOrText::Text(text) => Box::new(std::iter::once(text)),
    }
}

#[allow(clippy::cast_possible_truncation)]
fn expand_brace_expr_member(bem: word::BraceExpressionMember) -> Box<dyn Iterator<Item = String>> {
    match bem {
        word::BraceExpressionMember::NumberSequence {
            start,
            end,
            increment,
        } => {
            let increment = increment.unsigned_abs() as usize;

            if start <= end {
                Box::new((start..=end).step_by(increment).map(|n| n.to_string()))
            } else {
                Box::new(
                    (end..=start)
                        .step_by(increment)
                        .map(|n| n.to_string())
                        .collect::<Vec<_>>()
                        .into_iter()
                        .rev(),
                )
            }
        }

        word::BraceExpressionMember::CharSequence {
            start,
            end,
            increment,
        } => {
            let increment = increment.unsigned_abs() as usize;

            if start <= end {
                Box::new((start..=end).step_by(increment).map(|c| c.to_string()))
            } else {
                Box::new(
                    (end..=start)
                        .step_by(increment)
                        .map(|c| c.to_string())
                        .collect::<Vec<_>>()
                        .into_iter()
                        .rev(),
                )
            }
        }

        word::BraceExpressionMember::Child(elements) => {
            // Chain all element iterators together
            Box::new(generate_and_combine_brace_expansions(elements).into_iter())
        }
    }
}

/// Expand brace expressions in a word using brush_parser.
///
/// This is the main entry point for brace expansion. It parses the word
/// using brush_parser and then expands any brace expressions found.
pub fn expand_braces_with_parser(word: &str) -> Vec<String> {
    // Quick check to avoid parsing if there are no braces
    if !may_contain_braces_to_expand(word) {
        return vec![word.to_string()];
    }

    // Protect escaped brace-expansion characters (\{, \}, \,) by replacing them
    // with placeholders before parsing. This prevents single-quoted text content
    // (which escapes these chars) from being incorrectly expanded.
    let protected = word
        .replace("\\{", "\x01LBRACE\x01")
        .replace("\\}", "\x01RBRACE\x01")
        .replace("\\,", "\x01COMMA\x01");

    // Re-check after protection: if no unescaped braces remain, skip expansion
    if !may_contain_braces_to_expand(&protected) {
        return vec![word.to_string()];
    }

    // Use brush_parser to parse brace expansions
    let options = brush_parser::ParserOptions::default();

    let results = match brush_parser::word::parse_brace_expansions(&protected, &options) {
        Ok(Some(pieces)) => generate_and_combine_brace_expansions(pieces)
            .into_iter()
            .collect::<Vec<String>>(),
        Ok(None) => vec![protected],
        Err(_) => vec![protected],
    };

    // Restore the escaped characters
    results
        .into_iter()
        .map(|s| {
            s.replace("\x01LBRACE\x01", "\\{")
                .replace("\x01RBRACE\x01", "\\}")
                .replace("\x01COMMA\x01", "\\,")
        })
        .collect()
}

/// Quick check to see if a word may contain brace expressions.
/// This is a heuristic to avoid parsing when unnecessary.
fn may_contain_braces_to_expand(word: &str) -> bool {
    // Must have at least one unescaped '{' and one unescaped '}'
    if !has_unescaped_char(word, '{') || !has_unescaped_char(word, '}') {
        return false;
    }

    // Must have either an unescaped comma or '..' inside braces for expansion
    has_unescaped_char(word, ',') || word.contains("..")
}

/// Check if a string contains an unescaped occurrence of a character.
fn has_unescaped_char(s: &str, target: char) -> bool {
    let mut escaped = false;
    for c in s.chars() {
        if escaped {
            escaped = false;
            continue;
        }
        if c == '\\' {
            escaped = true;
            continue;
        }
        if c == target {
            return true;
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_simple_brace_list() {
        let result: Vec<String> = expand_braces_with_parser("{a,b,c}").into_iter().collect();
        assert_eq!(result, vec!["a", "b", "c"]);
    }

    #[test]
    fn test_number_sequence() {
        let result: Vec<String> = expand_braces_with_parser("{1..5}").into_iter().collect();
        assert_eq!(result, vec!["1", "2", "3", "4", "5"]);
    }

    #[test]
    fn test_number_sequence_with_step() {
        let result: Vec<String> = expand_braces_with_parser("{1..10..2}")
            .into_iter()
            .collect();
        assert_eq!(result, vec!["1", "3", "5", "7", "9"]);
    }

    #[test]
    fn test_char_sequence() {
        let result: Vec<String> = expand_braces_with_parser("{a..e}").into_iter().collect();
        assert_eq!(result, vec!["a", "b", "c", "d", "e"]);
    }

    #[test]
    fn test_reverse_number_sequence() {
        let result: Vec<String> = expand_braces_with_parser("{5..1}").into_iter().collect();
        assert_eq!(result, vec!["5", "4", "3", "2", "1"]);
    }

    #[test]
    fn test_with_prefix_suffix() {
        let result: Vec<String> = expand_braces_with_parser("file{1..3}.txt")
            .into_iter()
            .collect();
        assert_eq!(result, vec!["file1.txt", "file2.txt", "file3.txt"]);
    }

    #[test]
    fn test_nested_braces() {
        let result: Vec<String> = expand_braces_with_parser("{a,b}{1,2}")
            .into_iter()
            .collect();
        assert_eq!(result, vec!["a1", "a2", "b1", "b2"]);
    }

    #[test]
    fn test_no_braces() {
        let result: Vec<String> = expand_braces_with_parser("nobraces").into_iter().collect();
        assert_eq!(result, vec!["nobraces"]);
    }

    #[test]
    fn test_single_brace_no_match() {
        let result: Vec<String> = expand_braces_with_parser("{single}").into_iter().collect();
        // No comma or .., should return as-is
        assert_eq!(result, vec!["{single}"]);
    }
}
