import Foundation
import GRDB
import OSLog

/// Repository for app-scoped bundle artifacts. All methods use
/// `DatabaseManager.shared` for DB access — no separate connection needed.
struct AppBundleRepository {

    // MARK: - App Templates

    @discardableResult
    func saveAppTemplate(
        appId: String,
        name: String,
        version: String,
        template: String,
        defaultData: String? = nil,
        animation: String? = nil
    ) throws -> AppTemplateRecord {
        let dbQueue = try DatabaseManager.shared.getDatabase()
        let now = ISO8601DateFormatter().string(from: Date())
        let id = "\(appId):\(name)"

        try dbQueue.write { db in
            try db.execute(
                sql: """
                    INSERT OR REPLACE INTO app_templates
                    (id, app_id, name, version, template, default_data, animation,
                     created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?,
                            COALESCE((SELECT created_at FROM app_templates WHERE id = ?), ?), ?)
                """,
                arguments: [id, appId, name, version, template, defaultData, animation,
                            id, now, now]
            )
        }

        Log.app.info("AppBundleRepository: Saved template '\(name)' for app \(appId)")
        return AppTemplateRecord(
            id: id, appId: appId, name: name, version: version,
            template: template, defaultData: defaultData, animation: animation,
            createdAt: Date(), updatedAt: Date()
        )
    }

    func getAppTemplate(appId: String, name: String) throws -> AppTemplateRecord? {
        let dbQueue = try DatabaseManager.shared.getDatabase()
        let row = try dbQueue.read { db in
            try Row.fetchOne(
                db,
                sql: "SELECT * FROM app_templates WHERE app_id = ? AND name = ?",
                arguments: [appId, name]
            )
        }
        guard let row else { return nil }
        return appTemplate(from: row)
    }

    func listAppTemplates(appId: String) throws -> [AppTemplateRecord] {
        let dbQueue = try DatabaseManager.shared.getDatabase()
        let rows = try dbQueue.read { db in
            try Row.fetchAll(
                db,
                sql: "SELECT * FROM app_templates WHERE app_id = ? ORDER BY updated_at DESC",
                arguments: [appId]
            )
        }
        return rows.compactMap { appTemplate(from: $0) }
    }

    func deleteAppTemplate(appId: String, name: String) throws {
        let dbQueue = try DatabaseManager.shared.getDatabase()
        try dbQueue.write { db in
            try db.execute(
                sql: "DELETE FROM app_templates WHERE app_id = ? AND name = ?",
                arguments: [appId, name]
            )
        }
        Log.app.info("AppBundleRepository: Deleted template '\(name)' for app \(appId)")
    }

    func deleteAllAppTemplates(appId: String) throws {
        let dbQueue = try DatabaseManager.shared.getDatabase()
        try dbQueue.write { db in
            try db.execute(
                sql: "DELETE FROM app_templates WHERE app_id = ?",
                arguments: [appId]
            )
        }
    }

    // MARK: - App Scripts

    @discardableResult
    func saveAppScript(
        appId: String,
        name: String,
        source: String,
        description: String? = nil,
        capabilities: [String] = [],
        version: String = "1.0.0"
    ) throws -> AppScriptRecord {
        try DatabaseManager.validateScriptName(name)

        let dbQueue = try DatabaseManager.shared.getDatabase()
        let now = ISO8601DateFormatter().string(from: Date())
        let id = "\(appId):\(name)"

        let capsJSON: String? = capabilities.isEmpty ? nil : {
            if let data = try? JSONSerialization.data(withJSONObject: capabilities) {
                return String(data: data, encoding: .utf8)
            }
            return nil
        }()

        try dbQueue.write { db in
            try db.execute(
                sql: """
                    INSERT OR REPLACE INTO app_scripts
                    (id, app_id, name, description, source, required_capabilities,
                     version, created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?,
                            ?, COALESCE((SELECT created_at FROM app_scripts WHERE id = ?), ?), ?)
                """,
                arguments: [id, appId, name, description, source, capsJSON,
                            version, id, now, now]
            )

            // Write script to sandbox filesystem for WASM import resolution
            try DatabaseManager.shared.writeScriptToAppSandbox(appId: appId, name: name, source: source)
        }

        Log.app.info("AppBundleRepository: Saved script '\(name)' v\(version) for app \(appId)")
        return AppScriptRecord(
            id: id, appId: appId, name: name, description: description,
            source: source, requiredCapabilities: capabilities,
            metadata: nil, version: version,
            createdAt: Date(), updatedAt: Date()
        )
    }

