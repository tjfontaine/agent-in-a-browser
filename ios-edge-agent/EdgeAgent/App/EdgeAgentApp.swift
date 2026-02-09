import SwiftUI

@main
struct EdgeAgentApp: App {
    @StateObject private var configManager = ConfigManager()
    
    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(configManager)
        }
    }
}

struct ContentView: View {
    @EnvironmentObject var configManager: ConfigManager
    @State private var showSettings = false
    
    var body: some View {
        Group {
            if configManager.apiKey.isEmpty {
                WelcomeView(showSettings: $showSettings)
            } else {
                SuperAppView()
            }
        }
        .sheet(isPresented: $showSettings) {
            SettingsView()
        }
        // Agent creation is handled by SuperAppView with dynamic runtime config
    }
}

struct WelcomeView: View {
    @Binding var showSettings: Bool
    
    var body: some View {
        VStack(spacing: 24) {
            Image(systemName: "app.badge.fill")
                .font(.system(size: 80))
                .foregroundStyle(.orange)
            
            Text("Edge Super App")
                .font(.largeTitle.bold())
            
            Text("Build and iterate apps from plain-language requests")
                .foregroundStyle(.secondary)
            
            Text("Configure a provider to get started")
                .font(.caption)
                .foregroundStyle(.tertiary)
            
            Button("Open Settings") {
                showSettings = true
            }
            .buttonStyle(.borderedProminent)
            .tint(.orange)
        }
        .padding()
    }
}
