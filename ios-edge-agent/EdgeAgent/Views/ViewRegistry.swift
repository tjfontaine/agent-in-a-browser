import SwiftUI
import Foundation
import OSLog

// MARK: - View Template Types

/// Animation configuration for view transitions
struct ViewAnimation: Codable, Sendable {
    let enter: String?
    let exit: String?
    let duration: Double?
    
    static let `default` = ViewAnimation(enter: "slideFromRight", exit: "slideToRight", duration: 0.3)
    
    var enterTransition: AnyTransition {
        switch enter {
        case "fade": return .opacity
        case "slideFromRight": return .move(edge: .trailing)
        case "slideFromBottom": return .move(edge: .bottom)
        case "slideToRight": return .move(edge: .trailing)
        case "slideToBottom": return .move(edge: .bottom)
        case "scale": return .scale
        case "none": return .identity
        default: return .move(edge: .trailing)
        }
    }
    
    var exitTransition: AnyTransition {
        switch exit {
        case "fade": return .opacity
        case "slideFromRight": return .move(edge: .trailing)
        case "slideFromBottom": return .move(edge: .bottom)
        case "slideToRight": return .move(edge: .trailing)
        case "slideToBottom": return .move(edge: .bottom)
        case "scale": return .scale
        case "none": return .identity
        default: return .move(edge: .trailing)
        }
    }
    
    var animationDuration: Double {
        duration ?? 0.3
    }
}

/// A cached view template with data bindings
struct ViewTemplate: Codable, Sendable {
    let name: String
    let version: String
    let template: String  // JSON string of component tree
    let defaultData: String?  // JSON string of default data
    let animation: ViewAnimation?
    let createdAt: Date
    var updatedAt: Date
    
    /// Parse template into component dictionary
    func parseTemplate() -> [String: Any]? {
        guard let data = template.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return nil
        }
        return json
    }
    
    /// Parse default data into dictionary
    func parseDefaultData() -> [String: Any]? {
        guard let defaultData = defaultData,
              let data = defaultData.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return nil
        }
        return json
    }
}

/// State for a view in the navigation stack
struct ViewState: @unchecked Sendable {
    let viewName: String
    var data: [String: Any]
    var scrollOffset: CGFloat?
    
    // Sendable conformance requires explicit handling of [String: Any]
    init(viewName: String, data: [String: Any], scrollOffset: CGFloat? = nil) {
        self.viewName = viewName
        self.data = data
        self.scrollOffset = scrollOffset
    }
}

// MARK: - View Registry

/// Central registry for cached view templates and navigation state
@MainActor
class ViewRegistry: ObservableObject {
    
    static let shared = ViewRegistry()
    
    // MARK: - Published State
    
    /// Cached view templates by name
    @Published private(set) var templates: [String: ViewTemplate] = [:]
    
    /// Navigation stack (view name + data)
    @Published private(set) var navigationStack: [ViewState] = []
    
    /// Current rendered components (resolved from template + data)
    @Published var renderedComponents: [[String: Any]] = []
    
    // MARK: - Initialization
    
    private init() {
        Log.app.info("ViewRegistry: Initialized")
    }

    // MARK: - Path Patch Helpers

    private enum TemplatePathToken {
        case key(String)
        case index(Int)
    }
    
    // MARK: - Current View
    
    /// The current view state (top of navigation stack)
    var currentView: ViewState? {
        navigationStack.last
    }
    
    /// The current view's template
    var currentTemplate: ViewTemplate? {
        guard let viewName = currentView?.viewName else { return nil }
        return templates[viewName]
    }
    
    // MARK: - View Registration
    
