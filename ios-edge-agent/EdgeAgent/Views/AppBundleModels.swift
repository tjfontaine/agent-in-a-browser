import Foundation

// MARK: - App-Scoped Template Record

struct AppTemplateRecord: Identifiable, Hashable {
    let id: String
    let appId: String
    var name: String
    var version: String
    var template: String        // JSON blob
    var defaultData: String?    // JSON blob
    var animation: String?      // JSON blob
    let createdAt: Date
    var updatedAt: Date
}

// MARK: - App-Scoped Script Record

struct AppScriptRecord: Identifiable, Hashable {
    let id: String
    let appId: String
    var name: String
    var description: String?
    var source: String
    var requiredCapabilities: [String]
    var metadata: String?       // JSON blob
    var version: String
    let createdAt: Date
    var updatedAt: Date
}

// MARK: - Bundle Revision Record

struct BundleRevisionRecord: Identifiable, Hashable {
    let id: String
    let appId: String
    var status: BundleRevisionStatus
    var summary: String?
    var bundleJSON: String
    let createdAt: Date
    var promotedAt: Date?
}

enum BundleRevisionStatus: String, Codable, Hashable {
    case draft
    case promoted
    case discarded
}

// MARK: - Run Record

struct RunRecord: Identifiable, Hashable {
    let id: String
    let appId: String
    let revisionId: String
    let entrypoint: String
    var status: RunStatus
    var failureSignature: String?
    let startedAt: Date
    var endedAt: Date?
}

enum RunStatus: String, Codable, Hashable {
    case running
    case success
    case failed
    case aborted
    case repairing
}

// MARK: - Repair Attempt Record

struct RepairAttemptRecord: Identifiable, Hashable {
    let id: String
    let runId: String
    let appId: String
    let revisionId: String
    let attemptNo: Int
    var patchSummary: String?
    var outcome: RepairOutcome
    let startedAt: Date
    var endedAt: Date?
}

enum RepairOutcome: String, Codable, Hashable {
    case pending
    case success
    case failed
    case skipped
}

// MARK: - Binding Record (Phase 3)

struct AppBindingRecord: Identifiable, Hashable {
    let id: String
    let appId: String
    var template: String
    var componentPath: String
    var actionJSON: String      // JSON blob describing the action
    let createdAt: Date
    var updatedAt: Date
}

// MARK: - Permission Audit Record (Phase 4)

struct PermissionAuditRecord: Identifiable, Hashable {
    let id: String
    let appId: String
    let scriptName: String
    let capability: String
    let action: String          // "grant" or "revoke"
    let actor: String           // who triggered the action
    let timestamp: Date
}
