import SwiftUI

/// Full-screen SDUI rendering area.
/// Shows the live app being built — prioritized as: ComponentState > Thinking > Empty.
struct AppCanvasView: View {
    @ObservedObject var componentState: ComponentState

    let isAgentStreaming: Bool
    let streamText: String
    let loadError: String?
    let onAction: (String, Any?) -> Void
    let onAnnotate: (String, String, [String: Any]) -> Void
    let onRetry: () -> Void
    
    var body: some View {
        ScrollView {
            if let error = loadError {
                errorContent(error)

            } else if !componentState.rootComponents.isEmpty {
                componentContent
            } else if isAgentStreaming || !streamText.isEmpty {
                thinkingContent
            } else {
                emptyContent
            }
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
    
    private func errorContent(_ error: String) -> some View {
        VStack(spacing: 16) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.system(size: 60))
                .foregroundColor(.red)
            Text("Failed to Load Agent")
                .font(.title2.weight(.semibold))
            Text(error)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
            Button("Retry") { onRetry() }
                .buttonStyle(.borderedProminent)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(.top, 100)
    }
}