    /// Register a view template
    func registerView(
        name: String,
        version: String,
        template: [String: Any],
        defaultData: [String: Any]? = nil,
        animation: ViewAnimation? = nil
    ) throws {
        // Serialize template to JSON string
        let templateData = try JSONSerialization.data(withJSONObject: template)
        guard let templateString = String(data: templateData, encoding: .utf8) else {
            throw ViewRegistryError.serializationFailed("Failed to serialize template")
        }
        
        // Serialize default data if provided
        var defaultDataString: String? = nil
        if let defaultData = defaultData {
            let defaultDataData = try JSONSerialization.data(withJSONObject: defaultData)
            defaultDataString = String(data: defaultDataData, encoding: .utf8)
        }
        
        let now = Date()
        let existingCreatedAt = templates[name]?.createdAt ?? now
        let viewTemplate = ViewTemplate(
            name: name,
            version: version,
            template: templateString,
            defaultData: defaultDataString,
            animation: animation,
            createdAt: existingCreatedAt,
            updatedAt: now
        )
        
        // Check for version changes
        if let existing = templates[name] {
            if existing.version != version {
                Log.app.info("ViewRegistry: Updating '\(name)' from v\(existing.version) to v\(version)")
            }
        } else {
            Log.app.info("ViewRegistry: Registered new view '\(name)' v\(version)")
        }
        
        templates[name] = viewTemplate
        persistTemplate(viewTemplate)
    }
    
    // MARK: - Navigation
    
    /// Navigate to a registered view with data
    func showView(name: String, data: [String: Any]? = nil) throws {
        guard let template = templates[name] else {
            throw ViewRegistryError.viewNotFound(name)
        }
        
        // Merge with default data
        var viewData = template.parseDefaultData() ?? [:]
        if let data = data {
            for (key, value) in data {
                viewData[key] = value
            }
        }
        
        let viewState = ViewState(viewName: name, data: viewData)
        navigationStack.append(viewState)
        
        Log.app.info("ViewRegistry: showView '\(name)', stack depth: \(navigationStack.count)")
        Log.app.debug("ViewRegistry: Data keys: \(viewData.keys.joined(separator: ", "))")
        
        // Render the view
        try renderCurrentView()
    }
    
    /// Pop the navigation stack
    @discardableResult
    func popView() -> Bool {
        guard navigationStack.count > 1 else {
            Log.app.warning("ViewRegistry: Cannot pop - only one view in stack")
            return false
        }
        
        navigationStack.removeLast()
        Log.app.info("ViewRegistry: popped, stack depth: \(navigationStack.count)")
        
        // Re-render previous view
        do {
            try renderCurrentView()
        } catch {
            Log.app.error("ViewRegistry: Failed to render after pop: \(error)")
        }
        
        return true
    }
    
    /// Update data for the current view
    func updateViewData(data: [String: Any]) throws {
        guard var current = navigationStack.popLast() else {
            throw ViewRegistryError.noCurrentView
        }
        
        // Merge new data
        for (key, value) in data {
            current.data[key] = value
        }
        
        navigationStack.append(current)
        
        // Re-render
        try renderCurrentView()
    }

    /// Apply patches to a registered template
    func updateTemplate(name: String, patches: [[String: Any]]) throws {
        guard var existing = templates[name] else {
            throw ViewRegistryError.viewNotFound(name)
        }

        guard var template = existing.parseTemplate() else {
            throw ViewRegistryError.serializationFailed("Template for '\(name)' is not valid JSON")
        }

        for patch in patches {
            try applyTemplatePatch(&template, patch: patch)
        }

        let serialized = try JSONSerialization.data(withJSONObject: template)
        guard let serializedString = String(data: serialized, encoding: .utf8) else {
            throw ViewRegistryError.serializationFailed("Failed to serialize patched template")
        }

        existing = ViewTemplate(
            name: existing.name,
            version: existing.version,
            template: serializedString,
            defaultData: existing.defaultData,
            animation: existing.animation,
            createdAt: existing.createdAt,
            updatedAt: Date()
        )
        templates[name] = existing
        persistTemplate(existing)

        if currentView?.viewName == name {
            try renderCurrentView()
        }
    }
    
    // MARK: - Cache Management
    
    /// Invalidate a specific view
    func invalidateView(name: String) {
        templates.removeValue(forKey: name)
        try? DatabaseManager.shared.deleteViewTemplate(name: name)
        Log.app.info("ViewRegistry: Invalidated view '\(name)'")
    }
    
    /// Clear all cached views
    func invalidateAllViews() {
        templates.removeAll()
        navigationStack.removeAll()
        renderedComponents.removeAll()
        try? DatabaseManager.shared.clearViewTemplates()
        Log.app.info("ViewRegistry: Cleared all views")
    }

