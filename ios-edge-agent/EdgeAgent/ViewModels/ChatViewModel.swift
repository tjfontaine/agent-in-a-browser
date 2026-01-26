import SwiftUI
import Combine

/// Chat message for display
struct ChatMessage: Identifiable, Equatable {
    let id = UUID()
    let role: MessageRole
    let content: String
    let timestamp = Date()
    
    enum MessageRole: String {
        case user
        case assistant
        case tool
        case error
    }
}

@MainActor
class ChatViewModel: ObservableObject {
    @Published var messages: [ChatMessage] = []
    @Published var isStreaming = false
    @Published var currentStreamText = ""
    @Published var currentToolCall: String?
    
    private let bridge: AgentBridge
    private var cancellables = Set<AnyCancellable>()
    private var lastEventCount = 0
    
    init(bridge: AgentBridge) {
        self.bridge = bridge
        
        // Observe bridge events
        bridge.$events
            .sink { [weak self] events in
                self?.processNewEvents(events)
            }
            .store(in: &cancellables)
        
        // Observe streaming text
        bridge.$currentStreamText
            .assign(to: &$currentStreamText)
    }
    
    func send(_ text: String) {
        guard !text.isEmpty else { return }
        messages.append(ChatMessage(role: .user, content: text))
        currentStreamText = ""
        currentToolCall = nil
        bridge.send(text)
    }
    
    func cancel() {
        bridge.cancel()
        isStreaming = false
    }
    
    func clearHistory() {
        messages.removeAll()
        currentStreamText = ""
        currentToolCall = nil
        lastEventCount = 0
        bridge.clearHistory()
    }
    
    private func processNewEvents(_ events: [AgentEvent]) {
        // Only process new events
        let newEvents = Array(events.dropFirst(lastEventCount))
        lastEventCount = events.count
        
        for event in newEvents {
            switch event {
            case .streamStart:
                isStreaming = true
                currentStreamText = ""
                
            case .chunk(let text):
                currentStreamText = text
                
            case .complete(let text):
                messages.append(ChatMessage(role: .assistant, content: text))
                isStreaming = false
                currentStreamText = ""
                currentToolCall = nil
                
            case .error(let errorMsg):
                messages.append(ChatMessage(role: .error, content: errorMsg))
                isStreaming = false
                currentStreamText = ""
                currentToolCall = nil
                
            case .toolCall(let name):
                currentToolCall = name
                
            case .toolResult(let name, let output, let isError):
                let prefix = isError ? "❌ " : "✅ "
                let truncated = output.count > 500 ? String(output.prefix(500)) + "..." : output
                messages.append(ChatMessage(role: .tool, content: "\(prefix)\(name):\n\(truncated)"))
                currentToolCall = nil
                
            case .planGenerated(let content):
                messages.append(ChatMessage(role: .assistant, content: "📋 Plan generated:\n\(content)"))
                
            case .taskStart(_, let name, _):
                currentToolCall = "Task: \(name)"
                
            case .taskUpdate(_, let status, _):
                currentToolCall = status
                
            case .taskComplete(_, let success, _):
                currentToolCall = nil
                if !success {
                    messages.append(ChatMessage(role: .error, content: "Task failed"))
                }
                
            case .modelLoading(let text, _):
                currentToolCall = text
                
            case .ready:
                isStreaming = false
            }
        }
    }
}
