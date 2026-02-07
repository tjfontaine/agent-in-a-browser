import Foundation
import GRDB
import OSLog

// MARK: - Super App Workspace Models

struct SuperAppProject: Identifiable, Hashable {
    let id: String
    var name: String
    var status: String
    var summary: String?
    var lastPrompt: String?
    var currentRevisionId: String?
    var useConversationContext: Bool
    var guardrailsEnabled: Bool
    var requirePlanApproval: Bool
    let createdAt: Date
    var updatedAt: Date
}

struct SuperAppRevision: Identifiable, Hashable {
    let id: String
    let appId: String
    var summary: String
    var status: String
    var beforeSnapshot: String?
    var afterSnapshot: String?
    var guardrailNotes: String?
    let createdAt: Date
    var promotedAt: Date?
}

struct SuperAppFeedback: Identifiable, Hashable {
    let id: String
    let appId: String
    let revisionId: String?
    var what: String
    var why: String
    var severity: String
    var targetScreen: String?
    var status: String
    let createdAt: Date
}

struct SuperAppTask: Identifiable, Hashable {
    let id: String
    let appId: String
    var title: String
    var details: String?
    var status: String
    var source: String
    let createdAt: Date
    var updatedAt: Date
}

struct ConversationHistoryItem: Identifiable, Hashable {
    let id: String
    let appId: String
    let role: String
    let content: String
    let tags: [String]
    let createdAt: Date
}

/// Manages SQLite database for view templates and app state persistence using GRDB
/// GRDB is thread-safe, so no @MainActor needed
public final class DatabaseManager: @unchecked Sendable {
    
    public static let shared = DatabaseManager()
    
    private var dbQueue: DatabaseQueue?
    private let dbPath: URL
    
    // MARK: - Initialization
    
    private init() {
        let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first!
        dbPath = docs.appendingPathComponent("edge_agent.db")
        Log.app.info("DatabaseManager: Database path: \(dbPath.path)")
    }
    
    /// Ensure the database is initialized (lazy initialization for direct queries)
    private func ensureInitialized() throws -> DatabaseQueue {
        if let dbQueue = dbQueue {
            return dbQueue
        }
        
        // Lazy synchronous initialization
        Log.app.info("DatabaseManager: Lazy-initializing database...")
        let queue = try DatabaseQueue(path: dbPath.path)
        
        try queue.write { db in
            try db.execute(sql: """
                CREATE TABLE IF NOT EXISTS view_templates (
                    name TEXT PRIMARY KEY,
                    version TEXT NOT NULL,
                    template TEXT NOT NULL,
                    default_data TEXT,
                    animation TEXT,
                    created_at TEXT DEFAULT (datetime('now')),
                    updated_at TEXT DEFAULT (datetime('now'))
                )
            """)
            
            try db.execute(sql: """
                CREATE TABLE IF NOT EXISTS navigation_history (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    view_name TEXT NOT NULL,
                    data TEXT,
                    scroll_offset REAL,
                    timestamp TEXT DEFAULT (datetime('now'))
                )
            """)
            
            try db.execute(sql: """
                CREATE TABLE IF NOT EXISTS app_state (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL,
                    updated_at TEXT DEFAULT (datetime('now'))
                )
            """)
            
            try db.execute(sql: """
                CREATE TABLE IF NOT EXISTS data_cache (
                    key TEXT PRIMARY KEY,
                    data TEXT NOT NULL,
                    expires_at TEXT,
                    created_at TEXT DEFAULT (datetime('now'))
                )
            """)
            
            try db.execute(sql: """
                CREATE TABLE IF NOT EXISTS agent_memory (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    category TEXT NOT NULL,
                    content TEXT NOT NULL,
                    metadata TEXT,
                    created_at TEXT DEFAULT (datetime('now'))
                )
            """)

            // Super app projects/workspaces
            try db.execute(sql: """
                CREATE TABLE IF NOT EXISTS apps (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    status TEXT NOT NULL,
                    summary TEXT,
                    last_prompt TEXT,
                    current_revision_id TEXT,
                    use_conversation_context INTEGER NOT NULL DEFAULT 1,
                    guardrails_enabled INTEGER NOT NULL DEFAULT 1,
                    require_plan_approval INTEGER NOT NULL DEFAULT 1,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                )
            """)

            // Revision timeline for promote/discard workflow
            try db.execute(sql: """
                CREATE TABLE IF NOT EXISTS app_revisions (
                    id TEXT PRIMARY KEY,
                    app_id TEXT NOT NULL,
                    summary TEXT NOT NULL,
                    status TEXT NOT NULL,
                    before_snapshot TEXT,
                    after_snapshot TEXT,
                    guardrail_notes TEXT,
                    created_at TEXT NOT NULL,
                    promoted_at TEXT
                )
            """)

            // Structured user feedback records
            try db.execute(sql: """
                CREATE TABLE IF NOT EXISTS feedback_items (
                    id TEXT PRIMARY KEY,
                    app_id TEXT NOT NULL,
                    revision_id TEXT,
                    what TEXT NOT NULL,
                    why TEXT NOT NULL,
                    severity TEXT NOT NULL,
                    target_screen TEXT,
                    status TEXT NOT NULL,
                    created_at TEXT NOT NULL
                )
            """)

            // Task queue/milestone tracking
            try db.execute(sql: """
                CREATE TABLE IF NOT EXISTS app_tasks (
                    id TEXT PRIMARY KEY,
                    app_id TEXT NOT NULL,
                    title TEXT NOT NULL,
                    details TEXT,
                    status TEXT NOT NULL,
                    source TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                )
            """)

            // Conversation history per app for search/context injection
            try db.execute(sql: """
                CREATE TABLE IF NOT EXISTS conversation_messages (
                    id TEXT PRIMARY KEY,
                    app_id TEXT NOT NULL,
                    role TEXT NOT NULL,
                    content TEXT NOT NULL,
                    tags TEXT,
                    created_at TEXT NOT NULL
                )
            """)
            
            try db.execute(sql: "CREATE INDEX IF NOT EXISTS idx_nav_history_timestamp ON navigation_history(timestamp DESC)")
            try db.execute(sql: "CREATE INDEX IF NOT EXISTS idx_agent_memory_category ON agent_memory(category)")
            try db.execute(sql: "CREATE INDEX IF NOT EXISTS idx_data_cache_expires ON data_cache(expires_at)")
            try db.execute(sql: "CREATE INDEX IF NOT EXISTS idx_apps_updated_at ON apps(updated_at DESC)")
            try db.execute(sql: "CREATE INDEX IF NOT EXISTS idx_revisions_app_created ON app_revisions(app_id, created_at DESC)")
            try db.execute(sql: "CREATE INDEX IF NOT EXISTS idx_feedback_app_created ON feedback_items(app_id, created_at DESC)")
            try db.execute(sql: "CREATE INDEX IF NOT EXISTS idx_tasks_app_updated ON app_tasks(app_id, updated_at DESC)")
            try db.execute(sql: "CREATE INDEX IF NOT EXISTS idx_conversation_app_created ON conversation_messages(app_id, created_at DESC)")
        }
        
        dbQueue = queue
        Log.app.info("DatabaseManager: Lazy initialization complete")
        return queue
    }
    
