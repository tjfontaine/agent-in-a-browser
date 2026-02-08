import SwiftUI

/// Timeline entry for the conversation feed — wraps both user messages
/// and agent events into a unified, renderable model.
struct TimelineEntry: Identifiable {
    let id: String
    let timestamp: Date
    let kind: Kind
    
    enum Kind {
        case userMessage(String)
        case agentText(String)
        case toolCall(name: String)
        case toolResult(name: String, output: String, isError: Bool)
        case askUser(prompt: String, type: String)
        case systemNote(String)
        case error(String)
    }
}

/// Unified conversation timeline that interleaves user messages and agent events
/// into a scrolling chat feed, replacing the separate log view.
struct ConversationTimeline: View {
    let entries: [TimelineEntry]
    
    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 8) {
                    ForEach(entries) { entry in
                        timelineRow(entry)
                            .id(entry.id)
                    }
                }
                .padding(.horizontal)
                .padding(.vertical, 8)
            }
            .onChange(of: entries.count) { _, _ in
                if let last = entries.last {
                    withAnimation(.easeOut(duration: 0.2)) {
                        proxy.scrollTo(last.id, anchor: .bottom)
                    }
                }
            }
        }
    }
    
    // MARK: - Row Views
    
    @ViewBuilder
    private func timelineRow(_ entry: TimelineEntry) -> some View {
        switch entry.kind {
        case .userMessage(let text):
            userBubble(text)
        case .agentText(let text):
            agentBubble(text)
        case .toolCall(let name):
            toolCallRow(name)
        case .toolResult(let name, let output, let isError):
            toolResultRow(name: name, output: output, isError: isError)
        case .askUser(let prompt, _):
            askUserRow(prompt)
        case .systemNote(let text):
            systemRow(text)
        case .error(let text):
            errorRow(text)
        }
    }
    
    private func userBubble(_ text: String) -> some View {
        HStack {
            Spacer(minLength: 60)
            Text(text)
                .padding(12)
                .background(Color.orange)
                .foregroundColor(.white)
                .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
        }
    }
    
    private func agentBubble(_ text: String) -> some View {
        HStack {
            Text(text)
                .padding(12)
                .background(Color(.secondarySystemBackground))
                .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
            Spacer(minLength: 60)
        }
    }
    
    private func toolCallRow(_ name: String) -> some View {
        HStack(spacing: 6) {
            Image(systemName: "wrench.fill")
                .font(.caption2)
                .foregroundColor(.purple)
            Text(name)
                .font(.caption)
                .fontWeight(.medium)
                .foregroundColor(.purple)
        }
        .padding(.vertical, 4)
        .padding(.horizontal, 10)
        .background(Color.purple.opacity(0.1))
        .clipShape(Capsule())
    }
    
    private func toolResultRow(name: String, output: String, isError: Bool) -> some View {
        HStack(spacing: 6) {
            Image(systemName: isError ? "xmark.circle.fill" : "checkmark.circle.fill")
                .font(.caption2)
                .foregroundColor(isError ? .red : .green)
            Text("\(name)")
                .font(.caption)
                .fontWeight(.medium)
            if !output.isEmpty {
                Text("— \(output.prefix(80))")
                    .font(.caption)
                    .foregroundColor(.secondary)
                    .lineLimit(1)
            }
        }
        .padding(.vertical, 4)
        .padding(.horizontal, 10)
        .background((isError ? Color.red : Color.green).opacity(0.08))
        .clipShape(Capsule())
    }
    
    private func askUserRow(_ prompt: String) -> some View {
        HStack(spacing: 6) {
            Image(systemName: "questionmark.circle.fill")
                .foregroundColor(.orange)
            Text(prompt)
                .font(.caption)
                .foregroundColor(.primary)
                .lineLimit(2)
        }
        .padding(8)
        .background(Color.orange.opacity(0.1))
        .clipShape(RoundedRectangle(cornerRadius: 10))
    }
    
    private func systemRow(_ text: String) -> some View {
        HStack {
            Spacer()
            Text(text)
                .font(.caption2)
                .foregroundColor(.secondary)
            Spacer()
        }
        .padding(.vertical, 2)
    }
    
    private func errorRow(_ text: String) -> some View {
        HStack(spacing: 6) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundColor(.red)
            Text(text)
                .font(.caption)
                .foregroundColor(.red)
                .lineLimit(3)
        }
        .padding(8)
        .background(Color.red.opacity(0.08))
        .clipShape(RoundedRectangle(cornerRadius: 10))
    }
}
