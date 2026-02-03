import SwiftUI

/// Main MealMind view - agent-driven UI
/// This view observes agent events and renders components based on render_ui events.
/// All navigation and logic is controlled by the agent, not SwiftUI.
/// Uses native WasmKit runtime for WASM execution with proper async HTTP support.
struct MealMindView: View {
    @EnvironmentObject var configManager: ConfigManager
    @StateObject private var agent = NativeAgentHost.shared
    @StateObject private var componentState = ComponentState()
    @State private var showInput = true
    @State private var inputText = ""
    @State private var loadError: String?
    @State private var showSettings = false
    
    var body: some View {
        VStack(spacing: 0) {
            // Header
            headerView
            
            // Component rendering area
            ScrollView {
                if let error = loadError {
                    errorView(error)
                } else if componentState.rootComponents.isEmpty {
                    if !agent.currentStreamText.isEmpty {
                        // Agent is thinking - show subtle indicator
                        thinkingView
                    } else {
                        emptyStateView
                    }
                } else {
                    componentGrid
                }
            }
            
            // Input area (can be hidden by agent)
            if showInput && agent.isReady {
                inputArea
            }
        }
        .onAppear { setupAgent() }
        .onChange(of: agent.events) { _, events in
            processEvents(events)
        }
        .sheet(isPresented: $showSettings) {
            SettingsView()
        }
    }
    
    // MARK: - Subviews
    
    private var headerView: some View {
        HStack {
            Text("🍽️ MealMind")
                .font(.title)
                .fontWeight(.bold)
            
            // Native runtime badge
            Text("Native")
                .font(.caption)
                .foregroundColor(.white)
                .padding(.horizontal, 6)
                .padding(.vertical, 2)
                .background(Color.green)
                .cornerRadius(4)
            
            Spacer()
            
            if !agent.isReady && loadError == nil {
                ProgressView()
                    .padding(.trailing, 8)
                Text("Loading WASM...")
                    .font(.caption)
                    .foregroundColor(.secondary)
            }
            
            // Settings button
            Button(action: { showSettings = true }) {
                Image(systemName: "gearshape.fill")
                    .font(.title2)
                    .foregroundColor(.orange)
            }
        }
        .padding()
        .background(Color(.systemBackground))
    }
    
