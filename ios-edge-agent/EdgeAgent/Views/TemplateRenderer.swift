import Foundation
import OSLog

/// Resolves Mustache-style `{{path}}` bindings in component templates
public class TemplateRenderer {
    
    // MARK: - Main Render Method
    
    /// Resolve all {{bindings}} in a component tree
    public static func render(template: [String: Any], data: [String: Any]) -> [String: Any] {
        return resolveComponent(template, data: data, itemData: nil)
    }
    
    /// Render with item context (for ForEach)
    public static func renderWithItem(template: [String: Any], data: [String: Any], item: [String: Any]) -> [String: Any] {
        return resolveComponent(template, data: data, itemData: item)
    }
    
    // MARK: - Component Resolution
    
    private static func resolveComponent(_ component: [String: Any], data: [String: Any], itemData: [String: Any]?) -> [String: Any] {
        var result: [String: Any] = [:]
        
        for (key, value) in component {
            if key == "type" {
                // Handle special component types
                if let type = value as? String {
                    switch type {
                    case "ForEach":
                        // ForEach is handled specially - expand into multiple components
                        result[key] = value
                    case "If":
                        // If is handled specially - evaluate condition
                        result[key] = value
                    default:
                        result[key] = value
                    }
                } else {
                    result[key] = value
                }
            } else if key == "props" {
                if let props = value as? [String: Any] {
                    result[key] = resolveProps(props, data: data, itemData: itemData)
                } else {
                    result[key] = value
                }
            } else {
                result[key] = resolveValue(value, data: data, itemData: itemData)
            }
        }
        
        return result
    }
    
    private static func resolveProps(_ props: [String: Any], data: [String: Any], itemData: [String: Any]?) -> [String: Any] {
        var result: [String: Any] = [:]
        
        for (key, value) in props {
            if key == "children" {
                if let children = value as? [[String: Any]] {
                    result[key] = children.map { resolveComponent($0, data: data, itemData: itemData) }
                } else {
                    result[key] = value
                }
            } else if key == "itemTemplate" || key == "template" {
                // Don't resolve itemTemplate/template in ForEach - it's resolved per-item
                result[key] = value
            } else if key == "dataKey" {
                // dataKey is a reference, not a binding
                result[key] = value
            } else if key == "condition" {
                // condition needs special handling
                result[key] = value
            } else if key == "then" || key == "else" {
                // Conditional branches - resolve them
                if let branch = value as? [String: Any] {
                    result[key] = resolveComponent(branch, data: data, itemData: itemData)
                } else {
                    result[key] = value
                }
            } else {
                result[key] = resolveValue(value, data: data, itemData: itemData)
            }
        }
        
        return result
    }
    
    // MARK: - Value Resolution
    
    private static func resolveValue(_ value: Any, data: [String: Any], itemData: [String: Any]?) -> Any {
        if let stringValue = value as? String {
            return resolveString(stringValue, data: data, itemData: itemData)
        } else if let dictValue = value as? [String: Any] {
            return resolveComponent(dictValue, data: data, itemData: itemData)
        } else if let arrayValue = value as? [Any] {
            return arrayValue.map { resolveValue($0, data: data, itemData: itemData) }
        } else {
            return value
        }
    }
    
    /// Resolve a string that may contain {{bindings}}
    private static func resolveString(_ string: String, data: [String: Any], itemData: [String: Any]?) -> Any {
        // Check if the entire string is a single binding
        let trimmed = string.trimmingCharacters(in: .whitespaces)
        if trimmed.hasPrefix("{{") && trimmed.hasSuffix("}}") {
            let path = String(trimmed.dropFirst(2).dropLast(2)).trimmingCharacters(in: .whitespaces)
            // If the whole string is a binding, return the actual value (could be any type)
            if let resolved = resolve(path: path, in: data, itemData: itemData) {
                return resolved
            }
            return string // Return original if not found
        }
        
        // Otherwise, interpolate bindings within the string
        var result = string
        let pattern = "\\{\\{([^}]+)\\}\\}"
        
        guard let regex = try? NSRegularExpression(pattern: pattern) else {
            return string
        }
        
        let range = NSRange(string.startIndex..., in: string)
        let matches = regex.matches(in: string, range: range)
        
        // Process matches in reverse order to maintain correct positions
        for match in matches.reversed() {
            guard let matchRange = Range(match.range, in: string),
                  let pathRange = Range(match.range(at: 1), in: string) else {
                continue
            }
            
            let path = String(string[pathRange]).trimmingCharacters(in: .whitespaces)
            
            if let resolved = resolve(path: path, in: data, itemData: itemData) {
                let stringValue = stringifyValue(resolved)
                result = result.replacingCharacters(in: matchRange, with: stringValue)
            }
        }
        
        return result
    }
    
    // MARK: - Path Resolution
    
    /// Resolve a binding path like "recipe.title" or "item.id"
    public static func resolve(path: String, in data: [String: Any], itemData: [String: Any]? = nil) -> Any? {
        // Handle special paths
        if path == "result" {
            return data["result"]
        }
        
        // Handle "item.xxx" for ForEach context
        if path.hasPrefix("item.") {
            let itemPath = String(path.dropFirst(5))
            if let itemData = itemData {
                return resolvePath(itemPath, in: itemData)
            }
            return nil
        }
        
        // Handle "item" directly
        if path == "item" {
            return itemData
        }
        
        return resolvePath(path, in: data)
    }
    
