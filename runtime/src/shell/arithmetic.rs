//! Arithmetic expression evaluator using brush-parser AST.
//!
//! This module provides shell arithmetic evaluation by parsing expressions with
//! brush-parser's formal grammar and evaluating the resulting AST.

use super::env::ShellEnv;
use brush_parser::ast::{
    ArithmeticExpr, ArithmeticTarget, BinaryOperator, UnaryAssignmentOperator, UnaryOperator,
};

/// Parse and evaluate a shell arithmetic expression.
///
/// Uses brush-parser to parse the expression into an AST, then evaluates it
/// with proper operator precedence and all operators (bitwise, ternary, etc.).
pub fn evaluate(expr: &str, env: &mut ShellEnv) -> Result<i64, String> {
    let expr = expr.trim();

    if expr.is_empty() {
        return Ok(0);
    }

    // Parse using brush-parser
    let parsed =
        brush_parser::arithmetic::parse(expr).map_err(|e| format!("parse error: {:?}", e))?;

    // Evaluate the AST
    eval_expr(&parsed, env)
}

/// Evaluate an arithmetic expression AST node.
fn eval_expr(expr: &ArithmeticExpr, env: &mut ShellEnv) -> Result<i64, String> {
    match expr {
        ArithmeticExpr::Literal(n) => Ok(*n),

        ArithmeticExpr::Reference(target) => {
            let value = get_target_value(target, env)?;
            Ok(value)
        }

        ArithmeticExpr::UnaryOp(op, operand) => {
            let val = eval_expr(operand, env)?;
            Ok(match op {
                UnaryOperator::UnaryPlus => val,
                UnaryOperator::UnaryMinus => -val,
                UnaryOperator::LogicalNot => {
                    if val == 0 {
                        1
                    } else {
                        0
                    }
                }
                UnaryOperator::BitwiseNot => !val,
            })
        }

        ArithmeticExpr::BinaryOp(op, left, right) => {
            // Short-circuit evaluation for logical operators
            match op {
                BinaryOperator::LogicalAnd => {
                    let left_val = eval_expr(left, env)?;
                    if left_val == 0 {
                        return Ok(0);
                    }
                    let right_val = eval_expr(right, env)?;
                    return Ok(if right_val != 0 { 1 } else { 0 });
                }
                BinaryOperator::LogicalOr => {
                    let left_val = eval_expr(left, env)?;
                    if left_val != 0 {
                        return Ok(1);
                    }
                    let right_val = eval_expr(right, env)?;
                    return Ok(if right_val != 0 { 1 } else { 0 });
                }
                _ => {}
            }

            let left_val = eval_expr(left, env)?;
            let right_val = eval_expr(right, env)?;

            Ok(match op {
                BinaryOperator::Add => left_val + right_val,
                BinaryOperator::Subtract => left_val - right_val,
                BinaryOperator::Multiply => left_val * right_val,
                BinaryOperator::Divide => {
                    if right_val == 0 {
                        return Err("division by zero".to_string());
                    }
                    left_val / right_val
                }
                BinaryOperator::Modulo => {
                    if right_val == 0 {
                        return Err("division by zero".to_string());
                    }
                    left_val % right_val
                }
                BinaryOperator::Power => left_val.pow(right_val as u32),
                BinaryOperator::BitwiseAnd => left_val & right_val,
                BinaryOperator::BitwiseOr => left_val | right_val,
                BinaryOperator::BitwiseXor => left_val ^ right_val,
                BinaryOperator::ShiftLeft => left_val << right_val,
                BinaryOperator::ShiftRight => left_val >> right_val,
                BinaryOperator::LessThan => {
                    if left_val < right_val {
                        1
                    } else {
                        0
                    }
                }
                BinaryOperator::LessThanOrEqualTo => {
                    if left_val <= right_val {
                        1
                    } else {
                        0
                    }
                }
                BinaryOperator::GreaterThan => {
                    if left_val > right_val {
                        1
                    } else {
                        0
                    }
                }
                BinaryOperator::GreaterThanOrEqualTo => {
                    if left_val >= right_val {
                        1
                    } else {
                        0
                    }
                }
                BinaryOperator::Equals => {
                    if left_val == right_val {
                        1
                    } else {
                        0
                    }
                }
                BinaryOperator::NotEquals => {
                    if left_val != right_val {
                        1
                    } else {
                        0
                    }
                }
                BinaryOperator::Comma => right_val, // Comma operator: evaluate both, return right
                BinaryOperator::LogicalAnd | BinaryOperator::LogicalOr => {
                    unreachable!("handled above with short-circuit evaluation")
                }
            })
        }

        ArithmeticExpr::Conditional(cond, if_true, if_false) => {
            let cond_val = eval_expr(cond, env)?;
            if cond_val != 0 {
                eval_expr(if_true, env)
            } else {
                eval_expr(if_false, env)
            }
        }

        ArithmeticExpr::Assignment(target, value) => {
            let val = eval_expr(value, env)?;
            set_target_value(target, val, env)?;
            Ok(val)
        }

        ArithmeticExpr::BinaryAssignment(op, target, value) => {
            let current = get_target_value(target, env)?;
            let rhs = eval_expr(value, env)?;

            let new_val = match op {
                BinaryOperator::Add => current + rhs,
                BinaryOperator::Subtract => current - rhs,
                BinaryOperator::Multiply => current * rhs,
                BinaryOperator::Divide => {
                    if rhs == 0 {
                        return Err("division by zero".to_string());
                    }
                    current / rhs
                }
                BinaryOperator::Modulo => {
                    if rhs == 0 {
                        return Err("division by zero".to_string());
                    }
                    current % rhs
                }
                BinaryOperator::BitwiseAnd => current & rhs,
                BinaryOperator::BitwiseOr => current | rhs,
                BinaryOperator::BitwiseXor => current ^ rhs,
                BinaryOperator::ShiftLeft => current << rhs,
                BinaryOperator::ShiftRight => current >> rhs,
                _ => {
                    return Err(format!(
                        "unsupported compound assignment operator: {:?}",
                        op
                    ))
                }
            };

            set_target_value(target, new_val, env)?;
            Ok(new_val)
        }

        ArithmeticExpr::UnaryAssignment(op, target) => {
            let current = get_target_value(target, env)?;

            let (return_val, new_val) = match op {
                UnaryAssignmentOperator::PrefixIncrement => (current + 1, current + 1),
                UnaryAssignmentOperator::PrefixDecrement => (current - 1, current - 1),
                UnaryAssignmentOperator::PostfixIncrement => (current, current + 1),
                UnaryAssignmentOperator::PostfixDecrement => (current, current - 1),
            };

            set_target_value(target, new_val, env)?;
            Ok(return_val)
        }
    }
}