    /// Clear only rendered/navigation state while keeping cached templates intact.
    /// Useful when switching contexts without destroying globally reusable templates.
    func clearRenderedState() {
        navigationStack.removeAll()
        renderedComponents.removeAll()
        Log.app.info("ViewRegistry: Cleared rendered/navigation state")
    }
    
    // MARK: - Rendering
    
    /// Render the current view using TemplateRenderer
    private func renderCurrentView() throws {
        guard let viewState = currentView,
              let template = templates[viewState.viewName],
              let templateDict = template.parseTemplate() else {
            throw ViewRegistryError.renderFailed("No current view or template")
        }
        
        // Use TemplateRenderer to resolve bindings
        let resolved = TemplateRenderer.render(template: templateDict, data: viewState.data)
        renderedComponents = [resolved]
        
        // Debug: log template type for ForEach debugging
        if let type = templateDict["type"] as? String {
            Log.app.debug("ViewRegistry: Template type: \(type)")
        }
        if let props = templateDict["props"] as? [String: Any],
           let children = props["children"] as? [[String: Any]] {
            let childTypes = children.compactMap { $0["type"] as? String }
            Log.app.debug("ViewRegistry: Template children: \(childTypes.joined(separator: ", "))")
        }
        
        Log.app.debug("ViewRegistry: Rendered '\(viewState.viewName)'")
    }
    
    // MARK: - Persistence
    
    /// Load templates from SQLite (called on app launch)
    func loadFromDatabase() async throws {
        let loaded = try DatabaseManager.shared.loadViewTemplates()
        templates = loaded
        Log.app.info("ViewRegistry: Loaded \(loaded.count) template(s) from SQLite")
    }

    /// Save templates to SQLite
    func saveToDatabase() async throws {
        for template in templates.values {
            try DatabaseManager.shared.saveViewTemplate(template)
        }
        Log.app.info("ViewRegistry: Saved \(self.templates.count) template(s) to SQLite")
    }

    /// Export current templates as a JSON snapshot (for revision history)
    func exportTemplatesSnapshot() throws -> String {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        let templatesArray = Array(templates.values)
        let data = try encoder.encode(templatesArray)
        guard let json = String(data: data, encoding: .utf8) else {
            throw ViewRegistryError.serializationFailed("Failed to encode template snapshot")
        }
        return json
    }

    /// Import templates from a JSON snapshot and persist them
    func importTemplatesSnapshot(_ snapshot: String) throws {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        guard let data = snapshot.data(using: .utf8) else {
            throw ViewRegistryError.serializationFailed("Snapshot is not valid UTF-8")
        }
        let restored = try decoder.decode([ViewTemplate].self, from: data)

        templates = Dictionary(uniqueKeysWithValues: restored.map { ($0.name, $0) })
        navigationStack.removeAll()
        renderedComponents.removeAll()

        try DatabaseManager.shared.clearViewTemplates()
        for template in restored {
            try DatabaseManager.shared.saveViewTemplate(template)
        }

        Log.app.info("ViewRegistry: Imported \(restored.count) template(s) from revision snapshot")
    }

    private func persistTemplate(_ template: ViewTemplate) {
        do {
            try DatabaseManager.shared.saveViewTemplate(template)
        } catch {
            Log.app.error("ViewRegistry: Failed to persist template '\(template.name)': \(error)")
        }
    }

    private func applyTemplatePatch(_ template: inout [String: Any], patch: [String: Any]) throws {
        guard let path = patch["path"] as? String, !path.isEmpty else {
            throw ViewRegistryError.invalidPatch("Patch is missing 'path'")
        }

        let op = (patch["op"] as? String ?? "replace").lowercased()
        let tokens = try parseTemplatePath(path)

        var root: Any = template
        switch op {
        case "replace", "set":
            guard let value = patch["value"] else {
                throw ViewRegistryError.invalidPatch("Patch '\(path)' is missing 'value' for op '\(op)'")
            }
            try updateValue(in: &root, tokens: tokens, value: value, remove: false)
        case "remove", "delete":
            try updateValue(in: &root, tokens: tokens, value: nil, remove: true)
        default:
            throw ViewRegistryError.invalidPatch("Unsupported patch op '\(op)'")
        }

        guard let patched = root as? [String: Any] else {
            throw ViewRegistryError.invalidPatch("Patch '\(path)' corrupted root template type")
        }
        template = patched
    }