    /// Resolve a dot-separated path in a dictionary
    private static func resolvePath(_ path: String, in data: [String: Any]) -> Any? {
        let components = path.split(separator: ".").map(String.init)
        var current: Any = data
        
        for component in components {
            // Handle array access like "recipes[0]"
            if let bracketIndex = component.firstIndex(of: "["),
               let closeBracketIndex = component.firstIndex(of: "]") {
                let key = String(component[..<bracketIndex])
                let indexStr = String(component[component.index(after: bracketIndex)..<closeBracketIndex])
                
                guard let dict = current as? [String: Any],
                      let array = dict[key] as? [Any],
                      let index = Int(indexStr),
                      index >= 0 && index < array.count else {
                    return nil
                }
                current = array[index]
            } else {
                guard let dict = current as? [String: Any],
                      let value = dict[component] else {
                    return nil
                }
                current = value
            }
        }
        
        return current
    }
    
    // MARK: - ForEach Expansion
    
    /// Expand a ForEach component into multiple resolved components
    public static func expandForEach(
        dataKey: String,
        itemTemplate: [String: Any],
        data: [String: Any]
    ) -> [[String: Any]] {
        guard let items = resolvePath(dataKey, in: data) as? [[String: Any]] else {
            Log.app.warning("TemplateRenderer: ForEach dataKey '\(dataKey)' not found or not an array")
            return []
        }
        
        return items.map { item in
            renderWithItem(template: itemTemplate, data: data, item: item)
        }
    }
    
    // MARK: - Conditional Evaluation
    
    /// Evaluate a condition and return the appropriate branch
    public static func evaluateIf(
        condition: String,
        thenBranch: [String: Any]?,
        elseBranch: [String: Any]?,
        data: [String: Any]
    ) -> [String: Any]? {
        // Simple condition evaluation
        // Supports: {{path}}, {{path.length > 0}}, {{!path}}
        
        let trimmed = condition.trimmingCharacters(in: .whitespaces)
        var conditionPath = trimmed
        
        // Remove {{ }} if present
        if conditionPath.hasPrefix("{{") && conditionPath.hasSuffix("}}") {
            conditionPath = String(conditionPath.dropFirst(2).dropLast(2)).trimmingCharacters(in: .whitespaces)
        }
        
        var result = false
        
        // Handle negation
        if conditionPath.hasPrefix("!") {
            let path = String(conditionPath.dropFirst())
            result = !evaluateTruthy(path: path, data: data)
        }
        // Handle comparison operators
        else if conditionPath.contains(" > ") {
            let parts = conditionPath.components(separatedBy: " > ")
            if parts.count == 2,
               let leftValue = evaluateNumeric(path: parts[0].trimmingCharacters(in: .whitespaces), data: data),
               let rightValue = Double(parts[1].trimmingCharacters(in: .whitespaces)) {
                result = leftValue > rightValue
            }
        } else if conditionPath.contains(" < ") {
            let parts = conditionPath.components(separatedBy: " < ")
            if parts.count == 2,
               let leftValue = evaluateNumeric(path: parts[0].trimmingCharacters(in: .whitespaces), data: data),
               let rightValue = Double(parts[1].trimmingCharacters(in: .whitespaces)) {
                result = leftValue < rightValue
            }
        } else if conditionPath.contains(" == ") {
            let parts = conditionPath.components(separatedBy: " == ")
            if parts.count == 2 {
                let leftPath = parts[0].trimmingCharacters(in: .whitespaces)
                let rightValue = parts[1].trimmingCharacters(in: .whitespaces).replacingOccurrences(of: "\"", with: "")
                if let leftResolved = resolve(path: leftPath, in: data) {
                    result = stringifyValue(leftResolved) == rightValue
                }
            }
        } else {
            // Simple truthy check
            result = evaluateTruthy(path: conditionPath, data: data)
        }
        
        return result ? thenBranch : elseBranch
    }
    
    private static func evaluateTruthy(path: String, data: [String: Any]) -> Bool {
        // Handle .length accessor
        if path.hasSuffix(".length") {
            let basePath = String(path.dropLast(7))
            if let array = resolvePath(basePath, in: data) as? [Any] {
                return !array.isEmpty
            }
            if let string = resolvePath(basePath, in: data) as? String {
                return !string.isEmpty
            }
            return false
        }
        
        guard let value = resolvePath(path, in: data) else {
            return false
        }
        
        // Check truthiness
        if let bool = value as? Bool {
            return bool
        } else if let string = value as? String {
            return !string.isEmpty
        } else if let number = value as? NSNumber {
            return number.boolValue
        } else if let array = value as? [Any] {
            return !array.isEmpty
        } else if let dict = value as? [String: Any] {
            return !dict.isEmpty
        }
        
        return true // Non-nil = truthy
    }
    
    private static func evaluateNumeric(path: String, data: [String: Any]) -> Double? {
        // Handle .length accessor
        if path.hasSuffix(".length") {
            let basePath = String(path.dropLast(7))
            if let array = resolvePath(basePath, in: data) as? [Any] {
                return Double(array.count)
            }
            if let string = resolvePath(basePath, in: data) as? String {
                return Double(string.count)
            }
            return nil
        }
        
        guard let value = resolvePath(path, in: data) else {
            return nil
        }
        
        if let number = value as? NSNumber {
            return number.doubleValue
        } else if let double = value as? Double {
            return double
        } else if let int = value as? Int {
            return Double(int)
        }
        
        return nil
    }
    
    // MARK: - Helpers
    
    private static func stringifyValue(_ value: Any) -> String {
        if let string = value as? String {
            return string
        } else if let number = value as? NSNumber {
            return number.stringValue
        } else if let bool = value as? Bool {
            return bool ? "true" : "false"
        } else if let data = try? JSONSerialization.data(withJSONObject: value),
                  let string = String(data: data, encoding: .utf8) {
            return string
        }
        return String(describing: value)
    }
}
