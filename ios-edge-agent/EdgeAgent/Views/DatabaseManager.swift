import Foundation
import GRDB
import OSLog

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
            
            try db.execute(sql: "CREATE INDEX IF NOT EXISTS idx_nav_history_timestamp ON navigation_history(timestamp DESC)")
            try db.execute(sql: "CREATE INDEX IF NOT EXISTS idx_agent_memory_category ON agent_memory(category)")
            try db.execute(sql: "CREATE INDEX IF NOT EXISTS idx_data_cache_expires ON data_cache(expires_at)")
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
                
                // Create indexes
                try db.execute(sql: "CREATE INDEX IF NOT EXISTS idx_nav_history_timestamp ON navigation_history(timestamp DESC)")
                try db.execute(sql: "CREATE INDEX IF NOT EXISTS idx_agent_memory_category ON agent_memory(category)")
                try db.execute(sql: "CREATE INDEX IF NOT EXISTS idx_data_cache_expires ON data_cache(expires_at)")
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
        guard let dbQueue = dbQueue else {
            throw DatabaseError.initializationFailed("Database not initialized")
        }
        
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
        guard let dbQueue = dbQueue else {
            return [:]
        }
        
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