/// Get the numeric value of an arithmetic target (variable or array element).
fn get_target_value(target: &ArithmeticTarget, env: &ShellEnv) -> Result<i64, String> {
    match target {
        ArithmeticTarget::Variable(name) => {
            let value_str = env.get_var(name).map(|s| s.as_str()).unwrap_or("");
            if value_str.is_empty() {
                Ok(0)
            } else {
                parse_number(value_str)
            }
        }
        ArithmeticTarget::ArrayElement(name, index_expr) => {
            // Evaluate the index expression
            let index = eval_expr(index_expr, &mut env.clone())?;
            let value_str = env
                .get_array_element(name, &index.to_string())
                .unwrap_or_default();
            if value_str.is_empty() {
                Ok(0)
            } else {
                parse_number(&value_str)
            }
        }
    }
}

/// Set the value of an arithmetic target.
fn set_target_value(
    target: &ArithmeticTarget,
    value: i64,
    env: &mut ShellEnv,
) -> Result<(), String> {
    match target {
        ArithmeticTarget::Variable(name) => {
            let _ = env.set_var(name, &value.to_string());
            Ok(())
        }
        ArithmeticTarget::ArrayElement(name, index_expr) => {
            let index = eval_expr(index_expr, &mut env.clone())?;
            env.set_array_element(name, &index.to_string(), &value.to_string())?;
            Ok(())
        }
    }
}

