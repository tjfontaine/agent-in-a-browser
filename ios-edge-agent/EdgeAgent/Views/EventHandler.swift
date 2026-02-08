import Foundation
import OSLog

// MARK: - Event Handler Types

/// Types of event handlers that can be attached to UI components
public enum EventHandlerType: @unchecked Sendable {
    case shellEval(command: String, resultMode: ResultMode, onResult: ResultAction?, onError: ResultAction?)
    case scriptEval(code: String?, file: String?, args: [String], resultMode: ResultMode, onResult: ResultAction?, onError: ResultAction?)
    case runScript(appId: String, script: String, scriptAction: String?, args: [String], resultMode: ResultMode, onResult: ResultAction?, onError: ResultAction?)
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
            
        case "script_eval":
            let code = dict["code"] as? String
            let file = dict["file"] as? String
            guard code != nil || file != nil else {
                Log.app.warning("EventHandler: script_eval requires 'code' or 'file'")
                return nil
            }
            let args = dict["args"] as? [String] ?? []
            let seResultMode = ResultMode(rawValue: dict["resultMode"] as? String ?? "local") ?? .local
            
            var seOnResult: ResultAction? = nil
            if let onResultDict = dict["onResult"] as? [String: Any] {
                seOnResult = ResultAction.parse(from: onResultDict)
            }
            
            var seOnError: ResultAction? = nil
            if let onErrorDict = dict["onError"] as? [String: Any] {
                seOnError = ResultAction.parse(from: onErrorDict)
            }
            
            return .scriptEval(code: code, file: file, args: args, resultMode: seResultMode, onResult: seOnResult, onError: seOnError)
            
        case "run_script":
            guard let script = dict["script"] as? String else {
                Log.app.warning("EventHandler: run_script requires 'script'")
                return nil
            }
            guard let appId = dict["app_id"] as? String else {
                Log.app.warning("EventHandler: run_script requires 'app_id'")
                return nil
            }
            let scriptAction = dict["scriptAction"] as? String
            let rsArgs = dict["args"] as? [String] ?? []
            let rsResultMode = ResultMode(rawValue: dict["resultMode"] as? String ?? "local") ?? .local
            
            var rsOnResult: ResultAction? = nil
            if let rsOnResultDict = dict["onResult"] as? [String: Any] {
                rsOnResult = ResultAction.parse(from: rsOnResultDict)
            }
            
            var rsOnError: ResultAction? = nil
            if let rsOnErrorDict = dict["onError"] as? [String: Any] {
                rsOnError = ResultAction.parse(from: rsOnErrorDict)
            }
            
            return .runScript(appId: appId, script: script, scriptAction: scriptAction, args: rsArgs, resultMode: rsResultMode, onResult: rsOnResult, onError: rsOnError)
            
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
public enum ResultAction: @unchecked Sendable {
    case navigate(viewName: String, dataPath: String?)
    case update(changes: [String: Any])
    case toast(message: String)
    case agent(message: String)
    case render  // Render the script's JSON output as SDUI components directly
    
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
            
        case "render":
            return .render
            
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
    
    /// Callback to execute script_eval (direct WASM, no HTTP/MCP).
    /// Parameters: (code, file, args, appId, scriptName)
    public var onScriptEval: ((String?, String?, [String], String?, String?) async -> (Bool, String?))?
    
    /// Callback to render components directly (script-first rendering)
    public var onRenderComponents: (([[String: Any]]) -> Void)?
    
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
            
        case .scriptEval(let code, let file, let args, let resultMode, let onResult, let onError):
            return await executeScriptEval(
                code: code,
                file: file,
                args: args,
                resultMode: resultMode,
                onResult: onResult,
                onError: onError,
                context: context
            )
            
