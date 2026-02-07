import SwiftUI
import MCPServerKit

private enum WorkspaceMode: String, CaseIterable, Identifiable {
    case build = "Build"
    case preview = "Preview"
    case data = "Data"
    case logs = "Logs"

    var id: String { rawValue }
}

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

    @State private var hasInitialized = false
    @State private var showSettings = false
    @State private var showProjectManager = false
    @State private var showInput = true
    @State private var loadError: String?

    @State private var selectedMode: WorkspaceMode = .build
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

    private let feedbackSeverities = ["low", "medium", "high", "critical"]
    private let projectStatuses = ["active", "paused", "archived"]

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
        ScrollView {
            if let error = loadError {
                errorView(error)
            } else if !viewRegistry.renderedComponents.isEmpty {
                viewRegistryGrid
            } else if !componentState.rootComponents.isEmpty {
                componentGrid
            } else if !agent.currentStreamText.isEmpty {
                thinkingView
            } else {
                emptyStateView
            }
        }
    }

    var body: some View {
        VStack(spacing: 0) {
            headerView
            modePicker
            modeContent

            if showInput && agent.isReady && (selectedMode == .build || selectedMode == .preview) {
                inputArea
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
        .sheet(isPresented: $showProjectManager) {
            projectManagerView
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

    private var headerView: some View {
        HStack(spacing: 12) {
            if selectedMode == .preview && viewRegistry.navigationStack.count > 1 {
                Button(action: {
                    viewRegistry.popView()
                    appendLog(level: "nav", "Popped preview navigation stack")
                }) {
                    Image(systemName: "chevron.left")
                        .font(.title3)
                }
                .buttonStyle(.bordered)
            }

            Button(action: { showProjectManager = true }) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(activeProject?.name ?? "Select Project")
                        .font(.headline)
                        .lineLimit(1)
                    Text(activeProject?.status.capitalized ?? "No project")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .buttonStyle(.plain)

            Spacer()

            Text("Edge Super App")
                .font(.title3.weight(.semibold))

            Text("Native")
                .font(.caption)
                .foregroundColor(.white)
                .padding(.horizontal, 8)
                .padding(.vertical, 3)
                .background(Color.green)
                .cornerRadius(6)

            Spacer()

            if !agent.isReady && loadError == nil {
                ProgressView().controlSize(.small)
            }

            Button(action: { showSettings = true }) {
                Image(systemName: "gearshape.fill")
                    .font(.title3)
            }
            .buttonStyle(.bordered)
        }
        .padding()
        .background(Color(.systemBackground))
    }

    private var modePicker: some View {
        Picker("Mode", selection: $selectedMode) {
            ForEach(WorkspaceMode.allCases) { mode in
                Text(mode.rawValue).tag(mode)
            }
        }
        .pickerStyle(.segmented)
        .padding(.horizontal)
        .padding(.bottom, 10)
    }

    @ViewBuilder
    private var modeContent: some View {
        switch selectedMode {
        case .build:
            buildModeView
        case .preview:
            previewRenderArea
        case .data:
            dataModeView
        case .logs:
            logsModeView
        }
    }

    private var buildModeView: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                projectOverviewCard
                guardrailsCard
                tasksCard
                revisionsCard
                feedbackCard
                conversationCard
            }
            .padding()
        }
    }

    private var dataModeView: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                if let activeProject {
                    dataRow("Project ID", activeProject.id)
                    dataRow("Status", activeProject.status)
                    dataRow("Current Revision", activeProject.currentRevisionId ?? "None")
                    dataRow("Last Prompt", activeProject.lastPrompt ?? "None")
                    dataRow("Use Conversation Context", activeProject.useConversationContext ? "Yes" : "No")
                    dataRow("Guardrails", activeProject.guardrailsEnabled ? "Enabled" : "Disabled")
                    dataRow("Require Plan Approval", activeProject.requirePlanApproval ? "Yes" : "No")
                    dataRow("Revisions", "\(revisions.count)")
                    dataRow("Open Feedback", "\(feedbackItems.filter { $0.status == "open" }.count)")
                    dataRow("Tasks", "\(tasks.count)")
                    dataRow("Conversation Messages", "\(conversationHistory.count)")
                } else {
                    Text("No active project selected")
                        .foregroundStyle(.secondary)
                }
            }
            .padding()
        }
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

    // MARK: - Build Mode Cards

    private var projectOverviewCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Project Workspace")
                .font(.headline)
            if let activeProject {
                HStack {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(activeProject.name).font(.title3.weight(.semibold))
                        Text(activeProject.summary ?? "No summary yet")
                            .foregroundStyle(.secondary)
                    }
                    Spacer()
                    Menu {
                        ForEach(projectStatuses, id: \.self) { status in
                            Button(status.capitalized) {
                                updateActiveProjectStatus(status)
                            }
                        }
                    } label: {
                        Text(activeProject.status.capitalized)
                            .font(.caption.weight(.semibold))
                            .padding(.horizontal, 8)
                            .padding(.vertical, 5)
                            .background(Color.orange.opacity(0.15))
                            .clipShape(Capsule())
                    }
                }
            } else {
                Text("Create or select a project to begin.")
                    .foregroundStyle(.secondary)
            }
        }
        .padding()
        .background(Color(.secondarySystemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 12))
    }

    private var guardrailsCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Guardrails")
                .font(.headline)

            Toggle(
                "Enable guardrails for destructive operations",
                isOn: Binding(
                    get: { activeProject?.guardrailsEnabled ?? true },
                    set: { updateActiveProjectFlags(guardrailsEnabled: $0) }
                )
            )

            Toggle(
                "Require plan approval before destructive changes",
                isOn: Binding(
                    get: { activeProject?.requirePlanApproval ?? true },
                    set: { updateActiveProjectFlags(requirePlanApproval: $0) }
                )
            )
        }
        .padding()
        .background(Color(.secondarySystemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 12))
    }

    private var tasksCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Milestones & Tasks")
                .font(.headline)

            if tasks.isEmpty {
                Text("No tasks yet. Prompts and feedback create tasks automatically.")
                    .foregroundStyle(.secondary)
                    .font(.caption)
            } else {
                ForEach(Array(tasks.prefix(8)), id: \.id) { task in
                    HStack(alignment: .top) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(task.title).font(.subheadline.weight(.medium))
                            Text(task.details ?? task.source)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        Spacer()
                        Text(task.status)
                            .font(.caption2)
                            .padding(.horizontal, 6)
                            .padding(.vertical, 3)
                            .background(Color.gray.opacity(0.2))
                            .clipShape(Capsule())
                    }
                }
            }
        }
        .padding()
        .background(Color(.secondarySystemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 12))
    }

    private var revisionsCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Revisions")
                .font(.headline)

            if revisions.isEmpty {
                Text("No revisions yet. Sending a build prompt creates a draft revision.")
                    .foregroundStyle(.secondary)
                    .font(.caption)
            } else {
                ForEach(Array(revisions.prefix(10)), id: \.id) { revision in
                    VStack(alignment: .leading, spacing: 8) {
                        HStack {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(revision.summary)
                                    .font(.subheadline.weight(.semibold))
                                Text("\(revision.status.capitalized) • \(relativeTime(revision.createdAt))")
                                    .font(.caption2)
                                    .foregroundStyle(.secondary)
                            }
                            Spacer()
                            if (revision.status == "draft" || revision.status == "ready"), revision.afterSnapshot != nil {
                                Button("Promote") {
                                    promoteRevision(revision)
                                }
                                .buttonStyle(.borderedProminent)
                                .controlSize(.small)
                                Button("Discard", role: .destructive) {
                                    discardRevision(revision)
                                }
                                .buttonStyle(.bordered)
                                .controlSize(.small)
                            } else if revision.status == "draft" {
                                Text("In progress")
                                    .font(.caption2)
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }
                    .padding(10)
                    .background(Color(.tertiarySystemBackground))
                    .clipShape(RoundedRectangle(cornerRadius: 10))
                }
            }
        }
        .padding()
        .background(Color(.secondarySystemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 12))
    }

    private var feedbackCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Structured Feedback")
                .font(.headline)

            TextField("What should change?", text: $feedbackWhat)
                .textFieldStyle(.roundedBorder)
            TextField("Why does this need to change?", text: $feedbackWhy)
                .textFieldStyle(.roundedBorder)
            TextField("Target screen (optional)", text: $feedbackTargetScreen)
                .textFieldStyle(.roundedBorder)
            Picker("Severity", selection: $feedbackSeverity) {
                ForEach(feedbackSeverities, id: \.self) { severity in
                    Text(severity.capitalized).tag(severity)
                }
            }
            .pickerStyle(.segmented)

            Button("Submit Feedback") {
                submitStructuredFeedback()
            }
            .buttonStyle(.borderedProminent)
            .disabled(feedbackWhat.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || feedbackWhy.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)

            if !feedbackItems.isEmpty {
                Divider().padding(.vertical, 4)
                ForEach(Array(feedbackItems.prefix(8)), id: \.id) { item in
                    HStack(alignment: .top) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("[\(item.severity.uppercased())] \(item.what)")
                                .font(.subheadline.weight(.medium))
                            Text(item.why)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                            if let target = item.targetScreen, !target.isEmpty {
                                Text("Target: \(target)")
                                    .font(.caption2)
                                    .foregroundStyle(.secondary)
                            }
                        }
                        Spacer()
                        Menu(item.status.capitalized) {
                            Button("Open") { updateFeedbackStatus(item, status: "open") }
                            Button("Applied") { updateFeedbackStatus(item, status: "applied") }
                            Button("Rejected") { updateFeedbackStatus(item, status: "rejected") }
                        }
                    }
                }
            }
        }
        .padding()
        .background(Color(.secondarySystemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 12))
    }

    private var conversationCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("Conversation History")
                    .font(.headline)
                Spacer()
                Button("Clear") {
                    clearConversationHistory()
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
            }

            Toggle(
                "Use conversation history for context",
                isOn: Binding(
                    get: { activeProject?.useConversationContext ?? true },
                    set: { updateActiveProjectFlags(useConversationContext: $0) }
                )
            )

            TextField("Search conversation history", text: $conversationSearchQuery)
                .textFieldStyle(.roundedBorder)

            if filteredConversationHistory.isEmpty {
                Text("No conversation history for this project.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else {
                ForEach(Array(filteredConversationHistory.prefix(12)), id: \.id) { message in
                    VStack(alignment: .leading, spacing: 2) {
                        Text("[\(message.role.uppercased())] \(message.content)")
                            .font(.caption)
                            .lineLimit(3)
                        Text(relativeTime(message.createdAt))
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(8)
                    .background(Color(.tertiarySystemBackground))
                    .clipShape(RoundedRectangle(cornerRadius: 8))
                }
            }
        }
        .padding()
        .background(Color(.secondarySystemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 12))
    }

    // MARK: - Project Manager

    private var projectManagerView: some View {
        NavigationStack {
            VStack(spacing: 12) {
                HStack {
                    TextField("New project name", text: $newProjectName)
                        .textFieldStyle(.roundedBorder)
                    Button("Create") {
                        createProject()
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(newProjectName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
                .padding(.horizontal)

                List(projects) { project in
                    Button(action: {
                        if let pendingTurn, pendingTurn.projectId != project.id {
                            appendLog(level: "guardrail", "Cannot switch projects while a build request is still running")
                            return
                        }
                        activeProjectId = project.id
                        showProjectManager = false
                    }) {
                        VStack(alignment: .leading, spacing: 4) {
                            HStack {
                                Text(project.name)
                                    .font(.headline)
                                if project.id == activeProjectId {
                                    Image(systemName: "checkmark.circle.fill")
                                        .foregroundStyle(.green)
                                }
                            }
                            Text(project.summary ?? "No summary")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                            Text("\(project.status.capitalized) • Updated \(relativeTime(project.updatedAt))")
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                        }
                    }
                }
            }
            .navigationTitle("Projects")
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") {
                        showProjectManager = false
                    }
                }
            }
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

    private var inputArea: some View {
        HStack {
            TextField("Build or improve this app by...", text: $inputText)
                .textFieldStyle(.roundedBorder)
                .onSubmit { sendMessage() }

            Button(action: sendMessage) {
                Image(systemName: "paperplane.fill")
                    .foregroundColor(.white)
                    .padding(10)
                    .background(inputText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? Color.gray : Color.orange)
                    .clipShape(Circle())
            }
            .disabled(inputText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
        .padding()
        .background(Color(.systemBackground))
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

        if pendingTurn != nil {
            appendLog(level: "guardrail", "A build request is already running. Wait for it to complete before sending another.")
            return
        }

        inputText = ""

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
            appendLog(level: "tool", "Tool call: \(name)")
        case .toolResult(let name, let output, let isError):
            appendLog(level: isError ? "error" : "tool", "Tool result (\(name)): \(output.prefix(120))")
        case .complete(let text):
            Task {
                await finalizePendingRevisionAndTask(success: true, output: text)
            }
            appendLog(level: "agent", "Agent completed response")
        case .error(let message):
            Task {
                await finalizePendingRevisionAndTask(success: false, output: message)
            }
            appendLog(level: "error", "Agent error: \(message)")
        case .ready:
            appendLog(level: "system", "Agent is ready")
        case .chunk:
            break
        case .streamStart:
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
        if action == "input_submit",
           let dict = payload as? [String: String],
           let value = dict["value"] {
            inputText = value
            sendMessage()
            return
        }
        if let payload = payload as? String {
            agent.send("\(action): \(payload)")
        } else {
            agent.send(action)
        }
    }

    // MARK: - Project/Revision/Feedback Actions

    private func createProject() {
        let trimmed = newProjectName.trimmingCharacters(in: .whitespacesAndNewlines)
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
            let created = try DatabaseManager.shared.ensureDefaultProject()
            projects = [created]
            activeProjectId = created.id
            return
        }
        projects = loaded
        if activeProjectId == nil || !loaded.contains(where: { $0.id == activeProjectId }) {
            activeProjectId = loaded.first?.id
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

    private func dataRow(_ key: String, _ value: String) -> some View {
        HStack {
            Text(key)
                .font(.subheadline.weight(.semibold))
            Spacer()
            Text(value)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.trailing)
        }
        .padding(.vertical, 2)
    }

    private func appendLog(level: String, _ message: String) {
        activityLog.append(ActivityLogEntry(level: level, message: message))
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

Primary goals:
1. Turn user requests into runnable mini-apps/workflows.
2. Improve existing apps from user feedback.
3. Keep state in SQLite and reusable SDUI templates.
4. Use project-scoped revisions and conversation history as available context.

Tool strategy:
- Use `query_views` first to discover existing templates/data.
- Use `register_view` to define reusable screens.
- Use `show_view` to navigate and render actual experiences.
- Use `update_view_data` for iterative updates.
- Use `update_template` when the user asks for layout/style/interaction changes.
- Use `sqlite_query` for `apps`, `app_revisions`, `feedback_items`, `app_tasks`, and `conversation_messages`.
- Use shell/file tools to generate and modify code/assets when needed.

Workflow:
1. Clarify what to build with a focused UI form or prompt.
2. Show a plan with milestones and current status.
3. Build in small increments and surface each result in the UI using Preview mode.
4. Ask for structured feedback (what/why/severity/target) and apply improvements immediately.
5. Record a draft revision for each substantial change, then promote or discard as directed.
6. Persist the app specification and latest state so future requests continue from where it left off.

UI conventions:
- Prefer a clean single-column layout unless the user requests a grid.
- Use concise labels and obvious actions.
- Always include a clear "Revise" or "Improve" path once something is generated.
- Respect guardrails: for destructive actions, provide a short plan and await explicit confirmation.

When starting a new conversation:
- Greet briefly.
- Ask what app/workflow the user wants to create or improve.
- Offer quick starters (for example: dashboard, form-based tool, data browser, automation assistant).
"""

// MARK: - Preview

#Preview {
    SuperAppView()
}