/// Parse a numeric string, supporting hex, octal, and binary formats.
fn parse_number(s: &str) -> Result<i64, String> {
    let s = s.trim();

    if s.is_empty() {
        return Ok(0);
    }

    // Handle negative numbers
    if let Some(rest) = s.strip_prefix('-') {
        return Ok(-parse_number(rest)?);
    }

    // Hexadecimal: 0x or 0X prefix
    if let Some(hex) = s.strip_prefix("0x").or_else(|| s.strip_prefix("0X")) {
        return i64::from_str_radix(hex, 16).map_err(|_| format!("invalid hex number: {}", s));
    }

    // Modern octal: 0o or 0O prefix
    if let Some(oct) = s.strip_prefix("0o").or_else(|| s.strip_prefix("0O")) {
        return i64::from_str_radix(oct, 8).map_err(|_| format!("invalid octal number: {}", s));
    }

    // Binary: 0b or 0B prefix
    if let Some(bin) = s.strip_prefix("0b").or_else(|| s.strip_prefix("0B")) {
        return i64::from_str_radix(bin, 2).map_err(|_| format!("invalid binary number: {}", s));
    }

    // Legacy octal: leading 0 (only if all digits are 0-7)
    if s.starts_with('0') && s.len() > 1 && s.chars().all(|c| c.is_ascii_digit()) {
        if s.chars().skip(1).all(|c| c >= '0' && c <= '7') {
            return i64::from_str_radix(s, 8).map_err(|_| format!("invalid octal number: {}", s));
        }
    }

    // Decimal
    s.parse().map_err(|_| format!("invalid number: {}", s))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn eval(expr: &str) -> Result<i64, String> {
        let mut env = ShellEnv::new();
        evaluate(expr, &mut env)
    }

    fn eval_with_var(expr: &str, name: &str, value: &str) -> Result<i64, String> {
        let mut env = ShellEnv::new();
        let _ = env.set_var(name, value);
        evaluate(expr, &mut env)
    }

    // Basic arithmetic
    #[test]
    fn test_literal() {
        assert_eq!(eval("42").unwrap(), 42);
        assert_eq!(eval("0").unwrap(), 0);
        assert_eq!(eval("-5").unwrap(), -5);
    }

    #[test]
    fn test_addition() {
        assert_eq!(eval("1 + 2").unwrap(), 3);
        assert_eq!(eval("10 + 20 + 30").unwrap(), 60);
    }

    #[test]
    fn test_subtraction() {
        assert_eq!(eval("10 - 3").unwrap(), 7);
        assert_eq!(eval("5 - 10").unwrap(), -5);
    }

    #[test]
    fn test_multiplication() {
        assert_eq!(eval("3 * 4").unwrap(), 12);
        assert_eq!(eval("2 * 3 * 4").unwrap(), 24);
    }

    #[test]
    fn test_division() {
        assert_eq!(eval("10 / 2").unwrap(), 5);
        assert_eq!(eval("7 / 2").unwrap(), 3);
    }

    #[test]
    fn test_division_by_zero() {
        assert!(eval("5 / 0").is_err());
    }

    #[test]
    fn test_modulo() {
        assert_eq!(eval("10 % 3").unwrap(), 1);
        assert_eq!(eval("15 % 5").unwrap(), 0);
    }

    #[test]
    fn test_power() {
        assert_eq!(eval("2 ** 8").unwrap(), 256);
        assert_eq!(eval("3 ** 3").unwrap(), 27);
    }

    #[test]
    fn test_precedence() {
        assert_eq!(eval("2 + 3 * 4").unwrap(), 14);
        assert_eq!(eval("(2 + 3) * 4").unwrap(), 20);
    }

    // Comparison operators
    #[test]
    fn test_comparisons() {
        assert_eq!(eval("5 > 3").unwrap(), 1);
        assert_eq!(eval("3 > 5").unwrap(), 0);
        assert_eq!(eval("5 >= 5").unwrap(), 1);
        assert_eq!(eval("5 < 6").unwrap(), 1);
        assert_eq!(eval("5 <= 5").unwrap(), 1);
        assert_eq!(eval("5 == 5").unwrap(), 1);
        assert_eq!(eval("5 != 3").unwrap(), 1);
    }

    // Logical operators
    #[test]
    fn test_logical() {
        assert_eq!(eval("1 && 1").unwrap(), 1);
        assert_eq!(eval("1 && 0").unwrap(), 0);
        assert_eq!(eval("0 && 1").unwrap(), 0);
        assert_eq!(eval("0 || 1").unwrap(), 1);
        assert_eq!(eval("0 || 0").unwrap(), 0);
        assert_eq!(eval("!0").unwrap(), 1);
        assert_eq!(eval("!5").unwrap(), 0);
    }

    // Bitwise operators
    #[test]
    fn test_bitwise() {
        assert_eq!(eval("5 & 3").unwrap(), 1);
        assert_eq!(eval("5 | 3").unwrap(), 7);
        assert_eq!(eval("5 ^ 3").unwrap(), 6);
        assert_eq!(eval("~0").unwrap(), -1);
        assert_eq!(eval("1 << 4").unwrap(), 16);
        assert_eq!(eval("16 >> 2").unwrap(), 4);
    }

    // Ternary operator
    #[test]
    fn test_ternary() {
        assert_eq!(eval("1 ? 10 : 20").unwrap(), 10);
        assert_eq!(eval("0 ? 10 : 20").unwrap(), 20);
        assert_eq!(eval("5 > 3 ? 100 : 200").unwrap(), 100);
    }

    // Variables
    #[test]
    fn test_variable_reference() {
        assert_eq!(eval_with_var("x", "x", "42").unwrap(), 42);
        assert_eq!(eval_with_var("x + 10", "x", "32").unwrap(), 42);
    }

    #[test]
    fn test_unset_variable() {
        // Unset variables default to 0
        assert_eq!(eval("undefined_var").unwrap(), 0);
    }

    // Number formats
    #[test]
    fn test_hex() {
        assert_eq!(eval("0xFF").unwrap(), 255);
        assert_eq!(eval("0x10").unwrap(), 16);
    }

    #[test]
    fn test_octal() {
        assert_eq!(eval("010").unwrap(), 8);
        // brush-parser supports standard shell octal (leading 0)
        // 0o prefix is not standard shell arithmetic
        assert_eq!(eval("017").unwrap(), 15);
    }

    #[test]
    fn test_binary() {
        // Standard bash binary notation is base#number
        assert_eq!(eval("2#1010").unwrap(), 10);
        assert_eq!(eval("2#11111111").unwrap(), 255);
    }

    // Assignment operators
    #[test]
    fn test_assignment() {
        let mut env = ShellEnv::new();
        let result = evaluate("x = 42", &mut env).unwrap();
        assert_eq!(result, 42);
        assert_eq!(env.get_var("x").unwrap(), "42");
    }

    #[test]
    fn test_compound_assignment() {
        let mut env = ShellEnv::new();
        let _ = env.set_var("x", "10");
        let result = evaluate("x += 5", &mut env).unwrap();
        assert_eq!(result, 15);
        assert_eq!(env.get_var("x").unwrap(), "15");
    }

    #[test]
    fn test_increment_decrement() {
        let mut env = ShellEnv::new();
        let _ = env.set_var("x", "5");

        // Prefix increment
        assert_eq!(evaluate("++x", &mut env).unwrap(), 6);
        assert_eq!(env.get_var("x").unwrap(), "6");

        // Postfix increment
        assert_eq!(evaluate("x++", &mut env).unwrap(), 6);
        assert_eq!(env.get_var("x").unwrap(), "7");

        // Prefix decrement
        assert_eq!(evaluate("--x", &mut env).unwrap(), 6);
        assert_eq!(env.get_var("x").unwrap(), "6");

        // Postfix decrement
        assert_eq!(evaluate("x--", &mut env).unwrap(), 6);
        assert_eq!(env.get_var("x").unwrap(), "5");
    }

    // Comma operator
    #[test]
    fn test_comma() {
        let mut env = ShellEnv::new();
        // Comma evaluates both expressions, returns rightmost
        let result = evaluate("x = 1, y = 2, x + y", &mut env).unwrap();
        assert_eq!(result, 3);
    }
}
