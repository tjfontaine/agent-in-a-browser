import SwiftUI
import MCPServerKit

/// Main MealMind view - agent-driven UI
/// This view observes agent events and renders components based on render_ui events.
/// All navigation and logic is controlled by the agent, not SwiftUI.
/// Uses native WasmKit runtime for WASM execution with proper async HTTP support.
struct MealMindView: View {
    @EnvironmentObject var configManager: ConfigManager
    @StateObject private var agent = NativeAgentHost.shared
    @StateObject private var componentState = ComponentState()
    @ObservedObject private var viewRegistry = ViewRegistry.shared
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
                } else if !viewRegistry.renderedComponents.isEmpty {
                    // SDUI: show_view takes precedence over everything
                    viewRegistryGrid
                } else if !componentState.rootComponents.isEmpty {
                    // render_ui immediate mode
                    componentGrid
                } else if !agent.currentStreamText.isEmpty {
                    // Agent is thinking - show subtle indicator
                    thinkingView
                } else {
                    emptyStateView
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
            // Back button when there's navigation history
            if viewRegistry.navigationStack.count > 0 {
                Button(action: { 
                    viewRegistry.popView()
                }) {
                    Image(systemName: "chevron.left")
                        .font(.title2)
                        .foregroundColor(.orange)
                }
                .padding(.trailing, 4)
            }
            
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
    
    // SDUI: Render from ViewRegistry (show_view path)
    private var viewRegistryGrid: some View {
        VStack(spacing: 16) {
            ForEach(Array(viewRegistry.renderedComponents.enumerated()), id: \.offset) { _, component in
                ComponentRouter(component: component) { action, payload in
                    handleAction(action, payload: payload)
                }
                .transition(.opacity.combined(with: .scale))
            }
        }
        .padding()
        .animation(.spring(response: 0.3), value: viewRegistry.renderedComponents.count)
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
        
        // SDUI: ViewRegistry show_view callback
        // Note: MCPServer already calls ViewRegistry.shared.showView()
        // This callback is just for additional cleanup
        MCPServer.shared.onShowView = { _, _ in
            // Clear component state so ViewRegistry takes precedence
            componentState.rootComponents = []
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
        // Forward UI actions directly to agent - agent loop handles everything
        if action == "input_submit",
           let dict = payload as? [String: String],
           let value = dict["value"] {
            agent.send(value)
        } else if let payload = payload as? String {
            agent.send("\(action): \(payload)")
        } else {
            agent.send(action)
        }
    }
}

// MARK: - System Prompt

private let mealMindSystemPrompt = """
You are MealMind, a recipe assistant running on iOS.

## CRITICAL RULE
Users CANNOT see your text responses. You MUST use UI tools to display ALL content.

For recipe results: ALWAYS use `register_view` + `show_view` (SDUI)
For loading states: Use `render_ui` (only acceptable use)

## SDUI Tools (USE THESE FOR ALL RECIPE UIs!)

These tools use SQLite persistence - templates are cached and instant on repeat views:

- **query_views** - CHECK THIS FIRST! Returns registered templates and cached data. Use before re-fetching!
- **register_view** - Cache a view template with `{{}}` bindings. Call ONCE per template.
- **show_view** - Navigate to a registered view with data. Call this AFTER register_view.
- **update_view_data** - Update data in current view without flash/re-render
- **pop_view** - Navigate back to previous view
- **invalidate_view** / **invalidate_all_views** - Clear cached views

## OPTIMIZATION: Always Query Before Fetching!

Before fetching data or registering templates:
1. Call `query_views()` to see what's already cached
2. Call `query_views({name: "recipe_detail"})` to get cached data for a specific view
3. If template exists and data is cached, just call `show_view` with cached data!

## Shell Tools

- **shell_eval** - Run TypeScript via `tsx -e "..."` with fetch/async
- **read_file** / **write_file** / **edit_file** - File operations
- **list** / **grep** - Directory listing and search

## Loading State Tool (ONLY use for loading spinners)

- **render_ui** - Immediate render. ONLY for loading states, NEVER for recipe results!

## SDUI Pattern (REQUIRED for Recipe UIs)

### 1. Register Template with ForEach (first time only)
```
register_view({
  name: "recipe_grid",
  version: "1.0",
  component: {
    type: "VStack", props: { spacing: 12, children: [
      {type: "Text", props: {content: "{{title}}", size: "xl", weight: "bold"}},
      {type: "Text", props: {content: "Tap any recipe for details", color: "#666"}},
      {type: "ForEach", props: {items: "{{recipes}}", itemTemplate: {
        type: "Card", props: {onTap: "select:{{item.idMeal}}", shadow: true, children: [
          {type: "Image", props: {url: "{{item.strMealThumb}}", height: 120, cornerRadius: 8}},
          {type: "Text", props: {content: "{{item.strMeal}}", weight: "semibold"}}
        ]}
      }}}
    ]}
  },
  defaultData: {title: "Recipes", recipes: []}
})
```

⚠️ **CRITICAL: Template MUST use ForEach component!**
- Use `type: "ForEach"` with `items: "{{recipes}}"` binding
- Use `itemTemplate:` for per-item layout with `{{item.fieldName}}` bindings
- DO NOT use VStack with pre-built children!

### 2. Show with RAW DATA (not components!)
```
show_view({
  name: "recipe_grid",
  data: {
    title: "🍗 Chicken Recipes",
    recipes: [
      {idMeal: "52940", strMeal: "Brown Stew Chicken", strMealThumb: "https://..."},
      {idMeal: "52941", strMeal: "Chicken Congee", strMealThumb: "https://..."}
    ]
  }
})
```

⚠️ **CRITICAL: Pass RAW DATA arrays, not component objects!**
- `recipes` should be array of objects with data fields: `{idMeal, strMeal, strMealThumb}`
- DO NOT pass pre-built component JSON like `{type: "Card", props: {...}}`
- ForEach uses `itemTemplate` bindings to render each item

### 3. Update Data (no re-render flash)
```
update_view_data({data: {recipes: [...newRecipes]}})
```

## Workflow (Use SDUI!)

**ALWAYS use SDUI pattern for recipe results:**
1. Use `render_ui` ONLY for loading states
2. **CHECK for existing view first:**
   `sqlite_query({sql: "SELECT name, version FROM view_templates"})`
3. If view exists: skip to step 5. If not: `register_view` your template
4. `show_view` with real data after fetching
5. `update_view_data` for refreshes (no flash!)

**Why check first?** Avoids re-registering, primes your context with existing templates.

## Example: Fetch with tsx
```
shell_eval({command: `tsx -e "
const res = await fetch('https://www.themealdb.com/api/json/v1/1/filter.php?i=chicken');
const data = await res.json();
console.log(JSON.stringify(data.meals?.slice(0, 4) || []));
"`})
```

## UI Design Guidelines

**IMPORTANT LAYOUT RULES:**
- Cards are displayed in a 2-column grid, so each card is ~160pt wide
- Keep titles SHORT (max 20 chars) to prevent ugly line breaks like "Chick-en & Chori-zo"
- If recipe name is long, abbreviate it: "Chicken & Chorizo Rice Pot" → "Chorizo Rice Pot" or "Chicken Chorizo Rice"
- Use varied, useful badges (not all "Rice Dish"): try cuisine origin, cook time, or difficulty
- Badge examples: "🇯🇵 Japanese", "⏱️ 30 min", "Easy", "🌶️ Spicy", "One-Pot"

**Card Height Consistency:**
- Use consistent image height (120-140pt)
- Limit title to 1-2 lines max
- One badge per card is enough

## UI Templates

### Loading State (use render_ui for this ONLY)
render_ui({components: [{
  type:"VStack", props:{spacing:16, children:[
    {type:"Text", props:{content:"🍳 Finding recipes...", size:"xl", weight:"bold"}},
    {type:"Loading", props:{message:"Searching"}}
  ]}
}]})

### Recipe Card (compact, fits 2-col grid)
{type:"Card", props:{shadow:true, padding:8, onTap:"select_recipe:MEAL_ID", children:[
  {type:"Image", props:{url:"IMAGE_URL", height:120, cornerRadius:8}},
  {type:"VStack", props:{spacing:4, align:"leading", children:[
    {type:"Text", props:{content:"SHORT TITLE", size:"md", weight:"bold"}},
    {type:"Badge", props:{text:"⏱️ 30 min", color:"orange"}}
  ]}}
]}}

### Recipe Grid
render_ui({components: [{
  type:"VStack", props:{spacing:12, children:[
    {type:"Text", props:{content:"🍗 Chicken Recipes", size:"xl", weight:"bold"}},
    ...CARD_ARRAY
  ]}
}]})

## Component Reference
| Component | Props |
|-----------|-------|
| VStack/HStack | children:[], spacing:number, align:"leading"/"center"/"trailing" |
| Text | content:string, size:"sm"/"md"/"lg"/"xl", weight:"regular"/"bold", color:string |
| Image | url:string, height:number, cornerRadius:number |
| Card | shadow:bool, padding:number, onTap:"action:payload", children:[] |
| Badge | text:string, color:"orange"/"green"/"blue"/"red" |
| Button | label:string, action:"name:payload", style:"primary"/"secondary" |
| Loading | message:string |
| Input | placeholder:string, value:string, onSubmit:"action" |
| Spacer | (no props - flexible space) |

## API Reference
- Search by ingredient: https://www.themealdb.com/api/json/v1/1/filter.php?i=INGREDIENT
- Get full recipe: https://www.themealdb.com/api/json/v1/1/lookup.php?i=MEAL_ID

Start now: greet the user and ask what ingredients they have.
"""

// MARK: - Preview

#Preview {
    MealMindView()
}
