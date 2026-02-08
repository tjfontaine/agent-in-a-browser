import Foundation
import OSLog

/// Coordinates the bounded self-repair loop for app bundle runs.
///
/// The repair loop is agent-mediated: the LLM agent drives repair cycles,
/// while RepairCoordinator enforces policy limits (max attempts, time budget,
/// allowed surfaces) and performs rollback when the budget is exhausted.
struct RepairCoordinator {
    let appId: String
    let runId: String
    let policy: RepairPolicy
    
    private let repo = AppBundleRepository()
    
    // MARK: - Policy Enforcement
    
    /// Check if another repair attempt is allowed.
    /// Returns nil if allowed, or an error string if denied.
    func canRepair() throws -> String? {
        let attempts = try repo.listRepairAttempts(runId: runId)
        
        // Check max attempts
        if attempts.count >= policy.maxAttempts {
            return "repair_budget_exhausted: reached max \(policy.maxAttempts) attempts"
        }
        
        // Check time budget
        guard let run = try repo.getRun(id: runId) else {
            return "run_not_found: \(runId)"
        }
        
        let elapsedMs = Int(Date().timeIntervalSince(run.startedAt) * 1000)
        if elapsedMs > policy.timeBudgetMs {
            return "repair_budget_exhausted: exceeded time budget of \(policy.timeBudgetMs)ms (elapsed: \(elapsedMs)ms)"
        }
        
        // Check for repeated failure signature (same error twice in a row = give up)
        if let lastAttempt = attempts.last,
           let run = try repo.getRun(id: runId),
           run.failureSignature != nil,
           lastAttempt.patchSummary != nil {
            // If the previous attempt also failed with the same signature, auto-abort
            let previousRuns = attempts.filter { $0.outcome == .failed }
            if previousRuns.count >= 2 {
                return "repair_stuck: repeated failure with same signature"
            }
        }
        
        return nil
    }
    
    /// Record a repair attempt and return the attempt number.
    @discardableResult
    func recordAttempt(patchSummary: String?, outcome: RepairOutcome = .pending) throws -> Int {
        let attempts = try repo.listRepairAttempts(runId: runId)
        let attemptNo = attempts.count + 1
        guard let run = try repo.getRun(id: runId) else {
            throw NSError(
                domain: "RepairCoordinator",
                code: 404,
                userInfo: [NSLocalizedDescriptionKey: "Run '\(runId)' not found while recording repair attempt"]
            )
        }
        
        try repo.saveRepairAttempt(
            runId: runId,
            appId: appId,
            revisionId: run.revisionId,
            attemptNo: attemptNo,
            patchSummary: patchSummary,
            outcome: outcome
        )
        
        // Update run status to repairing
        try repo.updateRunStatus(id: runId, status: .repairing)
        
        Log.app.info("RepairCoordinator: recorded attempt #\(attemptNo) for run \(runId)")
        return attemptNo
    }
    
    /// Abort the run and rollback to the last promoted revision.
    func abortAndRollback() throws {
        // Mark the run as aborted
        try repo.updateRunStatus(id: runId, status: .aborted)
        
        // Find the last promoted revision and restore it
        if let lastPromoted = try repo.getLatestPromotedRevision(appId: appId) {
            let bundle = try JSONDecoder().decode(AppBundle.self, from: Data(lastPromoted.bundleJSON.utf8))
            try bundle.restore(appId: appId)
            Log.app.info("RepairCoordinator: rolled back to promoted revision \(lastPromoted.id) for app \(appId)")
        } else {
            Log.app.warning("RepairCoordinator: no promoted revision found for rollback, app \(appId)")
        }
    }
    
    /// Validate that a patch targets only allowed surfaces.
    static func validatePatchSurfaces(patches: [[String: Any]], policy: RepairPolicy) -> String? {
        for patch in patches {
            guard let target = patch["target"] as? String else { continue }
            
            // Check against disallowed operations
            for disallowed in policy.disallowedOps {
                if target.lowercased().contains(disallowed.lowercased()) {
                    return "patch_rejected: target '\(target)' matches disallowed operation '\(disallowed)'"
                }
            }
            
            // Check against allowed surfaces
            let surface = parseSurface(from: target)
            if !policy.allowedSurfaces.contains(surface) {
                return "patch_rejected: surface '\(surface)' not in allowed surfaces \(policy.allowedSurfaces)"
            }
        }
        return nil
    }
    
    /// Parse the surface type from a patch target string.
    private static func parseSurface(from target: String) -> String {
        if target.hasPrefix("template") || target.contains("template") {
            return "template_patch"
        } else if target.hasPrefix("script") || target.contains("script") {
            return "script_patch"
        } else if target.hasPrefix("binding") || target.contains("binding") {
            return "binding_patch"
        }
        return target
    }
}
