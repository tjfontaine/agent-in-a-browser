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
struct ViewState: Sendable {
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
        let viewTemplate = ViewTemplate(
            name: name,
            version: version,
            template: templateString,
            defaultData: defaultDataString,
            animation: animation,
            createdAt: now,
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
    
    // MARK: - Cache Management
    
    /// Invalidate a specific view
    func invalidateView(name: String) {
        templates.removeValue(forKey: name)
        Log.app.info("ViewRegistry: Invalidated view '\(name)'")
    }
    
    /// Clear all cached views
    func invalidateAllViews() {
        templates.removeAll()
        navigationStack.removeAll()
        renderedComponents.removeAll()
        Log.app.info("ViewRegistry: Cleared all views")
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
        // TODO: Implement SQLite loading via DatabaseManager
        Log.app.info("ViewRegistry: loadFromDatabase (not yet implemented)")
    }
    
    /// Save templates to SQLite
    func saveToDatabase() async throws {
        // TODO: Implement SQLite saving via DatabaseManager
        Log.app.info("ViewRegistry: saveToDatabase (not yet implemented)")
    }
}

// MARK: - Errors

public enum ViewRegistryError: Error, LocalizedError {
    case viewNotFound(String)
    case serializationFailed(String)
    case renderFailed(String)
    case noCurrentView
    
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
        }
    }
}