    func getAppScript(appId: String, name: String) throws -> AppScriptRecord? {
        let dbQueue = try DatabaseManager.shared.getDatabase()
        let row = try dbQueue.read { db in
            try Row.fetchOne(
                db,
                sql: "SELECT * FROM app_scripts WHERE app_id = ? AND name = ?",
                arguments: [appId, name]
            )
        }
        guard let row else { return nil }
        return appScript(from: row)
    }

    func listAppScripts(appId: String) throws -> [AppScriptRecord] {
        let dbQueue = try DatabaseManager.shared.getDatabase()
        let rows = try dbQueue.read { db in
            try Row.fetchAll(
                db,
                sql: "SELECT * FROM app_scripts WHERE app_id = ? ORDER BY updated_at DESC",
                arguments: [appId]
            )
        }
        return rows.compactMap { appScript(from: $0) }
    }

    func deleteAppScript(appId: String, name: String) throws {
        let dbQueue = try DatabaseManager.shared.getDatabase()
        try dbQueue.write { db in
            try db.execute(
                sql: "DELETE FROM app_scripts WHERE app_id = ? AND name = ?",
                arguments: [appId, name]
            )
        }
        DatabaseManager.shared.removeScriptFromAppSandbox(appId: appId, name: name)
        Log.app.info("AppBundleRepository: Deleted script '\(name)' for app \(appId)")
    }

    func deleteAllAppScripts(appId: String) throws {
        let existing = try listAppScripts(appId: appId)
        let dbQueue = try DatabaseManager.shared.getDatabase()
        try dbQueue.write { db in
            try db.execute(
                sql: "DELETE FROM app_scripts WHERE app_id = ?",
                arguments: [appId]
            )
        }
        for script in existing {
            DatabaseManager.shared.removeScriptFromAppSandbox(appId: appId, name: script.name)
        }
    }

    // MARK: - Bundle Revisions

    @discardableResult
    func saveBundleRevision(
        appId: String,
        status: BundleRevisionStatus = .draft,
        summary: String? = nil,
        bundleJSON: String
    ) throws -> BundleRevisionRecord {
        let dbQueue = try DatabaseManager.shared.getDatabase()
        let id = UUID().uuidString
        let now = ISO8601DateFormatter().string(from: Date())

        try dbQueue.write { db in
            try db.execute(
                sql: """
                    INSERT INTO app_bundle_revisions
                    (id, app_id, status, summary, bundle_json, created_at)
                    VALUES (?, ?, ?, ?, ?, ?)
                """,
                arguments: [id, appId, status.rawValue, summary, bundleJSON, now]
            )
        }

        Log.app.info("AppBundleRepository: Saved revision \(id) (\(status.rawValue)) for app \(appId)")
        return BundleRevisionRecord(
            id: id, appId: appId, status: status,
            summary: summary, bundleJSON: bundleJSON,
            createdAt: Date(), promotedAt: nil
        )
    }