    private func errorView(_ error: String) -> some View {
        VStack(spacing: 16) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.system(size: 60))
                .foregroundColor(.red)
            Text("Failed to Load Agent")
                .font(.title2)
                .fontWeight(.semibold)
            Text(error)
                .font(.body)
                .foregroundColor(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 40)
            Button("Retry") {
                loadError = nil
                setupAgent()
            }
            .buttonStyle(.borderedProminent)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(.top, 100)
    }
    
    private var emptyStateView: some View {
        VStack(spacing: 16) {
            Image(systemName: "fork.knife.circle")
                .font(.system(size: 80))
                .foregroundColor(.orange)
            Text("What do you have?")
                .font(.title2)
                .foregroundColor(.secondary)
            Text("Tell me what ingredients you have and I'll find recipes for you.")
                .font(.body)
                .foregroundColor(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 40)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(.top, 100)
    }
    
    private var thinkingView: some View {
        VStack(spacing: 12) {
            ProgressView()
                .scaleEffect(1.2)
            Text("Finding recipes...")
                .font(.subheadline)
                .foregroundColor(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(.top, 100)
    }
    
    private var componentGrid: some View {
        LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 16) {
            ForEach(Array(componentState.rootComponents.enumerated()), id: \.offset) { _, component in
                ComponentRouter(component: component) { action, payload in
                    handleAction(action, payload: payload)
                }
                .transition(.opacity.combined(with: .scale))
            }
        }
        .padding()
        .animation(.spring(response: 0.3), value: componentState.rootComponents.count)
    }
    
    private var inputArea: some View {
        HStack {
            TextField("I have chicken, rice, and...", text: $inputText)
                .textFieldStyle(.roundedBorder)
                .onSubmit { sendMessage() }
            
            Button(action: sendMessage) {
                Image(systemName: "paperplane.fill")
                    .foregroundColor(.white)
                    .padding(10)
                    .background(inputText.isEmpty ? Color.gray : Color.orange)
                    .clipShape(Circle())
            }
            .disabled(inputText.isEmpty)
        }
        .padding()
        .background(Color(.systemBackground))
    }
    
    // MARK: - Agent Integration
    
    private func setupAgent() {
        // 1. Start the iOS MCP server for render_ui / update_ui tools
        MCPServer.shared.onRenderUI = { newComponents in
            withAnimation(.easeInOut(duration: 0.25)) {
                componentState.render(newComponents)
            }
        }
        
        MCPServer.shared.onUpdateUI = { patches in
            withAnimation(.easeInOut(duration: 0.2)) {
                componentState.applyPatches(patches)
            }
        }
        
        Task {
            do {
                // 1a. Start Swift MCP server first and wait for it to be ready
                try await MCPServer.shared.start()
                Log.app.info("MealMind: Swift MCP server ready on port 9292")
                
                // Small delay to ensure server is accepting connections
                try await Task.sleep(nanoseconds: 100_000_000) // 100ms
                
                // 1b. Load Native MCP Host (shell tools WASM)
                // This is optional - gracefully handle if WASM module is missing
                do {
                    if !NativeMCPHost.shared.isReady {
                        Log.app.info("MealMind: Loading Native MCP Host (shell tools)...")
                        try await NativeMCPHost.shared.load()
                        try await NativeMCPHost.shared.startServer()
                        Log.app.info("MealMind: Native MCP Host ready on port 9293")
                    }
                } catch {
                    // Don't fail the whole app if MCP host fails to load
                    Log.app.warning("MealMind: Native MCP Host unavailable: \(error.localizedDescription)")
                }
                
                // 2. Load native WASM runtime and create agent
                if !agent.isReady {
                    Log.app.info("MealMind: Loading native WASM agent...")
                    try await agent.load()
                    Log.app.info("MealMind: Native WASM agent loaded")
                }
                
                // Build MCP server list - include shell tools if available
                var mcpServers = [
                    MCPServerConfig(url: MCPServer.shared.baseURL, name: "ios-tools")
                ]
                if NativeMCPHost.shared.isReady {
                    mcpServers.append(MCPServerConfig(url: "http://127.0.0.1:9293", name: "shell-tools"))
                }
                
                // Create agent with saved provider/model but MealMind system prompt
                let config = AgentConfig(
                    provider: configManager.provider,
                    model: configManager.model,
                    apiKey: configManager.apiKey,
                    baseUrl: configManager.baseUrl.isEmpty ? nil : configManager.baseUrl,
                    preamble: nil,  // Don't append to default
                    preambleOverride: mealMindSystemPrompt,  // MealMind-specific prompt
                    mcpServers: mcpServers,
                    maxTurns: UInt32(configManager.maxTurns)
                )
                agent.createAgent(config: config)
                Log.app.info("MealMind: Agent created with \(mcpServers.count) MCP servers")
            } catch {
                Log.app.error("MealMind: Failed to setup agent: \(error)")
                await MainActor.run {
                    loadError = error.localizedDescription
                }
            }
        }
    }
    
    private func sendMessage() {
        guard !inputText.isEmpty else { return }
        agent.send(inputText)
        inputText = ""
    }
    
    private func processEvents(_ events: [AgentEvent]) {
        // Look for the latest renderUI event
        for event in events.reversed() {
            if case .renderUI(let componentsJSON) = event {
                // Parse JSON string back to components
                if let jsonData = componentsJSON.data(using: .utf8),
                   let parsed = try? JSONSerialization.jsonObject(with: jsonData) as? [[String: Any]] {
                    withAnimation(.easeInOut(duration: 0.25)) {
                        componentState.render(parsed)
                    }
                }
                break
            }
        }
    }
    
    private func handleAction(_ action: String, payload: Any?) {
        // Convert UI actions to agent messages - agent loop drives all navigation
        switch action {
        case "select_recipe":
            if let recipeId = payload as? String {
                agent.send("Show me the full recipe for meal ID: \(recipeId)")
            }
        case "go_back":
            agent.send("Go back to the recipe list")
        case "input_submit":
            if let dict = payload as? [String: String],
               let value = dict["value"] {
                agent.send(value)
            }
        default:
            // Forward any action as natural language to the agent
            if let payload = payload as? String {
                agent.send("\(action): \(payload)")
            } else {
                agent.send(action)
            }
        }
    }
}

// MARK: - System Prompt

private let mealMindSystemPrompt = """
You are MealMind, a recipe assistant running on iOS.

## Architecture: Agent-Driven Navigation

You control ALL navigation and data fetching. The UI is declarative - you render it, users tap it, and you receive their actions as natural language messages. Your conversation context IS the navigation history.

**Flow:**
1. User taps card → You receive message like "Show me the full recipe for meal ID: 52940"
2. You fetch the recipe details from the API
3. You render the detail view with render_ui
4. User says "go back" → You re-render the list view

## Tools Available

**iOS UI Tools:**
- **render_ui** - Display native iOS components (cards, text, images, buttons)

**Shell Tools:**
- **shell_eval** - Run TypeScript via `tsx -e "..."` with fetch/async

CRITICAL: Users CANNOT see your text responses. You MUST use render_ui to display ALL content.

## UI Design Guidelines

**Card Layout (2-column grid, ~160pt wide each):**
- Keep titles SHORT (max 20 chars) - abbreviate long names
- Use varied badges: cuisine, cook time, difficulty (not all same category)
- Consistent image height (120pt)

**Making Cards Tappable:**
Add `onTap:"action_name:payload"` to Card props. The payload becomes a message to you.

## UI Templates

### Tappable Recipe Card
```json
{"type":"Card", "props":{
  "shadow":true, "padding":8,
  "onTap":"select_recipe:MEAL_ID",
  "children":[
    {"type":"Image", "props":{"url":"IMG_URL", "height":120, "cornerRadius":8}},
    {"type":"VStack", "props":{"spacing":4, "align":"leading", "children":[
      {"type":"Text", "props":{"content":"Short Title", "size":"md", "weight":"bold"}},
      {"type":"Badge", "props":{"text":"🇲🇽 Mexican", "color":"orange"}}
    ]}}
  ]
}}
```

### Recipe Detail View (with back button)
```json
{"type":"VStack", "props":{"spacing":16, "children":[
  {"type":"Button", "props":{"label":"← Back", "action":"go_back", "style":"ghost"}},
  {"type":"Image", "props":{"url":"IMG", "height":200, "cornerRadius":12}},
  {"type":"Text", "props":{"content":"Recipe Name", "size":"xl", "weight":"bold"}},
  {"type":"Text", "props":{"content":"Instructions here...", "size":"md"}}
]}}
```

## Component Reference
| Component | Props |
|-----------|-------|
| Card | shadow, padding, onTap:"action:payload", children |
| Button | label, action:"name", style:"primary"/"secondary"/"ghost" |
| VStack/HStack | children, spacing, align |
| Text | content, size, weight, color |
| Image | url, height, cornerRadius |
| Badge | text, color |
| Loading | message |

## API Reference
- Search: https://www.themealdb.com/api/json/v1/1/filter.php?i=INGREDIENT
- Details: https://www.themealdb.com/api/json/v1/1/lookup.php?i=MEAL_ID

Start now: greet the user and ask what ingredients they have.
"""

// MARK: - Preview

#Preview {
    MealMindView()
}
