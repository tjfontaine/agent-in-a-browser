import SwiftUI

struct ChatView: View {
    @EnvironmentObject var agentBridge: AgentBridge
    @EnvironmentObject var configManager: ConfigManager
    @StateObject private var viewModel: ChatViewModel
    @State private var inputText = ""
    @State private var showSettings = false
    @FocusState private var isInputFocused: Bool
    
    init() {
        // Use singleton AgentBridge
        _viewModel = StateObject(wrappedValue: ChatViewModel(bridge: AgentBridge.shared))
    }
    
    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                // Messages list
                ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(spacing: 12) {
                            ForEach(viewModel.messages) { message in
                                MessageBubble(message: message)
                                    .id(message.id)
                            }
                            
                            // Streaming text
                            if viewModel.isStreaming && !viewModel.currentStreamText.isEmpty {
                                MessageBubble(message: ChatMessage(
                                    role: .assistant,
                                    content: viewModel.currentStreamText
                                ))
                                .opacity(0.8)
                                .id("streaming")
                            }
                            
                            // Tool activity indicator
                            if let toolCall = viewModel.currentToolCall {
                                HStack {
                                    ProgressView()
                                        .scaleEffect(0.8)
                                    Text(toolCall)
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                                .padding(.horizontal)
                                .id("tool")
                            }
                        }
                        .padding()
                    }
                    .onChange(of: viewModel.messages.count) { _, _ in
                        withAnimation {
                            if let lastId = viewModel.messages.last?.id {
                                proxy.scrollTo(lastId, anchor: .bottom)
                            }
                        }
                    }
                    .onChange(of: viewModel.currentStreamText) { _, _ in
                        withAnimation {
                            proxy.scrollTo("streaming", anchor: .bottom)
                        }
                    }
                }
                
                Divider()
                
                // Input area
                HStack(spacing: 12) {
                    TextField("Message...", text: $inputText, axis: .vertical)
                        .textFieldStyle(.plain)
                        .padding(12)
                        .background(Color(.secondarySystemBackground))
                        .clipShape(RoundedRectangle(cornerRadius: 20))
                        .focused($isInputFocused)
                        .disabled(viewModel.isStreaming)
                        .onSubmit {
                            sendMessage()
                        }
                    
                    Button(action: viewModel.isStreaming ? viewModel.cancel : sendMessage) {
                        Image(systemName: viewModel.isStreaming ? "stop.circle.fill" : "arrow.up.circle.fill")
                            .font(.title)
                            .foregroundStyle(viewModel.isStreaming ? .red : .accentColor)
                    }
                    .disabled(inputText.isEmpty && !viewModel.isStreaming)
                }
                .padding()
                .background(.bar)
            }
            .navigationTitle("Edge Agent")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button {
                        viewModel.clearHistory()
                    } label: {
                        Image(systemName: "trash")
                    }
                    .disabled(viewModel.messages.isEmpty)
                }
                
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        showSettings = true
                    } label: {
                        Image(systemName: "gearshape")
                    }
                }
            }
            .sheet(isPresented: $showSettings) {
                SettingsView()
            }
        }
        .onAppear {
            // Re-initialize ViewModel with correct bridge
            // This is a workaround for @StateObject initialization
        }
    }
    
    private func sendMessage() {
        guard !inputText.isEmpty else { return }
        let message = inputText.trimmingCharacters(in: .whitespacesAndNewlines)
        inputText = ""
        viewModel.send(message)
    }
}

struct MessageBubble: View {
    let message: ChatMessage
    
    var body: some View {
        HStack {
            if message.role == .user {
                Spacer(minLength: 60)
            }
            
            VStack(alignment: message.role == .user ? .trailing : .leading, spacing: 4) {
                Text(message.content)
                    .padding(12)
                    .background(backgroundColor)
                    .foregroundStyle(foregroundColor)
                    .clipShape(RoundedRectangle(cornerRadius: 16))
                
                if message.role == .tool {
                    Text("Tool Result")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }
            
            if message.role != .user {
                Spacer(minLength: 60)
            }
        }
    }
    
    private var backgroundColor: Color {
        switch message.role {
        case .user: return .accentColor
        case .assistant: return Color(.secondarySystemBackground)
        case .tool: return Color(.tertiarySystemBackground)
        case .error: return .red.opacity(0.2)
        }
    }
    
    private var foregroundColor: Color {
        switch message.role {
        case .user: return .white
        case .error: return .red
        default: return .primary
        }
    }
}

#Preview {
    ChatView()
        .environmentObject(AgentBridge.shared)
        .environmentObject(ConfigManager())
}
