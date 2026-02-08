import SwiftUI
import MCPServerKit
import WASIShims



private struct ActivityLogEntry: Identifiable, Hashable {
    let id: UUID
    let timestamp: Date
    let level: String
    let message: String

    init(level: String, message: String, timestamp: Date = Date()) {
        self.id = UUID()
        self.timestamp = timestamp
        self.level = level
        self.message = message
    }
}

private struct PendingTurnState: Equatable {
    let projectId: String
    let revisionId: String
    let taskId: String
}

/// Main super-app workspace.
/// Includes project management, build/preview/data/log modes, revision control,
/// structured feedback, task tracking, and searchable conversation history.
struct SuperAppView: View {
    @EnvironmentObject var configManager: ConfigManager

    @StateObject private var agent = NativeAgentHost.shared
    @StateObject private var componentState = ComponentState()
    @ObservedObject private var viewRegistry = ViewRegistry.shared
    
    /// Event handler for script-first action dispatch
    private let eventHandler = EventHandler()

    @State private var hasInitialized = false
    @State private var showSettings = false

    @State private var showLogs = false
    @State private var showInput = true
    @State private var loadError: String?


    @State private var inputText = ""
    @State private var newProjectName = ""
    @State private var conversationSearchQuery = ""
    @State private var processedEventCount = 0

    @State private var pendingGuardrailPrompt: String?
    @State private var showGuardrailConfirmation = false
    @State private var pendingTurn: PendingTurnState?

    @State private var feedbackWhat = ""
    @State private var feedbackWhy = ""
    @State private var feedbackSeverity = "medium"
    @State private var feedbackTargetScreen = ""

    @State private var projects: [SuperAppProject] = []
    @State private var activeProjectId: String?
    @State private var revisions: [SuperAppRevision] = []
    @State private var feedbackItems: [SuperAppFeedback] = []
    @State private var tasks: [SuperAppTask] = []
    @State private var conversationHistory: [ConversationHistoryItem] = []
    @State private var activityLog: [ActivityLogEntry] = []
    
    // ask_user state
    @State private var pendingAskUserId: String?
    @State private var pendingAskUserType: String = "confirm"
    @State private var pendingAskUserPrompt: String = ""
    @State private var pendingAskUserOptions: [String]?
    @State private var askUserTextInput: String = ""
    
    // Live activity bar state
    @State private var agentProgressStep: Int = 0
    @State private var agentProgressTotal: Int = 0
    @State private var agentProgressDescription: String = ""
    @State private var currentToolName: String = ""
    @State private var isAgentWorking: Bool = false
    
    // Conversation timeline + mid-stream interjection
    @State private var timelineEntries: [TimelineEntry] = []
    @State private var queuedInterjection: String? = nil
    private let feedbackSeverities = ["low", "medium", "high", "critical"]


    private var activeProject: SuperAppProject? {
        projects.first(where: { $0.id == activeProjectId })
    }

    private var filteredConversationHistory: [ConversationHistoryItem] {
        let base = conversationHistory.sorted(by: { $0.createdAt > $1.createdAt })
        let query = conversationSearchQuery.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty else { return base }
        return base.filter { item in
            item.content.localizedCaseInsensitiveContains(query) ||
            item.tags.contains(where: { $0.localizedCaseInsensitiveContains(query) })
        }
    }

    private var previewRenderArea: some View {
        AppCanvasView(
            componentState: componentState,
            viewRegistry: viewRegistry,
            isAgentStreaming: isAgentWorking,
            streamText: agent.currentStreamText,
            loadError: loadError,
            onAction: { action, payload in
                handleAction(action, payload: payload)
            },
            onAnnotate: { componentType, key, props in
                // Pre-fill input with component context for targeted feedback
                let label = (props["text"] as? String) ?? (props["title"] as? String) ?? key
                let context = "[\(componentType) \"\(label)\"] "
                inputText = context
                addTimelineEntry(.systemNote("Annotating \(componentType): \(label)"))
                // Haptic feedback
                let generator = UIImpactFeedbackGenerator(style: .medium)
                generator.impactOccurred()
            },
            onRetry: {
                loadError = nil
                setupAgentIfNeeded(force: true)
            }
        )
    }