        case .runScript(let appId, let script, let scriptAction, let args, let resultMode, let onResult, let onError):
            return await executeRunScript(
                appId: appId,
                script: script,
                scriptAction: scriptAction,
                args: args,
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
    
    private func executeScriptEval(
        code: String?,
        file: String?,
        args: [String],
        resultMode: ResultMode,
        onResult: ResultAction?,
        onError: ResultAction?,
        context: EventContext
    ) async -> EventResult {
        Log.app.info("EventHandler: Executing script_eval: code=\(code?.prefix(50) ?? "nil"), file=\(file ?? "nil")")
        
        guard let scriptEval = onScriptEval else {
            Log.app.error("EventHandler: No script_eval handler configured")
            return .failure(error: "No script_eval handler configured")
        }
        
        let (success, output) = await scriptEval(code, file, args, nil, nil)
        
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
                onAgentMessage?("script_eval completed: \(message)")
            }
            
            // Execute onResult action
            if let onResult = onResult {
                return await executeResultAction(onResult, result: resultData, context: context)
            }
            
            return .success(data: resultData)
        } else {
            // Handle error
            let errorMessage = output ?? "script_eval failed"
            
            if let onError = onError {
                return await executeResultAction(onError, result: nil, context: context, error: errorMessage)
            }
            
            // Default: notify agent for error recovery
            onAgentMessage?("script_eval error: \(errorMessage)")
            return .failure(error: errorMessage)
        }
    }
    
    // TODO: Phase 4 — enforce app-scoped permissions before script execution (check appId grants)
    private func executeRunScript(
        appId: String,
        script: String,
        scriptAction: String?,
        args: [String],
        resultMode: ResultMode,
        onResult: ResultAction?,
        onError: ResultAction?,
        context: EventContext
    ) async -> EventResult {
        Log.app.info("EventHandler: Executing run_script: app=\(appId), script=\(script), action=\(scriptAction ?? "nil")")
        
        // Resolve script from app-scoped repository
        let repo = AppBundleRepository()
        do {
            guard try repo.getAppScript(appId: appId, name: script) != nil else {
                let errorMsg = "Script '\(script)' not found for app '\(appId)'"
                Log.app.error("EventHandler: \(errorMsg)")
                if let onError = onError {
                    return await executeResultAction(onError, result: nil, context: context, error: errorMsg)
                }
                onAgentMessage?("run_script error: \(errorMsg)")
                return .failure(error: errorMsg)
            }
        } catch {
            let errorMsg = "Failed to resolve script: \(error.localizedDescription)"
            if let onError = onError {
                return await executeResultAction(onError, result: nil, context: context, error: errorMsg)
            }
            return .failure(error: errorMsg)
        }
        
        // Build args: prepend scriptAction if provided
        var fullArgs = args
        if let action = scriptAction {
            fullArgs.insert(action, at: 0)
        }
        
        // Execute via sandbox filesystem
        let path = DatabaseManager.appScriptSandboxPath(appId: appId, name: script)
        guard let scriptEval = onScriptEval else {
            Log.app.error("EventHandler: No script_eval handler configured")
            return .failure(error: "No script_eval handler configured")
        }
        
        let (success, output) = await scriptEval(nil, path, fullArgs, appId, script)
        
        if success {
            var resultData: Any? = output
            if let output = output,
               let jsonData = output.data(using: .utf8),
               let json = try? JSONSerialization.jsonObject(with: jsonData) {
                resultData = json
            }
            
            if resultMode == .notify, let message = output {
                onAgentMessage?("run_script completed (\(script)): \(message)")
            }
            
            if let onResult = onResult {
                return await executeResultAction(onResult, result: resultData, context: context)
            }
            
            return .success(data: resultData)
        } else {
            let errorMessage = output ?? "run_script failed"
            
            if let onError = onError {
                return await executeResultAction(onError, result: nil, context: context, error: errorMessage)
            }
            
            onAgentMessage?("run_script error (\(script)): \(errorMessage)")
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
            
        case .render:
            return executeRenderResult(result: result)
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
    
    /// Render script output directly as SDUI components
    private func executeRenderResult(result: Any?) -> EventResult {
        Log.app.info("EventHandler: Rendering script result as SDUI")
        
        guard let onRenderComponents = onRenderComponents else {
            Log.app.error("EventHandler: No render callback configured")
            return .failure(error: "No render callback configured")
        }
        
        // Result can be a single component dict or an array of components
        if let components = result as? [[String: Any]] {
            onRenderComponents(components)
            return .success(data: ["rendered": components.count])
        } else if let component = result as? [String: Any], component["type"] is String {
            onRenderComponents([component])
            return .success(data: ["rendered": 1])
        } else {
            Log.app.warning("EventHandler: Script result is not a renderable component tree")
            return .failure(error: "Script output is not a component tree (expected {type, props} or [{type, props}])")
        }
    }
}