    func getBundleRevision(id: String, appId: String? = nil) throws -> BundleRevisionRecord? {
        let dbQueue = try DatabaseManager.shared.getDatabase()
        let row: Row? = try dbQueue.read { db in
            if let appId {
                return try Row.fetchOne(
                    db,
                    sql: "SELECT * FROM app_bundle_revisions WHERE id = ? AND app_id = ?",
                    arguments: [id, appId]
                )
            }
            return try Row.fetchOne(
                db,
                sql: "SELECT * FROM app_bundle_revisions WHERE id = ?",
                arguments: [id]
            )
        }
        guard let row else { return nil }
        return bundleRevision(from: row)
    }

    func listBundleRevisions(appId: String) throws -> [BundleRevisionRecord] {
        let dbQueue = try DatabaseManager.shared.getDatabase()
        let rows = try dbQueue.read { db in
            try Row.fetchAll(
                db,
                sql: "SELECT * FROM app_bundle_revisions WHERE app_id = ? ORDER BY created_at DESC",
                arguments: [appId]
            )
        }
        return rows.compactMap { bundleRevision(from: $0) }
    }

    func promoteBundleRevision(id: String) throws {
        let dbQueue = try DatabaseManager.shared.getDatabase()
        let now = ISO8601DateFormatter().string(from: Date())

        try dbQueue.write { db in
            try db.execute(
                sql: "UPDATE app_bundle_revisions SET status = ?, promoted_at = ? WHERE id = ?",
                arguments: [BundleRevisionStatus.promoted.rawValue, now, id]
            )
        }
        Log.app.info("AppBundleRepository: Promoted revision \(id)")
    }

    func getLatestPromotedRevision(appId: String) throws -> BundleRevisionRecord? {
        let dbQueue = try DatabaseManager.shared.getDatabase()
        let row = try dbQueue.read { db in
            try Row.fetchOne(
                db,
                sql: """
                    SELECT * FROM app_bundle_revisions
                    WHERE app_id = ? AND status = ?
                    ORDER BY promoted_at DESC LIMIT 1
                """,
                arguments: [appId, BundleRevisionStatus.promoted.rawValue]
            )
        }
        guard let row else { return nil }
        return bundleRevision(from: row)
    }

    // MARK: - Runs

    @discardableResult
    func saveRun(
        appId: String,
        revisionId: String,
        entrypoint: String,
        status: RunStatus = .running
    ) throws -> RunRecord {
        let dbQueue = try DatabaseManager.shared.getDatabase()
        let id = UUID().uuidString
        let now = ISO8601DateFormatter().string(from: Date())

        try dbQueue.write { db in
            try db.execute(
                sql: """
                    INSERT INTO app_runs
                    (id, app_id, revision_id, entrypoint, status, started_at)
                    VALUES (?, ?, ?, ?, ?, ?)
                """,
                arguments: [id, appId, revisionId, entrypoint, status.rawValue, now]
            )
        }

        return RunRecord(
            id: id, appId: appId, revisionId: revisionId,
            entrypoint: entrypoint, status: status,
            failureSignature: nil, startedAt: Date(), endedAt: nil
        )
    }

    func updateRunStatus(id: String, status: RunStatus, failureSignature: String? = nil) throws {
        let dbQueue = try DatabaseManager.shared.getDatabase()
        let now = ISO8601DateFormatter().string(from: Date())
        let endedAt: String? = (status == .running || status == .repairing) ? nil : now

        try dbQueue.write { db in
            try db.execute(
                sql: """
                    UPDATE app_runs
                    SET status = ?, failure_signature = ?, ended_at = ?
                    WHERE id = ?
                """,
                arguments: [status.rawValue, failureSignature, endedAt, id]
            )
        }
    }

    func getRun(id: String) throws -> RunRecord? {
        let dbQueue = try DatabaseManager.shared.getDatabase()
        let row = try dbQueue.read { db in
            try Row.fetchOne(
                db,
                sql: "SELECT * FROM app_runs WHERE id = ?",
                arguments: [id]
            )
        }
        guard let row else { return nil }
        return runRecord(from: row)
    }

    // MARK: - Repair Attempts

