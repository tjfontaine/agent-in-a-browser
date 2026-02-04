import Foundation
import OSLog

// MARK: - Event Handler Types

/// Types of event handlers that can be attached to UI components
public enum EventHandlerType: Sendable {
    case shellEval(command: String, resultMode: ResultMode, onResult: ResultAction?, onError: ResultAction?)
    case navigate(viewName: String, data: [String: Any]?)
    case update(changes: [String: Any])
    case agent(message: String)
    case popView
    
    /// Parse from a dictionary (JSON from component props)
    public static func parse(from dict: [String: Any], data: [String: Any], itemData: [String: Any]? = nil) -> EventHandlerType? {
        guard let type = dict["type"] as? String else {
            return nil
        }
        
        switch type {
        case "shell_eval":
            guard var command = dict["command"] as? String else {
                return nil
            }
            
            // Resolve bindings in command
            command = TemplateRenderer.resolve(path: command, in: data, itemData: itemData) as? String ?? command
            
            let resultMode = ResultMode(rawValue: dict["resultMode"] as? String ?? "local") ?? .local
            
            var onResult: ResultAction? = nil
            if let onResultDict = dict["onResult"] as? [String: Any] {
                onResult = ResultAction.parse(from: onResultDict)
            }
            
            var onError: ResultAction? = nil
            if let onErrorDict = dict["onError"] as? [String: Any] {
                onError = ResultAction.parse(from: onErrorDict)
            }
            
            return .shellEval(command: command, resultMode: resultMode, onResult: onResult, onError: onError)
            
        case "navigate":
            guard let viewName = dict["view"] as? String else {
                return nil
            }
            let navData = dict["data"] as? [String: Any]
            return .navigate(viewName: viewName, data: navData)
            
        case "update":
            guard let changes = dict["changes"] as? [String: Any] else {
                return nil
            }
            return .update(changes: changes)
            
        case "agent":
            guard let message = dict["message"] as? String else {
                return nil
            }
            // Resolve bindings in message
            let resolvedMessage = TemplateRenderer.resolve(path: message, in: data, itemData: itemData) as? String ?? message
            return .agent(message: resolvedMessage)
            
        case "pop":
            return .popView
            
        default:
            Log.app.warning("EventHandler: Unknown handler type '\(type)'")
            return nil
        }
    }
}

/// Result mode for shell_eval handlers
public enum ResultMode: String, Sendable {
    case local = "local"     // Host uses result, agent not notified
    case notify = "notify"   // Host uses result AND notifies agent
}

/// Action to take with the result of a shell_eval
public enum ResultAction: Sendable {
    case navigate(viewName: String, dataPath: String?)
    case update(changes: [String: Any])
    case toast(message: String)
    case agent(message: String)
    
    static func parse(from dict: [String: Any]) -> ResultAction? {
        guard let action = dict["action"] as? String else {
            return nil
        }
        
        switch action {
        case "navigate":
            guard let viewName = dict["view"] as? String else {
                return nil
            }
            let dataPath = dict["data"] as? String
            return .navigate(viewName: viewName, dataPath: dataPath)
            
        case "update":
            guard let changes = dict["changes"] as? [String: Any] else {
                return nil
            }
            return .update(changes: changes)
            
        case "toast":
            guard let message = dict["message"] as? String else {
                return nil
            }
            return .toast(message: message)
            
        case "agent":
            guard let message = dict["message"] as? String else {
                return nil
            }
            return .agent(message: message)
            
        default:
            return nil
        }
    }
}

// MARK: - Event Context

/// Context for executing an event handler
struct EventContext: @unchecked Sendable {
    let currentView: ViewState?
    let itemData: [String: Any]?
    let registry: ViewRegistry
    
    init(currentView: ViewState?, itemData: [String: Any]?, registry: ViewRegistry) {
        self.currentView = currentView
        self.itemData = itemData
        self.registry = registry
    }
}

// MARK: - Event Result

/// Result of executing an event handler
struct EventResult: @unchecked Sendable {
    let success: Bool
    let data: Any?
    let error: String?
    
    static func success(data: Any? = nil) -> EventResult {
        EventResult(success: true, data: data, error: nil)
    }
    
    static func failure(error: String) -> EventResult {
        EventResult(success: false, data: nil, error: error)
    }
}

// MARK: - Event Handler

/// Executes event handlers locally without LLM involvement
@MainActor
public class EventHandler {
    
    /// Callback to send messages to the agent
    public var onAgentMessage: ((String) -> Void)?
    
    /// Callback to show toast messages
    public var onToast: ((String) -> Void)?
    
    /// Callback to execute shell_eval (via NativeMCPHost)
    public var onShellEval: ((String) async -> (Bool, String?))? 
    
    public init() {}
    
    // MARK: - Execution
    