    // MARK: - Database Setup
    
    /// Initialize the database with schema
    public func initializeDatabase() async throws {
        Log.app.info("DatabaseManager: Initializing database...")
        
        do {
            dbQueue = try DatabaseQueue(path: dbPath.path)
            
            try await dbQueue?.write { db in
                // View templates (cached UI structures)
                try db.execute(sql: """
                    CREATE TABLE IF NOT EXISTS view_templates (
                        name TEXT PRIMARY KEY,
                        version TEXT NOT NULL,
                        template TEXT NOT NULL,
                        default_data TEXT,
                        animation TEXT,
                        created_at TEXT DEFAULT (datetime('now')),
                        updated_at TEXT DEFAULT (datetime('now'))
                    )
                """)
                
                // Navigation history (for back navigation and analytics)
                try db.execute(sql: """
                    CREATE TABLE IF NOT EXISTS navigation_history (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        view_name TEXT NOT NULL,
                        data TEXT,
                        scroll_offset REAL,
                        timestamp TEXT DEFAULT (datetime('now'))
                    )
                """)
                
                // App state (arbitrary key-value persistence)
                try db.execute(sql: """
                    CREATE TABLE IF NOT EXISTS app_state (
                        key TEXT PRIMARY KEY,
                        value TEXT NOT NULL,
                        updated_at TEXT DEFAULT (datetime('now'))
                    )
                """)
                
                // Cached data (for offline/prefetch scenarios)
                try db.execute(sql: """
                    CREATE TABLE IF NOT EXISTS data_cache (
                        key TEXT PRIMARY KEY,
                        data TEXT NOT NULL,
                        expires_at TEXT,
                        created_at TEXT DEFAULT (datetime('now'))
                    )
                """)
                
                // Agent memory (cross-session context)
                try db.execute(sql: """
                    CREATE TABLE IF NOT EXISTS agent_memory (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        category TEXT NOT NULL,
                        content TEXT NOT NULL,
                        metadata TEXT,
                        created_at TEXT DEFAULT (datetime('now'))
                    )
                """)

                // Super app projects/workspaces
                try db.execute(sql: """
                    CREATE TABLE IF NOT EXISTS apps (
                        id TEXT PRIMARY KEY,
                        name TEXT NOT NULL,
                        status TEXT NOT NULL,
                        summary TEXT,
                        last_prompt TEXT,
                        current_revision_id TEXT,
                        use_conversation_context INTEGER NOT NULL DEFAULT 1,
                        guardrails_enabled INTEGER NOT NULL DEFAULT 1,
                        require_plan_approval INTEGER NOT NULL DEFAULT 1,
                        created_at TEXT NOT NULL,
                        updated_at TEXT NOT NULL
                    )
                """)

                // Revision timeline for promote/discard workflow
                try db.execute(sql: """
                    CREATE TABLE IF NOT EXISTS app_revisions (
                        id TEXT PRIMARY KEY,
                        app_id TEXT NOT NULL,
                        summary TEXT NOT NULL,
                        status TEXT NOT NULL,
                        before_snapshot TEXT,
                        after_snapshot TEXT,
                        guardrail_notes TEXT,
                        created_at TEXT NOT NULL,
                        promoted_at TEXT
                    )
                """)

                // Structured user feedback records
                try db.execute(sql: """
                    CREATE TABLE IF NOT EXISTS feedback_items (
                        id TEXT PRIMARY KEY,
                        app_id TEXT NOT NULL,
                        revision_id TEXT,
                        what TEXT NOT NULL,
                        why TEXT NOT NULL,
                        severity TEXT NOT NULL,
                        target_screen TEXT,
                        status TEXT NOT NULL,
                        created_at TEXT NOT NULL
                    )
                """)

                // Task queue/milestone tracking
                try db.execute(sql: """
                    CREATE TABLE IF NOT EXISTS app_tasks (
                        id TEXT PRIMARY KEY,
                        app_id TEXT NOT NULL,
                        title TEXT NOT NULL,
                        details TEXT,
                        status TEXT NOT NULL,
                        source TEXT NOT NULL,
                        created_at TEXT NOT NULL,
                        updated_at TEXT NOT NULL
                    )
                """)

                // Conversation history per app for search/context injection
                try db.execute(sql: """
                    CREATE TABLE IF NOT EXISTS conversation_messages (
                        id TEXT PRIMARY KEY,
                        app_id TEXT NOT NULL,
                        role TEXT NOT NULL,
                        content TEXT NOT NULL,
                        tags TEXT,
                        created_at TEXT NOT NULL
                    )
                """)
                
                // Create indexes
                try db.execute(sql: "CREATE INDEX IF NOT EXISTS idx_nav_history_timestamp ON navigation_history(timestamp DESC)")
                try db.execute(sql: "CREATE INDEX IF NOT EXISTS idx_agent_memory_category ON agent_memory(category)")
                try db.execute(sql: "CREATE INDEX IF NOT EXISTS idx_data_cache_expires ON data_cache(expires_at)")
                try db.execute(sql: "CREATE INDEX IF NOT EXISTS idx_apps_updated_at ON apps(updated_at DESC)")
                try db.execute(sql: "CREATE INDEX IF NOT EXISTS idx_revisions_app_created ON app_revisions(app_id, created_at DESC)")
                try db.execute(sql: "CREATE INDEX IF NOT EXISTS idx_feedback_app_created ON feedback_items(app_id, created_at DESC)")
                try db.execute(sql: "CREATE INDEX IF NOT EXISTS idx_tasks_app_updated ON app_tasks(app_id, updated_at DESC)")
                try db.execute(sql: "CREATE INDEX IF NOT EXISTS idx_conversation_app_created ON conversation_messages(app_id, created_at DESC)")
            }
            
            Log.app.info("DatabaseManager: Database initialized successfully")
        } catch {
            Log.app.error("DatabaseManager: Failed to initialize database: \(error)")
            throw DatabaseError.initializationFailed(error.localizedDescription)
        }
    }
    
