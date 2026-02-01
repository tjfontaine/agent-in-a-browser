import SwiftUI

@main
struct EdgeAgentApp: App {
    @StateObject private var configManager = ConfigManager()
    @StateObject private var nativeAgent = NativeAgentHost.shared
    
    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(configManager)
                .environmentObject(nativeAgent)
        }
    }
}

struct ContentView: View {
    @EnvironmentObject var configManager: ConfigManager
    @EnvironmentObject var nativeAgent: NativeAgentHost
    @State private var showSettings = false
    
    var body: some View {
        Group {
            if configManager.apiKey.isEmpty {
                WelcomeView(showSettings: $showSettings)
            } else {
                MealMindView()
            }
        }
        .sheet(isPresented: $showSettings) {
            SettingsView()
        }
        // Agent creation is now handled by MealMindView with its own config
    }
}

struct WelcomeView: View {
    @Binding var showSettings: Bool
    
    var body: some View {
        VStack(spacing: 24) {
            Image(systemName: "fork.knife.circle.fill")
                .font(.system(size: 80))
                .foregroundStyle(.orange)
            
            Text("MealMind")
                .font(.largeTitle.bold())
            
            Text("Your AI-powered recipe assistant")
                .foregroundStyle(.secondary)
            
            Text("Configure your API key to get started")
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
