import SwiftUI

#if canImport(FoundationModels)
import FoundationModels
#endif

struct SettingsView: View {
    @EnvironmentObject var nativeAgent: NativeAgentHost
    @EnvironmentObject var configManager: ConfigManager
    @Environment(\.dismiss) private var dismiss
    
    // Check if on-device Foundation Models is available (iOS 26+ with Apple Silicon)
    private var isOnDeviceAvailable: Bool {
        #if canImport(FoundationModels)
        if #available(iOS 26.0, *) {
            return SystemLanguageModel.default.isAvailable
        }
        #endif
        return false
    }
    
    // Static provider/model lists
    private var providers: [ProviderInfo] {
        var list = [
            ProviderInfo(id: "gemini", name: "Google Gemini", defaultBaseUrl: nil),
            ProviderInfo(id: "anthropic", name: "Anthropic", defaultBaseUrl: nil),
            ProviderInfo(id: "openai", name: "OpenAI", defaultBaseUrl: nil),
            ProviderInfo(id: "openrouter", name: "OpenRouter", defaultBaseUrl: "https://openrouter.ai/api/v1")
        ]
        // Add Apple On-Device if available
        if isOnDeviceAvailable {
            list.insert(ProviderInfo(id: "apple-on-device", name: "🍎 Apple On-Device", defaultBaseUrl: "http://localhost:11534/v1"), at: 0)
        }
        // Add MLX option for iOS 17+
        list.insert(ProviderInfo(id: "mlx-local", name: "🦙 MLX Local", defaultBaseUrl: "http://localhost:11535/v1"), at: isOnDeviceAvailable ? 1 : 0)
        return list
    }
    
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
        case "apple-on-device":
            return [
                ModelInfo(id: "apple-on-device", name: "Apple Intelligence (~3B)")
            ]
        case "mlx-local":
            return [
                ModelInfo(id: "mlx-community/Qwen3-4B-4bit", name: "Qwen3 4B (~2.5GB)"),
                ModelInfo(id: "mlx-community/Llama-3.2-3B-Instruct-4bit", name: "LLaMA 3.2 3B (~2GB)"),
                ModelInfo(id: "mlx-community/Phi-3.5-mini-instruct-4bit", name: "Phi 3.5 Mini (~2GB)"),
                ModelInfo(id: "mlx-community/gemma-2-2b-it-4bit", name: "Gemma 2 2B (~1.5GB)")
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
                        // Auto-configure for on-device providers
                        if newProvider == "apple-on-device" {
                            configManager.baseUrl = "http://localhost:11534/v1"
                            configManager.apiKey = "not-needed"
                        } else if newProvider == "mlx-local" {
                            configManager.baseUrl = "http://localhost:11535/v1"
                            configManager.apiKey = "not-needed"
                        } else if let provider = providers.first(where: { $0.id == newProvider }),
                                  let defaultUrl = provider.defaultBaseUrl {
                            configManager.baseUrl = defaultUrl
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
                
                // Hide API Key section for on-device providers (no key needed)
                if configManager.provider != "apple-on-device" && configManager.provider != "mlx-local" {
                    Section("Authentication") {
                        SecureField("API Key", text: $configManager.apiKey)
                            .textContentType(.password)
                            .autocorrectionDisabled()
                        
                        TextField("Base URL (optional)", text: $configManager.baseUrl)
                            .keyboardType(.URL)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                    }
                } else {
                    Section {
                        HStack {
                            Image(systemName: "checkmark.shield.fill")
                                .foregroundColor(.green)
                            VStack(alignment: .leading) {
                                Text("Runs entirely on-device")
                                    .font(.subheadline)
                                if configManager.provider == "mlx-local" {
                                    Text("Model will download on first use")
                                        .font(.caption)
                                        .foregroundColor(.secondary)
                                }
                            }
                        }
                    } header: {
                        Text("Privacy")
                    }
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