    @discardableResult
    func saveRepairAttempt(
        runId: String,
        appId: String,
        revisionId: String,
        attemptNo: Int,
        patchSummary: String? = nil,
        outcome: RepairOutcome
    ) throws -> RepairAttemptRecord {
        let dbQueue = try DatabaseManager.shared.getDatabase()
        let id = UUID().uuidString
        let now = ISO8601DateFormatter().string(from: Date())

        try dbQueue.write { db in
            try db.execute(
                sql: """
                    INSERT INTO app_repair_attempts
                    (id, run_id, app_id, revision_id, attempt_no, patch_summary, outcome, started_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                arguments: [id, runId, appId, revisionId, attemptNo, patchSummary, outcome.rawValue, now]
            )
        }

        return RepairAttemptRecord(
            id: id, runId: runId, appId: appId, revisionId: revisionId,
            attemptNo: attemptNo, patchSummary: patchSummary, outcome: outcome,
            startedAt: Date(), endedAt: nil
        )
    }

    func listRepairAttempts(runId: String) throws -> [RepairAttemptRecord] {
        let dbQueue = try DatabaseManager.shared.getDatabase()
        let rows = try dbQueue.read { db in
            try Row.fetchAll(
                db,
                sql: "SELECT * FROM app_repair_attempts WHERE run_id = ? ORDER BY attempt_no",
                arguments: [runId]
            )
        }
        return rows.compactMap { repairAttempt(from: $0) }
    }

    func updateRepairAttempt(
        runId: String,
        attemptNo: Int,
        outcome: RepairOutcome,
        patchSummary: String? = nil
    ) throws {
        let dbQueue = try DatabaseManager.shared.getDatabase()
        let now = ISO8601DateFormatter().string(from: Date())
        try dbQueue.write { db in
            try db.execute(
                sql: """
                    UPDATE app_repair_attempts
                    SET outcome = ?, patch_summary = COALESCE(?, patch_summary), ended_at = ?
                    WHERE run_id = ? AND attempt_no = ?
                """,
                arguments: [outcome.rawValue, patchSummary, now, runId, attemptNo]
            )
        }
    }

    // MARK: - Row Parsers

    private func appTemplate(from row: Row) -> AppTemplateRecord? {
        let id: String? = row["id"]
        let appId: String? = row["app_id"]
        let name: String? = row["name"]
        let version: String? = row["version"]
        let template: String? = row["template"]
        guard let id, let appId, let name, let version, let template else { return nil }

        return AppTemplateRecord(
            id: id, appId: appId, name: name, version: version,
            template: template,
            defaultData: row["default_data"],
            animation: row["animation"],
            createdAt: DatabaseManager.shared.parseDate(row["created_at"]),
            updatedAt: DatabaseManager.shared.parseDate(row["updated_at"])
        )
    }

    private func appScript(from row: Row) -> AppScriptRecord? {
        let id: String? = row["id"]
        let appId: String? = row["app_id"]
        let name: String? = row["name"]
        let source: String? = row["source"]
        guard let id, let appId, let name, let source else { return nil }

        let capsRaw: String? = row["required_capabilities"]
        var caps: [String] = []
        if let capsRaw,
           let data = capsRaw.data(using: .utf8),
           let decoded = try? JSONSerialization.jsonObject(with: data) as? [String] {
            caps = decoded
        }

        return AppScriptRecord(
            id: id, appId: appId, name: name,
            description: row["description"],
            source: source,
            requiredCapabilities: caps,
            metadata: row["metadata"],
            version: row["version"] ?? "1.0.0",
            createdAt: DatabaseManager.shared.parseDate(row["created_at"]),
            updatedAt: DatabaseManager.shared.parseDate(row["updated_at"])
        )
    }

    private func bundleRevision(from row: Row) -> BundleRevisionRecord? {
        let id: String? = row["id"]
        let appId: String? = row["app_id"]
        let status: String? = row["status"]
        let bundleJSON: String? = row["bundle_json"]
        guard let id, let appId, let status, let bundleJSON,
              let statusEnum = BundleRevisionStatus(rawValue: status) else { return nil }

        return BundleRevisionRecord(
            id: id, appId: appId, status: statusEnum,
            summary: row["summary"],
            bundleJSON: bundleJSON,
            createdAt: DatabaseManager.shared.parseDate(row["created_at"]),
            promotedAt: {
                let promoted: String? = row["promoted_at"]
                return promoted.map { DatabaseManager.shared.parseDate($0) }
            }()
        )
    }

    private func runRecord(from row: Row) -> RunRecord? {
        let id: String? = row["id"]
        let appId: String? = row["app_id"]
        let revisionId: String? = row["revision_id"]
        let entrypoint: String? = row["entrypoint"]
        let status: String? = row["status"]
        guard let id, let appId, let revisionId, let entrypoint, let status,
              let statusEnum = RunStatus(rawValue: status) else { return nil }

        return RunRecord(
            id: id, appId: appId, revisionId: revisionId,
            entrypoint: entrypoint, status: statusEnum,
            failureSignature: row["failure_signature"],
            startedAt: DatabaseManager.shared.parseDate(row["started_at"]),
            endedAt: {
                let ended: String? = row["ended_at"]
                return ended.map { DatabaseManager.shared.parseDate($0) }
            }()
        )
    }

    private func repairAttempt(from row: Row) -> RepairAttemptRecord? {
        let id: String? = row["id"]
        let runId: String? = row["run_id"]
        let appId: String? = row["app_id"]
        let revisionId: String? = row["revision_id"]
        let outcome: String? = row["outcome"]
        guard let id, let runId, let appId, let revisionId, let outcome,
              let outcomeEnum = RepairOutcome(rawValue: outcome) else { return nil }

        let attemptNo: Int = row["attempt_no"] ?? 0

        return RepairAttemptRecord(
            id: id, runId: runId, appId: appId, revisionId: revisionId,
            attemptNo: attemptNo,
            patchSummary: row["patch_summary"],
            outcome: outcomeEnum,
            startedAt: DatabaseManager.shared.parseDate(row["started_at"]),
            endedAt: {
                let ended: String? = row["ended_at"]
                return ended.map { DatabaseManager.shared.parseDate($0) }
            }()
        )
    }

    // MARK: - Bindings (Phase 3)

    @discardableResult
    func saveAppBinding(
        appId: String,
        id: String,
        template: String,
        componentPath: String,
        actionJSON: String
    ) throws -> AppBindingRecord {
        let dbQueue = try DatabaseManager.shared.getDatabase()
        let now = ISO8601DateFormatter().string(from: Date())
        let storageId = namespacedBindingId(appId: appId, id: id)

        try dbQueue.write { db in
            try db.execute(
                sql: """
                    INSERT OR REPLACE INTO app_bindings
                    (id, app_id, template, component_path, action_json, created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, COALESCE((SELECT created_at FROM app_bindings WHERE id = ?), ?), ?)
                """,
                arguments: [storageId, appId, template, componentPath, actionJSON, storageId, now, now]
            )
        }
        Log.app.info("AppBundleRepository: Saved binding '\(id)' for app \(appId)")
        return AppBindingRecord(
            id: id, appId: appId, template: template,
            componentPath: componentPath, actionJSON: actionJSON,
            createdAt: Date(), updatedAt: Date()
        )
    }

    func listAppBindings(appId: String) throws -> [AppBindingRecord] {
        let dbQueue = try DatabaseManager.shared.getDatabase()
        let rows = try dbQueue.read { db in
            try Row.fetchAll(
                db,
                sql: "SELECT * FROM app_bindings WHERE app_id = ? ORDER BY template, component_path",
                arguments: [appId]
            )
        }
        return rows.compactMap { appBinding(from: $0) }
    }

    func deleteAppBinding(id: String, appId: String? = nil) throws {
        let dbQueue = try DatabaseManager.shared.getDatabase()
        try dbQueue.write { db in
            if let appId {
                try db.execute(
                    sql: "DELETE FROM app_bindings WHERE app_id = ? AND id IN (?, ?)",
                    arguments: [appId, id, namespacedBindingId(appId: appId, id: id)]
                )
            } else {
                try db.execute(
                    sql: "DELETE FROM app_bindings WHERE id = ?",
                    arguments: [id]
                )
            }
        }
    }

    func deleteAllAppBindings(appId: String) throws {
        let dbQueue = try DatabaseManager.shared.getDatabase()
        try dbQueue.write { db in
            try db.execute(
                sql: "DELETE FROM app_bindings WHERE app_id = ?",
                arguments: [appId]
            )
        }
    }

    func clearAppArtifacts(appId: String) throws {
        // Clear bindings/templates/scripts so restores are deterministic.
        try deleteAllAppBindings(appId: appId)
        try deleteAllAppTemplates(appId: appId)
        try deleteAllAppScripts(appId: appId)
    }

    private func appBinding(from row: Row) -> AppBindingRecord? {
        let storageId: String? = row["id"]
        let appId: String? = row["app_id"]
        let template: String? = row["template"]
        let componentPath: String? = row["component_path"]
        let actionJSON: String? = row["action_json"]
        guard let storageId, let appId, let template, let componentPath, let actionJSON else { return nil }

        let prefix = "\(appId):"
        let id = storageId.hasPrefix(prefix) ? String(storageId.dropFirst(prefix.count)) : storageId

        return AppBindingRecord(
            id: id, appId: appId, template: template,
            componentPath: componentPath, actionJSON: actionJSON,
            createdAt: DatabaseManager.shared.parseDate(row["created_at"]),
            updatedAt: DatabaseManager.shared.parseDate(row["updated_at"])
        )
    }

    private func namespacedBindingId(appId: String, id: String) -> String {
        "\(appId):\(id)"
    }

    // MARK: - Permission Audit (Phase 4)

    func logPermissionAudit(
        appId: String,
        scriptName: String,
        capability: String,
        action: String,
        actor: String
    ) throws {
        let dbQueue = try DatabaseManager.shared.getDatabase()
        let id = UUID().uuidString
        let now = ISO8601DateFormatter().string(from: Date())

        try dbQueue.write { db in
            try db.execute(
                sql: """
                    INSERT INTO app_permission_audit
                    (id, app_id, script_name, capability, action, actor, timestamp)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                arguments: [id, appId, scriptName, capability, action, actor, now]
            )
        }
        Log.app.info("PermissionAudit: \(action) '\(capability)' for \(scriptName) in app \(appId)")
    }

    func listPermissionAudits(appId: String, limit: Int = 100) throws -> [PermissionAuditRecord] {
        let dbQueue = try DatabaseManager.shared.getDatabase()
        let rows = try dbQueue.read { db in
            try Row.fetchAll(
                db,
                sql: "SELECT * FROM app_permission_audit WHERE app_id = ? ORDER BY timestamp DESC LIMIT ?",
                arguments: [appId, limit]
            )
        }
        return rows.compactMap { permissionAudit(from: $0) }
    }

    private func permissionAudit(from row: Row) -> PermissionAuditRecord? {
        let id: String? = row["id"]
        let appId: String? = row["app_id"]
        let scriptName: String? = row["script_name"]
        let capability: String? = row["capability"]
        let action: String? = row["action"]
        let actor: String? = row["actor"]
        guard let id, let appId, let scriptName, let capability, let action, let actor else { return nil }

        return PermissionAuditRecord(
            id: id, appId: appId, scriptName: scriptName,
            capability: capability, action: action, actor: actor,
            timestamp: DatabaseManager.shared.parseDate(row["timestamp"])
        )
    }
}