    private func parseTemplatePath(_ path: String) throws -> [TemplatePathToken] {
        var tokens: [TemplatePathToken] = []
        var keyBuffer = ""
        var i = path.startIndex

        func flushKey() {
            guard !keyBuffer.isEmpty else { return }
            tokens.append(.key(keyBuffer))
            keyBuffer = ""
        }

        while i < path.endIndex {
            let ch = path[i]
            if ch == "." {
                flushKey()
                i = path.index(after: i)
                continue
            }

            if ch == "[" {
                flushKey()
                let start = path.index(after: i)
                guard let close = path[start...].firstIndex(of: "]") else {
                    throw ViewRegistryError.invalidPatch("Unclosed '[' in patch path '\(path)'")
                }
                let indexString = String(path[start..<close])
                guard let index = Int(indexString) else {
                    throw ViewRegistryError.invalidPatch("Invalid array index '\(indexString)' in patch path '\(path)'")
                }
                tokens.append(.index(index))
                i = path.index(after: close)
                continue
            }

            keyBuffer.append(ch)
            i = path.index(after: i)
        }

        flushKey()
        if tokens.isEmpty {
            throw ViewRegistryError.invalidPatch("Patch path '\(path)' resolved to zero tokens")
        }
        return tokens
    }

    private func updateValue(
        in current: inout Any,
        tokens: [TemplatePathToken],
        value: Any?,
        remove: Bool
    ) throws {
        guard let head = tokens.first else {
            throw ViewRegistryError.invalidPatch("Invalid empty patch token list")
        }

        let tail = Array(tokens.dropFirst())

        if tail.isEmpty {
            switch head {
            case .key(let key):
                guard var dict = current as? [String: Any] else {
                    throw ViewRegistryError.invalidPatch("Expected object at '\(key)'")
                }
                if remove {
                    dict.removeValue(forKey: key)
                } else {
                    dict[key] = value ?? NSNull()
                }
                current = dict
            case .index(let index):
                guard var array = current as? [Any] else {
                    throw ViewRegistryError.invalidPatch("Expected array at index \(index)")
                }
                if remove {
                    guard index >= 0 && index < array.count else {
                        throw ViewRegistryError.invalidPatch("Index \(index) out of range")
                    }
                    array.remove(at: index)
                } else {
                    guard index >= 0 && index <= array.count else {
                        throw ViewRegistryError.invalidPatch("Index \(index) out of range")
                    }
                    if index == array.count {
                        array.append(value ?? NSNull())
                    } else {
                        array[index] = value ?? NSNull()
                    }
                }
                current = array
            }
            return
        }

        switch head {
        case .key(let key):
            guard var dict = current as? [String: Any] else {
                throw ViewRegistryError.invalidPatch("Expected object at '\(key)'")
            }
            guard var child = dict[key] else {
                throw ViewRegistryError.invalidPatch("Path component '\(key)' not found")
            }
            try updateValue(in: &child, tokens: tail, value: value, remove: remove)
            dict[key] = child
            current = dict
        case .index(let index):
            guard var array = current as? [Any] else {
                throw ViewRegistryError.invalidPatch("Expected array at index \(index)")
            }
            guard index >= 0 && index < array.count else {
                throw ViewRegistryError.invalidPatch("Index \(index) out of range")
            }
            var child = array[index]
            try updateValue(in: &child, tokens: tail, value: value, remove: remove)
            array[index] = child
            current = array
        }
    }
}

// MARK: - Errors

public enum ViewRegistryError: Error, LocalizedError {
    case viewNotFound(String)
    case serializationFailed(String)
    case renderFailed(String)
    case noCurrentView
    case invalidPatch(String)
    
    public var errorDescription: String? {
        switch self {
        case .viewNotFound(let name):
            return "View not found: \(name)"
        case .serializationFailed(let reason):
            return "Serialization failed: \(reason)"
        case .renderFailed(let reason):
            return "Render failed: \(reason)"
        case .noCurrentView:
            return "No current view in navigation stack"
        case .invalidPatch(let reason):
            return "Invalid template patch: \(reason)"
        }
    }
}
