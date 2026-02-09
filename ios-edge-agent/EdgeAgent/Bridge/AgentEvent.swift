import Foundation

/// Agent event matching the WIT variant type
enum AgentEvent: Identifiable, Equatable {
    case streamStart
    case chunk(String)
    case complete(String)
    case error(String)
    case toolCall(String)
    case toolResult(name: String, output: String, isError: Bool)
    case planGenerated(String)
    case taskStart(id: String, name: String, description: String)
    case taskUpdate(id: String, status: String, progress: UInt32?)
    case taskComplete(id: String, success: Bool, output: String?)
    case modelLoading(text: String, progress: Float)
    case ready

    case askUser(id: String, type: String, prompt: String, options: [String]?)
    case progress(step: Int, total: Int, description: String)
    case cancelled
    
    var id: String {
        switch self {
        case .streamStart: return "stream_start"
        case .chunk(let text): return "chunk_\(text.hashValue)"
        case .complete: return "complete"
        case .error(let msg): return "error_\(msg.hashValue)"
        case .toolCall(let name): return "tool_call_\(name)"
        case .toolResult(let name, _, _): return "tool_result_\(name)"
        case .planGenerated: return "plan_generated"
        case .taskStart(let id, _, _): return "task_start_\(id)"
        case .taskUpdate(let id, _, _): return "task_update_\(id)"
        case .taskComplete(let id, _, _): return "task_complete_\(id)"
        case .modelLoading: return "model_loading"
        case .ready: return "ready"

        case .askUser(let id, _, _, _): return "ask_user_\(id)"
        case .progress(let step, _, _): return "progress_\(step)"
        case .cancelled: return "cancelled"
        }
    }
    
    /// Parse event from JS dictionary
    static func from(_ dict: [String: Any]) -> AgentEvent? {
        guard let type = dict["type"] as? String else { return nil }
        
        switch type {
        case "stream_start": return .streamStart
        case "stream_chunk": return .chunk(dict["text"] as? String ?? "")
        case "stream_complete": return .complete(dict["text"] as? String ?? "")
        case "stream_error": return .error(dict["error"] as? String ?? "Unknown error")
        case "tool_call": return .toolCall(dict["name"] as? String ?? "")
        case "tool_result":
            let name = dict["name"] as? String ?? ""
            let output = dict["output"] as? String ?? ""
            let isError = dict["is_error"] as? Bool ?? false

            
            return .toolResult(name: name, output: output, isError: isError)
        case "plan_generated": return .planGenerated(dict["content"] as? String ?? "")
        case "task_start":
            return .taskStart(
                id: dict["id"] as? String ?? "",
                name: dict["name"] as? String ?? "",
                description: dict["description"] as? String ?? ""
            )
        case "task_update":
            return .taskUpdate(
                id: dict["id"] as? String ?? "",
                status: dict["status"] as? String ?? "",
                progress: (dict["progress"] as? NSNumber)?.uint32Value
            )
        case "task_complete":
            return .taskComplete(
                id: dict["id"] as? String ?? "",
                success: dict["success"] as? Bool ?? false,
                output: dict["output"] as? String
            )
        case "model_loading":
            return .modelLoading(
                text: dict["text"] as? String ?? "",
                progress: (dict["progress"] as? NSNumber)?.floatValue ?? 0
            )
        case "ready": return .ready

        case "ask_user":
            let id = dict["id"] as? String ?? UUID().uuidString
            let askType = dict["ask_type"] as? String ?? "confirm"
            let prompt = dict["prompt"] as? String ?? ""
            let options = dict["options"] as? [String]
            return .askUser(id: id, type: askType, prompt: prompt, options: options)
        case "progress":
            let step = dict["step"] as? Int ?? 0
            let total = dict["total"] as? Int ?? 0
            let desc = dict["description"] as? String ?? ""
            return .progress(step: step, total: total, description: desc)
        case "cancelled": return .cancelled
        default: return nil
        }
    }
}