    var body: some View {
        Group {
            if activeProjectId == nil {
                // FTUE / launcher when no project is active
                LauncherView(
                    projects: projects,
                    onSelectProject: { project in
                        activeProjectId = project.id
                        Task {
                            await loadActiveProjectDataAndRestoreState()
                            setupAgentIfNeeded(force: false)
                        }
                    },
                    onNewProject: {
                        quickStartProject()
                    }
                )
            } else {
                // Active workspace — canvas-first layout
                VStack(spacing: 0) {
                    canvasHeader
                    
                    ZStack(alignment: .bottom) {
                        // Full-screen canvas
                        previewRenderArea
                        
                        // Agent overlay at bottom
                        VStack(spacing: 0) {
                            // Conversation timeline (collapsible)
                            if !timelineEntries.isEmpty {
                                Divider()
                                ConversationTimeline(entries: timelineEntries)
                                    .frame(maxHeight: 200)
                                    .background(Color(.systemBackground).opacity(0.95))
                            }
                            
                            if showInput && agent.isReady {
                                AgentOverlayView(
                                    inputText: $inputText,
                                    isAgentWorking: isAgentWorking,
                                    currentToolName: currentToolName,
                                    progressStep: agentProgressStep,
                                    progressTotal: agentProgressTotal,
                                    progressDescription: agentProgressDescription,
                                    pendingAskUserId: pendingAskUserId,
                                    pendingAskUserType: pendingAskUserType,
                                    pendingAskUserPrompt: pendingAskUserPrompt,
                                    pendingAskUserOptions: pendingAskUserOptions,
                                    askUserTextInput: $askUserTextInput,
                                    onSend: { sendMessage() },
                                    onResolveAskUser: { response in
                                        resolveAskUserResponse(response)
                                    },
                                    onStop: {
                                        agent.cancel()
                                        isAgentWorking = false
                                        currentToolName = ""
                                        agentProgressStep = 0
                                        agentProgressTotal = 0
                                        agentProgressDescription = ""
                                        appendLog(level: "system", "Stop requested by user")
                                        addTimelineEntry(.systemNote("Agent stopped by user"))
                                    }
                                )
                            }
                        }
                    }
                }
            }
        }
        .onAppear {
            guard !hasInitialized else { return }
            hasInitialized = true
            initializeWorkspace()
        }
        .onChange(of: agent.events) { _, events in
            processEvents(events)
        }
        .onChange(of: activeProjectId) { _, _ in
            Task { await loadActiveProjectDataAndRestoreState() }
        }
        .sheet(isPresented: $showSettings) {
            SettingsView()
        }
        .sheet(isPresented: $showLogs) {
            NavigationStack {
                logsModeView
                    .navigationTitle("Logs")
                    .toolbar {
                        ToolbarItem(placement: .confirmationAction) {
                            Button("Done") { showLogs = false }
                        }
                    }
            }
        }

        .alert(
            "Potentially Destructive Change",
            isPresented: $showGuardrailConfirmation,
            presenting: pendingGuardrailPrompt
        ) { prompt in
            Button("Cancel", role: .cancel) {
                pendingGuardrailPrompt = nil
            }
            Button("Proceed", role: .destructive) {
                pendingGuardrailPrompt = nil
                Task {
                    await dispatchUserPrompt(prompt, destructiveApproved: true)
                }
            }
        } message: { _ in
            Text("Guardrails are enabled. This request may modify or remove existing state. Proceed anyway?")
        }
    }

    // MARK: - Top Level UI

