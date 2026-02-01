import SwiftUI

struct SettingsView: View {
    @EnvironmentObject var nativeAgent: NativeAgentHost
    @EnvironmentObject var configManager: ConfigManager
    @Environment(\.dismiss) private var dismiss
    
    // Static provider/model lists for now (native agent doesn't have WASM exports for these yet)
    private let providers: [ProviderInfo] = [
        ProviderInfo(id: "gemini", name: "Google Gemini", defaultBaseUrl: nil),
        ProviderInfo(id: "anthropic", name: "Anthropic", defaultBaseUrl: nil),
        ProviderInfo(id: "openai", name: "OpenAI", defaultBaseUrl: nil),
        ProviderInfo(id: "openrouter", name: "OpenRouter", defaultBaseUrl: "https://openrouter.ai/api/v1")
    ]
    
    private func modelsForProvider(_ providerId: String) -> [ModelInfo] {
        switch providerId {
        case "gemini":
            return [
                ModelInfo(id: "gemini-3-flash-preview", name: "Gemini 3 Flash (Preview)"),
                ModelInfo(id: "gemini-3-pro-preview", name: "Gemini 3 Pro (Preview)"),
                ModelInfo(id: "gemini-2.0-flash-exp", name: "Gemini 2.0 Flash"),
                ModelInfo(id: "gemini-1.5-pro", name: "Gemini 1.5 Pro"),
                ModelInfo(id: "gemini-1.5-flash", name: "Gemini 1.5 Flash")
            ]
        case "anthropic":
            return [
                ModelInfo(id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5"),
                ModelInfo(id: "claude-haiku-4-5", name: "Claude Haiku 4.5"),
                ModelInfo(id: "claude-3-5-sonnet-latest", name: "Claude 3.5 Sonnet")
            ]
        case "openai":
            return [
                ModelInfo(id: "gpt-4o", name: "GPT-4o"),
                ModelInfo(id: "gpt-4o-mini", name: "GPT-4o Mini"),
                ModelInfo(id: "gpt-4-turbo", name: "GPT-4 Turbo")
            ]
        case "openrouter":
            return [
                ModelInfo(id: "google/gemini-2.0-flash-exp:free", name: "Gemini 2.0 Flash (Free)"),
                ModelInfo(id: "anthropic/claude-3.5-sonnet", name: "Claude 3.5 Sonnet"),
                ModelInfo(id: "openai/gpt-4o", name: "GPT-4o")
            ]
        default:
            return []
        }
    }
    
    @State private var useCustomModel = false
    
    var body: some View {
        NavigationStack {
            Form {
                Section("Provider") {
                    Picker("Provider", selection: $configManager.provider) {
                        ForEach(providers) { provider in
                            Text(provider.name).tag(provider.id)
                        }
                    }
                    .onChange(of: configManager.provider) { _, newProvider in
                        // Reset model when provider changes
                        if let firstModel = modelsForProvider(newProvider).first {
                            configManager.model = firstModel.id
                            useCustomModel = false
                        }
                    }
                    
                    // Model picker
                    Picker("Model", selection: $configManager.model) {
                        ForEach(modelsForProvider(configManager.provider)) { model in
                            Text(model.name).tag(model.id)
                        }
                        if useCustomModel {
                            Text(configManager.model).tag(configManager.model)
                        }
                    }
                    .disabled(useCustomModel)
                    
                    // Custom model toggle + input
                    Toggle("Custom Model", isOn: $useCustomModel)
                    
                    if useCustomModel {
                        TextField("Model ID", text: $configManager.model)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                    }
                }
                
                Section("Authentication") {
                    SecureField("API Key", text: $configManager.apiKey)
                        .textContentType(.password)
                        .autocorrectionDisabled()
                    
                    TextField("Base URL (optional)", text: $configManager.baseUrl)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                }
                
                Section("Advanced") {
                    Stepper("Max Turns: \(configManager.maxTurns)", 
                            value: $configManager.maxTurns, 
                            in: 1...100)
                }
                
                Section {
                    Link("Get Anthropic API Key", destination: URL(string: "https://console.anthropic.com/settings/keys")!)
                    Link("Get OpenAI API Key", destination: URL(string: "https://platform.openai.com/api-keys")!)
                    Link("Get Google AI API Key", destination: URL(string: "https://aistudio.google.com/app/apikey")!)
                } header: {
                    Text("API Key Links")
                }
            }
            .navigationTitle("Settings")
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }
}

#Preview {
    SettingsView()
        .environmentObject(NativeAgentHost.shared)
        .environmentObject(ConfigManager())
}