    /// Execute an event handler
    func execute(
        handler: EventHandlerType,
        context: EventContext
    ) async -> EventResult {
        switch handler {
        case .shellEval(let command, let resultMode, let onResult, let onError):
            return await executeShellEval(
                command: command,
                resultMode: resultMode,
                onResult: onResult,
                onError: onError,
                context: context
            )
            
        case .navigate(let viewName, let data):
            return await executeNavigate(viewName: viewName, data: data, context: context)
            
        case .update(let changes):
            return await executeUpdate(changes: changes, context: context)
            
        case .agent(let message):
            return executeAgent(message: message)
            
        case .popView:
            return executePopView(context: context)
        }
    }
    
    // MARK: - Handler Implementations
    
    private func executeShellEval(
        command: String,
        resultMode: ResultMode,
        onResult: ResultAction?,
        onError: ResultAction?,
        context: EventContext
    ) async -> EventResult {
        Log.app.info("EventHandler: Executing shell_eval: \(command.prefix(100))...")
        
        guard let shellEval = onShellEval else {
            Log.app.error("EventHandler: No shell_eval handler configured")
            return .failure(error: "No shell_eval handler configured")
        }
        
        let (success, output) = await shellEval(command)
        
        if success {
            // Parse output as JSON if possible
            var resultData: Any? = output
            if let output = output,
               let jsonData = output.data(using: .utf8),
               let json = try? JSONSerialization.jsonObject(with: jsonData) {
                resultData = json
            }
            
            // Notify agent if requested
            if resultMode == .notify, let message = output {
                onAgentMessage?("shell_eval completed: \(message)")
            }
            
            // Execute onResult action
            if let onResult = onResult {
                return await executeResultAction(onResult, result: resultData, context: context)
            }
            
            return .success(data: resultData)
        } else {
            // Handle error
            let errorMessage = output ?? "shell_eval failed"
            
            if let onError = onError {
                return await executeResultAction(onError, result: nil, context: context, error: errorMessage)
            }
            
            // Default: notify agent for error recovery
            onAgentMessage?("shell_eval error: \(errorMessage)")
            return .failure(error: errorMessage)
        }
    }
    
    private func executeResultAction(
        _ action: ResultAction,
        result: Any?,
        context: EventContext,
        error: String? = nil
    ) async -> EventResult {
        switch action {
        case .navigate(let viewName, let dataPath):
            var navData: [String: Any]? = nil
            
            if let dataPath = dataPath {
                // Check if dataPath is {{result}}
                if dataPath == "{{result}}" {
                    if let resultDict = result as? [String: Any] {
                        navData = resultDict
                    } else if let result = result {
                        navData = ["result": result]
                    }
                } else if dataPath.hasPrefix("{{result.") {
                    // Extract path like {{result.field}}
                    let path = String(dataPath.dropFirst(9).dropLast(2))
                    if let resultDict = result as? [String: Any] {
                        if let value = TemplateRenderer.resolve(path: path, in: resultDict) {
                            navData = value as? [String: Any] ?? ["value": value]
                        }
                    }
                }
            }
            
            return await executeNavigate(viewName: viewName, data: navData, context: context)
            
        case .update(let changes):
            return await executeUpdate(changes: changes, context: context)
            
        case .toast(let message):
            var resolvedMessage = message
            if let error = error {
                resolvedMessage = message.replacingOccurrences(of: "{{error}}", with: error)
            }
            onToast?(resolvedMessage)
            return .success()
            
        case .agent(let message):
            var resolvedMessage = message
            if let error = error {
                resolvedMessage = message.replacingOccurrences(of: "{{error}}", with: error)
            }
            return executeAgent(message: resolvedMessage)
        }
    }
    
    private func executeNavigate(
        viewName: String,
        data: [String: Any]?,
        context: EventContext
    ) async -> EventResult {
        Log.app.info("EventHandler: Navigating to '\(viewName)'")
        
        do {
            try await MainActor.run {
                try context.registry.showView(name: viewName, data: data)
            }
            return .success()
        } catch {
            Log.app.error("EventHandler: Navigation failed: \(error)")
            return .failure(error: error.localizedDescription)
        }
    }
    
    private func executeUpdate(
        changes: [String: Any],
        context: EventContext
    ) async -> EventResult {
        Log.app.info("EventHandler: Updating view data")
        
        do {
            try await MainActor.run {
                try context.registry.updateViewData(data: changes)
            }
            return .success()
        } catch {
            Log.app.error("EventHandler: Update failed: \(error)")
            return .failure(error: error.localizedDescription)
        }
    }
    
    private func executeAgent(message: String) -> EventResult {
        Log.app.info("EventHandler: Escalating to agent: \(message.prefix(100))...")
        onAgentMessage?(message)
        return .success()
    }
    
    private func executePopView(context: EventContext) -> EventResult {
        Log.app.info("EventHandler: Popping view")
        
        let success = context.registry.popView()
        if success {
            return .success()
        } else {
            return .failure(error: "Cannot pop - at root view")
        }
    }
}
