import SwiftUI

/// Agent interaction overlay — combines live activity bar, ask_user card, and input area.
/// Designed to sit at the bottom of the screen as a compact, always-accessible interface.
struct AgentOverlayView: View {
    @Binding var inputText: String
    let isAgentWorking: Bool
    let currentToolName: String
    let progressStep: Int
    let progressTotal: Int
    let progressDescription: String
    
    // ask_user state
    let pendingAskUserId: String?
    let pendingAskUserType: String
    let pendingAskUserPrompt: String
    let pendingAskUserOptions: [String]?
    @Binding var askUserTextInput: String
    
    let onSend: () -> Void
    let onResolveAskUser: (String) -> Void
    let onStop: () -> Void
    
    var body: some View {
        VStack(spacing: 0) {
            if pendingAskUserId != nil {
                askUserCard
            }
            
            if isAgentWorking {
                liveActivityBar
            }
            
            inputBar
        }
    }
    
    // MARK: - Live Activity Bar
    
    private var liveActivityBar: some View {
        HStack(spacing: 12) {
            ProgressView()
                .scaleEffect(0.8)
            
            VStack(alignment: .leading, spacing: 2) {
                if !progressDescription.isEmpty {
                    Text(progressDescription)
                        .font(.caption)
                        .fontWeight(.medium)
                } else if !currentToolName.isEmpty {
                    Text("Running: \(currentToolName)")
                        .font(.caption)
                        .fontWeight(.medium)
                } else {
                    Text("Agent is working...")
                        .font(.caption)
                        .fontWeight(.medium)
                }
                
                if progressTotal > 0 {
                    ProgressView(value: Double(progressStep), total: Double(progressTotal))
                        .tint(.orange)
                }
            }
            
            Spacer()
            
            Button(action: onStop) {
                Image(systemName: "stop.circle.fill")
                    .font(.title2)
                    .foregroundColor(.red)
            }
        }
        .padding(.horizontal)
        .padding(.vertical, 8)
        .background(Color(.secondarySystemBackground))
    }
    
    // MARK: - Ask User Card
    
    private var askUserCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Image(systemName: "questionmark.circle.fill")
                    .foregroundColor(.orange)
                Text("Agent needs your input")
                    .font(.subheadline)
                    .fontWeight(.semibold)
            }
            
            ScrollView {
                Text(pendingAskUserPrompt)
                    .font(.body)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .frame(maxHeight: 300)
            
            askUserButtons
        }
        .padding()
        .background(
            RoundedRectangle(cornerRadius: 12)
                .fill(Color(.tertiarySystemBackground))
                .shadow(radius: 2)
        )
        .padding(.horizontal)
        .transition(.move(edge: .bottom).combined(with: .opacity))
        .animation(.spring(response: 0.3), value: pendingAskUserId)
    }
    
    @ViewBuilder
    private var askUserButtons: some View {
        switch pendingAskUserType {
        case "confirm":
            HStack(spacing: 12) {
                Button("Approve") { onResolveAskUser("approved") }
                    .buttonStyle(.borderedProminent)
                    .tint(.green)
                
                Button("Reject") { onResolveAskUser("rejected") }
                    .buttonStyle(.bordered)
                    .tint(.red)
            }
            
        case "choose":
            if let options = pendingAskUserOptions {
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 100), spacing: 8)], spacing: 8) {
                    ForEach(options, id: \.self) { option in
                        Button(option) { onResolveAskUser(option) }
                            .buttonStyle(.bordered)
                            .tint(.orange)
                    }
                }
            }
            
        case "text":
            HStack {
                TextField("Type your answer...", text: $askUserTextInput)
                    .textFieldStyle(.roundedBorder)
                    .onSubmit {
                        if !askUserTextInput.isEmpty {
                            onResolveAskUser(askUserTextInput)
                        }
                    }
                
                Button("Send") { onResolveAskUser(askUserTextInput) }
                    .buttonStyle(.borderedProminent)
                    .tint(.orange)
                    .disabled(askUserTextInput.isEmpty)
            }
            
        case "plan":
            HStack(spacing: 12) {
                Button("Approve Plan") { onResolveAskUser("approved") }
                    .buttonStyle(.borderedProminent)
                    .tint(.green)
                
                Button("Revise") { onResolveAskUser("revise") }
                    .buttonStyle(.bordered)
                    .tint(.orange)
            }
            
        default:
            Button("OK") { onResolveAskUser("ok") }
                .buttonStyle(.borderedProminent)
                .tint(.orange)
        }
    }
    
    // MARK: - Input Bar
    
    private var inputBar: some View {
        HStack {
            TextField("Describe a change...", text: $inputText)
                .textFieldStyle(.roundedBorder)
                .onSubmit { onSend() }
            
            Button(action: onSend) {
                Image(systemName: "paperplane.fill")
                    .foregroundColor(.white)
                    .padding(10)
                    .background(inputText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? Color.gray : Color.orange)
                    .clipShape(Circle())
            }
            .disabled(inputText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
        .padding()
        .background(Color(.systemBackground))
    }
}