    private var canvasHeader: some View {
        HStack(spacing: 12) {
            // Back to launcher
            Button(action: { activeProjectId = nil }) {
                Image(systemName: "chevron.left")
                    .font(.title3)
            }
            .buttonStyle(.plain)
            
            // Nav back for SDUI stack
            if viewRegistry.navigationStack.count > 1 {
                Button(action: {
                    viewRegistry.popView()
                    appendLog(level: "nav", "Popped preview navigation stack")
                }) {
                    Image(systemName: "arrow.uturn.backward")
                        .font(.caption)
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
            }
            
            Text(activeProject?.name ?? "Untitled")
                .font(.headline)
                .lineLimit(1)
            
            Spacer()
            
            if !agent.isReady && loadError == nil {
                ProgressView().controlSize(.small)
            }
            
            Menu {
                Button(action: { showLogs = true }) {
                    Label("Logs", systemImage: "text.alignleft")
                }
                Button(action: { showSettings = true }) {
                    Label("Settings", systemImage: "gearshape")
                }
            } label: {
                Image(systemName: "ellipsis.circle")
                    .font(.title3)
            }
            .buttonStyle(.plain)
        }
        .padding(.horizontal)
        .padding(.vertical, 8)
        .background(Color(.systemBackground))
    }



    private var logsModeView: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 8) {
                ForEach(activityLog.sorted(by: { $0.timestamp > $1.timestamp })) { entry in
                    VStack(alignment: .leading, spacing: 3) {
                        Text("[\(entry.level.uppercased())] \(entry.message)")
                            .font(.system(.footnote, design: .monospaced))
                        Text(relativeTime(entry.timestamp))
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(10)
                    .background(Color(.secondarySystemBackground))
                    .clipShape(RoundedRectangle(cornerRadius: 10))
                }
            }
            .padding()
        }
    }

    // MARK: - Preview/Rendering Blocks

    private func errorView(_ error: String) -> some View {
        VStack(spacing: 16) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.system(size: 60))
                .foregroundColor(.red)
            Text("Failed to Load Agent")
                .font(.title2.weight(.semibold))
            Text(error)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
            Button("Retry") {
                loadError = nil
                setupAgentIfNeeded(force: true)
            }
            .buttonStyle(.borderedProminent)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(.top, 100)
    }

    private var emptyStateView: some View {
        VStack(spacing: 16) {
            Image(systemName: "app.badge")
                .font(.system(size: 80))
                .foregroundColor(.orange)
            Text("What should we build?")
                .font(.title2)
                .foregroundColor(.secondary)
            Text("Use Build mode to request a new app, then use Preview mode to test and iterate.")
                .multilineTextAlignment(.center)
                .foregroundStyle(.secondary)
                .padding(.horizontal, 30)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(.top, 100)
    }

    private var thinkingView: some View {
        VStack(spacing: 12) {
            ProgressView().scaleEffect(1.2)
            Text("Designing and building...")
                .font(.subheadline)
                .foregroundColor(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(.top, 100)
    }

    private var componentGrid: some View {
        VStack(spacing: 16) {
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


    

    
    private func resolveAskUserResponse(_ response: String) {
        guard let requestId = pendingAskUserId else { return }
        withAnimation {
            pendingAskUserId = nil
        }
        MCPServer.shared.resolveAskUser(requestId: requestId, response: response)
    }
    
    // MARK: - Workspace Initialization

    private func initializeWorkspace() {
        Task {
            do {
                try await DatabaseManager.shared.initializeDatabase()
                try await loadProjects()
                await loadActiveProjectDataAndRestoreState()
                setupAgentIfNeeded(force: false)
            } catch {
                loadError = "Workspace initialization failed: \(error.localizedDescription)"
            }
        }
    }

    private func setupAgentIfNeeded(force: Bool) {
        if hasInitialized && !force && agent.isReady {
            return
        }
        setupAgent()
    }

    // MARK: - Agent Integration

    private func setupAgent() {
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

        MCPServer.shared.onShowView = { _, _ in
            componentState.rootComponents = []
        }
        
        MCPServer.shared.onAskUser = { requestId, askType, prompt, options in
            pendingAskUserId = requestId
            pendingAskUserType = askType
            pendingAskUserPrompt = prompt
            pendingAskUserOptions = options
            askUserTextInput = ""
        }
        
        // Wire EventHandler callbacks for script-first action dispatch
        eventHandler.onAgentMessage = { [weak agent] message in
            agent?.send(message)
        }
        
        eventHandler.onToast = { message in
            Log.app.info("Toast: \(message)")
        }
        
        let registry = viewRegistry
        eventHandler.onRenderComponents = { components in
            withAnimation(.easeInOut(duration: 0.25)) {
                registry.renderedComponents = components
            }
        }
        
        eventHandler.onShellEval = { command in
            // Execute via local shell-tools MCP server (port 9293)
            guard NativeMCPHost.shared.isReady else {
                return (false, "Shell tools not available")
            }
            
            do {
                let url = URL(string: "http://127.0.0.1:9293/mcp")!
                var request = URLRequest(url: url)
                request.httpMethod = "POST"
                request.setValue("application/json", forHTTPHeaderField: "Content-Type")
                
                let rpcBody: [String: Any] = [
                    "jsonrpc": "2.0",
                    "method": "tools/call",
                    "id": UUID().uuidString,
                    "params": [
                        "name": "shell_eval",
                        "arguments": ["command": command]
                    ]
                ]
                request.httpBody = try JSONSerialization.data(withJSONObject: rpcBody)
                
                let (data, response) = try await URLSession.shared.data(for: request)
                
                guard let httpResponse = response as? HTTPURLResponse,
                      httpResponse.statusCode == 200 else {
                    let statusCode = (response as? HTTPURLResponse)?.statusCode ?? 0
                    return (false, "Shell eval HTTP error: \(statusCode)")
                }
                
                // Parse MCP response
                if let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                   let result = json["result"] as? [String: Any],
                   let content = result["content"] as? [[String: Any]],
                   let first = content.first,
                   let text = first["text"] as? String {
                    let isError = result["isError"] as? Bool ?? false
                    return (!isError, text)
                }
                
                return (true, String(data: data, encoding: .utf8))
            } catch {
                return (false, "Shell eval error: \(error.localizedDescription)")
            }
        }
        
        eventHandler.onScriptEval = { code, file, args, appId, scriptName in
            if let code = code {
                return await ScriptExecutor.shared.eval(code: code)
            } else if let file = file {
                return await ScriptExecutor.shared.evalFile(
                    path: file,
                    args: args,
                    appId: appId ?? "global",
                    scriptName: scriptName ?? "global"
                )
            }
            return (false, "script_eval requires 'code' or 'file'")
        }

        Task {
            do {
                do {
                    try await viewRegistry.loadFromDatabase()
                } catch {
                    Log.app.warning("SuperApp: Failed to load cached views: \(error.localizedDescription)")
                }

                try await MCPServer.shared.start()
                if #available(iOS 26.0, *) {
                    do {
                        try await FoundationModelsServer.shared.start()
                    } catch {
                        Log.app.warning("SuperApp: Foundation Models unavailable: \(error.localizedDescription)")
                    }
                }

                try await Task.sleep(nanoseconds: 100_000_000)

                do {
                    if !NativeMCPHost.shared.isReady {
                        try await NativeMCPHost.shared.load()
                        try await NativeMCPHost.shared.startServer()
                    }
                } catch {
                    Log.app.warning("SuperApp: Native MCP Host unavailable: \(error.localizedDescription)")
                }

                if !agent.isReady {
                    try await agent.load()
                }

                var mcpServers = [MCPServerConfig(url: MCPServer.shared.baseURL, name: "ios-tools")]
                if NativeMCPHost.shared.isReady {
                    mcpServers.append(MCPServerConfig(url: "http://127.0.0.1:9293", name: "shell-tools"))
                }

                let provider = configManager.provider == "apple-on-device" ? "openai" : configManager.provider
                let config = AgentConfig(
                    provider: provider,
                    model: configManager.model,
                    apiKey: configManager.apiKey,
                    baseUrl: configManager.baseUrl.isEmpty ? nil : configManager.baseUrl,
                    preamble: nil,
                    preambleOverride: superAppSystemPrompt,
                    mcpServers: mcpServers,
                    maxTurns: UInt32(configManager.maxTurns)
                )
                agent.createAgent(config: config)
                appendLog(level: "system", "Agent initialized with \(mcpServers.count) MCP servers")
            } catch {
                loadError = error.localizedDescription
                appendLog(level: "error", "Agent setup failed: \(error.localizedDescription)")
            }
        }
    }

    // MARK: - Prompt Dispatch / Guardrails

    private func sendMessage() {
        let prompt = inputText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !prompt.isEmpty else { return }

        guard let activeProject else {
            appendLog(level: "error", "No active project selected for prompt dispatch")
            return
        }

        // Mid-stream interjection: if agent is working, queue the input
        if pendingTurn != nil && isAgentWorking {
            queuedInterjection = prompt
            inputText = ""
            addTimelineEntry(.userMessage("[queued] \(prompt)"))
            appendLog(level: "system", "Interjection queued — will send after current turn")
            return
        }
        
        if pendingTurn != nil {
            appendLog(level: "guardrail", "A build request is already running. Wait for it to complete before sending another.")
            return
        }

        inputText = ""
        addTimelineEntry(.userMessage(prompt))

        if activeProject.guardrailsEnabled && isPotentiallyDestructive(prompt) {
            pendingGuardrailPrompt = prompt
            showGuardrailConfirmation = true
            appendLog(level: "guardrail", "Blocked potentially destructive prompt pending confirmation")
            return
        }

        Task {
            await dispatchUserPrompt(prompt, destructiveApproved: false)
        }
    }

    @MainActor
    private func dispatchUserPrompt(_ prompt: String, destructiveApproved: Bool) async {
        guard let activeProject else { return }

        do {
            guard pendingTurn == nil else {
                appendLog(level: "guardrail", "A build request is already running")
                return
            }

            let promptForAgent = try buildPromptForAgent(
                project: activeProject,
                prompt: prompt,
                destructiveApproved: destructiveApproved
            )

            let beforeSnapshot = try? viewRegistry.exportTemplatesSnapshot()
            let revision = try DatabaseManager.shared.createRevision(
                appId: activeProject.id,
                summary: prompt,
                status: "draft",
                beforeSnapshot: beforeSnapshot,
                afterSnapshot: nil,
                guardrailNotes: destructiveApproved ? "Destructive override approved by user" : nil
            )

            let task = try DatabaseManager.shared.createTask(
                appId: activeProject.id,
                title: "Build request",
                details: prompt,
                status: "in_progress",
                source: "prompt"
            )
            pendingTurn = PendingTurnState(
                projectId: activeProject.id,
                revisionId: revision.id,
                taskId: task.id
            )

            _ = try DatabaseManager.shared.appendConversationMessage(
                appId: activeProject.id,
                role: "user",
                content: prompt,
                tags: ["prompt"]
            )

            try DatabaseManager.shared.updateProject(id: activeProject.id, lastPrompt: prompt)
            agent.send(promptForAgent)
            appendLog(level: "prompt", "Dispatched prompt to agent for project \(activeProject.name)")
            try await loadProjects()
            await loadActiveProjectData()
        } catch {
            appendLog(level: "error", "Failed to dispatch prompt: \(error.localizedDescription)")
        }
    }

    private func buildPromptForAgent(
        project: SuperAppProject,
        prompt: String,
        destructiveApproved: Bool
    ) throws -> String {
        var sections: [String] = []

        if project.requirePlanApproval {
            sections.append("""
            Guardrail requirements:
            - For destructive file/database/template changes, provide a short plan and wait for explicit confirmation.
            - For schema changes, show a migration preview before execution.
            """)
        }

        if destructiveApproved {
            sections.append("Guardrail override approved for this request.")
        }

        if project.useConversationContext {
            let contextItems = try DatabaseManager.shared.searchConversationMessages(
                appId: project.id,
                query: prompt,
                limit: 6
            ).reversed()

            if !contextItems.isEmpty {
                let contextLines = contextItems.map { "[\($0.role)] \($0.content)" }.joined(separator: "\n")
                sections.append("Conversation context:\n\(contextLines)")
            }
        }

        sections.append("Current request:\n\(prompt)")
        return sections.joined(separator: "\n\n")
    }

    private func isPotentiallyDestructive(_ prompt: String) -> Bool {
        let lowered = prompt.lowercased()
        let patterns = [
            "drop table",
            "delete all",
            "remove all",
            "truncate",
            "wipe",
            "reset database",
            "destroy",
            "clear everything",
            "invalidate all",
        ]
        return patterns.contains(where: { lowered.contains($0) })
    }

    // MARK: - Event Handling

    private func processEvents(_ events: [AgentEvent]) {
        guard processedEventCount <= events.count else {
            processedEventCount = events.count
            return
        }
        let newEvents = events.dropFirst(processedEventCount)
        processedEventCount = events.count

        for event in newEvents {
            handleAgentEvent(event)
        }
    }

    private func handleAgentEvent(_ event: AgentEvent) {
        switch event {
        case .renderUI(let componentsJSON):
            if let jsonData = componentsJSON.data(using: .utf8),
               let parsed = try? JSONSerialization.jsonObject(with: jsonData) as? [[String: Any]] {
                withAnimation(.easeInOut(duration: 0.25)) {
                    componentState.render(parsed)
                }
            }
        case .toolCall(let name):
            currentToolName = name
            appendLog(level: "tool", "Tool call: \(name)")
            addTimelineEntry(.toolCall(name: name))
        case .toolResult(let name, let output, let isError):
            appendLog(level: isError ? "error" : "tool", "Tool result (\(name)): \(output.prefix(120))")
            addTimelineEntry(.toolResult(name: name, output: output, isError: isError))
        case .complete(let text):
            isAgentWorking = false
            currentToolName = ""
            agentProgressStep = 0
            agentProgressTotal = 0
            agentProgressDescription = ""
            if !text.isEmpty {
                addTimelineEntry(.agentText(text))
            }
            Task {
                await finalizePendingRevisionAndTask(success: true, output: text)
                // Replay queued interjection if any
                if let interjection = queuedInterjection {
                    queuedInterjection = nil
                    addTimelineEntry(.systemNote("Replaying queued interjection..."))
                    await dispatchUserPrompt(interjection, destructiveApproved: false)
                }
            }
            appendLog(level: "agent", "Agent completed response")
        case .error(let message):
            isAgentWorking = false
            currentToolName = ""
            agentProgressStep = 0
            agentProgressTotal = 0
            agentProgressDescription = ""
            addTimelineEntry(.error(message))
            Task {
                await finalizePendingRevisionAndTask(success: false, output: message)
            }
            appendLog(level: "error", "Agent error: \(message)")
        case .ready:
            appendLog(level: "system", "Agent is ready")
        case .chunk:
            break
        case .streamStart:
            isAgentWorking = true
            appendLog(level: "agent", "Agent streaming started")
        case .planGenerated(let content):
            appendLog(level: "plan", "Plan generated: \(content.prefix(120))")
        case .taskStart(let id, let name, _):
            appendLog(level: "task", "Task started \(id): \(name)")
        case .taskUpdate(let id, let status, _):
            appendLog(level: "task", "Task updated \(id): \(status)")
        case .taskComplete(let id, let success, _):
            appendLog(level: success ? "task" : "error", "Task completed \(id), success=\(success)")
        case .modelLoading(let text, let progress):
            appendLog(level: "model", "\(text) (\(Int(progress * 100))%)")
        case .askUser:
            break  // Handled via MCPServer.onAskUser callback
        case .progress(let step, let total, let desc):
            agentProgressStep = step
            agentProgressTotal = total
            agentProgressDescription = desc
        case .cancelled:
            appendLog(level: "system", "Agent cancelled by user")
        }
    }

    @MainActor
    private func finalizePendingRevisionAndTask(success: Bool, output: String) async {
        guard let pendingTurn else { return }

        do {
            if !output.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                let role = success ? "assistant" : "system"
                let tag = success ? "response" : "error"
                _ = try DatabaseManager.shared.appendConversationMessage(
                    appId: pendingTurn.projectId,
                    role: role,
                    content: output,
                    tags: [tag]
                )
            }

            let afterSnapshot = success ? (try? viewRegistry.exportTemplatesSnapshot()) : nil
            try DatabaseManager.shared.setRevisionAfterSnapshot(id: pendingTurn.revisionId, snapshot: afterSnapshot)
            try DatabaseManager.shared.updateRevisionStatus(
                id: pendingTurn.revisionId,
                status: success ? "ready" : "failed"
            )

            try DatabaseManager.shared.updateTaskStatus(
                id: pendingTurn.taskId,
                status: success ? "completed" : "failed"
            )
        } catch {
            appendLog(level: "error", "Failed finalizing revision/task state: \(error.localizedDescription)")
        }

        let pendingProjectId = pendingTurn.projectId
        self.pendingTurn = nil
        if activeProjectId == pendingProjectId {
            await loadActiveProjectData()
        }
    }

    private func handleAction(_ action: String, payload: Any?) {
        // 1. Handle input_submit (text input component)
        if action == "input_submit",
           let dict = payload as? [String: String],
           let value = dict["value"] {
            inputText = value
            sendMessage()
            return
        }
        
        // 2. Attempt structured event dispatch (script-first)
        //    Components can emit action dicts with {type, command, onResult, ...}
        //    This lets buttons run scripts directly without LLM round-trips.
        if let payloadDict = payload as? [String: Any],
           let eventType = EventHandlerType.parse(
               from: payloadDict,
               data: viewRegistry.currentView?.data ?? [:],
               itemData: nil
           ) {
            let context = EventContext(
                currentView: nil,
                itemData: nil,
                registry: viewRegistry
            )
            Task {
                let _ = await eventHandler.execute(handler: eventType, context: context)
            }
            return
        }
        
        // 3. Try parsing the action string itself as a JSON event config
        if let jsonData = action.data(using: .utf8),
           let dict = try? JSONSerialization.jsonObject(with: jsonData) as? [String: Any],
           let eventType = EventHandlerType.parse(
               from: dict,
               data: viewRegistry.currentView?.data ?? [:],
               itemData: nil
           ) {
            let context = EventContext(
                currentView: nil,
                itemData: nil,
                registry: viewRegistry
            )
            Task {
                let _ = await eventHandler.execute(handler: eventType, context: context)
            }
            return
        }
        
        // 4. Fallback: send to agent (LLM round-trip)
        if let payload = payload as? String {
            agent.send("\(action): \(payload)")
        } else {
            agent.send(action)
        }
    }

    // MARK: - Project/Revision/Feedback Actions

    private func createProject(name: String? = nil) {
        let nameToUse = name ?? newProjectName
        let trimmed = nameToUse.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        do {
            let project = try DatabaseManager.shared.createProject(name: trimmed, summary: "Created from super app workspace")
            newProjectName = ""
            activeProjectId = project.id
            Task {
                await reloadProjectsAndActiveData(context: "creating project", restoreState: true)
            }
            appendLog(level: "project", "Created project '\(project.name)'")
        } catch {
            appendLog(level: "error", "Failed creating project: \(error.localizedDescription)")
        }
    }
    
    private func quickStartProject() {
        let name = "Untitled App \(projects.count + 1)"
        createProject(name: name)
    }

    private func updateActiveProjectStatus(_ status: String) {
        guard let activeProject else { return }
        do {
            try DatabaseManager.shared.updateProject(id: activeProject.id, status: status)
            Task {
                await reloadProjectsAndActiveData(context: "updating project status")
            }
        } catch {
            appendLog(level: "error", "Failed updating project status: \(error.localizedDescription)")
        }
    }

    private func updateActiveProjectFlags(
        useConversationContext: Bool? = nil,
        guardrailsEnabled: Bool? = nil,
        requirePlanApproval: Bool? = nil
    ) {
        guard let activeProject else { return }
        do {
            try DatabaseManager.shared.updateProjectFlags(
                id: activeProject.id,
                useConversationContext: useConversationContext,
                guardrailsEnabled: guardrailsEnabled,
                requirePlanApproval: requirePlanApproval
            )
            Task {
                await reloadProjectsAndActiveData(context: "updating project guardrail/context settings")
            }
        } catch {
            appendLog(level: "error", "Failed updating guardrail/context settings: \(error.localizedDescription)")
        }
    }

    private func promoteRevision(_ revision: SuperAppRevision) {
        guard let activeProject else { return }
        guard revision.afterSnapshot != nil else {
            appendLog(level: "revision", "Revision is still in progress and cannot be promoted yet")
            return
        }
        do {
            try DatabaseManager.shared.updateRevisionStatus(id: revision.id, status: "promoted", promoted: true)
            try DatabaseManager.shared.updateProject(id: activeProject.id, currentRevisionId: revision.id)
            appendLog(level: "revision", "Promoted revision \(revision.id)")
            Task {
                await reloadProjectsAndActiveData(context: "promoting revision")
            }
        } catch {
            appendLog(level: "error", "Failed to promote revision: \(error.localizedDescription)")
        }
    }

    private func discardRevision(_ revision: SuperAppRevision) {
        do {
            try DatabaseManager.shared.updateRevisionStatus(id: revision.id, status: "discarded")
            if let beforeSnapshot = revision.beforeSnapshot {
                try viewRegistry.importTemplatesSnapshot(beforeSnapshot)
                appendLog(level: "revision", "Discarded revision and restored prior snapshot")
            } else {
                appendLog(level: "revision", "Discarded revision without snapshot rollback")
            }
            Task { await loadActiveProjectData() }
        } catch {
            appendLog(level: "error", "Failed discarding revision: \(error.localizedDescription)")
        }
    }

    private func submitStructuredFeedback() {
        guard let activeProject else { return }
        let what = feedbackWhat.trimmingCharacters(in: .whitespacesAndNewlines)
        let why = feedbackWhy.trimmingCharacters(in: .whitespacesAndNewlines)
        let target = feedbackTargetScreen.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !what.isEmpty, !why.isEmpty else { return }

        do {
            let feedback = try DatabaseManager.shared.createFeedback(
                appId: activeProject.id,
                revisionId: activeProject.currentRevisionId,
                what: what,
                why: why,
                severity: feedbackSeverity,
                targetScreen: target.isEmpty ? nil : target,
                status: "open"
            )
            _ = try DatabaseManager.shared.createTask(
                appId: activeProject.id,
                title: "Address feedback: \(what)",
                details: why,
                status: "open",
                source: "feedback"
            )
            feedbackWhat = ""
            feedbackWhy = ""
            feedbackTargetScreen = ""
            appendLog(level: "feedback", "Created feedback \(feedback.id)")

            let message = """
            Feedback update:
            - What: \(feedback.what)
            - Why: \(feedback.why)
            - Severity: \(feedback.severity)
            - Target Screen: \(feedback.targetScreen ?? "unspecified")
            """
            agent.send(message)
            Task { await loadActiveProjectData() }
        } catch {
            appendLog(level: "error", "Failed creating feedback: \(error.localizedDescription)")
        }
    }

    private func updateFeedbackStatus(_ feedback: SuperAppFeedback, status: String) {
        do {
            try DatabaseManager.shared.updateFeedbackStatus(id: feedback.id, status: status)
            Task { await loadActiveProjectData() }
        } catch {
            appendLog(level: "error", "Failed updating feedback status: \(error.localizedDescription)")
        }
    }

    private func clearConversationHistory() {
        guard let activeProject else { return }
        do {
            try DatabaseManager.shared.clearConversationMessages(appId: activeProject.id)
            Task { await loadActiveProjectData() }
            appendLog(level: "history", "Cleared conversation history")
        } catch {
            appendLog(level: "error", "Failed to clear conversation history: \(error.localizedDescription)")
        }
    }

    // MARK: - Data Loading

    @MainActor
    private func loadProjects() async throws {
        let loaded = try DatabaseManager.shared.listProjects()
        if loaded.isEmpty {
            // No projects yet — leave activeProjectId nil so LauncherView shows
            projects = []
            return
        }
        projects = loaded
        // Don't auto-select — let the user choose from LauncherView
        // Only auto-select if they previously had one (e.g. returning from background)
        if let current = activeProjectId, loaded.contains(where: { $0.id == current }) {
            // Keep current selection
        } else {
            activeProjectId = nil
        }
    }

    @MainActor
    private func loadActiveProjectData() async {
        guard let activeProject else {
            revisions = []
            feedbackItems = []
            tasks = []
            conversationHistory = []
            return
        }
        do {
            revisions = try DatabaseManager.shared.listRevisions(appId: activeProject.id)
            feedbackItems = try DatabaseManager.shared.listFeedback(appId: activeProject.id)
            tasks = try DatabaseManager.shared.listTasks(appId: activeProject.id)
            conversationHistory = try DatabaseManager.shared.listConversationMessages(appId: activeProject.id)
        } catch {
            appendLog(level: "error", "Failed loading project data: \(error.localizedDescription)")
        }
    }

    @MainActor
    private func loadActiveProjectDataAndRestoreState() async {
        await loadActiveProjectData()
        guard let activeProject else { return }
        do {
            if let revisionId = activeProject.currentRevisionId,
               let revision = try DatabaseManager.shared.getRevision(id: revisionId),
               let snapshot = revision.afterSnapshot {
                try viewRegistry.importTemplatesSnapshot(snapshot)
                appendLog(level: "revision", "Restored promoted snapshot for project \(activeProject.name)")
            } else {
                viewRegistry.clearRenderedState()
                componentState.rootComponents = []
            }
        } catch {
            appendLog(level: "error", "Failed restoring project state: \(error.localizedDescription)")
        }
    }

    @MainActor
    private func reloadProjectsAndActiveData(context: String, restoreState: Bool = false) async {
        do {
            try await loadProjects()
            if restoreState {
                await loadActiveProjectDataAndRestoreState()
            } else {
                await loadActiveProjectData()
            }
        } catch {
            appendLog(level: "error", "Failed \(context): \(error.localizedDescription)")
        }
    }

    // MARK: - UI Helpers



    private func appendLog(level: String, _ message: String) {
        activityLog.append(ActivityLogEntry(level: level, message: message))
    }
    
    private func addTimelineEntry(_ kind: TimelineEntry.Kind) {
        timelineEntries.append(TimelineEntry(
            id: UUID().uuidString,
            timestamp: Date(),
            kind: kind
        ))
    }

    private func relativeTime(_ date: Date) -> String {
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .short
        return formatter.localizedString(for: date, relativeTo: Date())
    }
}

// MARK: - System Prompt

private let superAppSystemPrompt = """
You are Edge Super App, an on-device app builder running on iOS.

CRITICAL: The user cannot see your plain text responses. Always present progress and results with UI tools.

## Architecture

You build mini-apps as persistent TypeScript scripts backed by native SDUI rendering. Separate **view** (SDUI templates) from **logic** (TypeScript scripts). This way, button taps run scripts instantly without waiting for you.

Every app has an `app_id` (UUID). All scripts, templates, and bundles are scoped to that app.

## Tool Strategy

1. **Discover first**: Use `query_views` to find existing templates, `list_scripts(app_id)` to find saved scripts, `bundle_get(app_id)` to see full app state.
2. **Templates for layout**: Use `register_view(name, version, component, app_id?)` for reusable screen structures.
3. **Scripts for logic**: Use `save_script(name, source, app_id)` to persist reusable TypeScript scripts. Use `run_script(name, app_id)` to execute them.
4. **Wire actions to scripts**: Button/card actions should use `run_script` event configs (preferred) or `shell_eval`.
5. **Show results**: Use `show_view` to render experiences.
6. **Iterate**: Use `update_template` and `update_view_data` for refinements.
7. **Bundle management**: Use `bundle_get`, `bundle_put`, `bundle_patch` to snapshot, restore, and patch app state.
8. **Track runs**: Use `bundle_run` for tracked script execution, `bundle_run_status` to check results, `bundle_repair_trace` for debugging.

## Script-First Actions

When a button should DO something (fetch data, update state, compute), wire it to a script using the typed `run_script` event:

```json
{
  "type": "button",
  "label": "Refresh",
  "action": {
    "type": "run_script",
    "app_id": "your-app-uuid",
    "script": "my-script",
    "scriptAction": "refresh",
    "onResult": { "action": "render" }
  }
}
```

Action types for buttons (preferred order):
- `{"type": "run_script", "app_id": "...", "script": "name", "scriptAction": "action", "onResult": {"action": "render"}}` — run app-scoped script, render output as UI
- `{"type": "run_script", "app_id": "...", "script": "name", "onResult": {"action": "navigate", "view": "...", "data": "{{result}}"}}` — run script, navigate with result
- `{"type": "run_script", "app_id": "...", "script": "name", "onResult": {"action": "update", "changes": {...}}}` — run script, update view data
- `{"type": "run_script", "app_id": "...", "script": "name", "onResult": {"action": "toast", "message": "Done!"}}` — run script, show toast
- `{"type": "shell_eval", "command": "...", "onResult": {"action": "render"}}` — fallback: run arbitrary command
- `{"type": "navigate", "view": "screen-name", "data": {...}}` — navigate to a registered view
- `{"type": "agent", "message": "..."}` — escalate to you (use sparingly, only for ambiguous user input)

Prefer `run_script` over `shell_eval` — it validates the script exists and is type-safe. Use `"agent"` type ONLY when no script can handle the action.

## Writing Scripts

Scripts are TypeScript files that run in the local WASM sandbox.

### Script Registry

Use the script registry to save, discover, and compose scripts:

- `save_script(name, source, app_id, description?, permissions?)` — persist a reusable script
- `list_scripts(app_id)` — discover existing scripts before writing new ones
- `get_script(name, app_id)` — read a script's source code
- `run_script(name, app_id, args?)` — execute a saved script

Scripts are saved to `/apps/{app_id}/scripts/{name}.ts` and can import each other:

```typescript
// /apps/{app_id}/scripts/utils.ts — shared utilities
export function today() { return new Date().toISOString().split('T')[0]; }
export function getCount(key: string) { return parseInt(localStorage.getItem(key) || '0'); }
```

```typescript
// /apps/{app_id}/scripts/water-tracker.ts — imports from utils
import { today, getCount } from '/apps/{app_id}/scripts/utils.ts';

const action = process.argv[2] || 'status';
const key = `water:${today()}`;

if (action === 'add') {
  const glasses = getCount(key) + 1;
  localStorage.setItem(key, String(glasses));
  console.log(JSON.stringify({ type: "card", title: "💧 Water Logged", body: `${glasses}/8 glasses` }));
} else {
  const glasses = getCount(key);
  console.log(JSON.stringify({
    type: "scroll", children: [
      { type: "card", title: "💧 Today's Water", body: `${glasses}/8 glasses` },
      { type: "button", label: "Log a Glass",
        action: { type: "run_script", app_id: "{app_id}", script: "water-tracker",
                  scriptAction: "add", onResult: { action: "render" } } }
    ]
  }));
}
```

Always `list_scripts(app_id)` before writing a new script — reuse and compose existing scripts.

## Bundle Management

Bundles snapshot the complete state of an app (templates, scripts, bindings, policy):

- `bundle_get(app_id)` — get live bundle JSON from current DB state
- `bundle_get(app_id, revision_id)` — get a specific stored revision
- `bundle_put(app_id, bundle_json, mode)` — save a revision (`draft` or `promote`)
- `bundle_patch(app_id, patches)` — apply targeted patches to templates or scripts
- `bundle_run(app_id, entrypoint, args?)` — execute a script as a tracked run
- `bundle_run_status(run_id)` — check run status and failure details
- `bundle_repair_trace(run_id)` — list repair attempts for debugging

## Workflow

1. Clarify what to build with a focused UI form/prompt.
2. Show a plan with milestones and current status.
3. Write script files for logic, register templates for layout, wire actions.
4. Build in small increments, surface each result in Preview mode.
5. Ask for structured feedback and apply improvements immediately.
6. Persist app specification and state for continuity.

## UI Conventions

- Prefer clean single-column layouts unless the user requests a grid.
- Use concise labels and obvious actions.
- Include "Revise" or "Improve" paths once something is generated.
- For destructive actions, show a plan and await confirmation.

## User Collaboration

Use `ask_user` to involve the user in decisions:

- `ask_user(type: "confirm", prompt: "...")` — yes/no approval (returns "approved" or "rejected")
- `ask_user(type: "choose", prompt: "...", options: ["A", "B", "C"])` — pick from options (returns selected option)
- `ask_user(type: "text", prompt: "...")` — free-form input (returns user's text)
- `ask_user(type: "plan", prompt: "## My Plan\n...")` — plan approval (returns "approved" or "revise")

**When to use ask_user:**
- Before major layout decisions (grid vs list, tabs vs stack)
- When multiple valid approaches exist (color scheme, feature scope)
- Before destructive changes (deleting screens, resetting data)
- At milestones to confirm direction
- NEVER assume — ask when uncertain about preferences

## Starting a New Conversation

- Greet briefly.
- Ask what app/workflow to create or improve.
- Offer quick starters (dashboard, form tool, data browser, automation).
"""

// MARK: - Preview

#Preview {
    SuperAppView()
}