    // MARK: - View Templates
    
    /// Save a view template to the database
    func saveViewTemplate(_ template: ViewTemplate) throws {
        let dbQueue = try ensureInitialized()
        
        let animationJSON: String?
        if let animation = template.animation {
            let dict: [String: Any] = [
                "enter": animation.enter ?? "",
                "exit": animation.exit ?? "",
                "duration": animation.duration ?? 0.3
            ]
            if let data = try? JSONSerialization.data(withJSONObject: dict) {
                animationJSON = String(data: data, encoding: .utf8)
            } else {
                animationJSON = nil
            }
        } else {
            animationJSON = nil
        }
        
        let dateFormatter = ISO8601DateFormatter()
        
        try dbQueue.write { db in
            try db.execute(
                sql: """
                    INSERT OR REPLACE INTO view_templates 
                    (name, version, template, default_data, animation, created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                arguments: [
                    template.name,
                    template.version,
                    template.template,
                    template.defaultData,
                    animationJSON,
                    dateFormatter.string(from: template.createdAt),
                    dateFormatter.string(from: template.updatedAt)
                ]
            )
        }
        
        Log.app.info("DatabaseManager: Saved template '\(template.name)' v\(template.version)")
    }
    
    /// Load all view templates from the database
    func loadViewTemplates() throws -> [String: ViewTemplate] {
        let dbQueue = try ensureInitialized()
        
        let rows = try dbQueue.read { db in
            try Row.fetchAll(db, sql: "SELECT * FROM view_templates")
        }
        
        var templates: [String: ViewTemplate] = [:]
        let dateFormatter = ISO8601DateFormatter()
        
        for row in rows {
            let name: String = row["name"]
            let version: String = row["version"]
            let template: String = row["template"]
            let defaultData: String? = row["default_data"]
            let animationStr: String? = row["animation"]
            let createdAtStr: String? = row["created_at"]
            let updatedAtStr: String? = row["updated_at"]
            
            var animation: ViewAnimation? = nil
            if let animationStr = animationStr,
               let animData = animationStr.data(using: .utf8),
               let animDict = try? JSONSerialization.jsonObject(with: animData) as? [String: Any] {
                animation = ViewAnimation(
                    enter: animDict["enter"] as? String,
                    exit: animDict["exit"] as? String,
                    duration: animDict["duration"] as? Double
                )
            }
            
            let createdAt = createdAtStr.flatMap { dateFormatter.date(from: $0) } ?? Date()
            let updatedAt = updatedAtStr.flatMap { dateFormatter.date(from: $0) } ?? Date()
            
            let viewTemplate = ViewTemplate(
                name: name,
                version: version,
                template: template,
                defaultData: defaultData,
                animation: animation,
                createdAt: createdAt,
                updatedAt: updatedAt
            )
            
            templates[name] = viewTemplate
        }
        
        Log.app.info("DatabaseManager: Loaded \(templates.count) templates")
        return templates
    }

    /// Delete a single view template by name
    func deleteViewTemplate(name: String) throws {
        let dbQueue = try ensureInitialized()
        try dbQueue.write { db in
            try db.execute(
                sql: "DELETE FROM view_templates WHERE name = ?",
                arguments: [name]
            )
        }
    }

    /// Remove all cached view templates
    func clearViewTemplates() throws {
        let dbQueue = try ensureInitialized()
        try dbQueue.write { db in
            try db.execute(sql: "DELETE FROM view_templates")
        }
    }

    // MARK: - Super App Projects

    func ensureDefaultProject() throws -> SuperAppProject {
        let existing = try listProjects()
        if let first = existing.first {
            return first
        }
        return try createProject(name: "Default Workspace", summary: "Primary super app workspace")
    }

    func listProjects() throws -> [SuperAppProject] {
        let dbQueue = try ensureInitialized()
        let rows = try dbQueue.read { db in
            try Row.fetchAll(db, sql: "SELECT * FROM apps ORDER BY updated_at DESC")
        }
        return rows.compactMap { row in
            project(from: row)
        }
    }

    func getProject(id: String) throws -> SuperAppProject? {
        let dbQueue = try ensureInitialized()
        let row = try dbQueue.read { db in
            try Row.fetchOne(db, sql: "SELECT * FROM apps WHERE id = ?", arguments: [id])
        }
        guard let row else { return nil }
        return project(from: row)
    }

    @discardableResult
    func createProject(name: String, summary: String?) throws -> SuperAppProject {
        let dbQueue = try ensureInitialized()
        let now = iso8601Now()
        let id = UUID().uuidString
        try dbQueue.write { db in
            try db.execute(
                sql: """
                    INSERT INTO apps
                    (id, name, status, summary, last_prompt, current_revision_id, use_conversation_context, guardrails_enabled, require_plan_approval, created_at, updated_at)
                    VALUES (?, ?, ?, ?, NULL, NULL, 1, 1, 1, ?, ?)
                """,
                arguments: [id, name, "active", summary, now, now]
            )
        }
        return try getProject(id: id) ?? SuperAppProject(
            id: id,
            name: name,
            status: "active",
            summary: summary,
            lastPrompt: nil,
            currentRevisionId: nil,
            useConversationContext: true,
            guardrailsEnabled: true,
            requirePlanApproval: true,
            createdAt: Date(),
            updatedAt: Date()
        )
    }

    func updateProject(
        id: String,
        name: String? = nil,
        status: String? = nil,
        summary: String? = nil,
        lastPrompt: String? = nil,
        currentRevisionId: String? = nil
    ) throws {
        guard var project = try getProject(id: id) else { return }
        if let name { project.name = name }
        if let status { project.status = status }
        if let summary { project.summary = summary }
        if let lastPrompt { project.lastPrompt = lastPrompt }
        if let currentRevisionId { project.currentRevisionId = currentRevisionId }
        try persistProject(project)
    }

    func updateProjectFlags(
        id: String,
        useConversationContext: Bool? = nil,
        guardrailsEnabled: Bool? = nil,
        requirePlanApproval: Bool? = nil
    ) throws {
        guard var project = try getProject(id: id) else { return }
        if let useConversationContext { project.useConversationContext = useConversationContext }
        if let guardrailsEnabled { project.guardrailsEnabled = guardrailsEnabled }
        if let requirePlanApproval { project.requirePlanApproval = requirePlanApproval }
        try persistProject(project)
    }

    private func persistProject(_ project: SuperAppProject) throws {
        let dbQueue = try ensureInitialized()
        let now = iso8601Now()
        try dbQueue.write { db in
            try db.execute(
                sql: """
                    UPDATE apps
                    SET name = ?, status = ?, summary = ?, last_prompt = ?, current_revision_id = ?,
                        use_conversation_context = ?, guardrails_enabled = ?, require_plan_approval = ?, updated_at = ?
                    WHERE id = ?
                """,
                arguments: [
                    project.name,
                    project.status,
                    project.summary,
                    project.lastPrompt,
                    project.currentRevisionId,
                    project.useConversationContext ? 1 : 0,
                    project.guardrailsEnabled ? 1 : 0,
                    project.requirePlanApproval ? 1 : 0,
                    now,
                    project.id,
                ]
            )
        }
    }

    // MARK: - Revisions

    @discardableResult
    func createRevision(
        appId: String,
        summary: String,
        status: String = "draft",
        beforeSnapshot: String?,
        afterSnapshot: String?,
        guardrailNotes: String?
    ) throws -> SuperAppRevision {
        let dbQueue = try ensureInitialized()
        let id = UUID().uuidString
        let now = iso8601Now()
        try dbQueue.write { db in
            try db.execute(
                sql: """
                    INSERT INTO app_revisions
                    (id, app_id, summary, status, before_snapshot, after_snapshot, guardrail_notes, created_at, promoted_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
                """,
                arguments: [id, appId, summary, status, beforeSnapshot, afterSnapshot, guardrailNotes, now]
            )
        }
        return try getRevision(id: id) ?? SuperAppRevision(
            id: id,
            appId: appId,
            summary: summary,
            status: status,
            beforeSnapshot: beforeSnapshot,
            afterSnapshot: afterSnapshot,
            guardrailNotes: guardrailNotes,
            createdAt: Date(),
            promotedAt: nil
        )
    }

    func getRevision(id: String) throws -> SuperAppRevision? {
        let dbQueue = try ensureInitialized()
        let row = try dbQueue.read { db in
            try Row.fetchOne(db, sql: "SELECT * FROM app_revisions WHERE id = ?", arguments: [id])
        }
        guard let row else { return nil }
        return revision(from: row)
    }

    func listRevisions(appId: String, limit: Int = 50) throws -> [SuperAppRevision] {
        let dbQueue = try ensureInitialized()
        let rows = try dbQueue.read { db in
            try Row.fetchAll(
                db,
                sql: "SELECT * FROM app_revisions WHERE app_id = ? ORDER BY created_at DESC LIMIT ?",
                arguments: [appId, limit]
            )
        }
        return rows.compactMap { row in
            revision(from: row)
        }
    }

    func updateRevisionStatus(id: String, status: String, promoted: Bool = false) throws {
        let dbQueue = try ensureInitialized()
        let promotedAt = promoted ? iso8601Now() : nil
        try dbQueue.write { db in
            try db.execute(
                sql: "UPDATE app_revisions SET status = ?, promoted_at = COALESCE(?, promoted_at) WHERE id = ?",
                arguments: [status, promotedAt, id]
            )
        }
    }

    func setRevisionAfterSnapshot(id: String, snapshot: String?) throws {
        let dbQueue = try ensureInitialized()
        try dbQueue.write { db in
            try db.execute(
                sql: "UPDATE app_revisions SET after_snapshot = ? WHERE id = ?",
                arguments: [snapshot, id]
            )
        }
    }

    // MARK: - Structured Feedback

    @discardableResult
    func createFeedback(
        appId: String,
        revisionId: String?,
        what: String,
        why: String,
        severity: String,
        targetScreen: String?,
        status: String = "open"
    ) throws -> SuperAppFeedback {
        let dbQueue = try ensureInitialized()
        let id = UUID().uuidString
        let now = iso8601Now()
        try dbQueue.write { db in
            try db.execute(
                sql: """
                    INSERT INTO feedback_items
                    (id, app_id, revision_id, what, why, severity, target_screen, status, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                arguments: [id, appId, revisionId, what, why, severity, targetScreen, status, now]
            )
        }
        return try getFeedback(id: id) ?? SuperAppFeedback(
            id: id,
            appId: appId,
            revisionId: revisionId,
            what: what,
            why: why,
            severity: severity,
            targetScreen: targetScreen,
            status: status,
            createdAt: Date()
        )
    }

    func getFeedback(id: String) throws -> SuperAppFeedback? {
        let dbQueue = try ensureInitialized()
        let row = try dbQueue.read { db in
            try Row.fetchOne(db, sql: "SELECT * FROM feedback_items WHERE id = ?", arguments: [id])
        }
        guard let row else { return nil }
        return feedback(from: row)
    }

    func listFeedback(appId: String, limit: Int = 200) throws -> [SuperAppFeedback] {
        let dbQueue = try ensureInitialized()
        let rows = try dbQueue.read { db in
            try Row.fetchAll(
                db,
                sql: "SELECT * FROM feedback_items WHERE app_id = ? ORDER BY created_at DESC LIMIT ?",
                arguments: [appId, limit]
            )
        }
        return rows.compactMap { row in
            feedback(from: row)
        }
    }

    func updateFeedbackStatus(id: String, status: String) throws {
        let dbQueue = try ensureInitialized()
        try dbQueue.write { db in
            try db.execute(
                sql: "UPDATE feedback_items SET status = ? WHERE id = ?",
                arguments: [status, id]
            )
        }
    }

    // MARK: - Task Queue

    @discardableResult
    func createTask(
        appId: String,
        title: String,
        details: String?,
        status: String,
        source: String
    ) throws -> SuperAppTask {
        let dbQueue = try ensureInitialized()
        let id = UUID().uuidString
        let now = iso8601Now()
        try dbQueue.write { db in
            try db.execute(
                sql: """
                    INSERT INTO app_tasks
                    (id, app_id, title, details, status, source, created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                arguments: [id, appId, title, details, status, source, now, now]
            )
        }
        return try getTask(id: id) ?? SuperAppTask(
            id: id,
            appId: appId,
            title: title,
            details: details,
            status: status,
            source: source,
            createdAt: Date(),
            updatedAt: Date()
        )
    }

    func getTask(id: String) throws -> SuperAppTask? {
        let dbQueue = try ensureInitialized()
        let row = try dbQueue.read { db in
            try Row.fetchOne(db, sql: "SELECT * FROM app_tasks WHERE id = ?", arguments: [id])
        }
        guard let row else { return nil }
        return task(from: row)
    }

    func listTasks(appId: String, limit: Int = 200) throws -> [SuperAppTask] {
        let dbQueue = try ensureInitialized()
        let rows = try dbQueue.read { db in
            try Row.fetchAll(
                db,
                sql: "SELECT * FROM app_tasks WHERE app_id = ? ORDER BY updated_at DESC LIMIT ?",
                arguments: [appId, limit]
            )
        }
        return rows.compactMap { row in
            task(from: row)
        }
    }

    func updateTaskStatus(id: String, status: String) throws {
        let dbQueue = try ensureInitialized()
        let now = iso8601Now()
        try dbQueue.write { db in
            try db.execute(
                sql: "UPDATE app_tasks SET status = ?, updated_at = ? WHERE id = ?",
                arguments: [status, now, id]
            )
        }
    }

    // MARK: - Conversation History

    @discardableResult
    func appendConversationMessage(
        appId: String,
        role: String,
        content: String,
        tags: [String]
    ) throws -> ConversationHistoryItem {
        let dbQueue = try ensureInitialized()
        let id = UUID().uuidString
        let now = iso8601Now()
        let tagsJSON = try String(data: JSONEncoder().encode(tags), encoding: .utf8)
        try dbQueue.write { db in
            try db.execute(
                sql: """
                    INSERT INTO conversation_messages
                    (id, app_id, role, content, tags, created_at)
                    VALUES (?, ?, ?, ?, ?, ?)
                """,
                arguments: [id, appId, role, content, tagsJSON, now]
            )
        }
        return try getConversationMessage(id: id) ?? ConversationHistoryItem(
            id: id,
            appId: appId,
            role: role,
            content: content,
            tags: tags,
            createdAt: Date()
        )
    }

    func getConversationMessage(id: String) throws -> ConversationHistoryItem? {
        let dbQueue = try ensureInitialized()
        let row = try dbQueue.read { db in
            try Row.fetchOne(db, sql: "SELECT * FROM conversation_messages WHERE id = ?", arguments: [id])
        }
        guard let row else { return nil }
        return conversationMessage(from: row)
    }

    func listConversationMessages(appId: String, limit: Int = 300) throws -> [ConversationHistoryItem] {
        let dbQueue = try ensureInitialized()
        let rows = try dbQueue.read { db in
            try Row.fetchAll(
                db,
                sql: "SELECT * FROM conversation_messages WHERE app_id = ? ORDER BY created_at DESC LIMIT ?",
                arguments: [appId, limit]
            )
        }
        return rows.compactMap { row in
            conversationMessage(from: row)
        }
    }

    func searchConversationMessages(appId: String, query: String, limit: Int = 20) throws -> [ConversationHistoryItem] {
        let dbQueue = try ensureInitialized()
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            return try listConversationMessages(appId: appId, limit: limit)
        }
        let pattern = "%\(trimmed)%"
        let rows = try dbQueue.read { db in
            try Row.fetchAll(
                db,
                sql: """
                    SELECT * FROM conversation_messages
                    WHERE app_id = ?
                      AND (content LIKE ? OR tags LIKE ?)
                    ORDER BY created_at DESC
                    LIMIT ?
                """,
                arguments: [appId, pattern, pattern, limit]
            )
        }
        return rows.compactMap { row in
            conversationMessage(from: row)
        }
    }

    func clearConversationMessages(appId: String) throws {
        let dbQueue = try ensureInitialized()
        try dbQueue.write { db in
            try db.execute(
                sql: "DELETE FROM conversation_messages WHERE app_id = ?",
                arguments: [appId]
            )
        }
    }
    
    // MARK: - App State
    
    /// Save app state value
    func saveAppState(key: String, value: String) throws {
        guard let dbQueue = dbQueue else {
            throw DatabaseError.initializationFailed("Database not initialized")
        }
        
        try dbQueue.write { db in
            try db.execute(
                sql: """
                    INSERT OR REPLACE INTO app_state (key, value, updated_at)
                    VALUES (?, ?, datetime('now'))
                """,
                arguments: [key, value]
            )
        }
    }
    
    /// Load app state value
    func loadAppState(key: String) throws -> String? {
        guard let dbQueue = dbQueue else {
            return nil
        }
        
        return try dbQueue.read { db in
            try String.fetchOne(db, sql: "SELECT value FROM app_state WHERE key = ?", arguments: [key])
        }
    }
    
    /// Load all app state
    func loadAllAppState() throws -> [String: String] {
        guard let dbQueue = dbQueue else {
            return [:]
        }
        
        let rows = try dbQueue.read { db in
            try Row.fetchAll(db, sql: "SELECT key, value FROM app_state")
        }
        
        var state: [String: String] = [:]
        for row in rows {
            let key: String = row["key"]
            let value: String = row["value"]
            state[key] = value
        }
        return state
    }
    
    // MARK: - Agent Memory
    
    /// Save agent memory entry
    func saveAgentMemory(category: String, content: String, metadata: String?) throws {
        guard let dbQueue = dbQueue else {
            throw DatabaseError.initializationFailed("Database not initialized")
        }
        
        try dbQueue.write { db in
            try db.execute(
                sql: """
                    INSERT INTO agent_memory (category, content, metadata, created_at)
                    VALUES (?, ?, ?, datetime('now'))
                """,
                arguments: [category, content, metadata]
            )
        }
    }
    
    /// Load agent memories by category
    func loadAgentMemories(category: String, limit: Int = 100) throws -> [[String: Any]] {
        guard let dbQueue = dbQueue else {
            return []
        }
        
        let rows = try dbQueue.read { db in
            try Row.fetchAll(
                db,
                sql: "SELECT * FROM agent_memory WHERE category = ? ORDER BY created_at DESC LIMIT ?",
                arguments: [category, limit]
            )
        }
        
        return rows.map { row -> [String: Any] in
            var dict: [String: Any] = [
                "id": row["id"] as Int,
                "category": row["category"] as String,
                "content": row["content"] as String,
                "created_at": row["created_at"] as String? ?? ""
            ]
            if let metadata: String = row["metadata"] {
                dict["metadata"] = metadata
            }
            return dict
        }
    }
    
    // MARK: - Query Execution
    
    /// Execute arbitrary SQL query with parameter binding
    /// Returns results as array of dictionaries for SELECT, or row metadata for INSERT/UPDATE/DELETE
    func executeQuery(sql: String, params: [Any]) throws -> [[String: Any]] {
        let queue = try ensureInitialized()
        
        // Convert params to DatabaseValueConvertible
        let arguments = StatementArguments(params.map { param -> DatabaseValue in
            if let str = param as? String {
                return str.databaseValue
            } else if let int = param as? Int {
                return int.databaseValue
            } else if let double = param as? Double {
                return double.databaseValue
            } else if let bool = param as? Bool {
                return bool.databaseValue
            } else if param is NSNull {
                return .null
            } else {
                return String(describing: param).databaseValue
            }
        })
        
        let sqlLower = sql.lowercased().trimmingCharacters(in: .whitespaces)
        
        if sqlLower.hasPrefix("select") {
            // SELECT query - return results
            let rows = try queue.read { db in
                try Row.fetchAll(db, sql: sql, arguments: arguments)
            }
            
            return rows.map { row -> [String: Any] in
                var dict: [String: Any] = [:]
                for column in row.columnNames {
                    if let value = row[column] {
                        dict[column] = value
                    }
                }
                return dict
            }
        } else {
            // INSERT/UPDATE/DELETE - execute and return metadata
            try queue.write { db in
                try db.execute(sql: sql, arguments: arguments)
            }
            return [["success": true, "sql": sql]]
        }
    }
    
    // MARK: - Helpers

    private func iso8601Now() -> String {
        ISO8601DateFormatter().string(from: Date())
    }

    private func parseDate(_ raw: String?) -> Date {
        guard let raw else { return Date() }

        let iso = ISO8601DateFormatter()
        if let date = iso.date(from: raw) {
            return date
        }

        let sql = DateFormatter()
        sql.locale = Locale(identifier: "en_US_POSIX")
        sql.timeZone = TimeZone(secondsFromGMT: 0)
        sql.dateFormat = "yyyy-MM-dd HH:mm:ss"
        if let date = sql.date(from: raw) {
            return date
        }

        return Date()
    }

    private func parseOptionalDate(_ raw: String?) -> Date? {
        guard let raw else { return nil }

        let iso = ISO8601DateFormatter()
        if let date = iso.date(from: raw) {
            return date
        }

        let sql = DateFormatter()
        sql.locale = Locale(identifier: "en_US_POSIX")
        sql.timeZone = TimeZone(secondsFromGMT: 0)
        sql.dateFormat = "yyyy-MM-dd HH:mm:ss"
        if let date = sql.date(from: raw) {
            return date
        }

        return nil
    }

    private func decodeTags(_ raw: String?) -> [String] {
        guard let raw,
              let data = raw.data(using: .utf8),
              let tags = try? JSONDecoder().decode([String].self, from: data) else {
            return []
        }
        return tags
    }

    private func project(from row: Row) -> SuperAppProject? {
        let id: String? = row["id"]
        let name: String? = row["name"]
        let status: String? = row["status"]
        guard let id, let name, let status else { return nil }

        let summary: String? = row["summary"]
        let lastPrompt: String? = row["last_prompt"]
        let currentRevisionId: String? = row["current_revision_id"]
        let useConversationContext: Int = row["use_conversation_context"]
        let guardrailsEnabled: Int = row["guardrails_enabled"]
        let requirePlanApproval: Int = row["require_plan_approval"]
        let createdAt: String? = row["created_at"]
        let updatedAt: String? = row["updated_at"]

        return SuperAppProject(
            id: id,
            name: name,
            status: status,
            summary: summary,
            lastPrompt: lastPrompt,
            currentRevisionId: currentRevisionId,
            useConversationContext: useConversationContext != 0,
            guardrailsEnabled: guardrailsEnabled != 0,
            requirePlanApproval: requirePlanApproval != 0,
            createdAt: parseDate(createdAt),
            updatedAt: parseDate(updatedAt)
        )
    }

    private func revision(from row: Row) -> SuperAppRevision? {
        let id: String? = row["id"]
        let appId: String? = row["app_id"]
        let summary: String? = row["summary"]
        let status: String? = row["status"]
        guard let id, let appId, let summary, let status else { return nil }

        let beforeSnapshot: String? = row["before_snapshot"]
        let afterSnapshot: String? = row["after_snapshot"]
        let guardrailNotes: String? = row["guardrail_notes"]
        let createdAt: String? = row["created_at"]
        let promotedAt: String? = row["promoted_at"]

        return SuperAppRevision(
            id: id,
            appId: appId,
            summary: summary,
            status: status,
            beforeSnapshot: beforeSnapshot,
            afterSnapshot: afterSnapshot,
            guardrailNotes: guardrailNotes,
            createdAt: parseDate(createdAt),
            promotedAt: parseOptionalDate(promotedAt)
        )
    }

    private func feedback(from row: Row) -> SuperAppFeedback? {
        let id: String? = row["id"]
        let appId: String? = row["app_id"]
        let what: String? = row["what"]
        let why: String? = row["why"]
        let severity: String? = row["severity"]
        let status: String? = row["status"]
        guard let id, let appId, let what, let why, let severity, let status else { return nil }

        let revisionId: String? = row["revision_id"]
        let targetScreen: String? = row["target_screen"]
        let createdAt: String? = row["created_at"]

        return SuperAppFeedback(
            id: id,
            appId: appId,
            revisionId: revisionId,
            what: what,
            why: why,
            severity: severity,
            targetScreen: targetScreen,
            status: status,
            createdAt: parseDate(createdAt)
        )
    }

    private func task(from row: Row) -> SuperAppTask? {
        let id: String? = row["id"]
        let appId: String? = row["app_id"]
        let title: String? = row["title"]
        let status: String? = row["status"]
        let source: String? = row["source"]
        guard let id, let appId, let title, let status, let source else { return nil }

        let details: String? = row["details"]
        let createdAt: String? = row["created_at"]
        let updatedAt: String? = row["updated_at"]

        return SuperAppTask(
            id: id,
            appId: appId,
            title: title,
            details: details,
            status: status,
            source: source,
            createdAt: parseDate(createdAt),
            updatedAt: parseDate(updatedAt)
        )
    }

    private func conversationMessage(from row: Row) -> ConversationHistoryItem? {
        let id: String? = row["id"]
        let appId: String? = row["app_id"]
        let role: String? = row["role"]
        let content: String? = row["content"]
        guard let id, let appId, let role, let content else { return nil }

        let tagsRaw: String? = row["tags"]
        let createdAt: String? = row["created_at"]
        return ConversationHistoryItem(
            id: id,
            appId: appId,
            role: role,
            content: content,
            tags: decodeTags(tagsRaw),
            createdAt: parseDate(createdAt)
        )
    }
    
    private func escapeSql(_ str: String) -> String {
        return str.replacingOccurrences(of: "'", with: "''")
    }
}

// MARK: - Errors

public enum DatabaseError: Error, LocalizedError {
    case initializationFailed(String)
    case queryFailed(String)
    
    public var errorDescription: String? {
        switch self {
        case .initializationFailed(let reason):
            return "Database initialization failed: \(reason)"
        case .queryFailed(let reason):
            return "Database query failed: \(reason)"
        }
    }
}
