import Foundation
import WASIShims
import OSLog

// MARK: - App Bundle (Codable v1 schema)

/// Top-level bundle artifact. Encodes the complete state of an app for
/// snapshotting, revision storage, and import/export.
struct AppBundle: Codable {
    let schemaVersion: String
    var manifest: AppManifest
    var templates: [BundleTemplate]
    var scripts: [BundleScript]
    var bindings: [BundleBinding]
    var policy: BundlePolicy

    init(
        manifest: AppManifest,
        templates: [BundleTemplate] = [],
        scripts: [BundleScript] = [],
        bindings: [BundleBinding] = [],
        policy: BundlePolicy = BundlePolicy()
    ) {
        self.schemaVersion = "1.0.0"
        self.manifest = manifest
        self.templates = templates
        self.scripts = scripts
        self.bindings = bindings
        self.policy = policy
    }
}

// MARK: - Manifest

struct AppManifest: Codable {
    var appId: String
    let bundleVersion: String
    var entrypoints: [String: AppEntrypoint]
    var repairPolicy: RepairPolicy

    init(
        appId: String,
        bundleVersion: String = "1.0.0",
        entrypoints: [String: AppEntrypoint] = [:],
        repairPolicy: RepairPolicy = RepairPolicy()
    ) {
        self.appId = appId
        self.bundleVersion = bundleVersion
        self.entrypoints = entrypoints
        self.repairPolicy = repairPolicy
    }
}

struct AppEntrypoint: Codable {
    let script: String
    let action: String
}

struct RepairPolicy: Codable {
    var enabled: Bool
    var maxAttempts: Int
    var timeBudgetMs: Int
    var allowedSurfaces: [String]
    var disallowedOps: [String]

    init(
        enabled: Bool = true,
        maxAttempts: Int = 2,
        timeBudgetMs: Int = 30000,
        allowedSurfaces: [String] = ["template_patch", "script_patch", "binding_patch"],
        disallowedOps: [String] = ["sql_schema_change", "permission_auto_grant"]
    ) {
        self.enabled = enabled
        self.maxAttempts = maxAttempts
        self.timeBudgetMs = timeBudgetMs
        self.allowedSurfaces = allowedSurfaces
        self.disallowedOps = disallowedOps
    }
}

// MARK: - Bundle Template

struct BundleTemplate: Codable {
    let name: String
    let version: String
    let template: AnyCodable   // JSON object — component tree
    var defaultData: AnyCodable?

    init(name: String, version: String, template: [String: Any], defaultData: [String: Any]? = nil) {
        self.name = name
        self.version = version
        self.template = AnyCodable(template)
        self.defaultData = defaultData.map { AnyCodable($0) }
    }
}

// MARK: - Bundle Script

struct BundleScript: Codable {
    let name: String
    let version: String
    let source: String
    var description: String?
    var requiredCapabilities: [String]?

    init(name: String, version: String, source: String, description: String? = nil, requiredCapabilities: [String]? = nil) {
        self.name = name
        self.version = version
        self.source = source
        self.description = description
        self.requiredCapabilities = requiredCapabilities
    }
}

// MARK: - Bundle Binding

struct BundleBinding: Codable {
    let id: String
    let template: String
    let componentPath: String
    let action: BundleAction
}

struct BundleAction: Codable {
    let type: String           // e.g. "run_script"
    var script: String?
    var scriptAction: String?
    var args: [String]?
}

// MARK: - Bundle Policy

struct BundlePolicy: Codable {
    var grants: [String]
    var lastUpdatedAt: String

    init(grants: [String] = [], lastUpdatedAt: String? = nil) {
        self.grants = grants
        self.lastUpdatedAt = lastUpdatedAt ?? ISO8601DateFormatter().string(from: Date())
    }
}

// MARK: - Assembly

extension AppBundle {
    /// Return a copy of this bundle retargeted to a new app id.
    func retargeted(to appId: String) -> AppBundle {
        var copy = self
        copy.manifest.appId = appId
        return copy
    }

    /// Build a bundle snapshot from the current app-scoped DB state.
    /// Includes templates, scripts, bindings, and policy grants.
    static func build(appId: String) throws -> AppBundle {
        let repo = AppBundleRepository()

        let templateRecords = try repo.listAppTemplates(appId: appId)
        let scriptRecords = try repo.listAppScripts(appId: appId)
        let bindingRecords = try repo.listAppBindings(appId: appId)

        let templates: [BundleTemplate] = templateRecords.map { rec in
            let tmpl = (try? JSONSerialization.jsonObject(with: Data(rec.template.utf8))) as? [String: Any] ?? [:]
            let dd: [String: Any]? = rec.defaultData.flatMap {
                (try? JSONSerialization.jsonObject(with: Data($0.utf8))) as? [String: Any]
            }
            return BundleTemplate(name: rec.name, version: rec.version, template: tmpl, defaultData: dd)
        }

        let scripts: [BundleScript] = scriptRecords.map { rec in
            BundleScript(
                name: rec.name,
                version: rec.version,
                source: rec.source,
                description: rec.description,
                requiredCapabilities: rec.requiredCapabilities.isEmpty ? nil : rec.requiredCapabilities
            )
        }

        let bindings: [BundleBinding] = bindingRecords.compactMap { rec in
            guard let actionData = rec.actionJSON.data(using: .utf8),
                  let action = try? JSONDecoder().decode(BundleAction.self, from: actionData) else {
                return nil
            }
            return BundleBinding(id: rec.id, template: rec.template, componentPath: rec.componentPath, action: action)
        }

        // Snapshot current permission grants for this app
        let grants = ScriptPermissions.shared.listGrants(forApp: appId)
        let policy = BundlePolicy(grants: grants)

        let manifest = AppManifest(appId: appId)
        return AppBundle(manifest: manifest, templates: templates, scripts: scripts, bindings: bindings, policy: policy)
    }

