import SwiftUI

struct SettingsView: View {
    @EnvironmentObject var agentBridge: AgentBridge
    @EnvironmentObject var configManager: ConfigManager
    @Environment(\.dismiss) private var dismiss
    
    @State private var providers: [ProviderInfo] = []
    @State private var models: [ModelInfo] = []
    @State private var isLoading = true
    @State private var useCustomModel = false
    
    var body: some View {
        NavigationStack {
            Form {
                Section("Provider") {
                    if isLoading {
                        ProgressView("Loading providers...")
                    } else {
                        Picker("Provider", selection: $configManager.provider) {
                            ForEach(providers) { provider in
                                Text(provider.name).tag(provider.id)
                            }
                        }
                        .onChange(of: configManager.provider) { _, newProvider in
                            Task {
                                await loadModelsForProvider(newProvider)
                                // Reset model when provider changes
                                if let firstModel = models.first {
                                    configManager.model = firstModel.id
                                    useCustomModel = false
                                }
                            }
                        }
                        
                        // Model picker with refresh
                        HStack {
                            Picker("Model", selection: $configManager.model) {
                                ForEach(models) { model in
                                    Text(model.name).tag(model.id)
                                }
                                if useCustomModel {
                                    Text(configManager.model).tag(configManager.model)
                                }
                            }
                            .disabled(useCustomModel)
                            
                            Button {
                                Task {
                                    isLoading = true
                                    await loadModelsForProvider(configManager.provider)
                                    isLoading = false
                                }
                            } label: {
                                Image(systemName: "arrow.clockwise")
                            }
                            .buttonStyle(.borderless)
                        }
                        
                        // Custom model toggle + input
                        Toggle("Custom Model", isOn: $useCustomModel)
                        
                        if useCustomModel {
                            TextField("Model ID", text: $configManager.model)
                                .textInputAutocapitalization(.never)
                                .autocorrectionDisabled()
                        }
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
            .task {
                await loadProviders()
            }
            .onChange(of: agentBridge.isReady) { _, isReady in
                // Reload providers when WASM becomes ready
                if isReady && providers.isEmpty {
                    Task { await loadProviders() }
                }
            }
        }
    }
    
    private func loadProviders() async {
        // Wait for WASM to be ready before loading
        if !agentBridge.isReady {
            // Will be retried when isReady changes to true via onChange observer
            return
        }
        
        providers = await agentBridge.listProviders()
        await loadModelsForProvider(configManager.provider)
        isLoading = false
    }
    
    private func loadModelsForProvider(_ providerId: String) async {
        models = await agentBridge.listModels(providerId: providerId)
    }
}

#Preview {
    SettingsView()
        .environmentObject(AgentBridge.shared)
        .environmentObject(ConfigManager())
}
