import SwiftUI

@main
struct EdgeAgentApp: App {
    @StateObject private var configManager = ConfigManager()
    private let agentBridge = AgentBridge.shared  // Use singleton
    
    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(configManager)
                .environmentObject(agentBridge)
        }
    }
}

struct ContentView: View {
    @EnvironmentObject var configManager: ConfigManager
    @EnvironmentObject var agentBridge: AgentBridge
    @State private var showSettings = false
    
    var body: some View {
        Group {
            if configManager.apiKey.isEmpty {
                WelcomeView(showSettings: $showSettings)
            } else {
                ChatView()
            }
        }
        .sheet(isPresented: $showSettings) {
            SettingsView()
        }
        .onChange(of: agentBridge.isReady) { ready in
            if ready && !configManager.apiKey.isEmpty {
                agentBridge.createAgent(config: configManager.buildAgentConfig())
            }
        }
        .onChange(of: showSettings) { wasShowing, isShowing in
            // Recreate agent when settings sheet closes (to pick up changes)
            if wasShowing && !isShowing && agentBridge.isReady && !configManager.apiKey.isEmpty {
                print("[EdgeAgentApp] Settings closed, recreating agent with new config")
                agentBridge.createAgent(config: configManager.buildAgentConfig())
            }
        }
    }
}

struct WelcomeView: View {
    @Binding var showSettings: Bool
    
    var body: some View {
        VStack(spacing: 24) {
            Image(systemName: "brain.head.profile")
                .font(.system(size: 80))
                .foregroundStyle(.tint)
            
            Text("Edge Agent")
                .font(.largeTitle.bold())
            
            Text("Configure your API key to get started")
                .foregroundStyle(.secondary)
            
            Button("Open Settings") {
                showSettings = true
            }
            .buttonStyle(.borderedProminent)
        }
        .padding()
    }
}
