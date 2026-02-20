import SwiftUI

enum UIErrorState: Equatable {
    case none
    case recovering(attempt: Int)
    case failed(reason: String)
}

/// Full-screen SDUI rendering area.
/// Shows the live app being built — prioritized as: ComponentState > Thinking > Empty.
struct AppCanvasView: View {
    @ObservedObject var componentState: ComponentState

    let isAgentStreaming: Bool
    let streamText: String
    let errorState: UIErrorState
    let onAction: (String, Any?) -> Void
    let onAnnotate: (String, String, [String: Any]) -> Void
    let onRetry: () -> Void
    let onShowRepairLogs: (() -> Void)?
    
    var body: some View {
        ScrollView {
            content
        }
        .overlay(alignment: .top) {
            if case .recovering = errorState {
                recoveringContent()
            }
        }
    }
    
    @ViewBuilder
    private var content: some View {
        if case .failed(let reason) = errorState {
            FallbackErrorView(reason: reason, onRetry: onRetry, onShowRepairLogs: onShowRepairLogs)
        } else if !componentState.rootComponents.isEmpty {
            componentContent
        } else if isAgentStreaming || !streamText.isEmpty {
            thinkingContent
        } else {
            emptyContent
        }
    }
    
    // MARK: - Content Views
    

    
    private var componentContent: some View {
        VStack(spacing: 16) {
            ForEach(Array(componentState.rootComponents.enumerated()), id: \.offset) { _, component in
                ComponentRouter(component: component, onAction: { action, payload in
                    onAction(action, payload)
                }, onAnnotate: onAnnotate)
                .transition(.opacity.combined(with: .scale))
            }
        }
        .padding()
        .animation(.spring(response: 0.3), value: componentState.rootComponents.count)
    }
    
    private var thinkingContent: some View {
        VStack(spacing: 12) {
            ProgressView().scaleEffect(1.2)
            Text("Designing and building...")
                .font(.subheadline)
                .foregroundColor(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(.top, 100)
    }
    
    private var emptyContent: some View {
        VStack(spacing: 16) {
            Image(systemName: "app.badge")
                .font(.system(size: 80))
                .foregroundColor(.orange)
            Text("What should we build?")
                .font(.title2)
                .foregroundColor(.secondary)
            Text("Describe what you'd like and the agent will start building.")
                .multilineTextAlignment(.center)
                .foregroundStyle(.secondary)
                .padding(.horizontal, 30)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(.top, 100)
    }
    
    private func recoveringContent() -> some View {
        HStack(spacing: 12) {
            ProgressView()
                .controlSize(.small)
            Text("Agent is refining the design...")
                .font(.subheadline.weight(.medium))
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .background(
            Capsule()
                .fill(Color(.systemBackground).opacity(0.95))
                .shadow(color: .black.opacity(0.15), radius: 6, y: 2)
        )
        .padding(.top, 16)
        .transition(.move(edge: .top).combined(with: .opacity))
        .animation(.spring(response: 0.3), value: errorState)
    }
}

struct FallbackErrorView: View {
    let reason: String
    let onRetry: () -> Void
    let onShowRepairLogs: (() -> Void)?

    var body: some View {
        VStack(spacing: 16) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.system(size: 60))
                .foregroundColor(.red)
            Text("Failed to Load Interface")
                .font(.title2.weight(.semibold))
            
            Text(reason)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal)
            
            HStack(spacing: 16) {
                Button("Retry Generation") { 
                    onRetry() 
                }
                .buttonStyle(.borderedProminent)
                
                if let onShowRepairLogs {
                    Button("Show Repair Logs") {
                        onShowRepairLogs()
                    }
                    .buttonStyle(.bordered)
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(.top, 100)
    }
}
