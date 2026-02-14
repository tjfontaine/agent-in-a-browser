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

private enum WorkspaceMode: String {
    case edit
    case run
}

/// Main super-app workspace.
/// Includes project management, build/preview/data/log modes, revision control,
/// structured feedback, task tracking, and searchable conversation history.
struct SuperAppView: View {
    @EnvironmentObject var configManager: ConfigManager

    @StateObject private var agent = EdgeAgentSession.shared
    @StateObject private var componentState = ComponentState()


    /// Event handler for script-first action dispatch
    private let eventHandler = EventHandler()

    @State private var hasInitialized = false
    @State private var showSettings = false

    @State private var showLogs = false
    @State private var showInput = true
    @State private var workspaceMode: WorkspaceMode = .edit
    @State private var loadError: String?


    @State private var inputText = ""
    @State private var newProjectName = ""
    @State private var showCreateProjectPrompt = false
    @State private var showRenameProjectPrompt = false
    @State private var renameProjectName = ""
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
    @State private var pendingProjectDeletion: SuperAppProject?
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
    @State private var pendingAskUserLocalResolver: ((String) -> Void)?

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

    private var activeProjectDisplayName: String {
        let trimmed = activeProject?.name.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? "Untitled App" : trimmed
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

            isAgentStreaming: isAgentWorking,
            streamText: agent.currentStreamText,
            loadError: loadError,
            onAction: { action, payload in
                handleAction(action, payload: payload)
            },
            onAnnotate: { componentType, key, props in
                // Pre-fill input with component context for targeted feedback
                let label = (props["content"] as? String) ?? (props["text"] as? String) ?? (props["title"] as? String) ?? (props["label"] as? String) ?? key
                let context = "[\(componentType) \"\(label)\"] "
                applyWorkspaceMode(.edit)
                inputText = context
                addTimelineEntry(.systemNote("Annotating \(componentType): \(label)"))
                #if !targetEnvironment(simulator)
                // Haptic feedback on real devices only; simulator logs missing pattern library warnings.
                let generator = UIImpactFeedbackGenerator(style: .medium)
                generator.impactOccurred()
                #endif
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
                    onRunProject: { project in
                        applyWorkspaceMode(.run)
                        activeProjectId = project.id
                        Task {
                            await reloadProjectsAndActiveData(context: "opening project", restoreState: true)
                            setupAgentIfNeeded(force: false)
                            await tryAutoRunMainScript()
                        }
                    },
                    onEditProject: { project in
                        applyWorkspaceMode(.edit)
                        activeProjectId = project.id
                        Task {
                            await reloadProjectsAndActiveData(context: "editing project", restoreState: true)
                            setupAgentIfNeeded(force: false)
                        }
                    },
                    onDeleteProject: { project in
                        requestDeleteProject(project)
                    },
                    onNewProject: {
                        newProjectName = nextUntitledProjectName()
                        showCreateProjectPrompt = true
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

                            if (showInput || pendingAskUserId != nil) && agent.isReady {
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
        .onDisappear {
            ScriptPermissions.shared.requestConsent = nil
        }
        .onChange(of: agent.events) { _, events in
            processEvents(events)
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
        .alert(
            "Delete App?",
            isPresented: Binding(
                get: { pendingProjectDeletion != nil },
                set: { isPresented in
                    if !isPresented {
                        pendingProjectDeletion = nil
                    }
                }
            ),
            presenting: pendingProjectDeletion
        ) { project in
            Button("Cancel", role: .cancel) {
                pendingProjectDeletion = nil
            }
            Button("Delete", role: .destructive) {
                deleteProject(project)
            }
        } message: { project in
            let displayName = project.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "Untitled App" : project.name
            Text("Delete \"\(displayName)\" and all of its scripts, runs, and history?")
        }
        .alert("New App", isPresented: $showCreateProjectPrompt) {
            TextField("App name", text: $newProjectName)
            Button("Cancel", role: .cancel) {
                newProjectName = ""
            }
            Button("Create") {
                createProject(name: newProjectName)
            }
        } message: {
            Text("Choose a name for the new app.")
        }
        .alert("Rename App", isPresented: $showRenameProjectPrompt) {
            TextField("App name", text: $renameProjectName)
            Button("Cancel", role: .cancel) {
                renameProjectName = ""
            }
            Button("Save") {
                renameActiveProject(to: renameProjectName)
            }
        } message: {
            Text("Update the launcher name for this app.")
        }
    }

    // MARK: - Top Level UI

    private var canvasHeader: some View {
        HStack(spacing: 12) {
            // Back to launcher
            Button(action: {
                activeProjectId = nil
                applyWorkspaceMode(.edit)
            }) {
                Image(systemName: "chevron.left")
                    .font(.title3)
            }
            .buttonStyle(.plain)
            Text(activeProjectDisplayName)
                .font(.headline)
                .lineLimit(1)
            Text(workspaceMode == .edit ? "EDIT" : "RUN")
                .font(.caption2.weight(.semibold))
                .padding(.horizontal, 8)
                .padding(.vertical, 4)
                .background(workspaceMode == .edit ? Color.orange.opacity(0.16) : Color.blue.opacity(0.16))
                .foregroundStyle(workspaceMode == .edit ? Color.orange : Color.blue)
                .clipShape(Capsule())

            Spacer()

            if !agent.isReady && loadError == nil {
                ProgressView().controlSize(.small)
            }

            Menu {
                Button {
                    if workspaceMode == .edit {
                        applyWorkspaceMode(.run)
                        Task {
                            await tryAutoRunMainScript()
                        }
                    } else {
                        applyWorkspaceMode(.edit)
                    }
                } label: {
                    Label(
                        workspaceMode == .edit ? "Switch to Run Mode" : "Switch to Edit Mode",
                        systemImage: workspaceMode == .edit ? "play.circle" : "pencil"
                    )
                }
                Button(action: { showLogs = true }) {
                    Label("Logs", systemImage: "text.alignleft")
                }
                Button(action: { showSettings = true }) {
                    Label("Settings", systemImage: "gearshape")
                }
                if let activeProject {
                    Button {
                        renameProjectName = activeProjectDisplayName
                        showRenameProjectPrompt = true
                    } label: {
                        Label("Rename App", systemImage: "text.cursor")
                    }
                    Button(role: .destructive) {
                        requestDeleteProject(activeProject)
                    } label: {
                        Label("Delete App", systemImage: "trash")
                    }
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







    private func resolveAskUserResponse(_ response: String) {
        let requestId = pendingAskUserId
        let localResolver = pendingAskUserLocalResolver
        withAnimation {
            pendingAskUserId = nil
            pendingAskUserType = "confirm"
            pendingAskUserPrompt = ""
            pendingAskUserOptions = nil
            askUserTextInput = ""
            pendingAskUserLocalResolver = nil
        }
        if let localResolver {
            localResolver(response)
            return
        }
        guard let requestId else {
            return
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
        syncMCPWorkspaceToolMode()

        MCPServer.shared.onRenderUI = { newComponents in
            withAnimation(.easeInOut(duration: 0.25)) {
                componentState.render(newComponents)
            }
        }

        MCPServer.shared.onPatchUI = { patches in
            withAnimation(.easeInOut(duration: 0.2)) {
                componentState.applyPatches(patches)
            }
        }
        MCPServer.shared.onAskUser = { requestId, askType, prompt, options in
            pendingAskUserId = requestId
            pendingAskUserType = askType
            pendingAskUserPrompt = prompt
            pendingAskUserOptions = options
            askUserTextInput = ""
            pendingAskUserLocalResolver = nil
        }

        ScriptPermissions.shared.requestConsent = { appId, scriptName, capability, completion in
            DispatchQueue.main.async {
                if pendingAskUserId != nil {
                    completion(false)
                    return
                }
                pendingAskUserId = "perm-\(UUID().uuidString)"
                pendingAskUserType = "choose"
                pendingAskUserPrompt = "Allow script `\(scriptName)` in app `\(appId)` to access `\(capability.rawValue)`?"
                pendingAskUserOptions = ["Allow", "Deny"]
                askUserTextInput = ""
                pendingAskUserLocalResolver = { selection in
                    completion(selection == "Allow")
                }
            }
        }

        // Wire EventHandler callbacks for script-first action dispatch
        eventHandler.onAgentMessage = { [weak agent] message in
            agent?.send(message)
        }

        eventHandler.onRenderComponents = { [weak componentState] components in
            DispatchQueue.main.async {
                withAnimation(.easeInOut(duration: 0.25)) {
                    componentState?.render(components)
                }
            }
        }

        eventHandler.onToast = { message in
            Log.app.info("Toast: \(message)")
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


                try await MCPServer.shared.start()

                try await Task.sleep(nanoseconds: 100_000_000)

                do {
                    if !NativeMCPHost.shared.isReady {
                        try await NativeMCPHost.shared.load()
                        try await NativeMCPHost.shared.startServer()
                    }
                } catch {
                    Log.app.warning("SuperApp: Native MCP Host unavailable: \(error.localizedDescription)")
                }

                // EdgeAgentSession has no WASM to load — session is created in createAgent

                var mcpServers: [MCPServerConfig] = [MCPServerConfig(url: MCPServer.shared.baseURL, name: "ios-tools")]
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
                await agent.createAgent(config: config)
                appendLog(level: "system", "Agent initialized with \(mcpServers.count) MCP servers")
            } catch {
                loadError = error.localizedDescription
                appendLog(level: "error", "Agent setup failed: \(error.localizedDescription)")
            }
        }
    }

    // MARK: - Prompt Dispatch / Guardrails

    private func sendMessage() {
        guard workspaceMode == .edit else {
            appendLog(level: "guardrail", "Editing is disabled in Run mode. Switch to Edit mode to send prompts.")
            return
        }

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
        guard workspaceMode == .edit else {
            appendLog(level: "guardrail", "Ignored prompt in Run mode")
            return
        }
        guard let activeProject else { return }

        do {
            guard pendingTurn == nil else {
                appendLog(level: "guardrail", "A build request is already running")
                return
            }

            let hasScripts = (try? !AppBundleRepository().listAppScripts(appId: activeProject.id).isEmpty) ?? false
            var projectForPrompt = activeProject
            if !hasScripts,
               isAutoGeneratedProjectName(activeProject.name),
               let inferredName = inferredProjectName(from: prompt) {
                try DatabaseManager.shared.updateProject(id: activeProject.id, name: inferredName)
                if let refreshedProject = try DatabaseManager.shared.getProject(id: activeProject.id) {
                    projectForPrompt = refreshedProject
                }
                appendLog(level: "project", "Auto-named app as '\(projectForPrompt.name)'")
            }

            let promptForAgent = try buildPromptForAgent(
                project: projectForPrompt,
                prompt: prompt,
                destructiveApproved: destructiveApproved
            )

            let beforeSnapshot = snapshotBundleJSONString(appId: projectForPrompt.id)
            let revision = try DatabaseManager.shared.createRevision(
                appId: projectForPrompt.id,
                summary: prompt,
                status: "draft",
                beforeSnapshot: beforeSnapshot,
                afterSnapshot: nil,
                guardrailNotes: destructiveApproved ? "Destructive override approved by user" : nil
            )

            let task = try DatabaseManager.shared.createTask(
                appId: projectForPrompt.id,
                title: "Build request",
                details: prompt,
                status: "in_progress",
                source: "prompt"
            )
            pendingTurn = PendingTurnState(
                projectId: projectForPrompt.id,
                revisionId: revision.id,
                taskId: task.id
            )

            _ = try DatabaseManager.shared.appendConversationMessage(
                appId: projectForPrompt.id,
                role: "user",
                content: prompt,
                tags: ["prompt"]
            )

            try DatabaseManager.shared.updateProject(id: projectForPrompt.id, lastPrompt: prompt)
            agent.send(promptForAgent)
            appendLog(level: "prompt", "Dispatched prompt to agent for project \(projectForPrompt.name)")
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

        // Always inject the project identity so the agent uses the correct app_id
        sections.append("""
        App context:
        - app_id: \(project.id)
        - app_name: \(project.name)
        Use this app_id for ALL save_script, run_script, and bundle tool calls.
        """)

        // Include existing scripts so the agent can resume rather than recreate
        if let scripts = try? AppBundleRepository().listAppScripts(appId: project.id),
           !scripts.isEmpty {
            let list = scripts.map { "- \($0.name): \($0.description ?? "no description")" }.joined(separator: "\n")
            sections.append("Existing scripts for this app:\n\(list)")
        }

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
            isAgentWorking = false
            currentToolName = ""
            agentProgressStep = 0
            agentProgressTotal = 0
            agentProgressDescription = ""
            addTimelineEntry(.systemNote("Agent cancelled by user"))
            Task {
                await finalizePendingRevisionAndTask(success: false, output: "Cancelled by user")
            }
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

            let afterSnapshot = snapshotBundleJSONString(appId: pendingTurn.projectId)
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
        if action == "input_submit" {
            if workspaceMode == .edit,
               let dict = payload as? [String: String],
               let value = dict["value"] {
                inputText = value
                sendMessage()
            } else {
                appendLog(level: "runtime", "Ignored input_submit in Run mode")
            }
            return
        }

        // 2. Attempt structured event dispatch (script-first)
        //    Components can emit action dicts with {type, command, onResult, ...}
        //    This lets buttons run scripts directly without LLM round-trips.
        if let payloadDict = payload as? [String: Any],
           let eventType = EventHandlerType.parse(
               from: payloadDict,
               data: [:], // SDUI View Data deprecated
               itemData: nil
           ) {
            guard shouldExecuteEventInCurrentMode(eventType) else {
                appendLog(level: "runtime", "Blocked event '\(action)' in Run mode")
                return
            }
            let context = EventContext(itemData: nil)
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
               data: [:], // SDUI View Data deprecated
               itemData: nil
           ) {
            guard shouldExecuteEventInCurrentMode(eventType) else {
                appendLog(level: "runtime", "Blocked JSON event in Run mode")
                return
            }
            let context = EventContext(itemData: nil)
            Task {
                let _ = await eventHandler.execute(handler: eventType, context: context)
            }
            return
        }

        // 4. Fallback: send to agent (LLM round-trip)
        guard workspaceMode == .edit else {
            appendLog(level: "runtime", "Ignored unhandled action '\(action)' in Run mode")
            return
        }
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
        let effectiveName = trimmed.isEmpty ? nextUntitledProjectName() : trimmed
        do {
            let project = try DatabaseManager.shared.createProject(name: effectiveName, summary: "Created from super app workspace")
            applyWorkspaceMode(.edit)
            showCreateProjectPrompt = false
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

    private func nextUntitledProjectName() -> String {
        let existingNames = Set(
            projects.map { $0.name.trimmingCharacters(in: .whitespacesAndNewlines) }
        )
        var index = 1
        while existingNames.contains("Untitled App \(index)") {
            index += 1
        }
        return "Untitled App \(index)"
    }

    private func quickStartProject() {
        createProject(name: nextUntitledProjectName())
    }

    private func renameActiveProject(to name: String) {
        guard let activeProject else { return }
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        let effectiveName = trimmed.isEmpty ? activeProjectDisplayName : trimmed
        do {
            try DatabaseManager.shared.updateProject(id: activeProject.id, name: effectiveName)
            showRenameProjectPrompt = false
            renameProjectName = ""
            appendLog(level: "project", "Renamed project to '\(effectiveName)'")
            Task {
                await reloadProjectsAndActiveData(context: "renaming project", restoreState: false)
            }
        } catch {
            appendLog(level: "error", "Failed renaming project: \(error.localizedDescription)")
        }
    }

    private func requestDeleteProject(_ project: SuperAppProject) {
        pendingProjectDeletion = project
    }

    private func deleteProject(_ project: SuperAppProject) {
        do {
            if pendingTurn?.projectId == project.id {
                pendingTurn = nil
                agent.cancel()
                isAgentWorking = false
            }
            try DatabaseManager.shared.deleteProject(id: project.id)
            if activeProjectId == project.id {
                activeProjectId = nil
                componentState.rootComponents = []
            }
            pendingProjectDeletion = nil
            appendLog(level: "project", "Deleted project '\(project.name)'")
            Task {
                await reloadProjectsAndActiveData(context: "deleting project", restoreState: false)
            }
        } catch {
            appendLog(level: "error", "Failed deleting project: \(error.localizedDescription)")
        }
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
        guard let activeProject else { return }
        do {
            try DatabaseManager.shared.updateRevisionStatus(id: revision.id, status: "discarded")
            if let beforeSnapshot = revision.beforeSnapshot {
                try restoreBundleSnapshot(beforeSnapshot, appId: activeProject.id)
                componentState.rootComponents = []
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
                try restoreBundleSnapshot(snapshot, appId: activeProject.id)
                componentState.rootComponents = []
                appendLog(level: "revision", "Restored promoted snapshot for project \(activeProject.name)")
            } else {
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

    private func applyWorkspaceMode(_ mode: WorkspaceMode) {
        withAnimation(.easeInOut(duration: 0.2)) {
            workspaceMode = mode
            showInput = (mode == .edit)
        }
        syncMCPWorkspaceToolMode()
        appendLog(level: "mode", "Workspace mode: \(mode.rawValue)")
    }

    private func syncMCPWorkspaceToolMode() {
        let toolMode: MCPServer.WorkspaceToolMode = workspaceMode == .edit ? .edit : .run
        MCPServer.shared.setWorkspaceToolMode(toolMode)
    }

    private func shouldExecuteEventInCurrentMode(_ eventType: EventHandlerType) -> Bool {
        guard workspaceMode == .run else { return true }
        switch eventType {
        case .runScript, .scriptEval:
            return true
        case .shellEval, .agent:
            return false
        }
    }

    private func addTimelineEntry(_ kind: TimelineEntry.Kind) {
        timelineEntries.append(TimelineEntry(
            id: UUID().uuidString,
            timestamp: Date(),
            kind: kind
        ))
    }

    @MainActor
    private func snapshotBundleJSONString(appId: String) -> String? {
        guard let bundle = try? AppBundle.build(appId: appId),
              let data = try? JSONEncoder().encode(bundle),
              let json = String(data: data, encoding: .utf8) else {
            appendLog(level: "revision", "Bundle snapshot unavailable for app \(appId)")
            return nil
        }
        return json
    }

    @MainActor
    private func restoreBundleSnapshot(_ snapshot: String, appId: String) throws {
        guard let data = snapshot.data(using: .utf8) else {
            throw NSError(domain: "SuperAppView", code: 1, userInfo: [
                NSLocalizedDescriptionKey: "Snapshot data is not valid UTF-8"
            ])
        }
        var bundle = try JSONDecoder().decode(AppBundle.self, from: data)
        if bundle.manifest.appId != appId {
            bundle = bundle.retargeted(to: appId)
        }
        try bundle.restore(appId: appId)
    }

    private func relativeTime(_ date: Date) -> String {
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .short
        return formatter.localizedString(for: date, relativeTo: Date())
    }

    private func isAutoGeneratedProjectName(_ name: String) -> Bool {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.caseInsensitiveCompare("Untitled App") == .orderedSame { return true }
        return trimmed.range(of: #"^Untitled App \d+$"#, options: .regularExpression) != nil
    }

    private func inferredProjectName(from prompt: String) -> String? {
        let firstLine = prompt
            .components(separatedBy: .newlines)
            .first?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !firstLine.isEmpty else { return nil }

        let patterns = [
            #"(?i)\b(?:build|create|make|design|develop|craft|generate)\s+(?:me\s+)?(?:an?\s+)?(.+?)\s+app\b"#,
            #"(?i)\b(?:an?\s+)?(.+?)\s+app\b"#
        ]

        var candidate: String?
        for pattern in patterns {
            if let regex = try? NSRegularExpression(pattern: pattern),
               let match = regex.firstMatch(
                in: firstLine,
                options: [],
                range: NSRange(firstLine.startIndex..., in: firstLine)
               ),
               let range = Range(match.range(at: 1), in: firstLine) {
                candidate = String(firstLine[range])
                break
            }
        }

        guard var candidate else { return nil }
        candidate = candidate
            .replacingOccurrences(of: #"[^\p{L}\p{N}\s-]"#, with: " ", options: .regularExpression)
            .replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !candidate.isEmpty else { return nil }

        let stopWords = Set(["a", "an", "the", "new", "simple"])
        let tokens = candidate
            .split(separator: " ")
            .map(String.init)
            .filter { !stopWords.contains($0.lowercased()) }
        guard !tokens.isEmpty else { return nil }

        let capped = tokens.prefix(5).map { token -> String in
            guard let first = token.first else { return token }
            return String(first).uppercased() + token.dropFirst().lowercased()
        }
        let name = capped.joined(separator: " ").trimmingCharacters(in: .whitespacesAndNewlines)
        return name.isEmpty ? nil : name
    }

    // MARK: - Auto Run

    @MainActor
    private func tryAutoRunMainScript() async {
        guard let activeProject else { return }

        do {
            let scripts = try AppBundleRepository().listAppScripts(appId: activeProject.id)
            guard !scripts.isEmpty else { return }

            // Prefer explicit entrypoint names; never run an arbitrary utility script.
            let projectSlug = activeProject.name
                .lowercased()
                .replacingOccurrences(of: #"[^a-z0-9]+"#, with: "-", options: .regularExpression)
                .trimmingCharacters(in: CharacterSet(charactersIn: "-"))

            var prioritizedNames = ["main", "home", "index", "app", "start", "launch"]
            if !projectSlug.isEmpty {
                prioritizedNames.append(contentsOf: [
                    projectSlug,
                    "\(projectSlug)-main",
                    "\(projectSlug)-home",
                    "\(projectSlug)-index"
                ])
            }

            let lowerToActual = Dictionary(
                uniqueKeysWithValues: scripts.map { ($0.name.lowercased(), $0.name) }
            )

            var scriptName: String?
            for candidate in prioritizedNames {
                if let match = lowerToActual[candidate.lowercased()] {
                    scriptName = match
                    break
                }
            }

            if scriptName == nil {
                scriptName = scripts.first(where: {
                    $0.name.lowercased().hasSuffix("-main") || $0.name.lowercased().hasSuffix("-home")
                })?.name
            }

            if scriptName == nil {
                scriptName = scripts.first(where: {
                    let description = ($0.description ?? "").lowercased()
                    return description.contains("entrypoint")
                        || description.contains("home screen")
                        || description.contains("main screen")
                })?.name
            }

            if scriptName == nil, scripts.count == 1 {
                scriptName = scripts[0].name
            }

            if let scriptName {
                appendLog(level: "system", "Auto-running script: \(scriptName)")

                let path = DatabaseManager.appScriptSandboxPath(appId: activeProject.id, name: scriptName)
                let (success, output) = await ScriptExecutor.shared.evalFile(
                    path: path,
                    args: [],
                    appId: activeProject.id,
                    scriptName: scriptName
                )

                if !success {
                    appendLog(level: "error", "Auto-run failed: \(output ?? "unknown error")")
                } else {
                     appendLog(level: "system", "Auto-run success")
                }
            } else {
                appendLog(level: "system", "No clear entrypoint script found to auto-run")
            }
        } catch {
            appendLog(level: "error", "Failed to list scripts for auto-run: \(error.localizedDescription)")
        }
    }
}

// MARK: - System Prompt

private let superAppSystemPrompt = """
You are Edge Super App, an on-device app builder running on iOS.

CRITICAL: The user cannot see your plain text responses. You MUST render all UI by writing TypeScript scripts and running them via the `save_script` and `run_script` tools. There is NO direct `ios.render.show` tool — it is a script-level SDK API only available inside TypeScript code.

## Architecture

You build mini-apps as persistent TypeScript scripts that render native UI declaratively. Inside scripts, call `ios.render.show()` to push a component tree and `ios.render.patch()` for incremental updates — enabling real-time progressive rendering.

**Rendering workflow:** Write a TypeScript script → `save_script(name, source, app_id)` → `run_script(name, app_id)`. The script's `ios.render.show()` call displays native UI.

Every app has an `app_id` (UUID). All scripts and bundles are scoped to that app.

## Rendering

### `ios.render.show(layout)`
Push a full component tree to the native renderer. Accepts a JSON object or string.

```typescript
ios.render.show({
  type: "scroll", children: [
    { type: "text", content: "Hello", style: "title" },
    { type: "card", key: "status-card", title: "Status", body: "Loading..." }
  ]
});
```

### `ios.render.patch(patches)`
Apply incremental updates to the current UI tree. Each patch targets a component by its `key`.

```typescript
ios.render.patch([
  { key: "status-card", op: "update", props: { body: "Complete ✓" } },
  { key: "items-list", op: "append", component: { type: "card", title: "New Item" } }
]);
```

**Operations:** `replace` (swap component), `remove`, `update` (merge props), `append`, `prepend` (add child to container).

### Progressive Rendering Pattern

Always render a skeleton first, then patch in data as it becomes available:

```typescript
// Step 1: Show skeleton immediately
ios.render.show({
  type: "scroll", children: [
    { type: "text", content: "🔍 Searching...", style: "title", key: "title" },
    { type: "progress", key: "loader" },
    { type: "vstack", key: "results", children: [] }
  ]
});

// Step 2: Patch in results as they arrive
ios.render.patch([
  { key: "title", op: "update", props: { content: "Results" } },
  { key: "loader", op: "remove" },
  { key: "results", op: "append", component: { type: "card", title: "Result 1" } }
]);
```

### Component Types

| Type | Key Props |
|------|-----------|
| `text` | `content`, `style` (title/headline/subheadline/body/caption/footnote) |
| `button` | `label`, `style` (primary/secondary/destructive), `action` |
| `card` | `title`, `body`, `subtitle`, `action` |
| `image` | `systemName` (SF Symbol) or `url`, `width`, `height` |
| `scroll` | `children` |
| `hstack` / `vstack` | `children`, `spacing`, `alignment` |
| `spacer` | (no props) |
| `divider` | (no props) |
| `input` | `placeholder`, `value`, `key` |
| `progress` | `value` (0-1, omit for indeterminate) |
| `badge` | `text`, `color` |
| `grid` | `children`, `columns` |
| `list` | `children` |

All components accept an optional `key` for targeting with `patch`.

## Tool Strategy

1. **Discover first**: Use `list_scripts(app_id)` to find saved scripts, `bundle_get(app_id)` to see full app state.
2. **Scripts for everything**: Use `save_script(name, source, app_id)` to persist reusable TypeScript. Use `run_script(name, app_id)` to execute.
3. **Wire actions to scripts**: Button actions should use `run_script` event configs.
4. **Bundle management**: Use `bundle_get`, `bundle_put`, `bundle_patch` to snapshot, restore, and patch app state.
5. **Track runs**: Use `bundle_run` for tracked execution, `bundle_run_status` to check results.
6. **Optional args rule**: For optional fields (for example `revision_id` and `repair_for_run_id`), omit the key when unknown. Never send empty strings.

## Script-First Actions

When a button should DO something, wire it to a script:

```json
{
  "type": "button",
  "label": "Refresh",
  "action": {
    "type": "run_script",
    "app_id": "your-app-uuid",
    "script": "my-script",
    "scriptAction": "refresh"
  }
}
```

If the script uses `ios.render.show()` or `ios.render.patch()`, do not add `onResult: { "action": "render" }` on `run_script` actions.

## Writing Scripts

Scripts are TypeScript files running in the local WASM sandbox with full access to the `ios.*` SDK.

**CRITICAL: Scripts must execute at the top level.** `run_script` evaluates the file — only top-level code runs. Do NOT just export functions; you must CALL them. Example:

```typescript
// CORRECT — top-level execution renders UI immediately
const meals = JSON.parse(ios.storage.get("saved_meals") || "[]");
ios.render.show({
  type: "scroll", children: [
    { type: "text", content: "My Meals", style: "title" },
    ...meals.map(m => ({ type: "card", title: m.name }))
  ]
});
```

```typescript
// WRONG — exports a function but never calls it, nothing renders
export function showHome() {
  ios.render.show({ type: "text", content: "Hello" });
}
```

### Script Registry

- `save_script(name, source, app_id, description?, permissions?)` — persist a reusable script
- `list_scripts(app_id)` — discover existing scripts before writing new ones
- `get_script(name, app_id)` — read a script's source code
- `run_script(name, app_id, args?)` — execute a saved script

Scripts are saved to `/apps/{app_id}/scripts/{name}.ts` and can import each other.

Always `list_scripts(app_id)` before writing a new script — reuse and compose existing ones.

### iOS Bridge SDK (`ios.*`)

Scripts have direct access to native APIs — no HTTP/MCP overhead:

- **Storage**: `ios.storage.get/set/remove/keys` — scoped key-value storage
- **Device**: `ios.device.info/connectivity/locale` — hardware and system info
- **Render**: `ios.render.show/patch` — UI rendering (described above)
- **Permissions**: `ios.permissions.request/check/revoke` — capability grants
- **Contacts**: `ios.contacts.search/get` — address book (requires consent)
- **Calendar**: `ios.calendar.events/createEvent` — EventKit (requires consent)
- **Notifications**: `ios.notifications.schedule/cancel` — local notifications
- **Clipboard**: `ios.clipboard.get/set` — pasteboard
- **Location**: `ios.location.current/geocode` — CoreLocation (requires consent)
- **Health**: `ios.health.query/statistics` — HealthKit (requires consent)
- **Keychain**: `ios.keychain.get/set/remove` — secure storage
- **Photos**: `ios.photos.search/asset/albums` — photo library (requires consent)

## Bundle Management

Bundles snapshot the complete state of an app (scripts, bindings, policy):

- `bundle_get(app_id)` — get live bundle JSON
- `bundle_get(app_id, revision_id)` — get a specific saved revision (only when you have a real revision id)
- `bundle_put(app_id, bundle_json, mode)` — save a revision (`draft` or `promote`)
- `bundle_patch(app_id, patches)` — apply targeted patches
- `bundle_run(app_id, entrypoint, args?, revision_id?)` — execute as a tracked run (`revision_id` optional; omit when unknown)
- `bundle_run_status(run_id)` — check run status
- `bundle_repair_trace(run_id)` — list repair attempts for debugging

## User Collaboration

Use `ask_user` to involve the user in decisions:

- `ask_user(type: "confirm", prompt: "...")` — yes/no approval
- `ask_user(type: "choose", prompt: "...", options: ["A", "B", "C"])` — pick from options
- `ask_user(type: "text", prompt: "...")` — free-form input
- `ask_user(type: "plan", prompt: "## My Plan\\n...")` — plan approval

**When to use ask_user:**
- Before major layout decisions
- When multiple valid approaches exist
- Before destructive changes
- At milestones to confirm direction

## Workflow

1. Greet briefly.
2. Ask what app/workflow to create or improve.
3. Write a TypeScript script that calls `ios.render.show()` to display a plan, save it with `save_script`, run it with `run_script`, then await approval via `ask_user`.
4. Build in small increments — render skeleton first, then patch in details via scripts.
5. Surface each result visually through scripts. Ask for feedback and iterate.
"""

// MARK: - Preview

#Preview {
    SuperAppView()
}
