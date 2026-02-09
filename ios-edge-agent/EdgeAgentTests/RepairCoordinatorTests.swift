import XCTest
@testable import EdgeAgent

final class RepairCoordinatorTests: XCTestCase {
    private let repo = AppBundleRepository()
    
    private func makeRun(appId: String) throws -> (revisionId: String, runId: String) {
        let revision = try repo.saveBundleRevision(appId: appId, bundleJSON: "{}")
        let run = try repo.saveRun(appId: appId, revisionId: revision.id, entrypoint: "main", status: .failed)
        return (revision.id, run.id)
    }
    
    func testCanRepairRejectsCrossAppRun() throws {
        let ownerAppId = "owner-\(UUID().uuidString.prefix(8))"
        let callerAppId = "caller-\(UUID().uuidString.prefix(8))"
        let (_, runId) = try makeRun(appId: ownerAppId)
        
        let coordinator = RepairCoordinator(
            appId: callerAppId,
            runId: runId,
            policy: RepairPolicy(maxAttempts: 5, timeBudgetMs: 120_000)
        )
        
        let denial = try coordinator.canRepair()
        XCTAssertNotNil(denial)
        XCTAssertTrue(denial?.hasPrefix("run_app_mismatch:") == true)
    }
    
    func testCanRepairRejectsRepeatedFailureSignature() throws {
        let appId = "repeat-\(UUID().uuidString.prefix(8))"
        let (revisionId, runId) = try makeRun(appId: appId)
        
        try repo.saveRepairAttempt(
            runId: runId,
            appId: appId,
            revisionId: revisionId,
            attemptNo: 1,
            patchSummary: "repair failed: TypeError: undefined is not a function",
            outcome: .failed
        )
        try repo.saveRepairAttempt(
            runId: runId,
            appId: appId,
            revisionId: revisionId,
            attemptNo: 2,
            patchSummary: "repair failed: TypeError: undefined is not a function",
            outcome: .failed
        )
        
        let coordinator = RepairCoordinator(
            appId: appId,
            runId: runId,
            policy: RepairPolicy(maxAttempts: 5, timeBudgetMs: 120_000)
        )
        
        let denial = try coordinator.canRepair()
        XCTAssertEqual(denial, "repair_stuck: repeated failure with same signature")
    }
    
    func testCanRepairAllowsDistinctFailureSignatures() throws {
        let appId = "distinct-\(UUID().uuidString.prefix(8))"
        let (revisionId, runId) = try makeRun(appId: appId)
        
        try repo.saveRepairAttempt(
            runId: runId,
            appId: appId,
            revisionId: revisionId,
            attemptNo: 1,
            patchSummary: "repair failed: TypeError: undefined is not a function",
            outcome: .failed
        )
        try repo.saveRepairAttempt(
            runId: runId,
            appId: appId,
            revisionId: revisionId,
            attemptNo: 2,
            patchSummary: "repair failed: ReferenceError: x is not defined",
            outcome: .failed
        )
        
        let coordinator = RepairCoordinator(
            appId: appId,
            runId: runId,
            policy: RepairPolicy(maxAttempts: 5, timeBudgetMs: 120_000)
        )
        
        let denial = try coordinator.canRepair()
        XCTAssertNil(denial)
    }
}