    /// Restore a bundle snapshot into the app-scoped DB tables.
    /// Restores templates, scripts, bindings, and policy grants.
    func restore(appId: String) throws {
        let repo = AppBundleRepository()

        // Reconstructive restore: clear app-scoped state first so promote/rollback
        // fully matches the revision snapshot.
        try repo.clearAppArtifacts(appId: appId)
        ScriptPermissions.shared.revokeAll(forApp: appId)

        for tmpl in templates {
            let templateJSON: String
            if let data = try? JSONEncoder().encode(tmpl.template),
               let str = String(data: data, encoding: .utf8) {
                templateJSON = str
            } else {
                templateJSON = "{}"
            }

            let defaultDataJSON: String?
            if let dd = tmpl.defaultData,
               let data = try? JSONEncoder().encode(dd),
               let str = String(data: data, encoding: .utf8) {
                defaultDataJSON = str
            } else {
                defaultDataJSON = nil
            }

            try repo.saveAppTemplate(
                appId: appId,
                name: tmpl.name,
                version: tmpl.version,
                template: templateJSON,
                defaultData: defaultDataJSON
            )
        }

        for script in scripts {
            try repo.saveAppScript(
                appId: appId,
                name: script.name,
                source: script.source,
                description: script.description,
                capabilities: script.requiredCapabilities ?? [],
                version: script.version
            )
        }

        // Restore bindings
        for binding in bindings {
            let actionJSON: String
            if let data = try? JSONEncoder().encode(binding.action),
               let str = String(data: data, encoding: .utf8) {
                actionJSON = str
            } else {
                actionJSON = "{}"
            }
            try repo.saveAppBinding(
                appId: appId,
                id: binding.id,
                template: binding.template,
                componentPath: binding.componentPath,
                actionJSON: actionJSON
            )
        }

        // Restore policy grants
        for grant in policy.grants {
            ScriptPermissions.shared.grant(grant, forApp: appId)
        }

        Log.app.info("AppBundle: Restored bundle with \(templates.count) templates, \(scripts.count) scripts, \(bindings.count) bindings for app \(appId)")
    }

    /// Validate referential integrity of the bundle.
    /// Returns nil if valid, or an array of error strings describing integrity issues.
    func validate() -> [String]? {
        var errors: [String] = []

        if manifest.appId.isEmpty {
            errors.append("Manifest appId must not be empty")
        }

        let scriptNames = Set(scripts.map(\.name))
        let templateNames = Set(templates.map(\.name))

        // Every entrypoint must reference an existing script
        for (name, entry) in manifest.entrypoints {
            if !scriptNames.contains(entry.script) {
                errors.append("Entrypoint '\(name)' references missing script '\(entry.script)'")
            }
        }

        // Every binding must reference an existing template
        for binding in bindings {
            if !templateNames.contains(binding.template) {
                errors.append("Binding '\(binding.id)' references missing template '\(binding.template)'")
            }
            // If the binding action is run_script, the script must exist
            if binding.action.type == "run_script", let script = binding.action.script {
                if !scriptNames.contains(script) {
                    errors.append("Binding '\(binding.id)' action references missing script '\(script)'")
                }
            }
        }

        return errors.isEmpty ? nil : errors
    }
}

// MARK: - AnyCodable (minimal)

/// Minimal type-erased Codable wrapper for heterogeneous JSON.
struct AnyCodable: Codable, Hashable {
    let value: Any

    init(_ value: Any) {
        self.value = value
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            value = NSNull()
        } else if let b = try? container.decode(Bool.self) {
            value = b
        } else if let i = try? container.decode(Int.self) {
            value = i
        } else if let d = try? container.decode(Double.self) {
            value = d
        } else if let s = try? container.decode(String.self) {
            value = s
        } else if let arr = try? container.decode([AnyCodable].self) {
            value = arr.map(\.value)
        } else if let dict = try? container.decode([String: AnyCodable].self) {
            value = dict.mapValues(\.value)
        } else {
            throw DecodingError.dataCorruptedError(in: container, debugDescription: "AnyCodable: unsupported type")
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch value {
        case is NSNull:
            try container.encodeNil()
        case let b as Bool:
            try container.encode(b)
        case let i as Int:
            try container.encode(i)
        case let d as Double:
            try container.encode(d)
        case let s as String:
            try container.encode(s)
        case let arr as [Any]:
            try container.encode(arr.map { AnyCodable($0) })
        case let dict as [String: Any]:
            try container.encode(dict.mapValues { AnyCodable($0) })
        default:
            throw EncodingError.invalidValue(value, .init(codingPath: encoder.codingPath, debugDescription: "AnyCodable: unsupported type \(type(of: value))"))
        }
    }

    static func == (lhs: AnyCodable, rhs: AnyCodable) -> Bool {
        // Best-effort equality via JSON round-trip
        guard let l = try? JSONEncoder().encode(lhs),
              let r = try? JSONEncoder().encode(rhs) else { return false }
        return l == r
    }

    func hash(into hasher: inout Hasher) {
        if let data = try? JSONEncoder().encode(self) {
            hasher.combine(data)
        }
    }
}
