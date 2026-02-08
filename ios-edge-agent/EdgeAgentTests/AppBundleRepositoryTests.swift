import XCTest
@testable import EdgeAgent

final class AppBundleRepositoryTests: XCTestCase {
    
    let repo = AppBundleRepository()
    let testAppId = "test-app-\(UUID().uuidString.prefix(8))"
    
    // MARK: - Schema Idempotency
    
    func testSchemaIdempotency() async throws {
        // Initialize twice — should not crash
        try await DatabaseManager.shared.initializeDatabase()
        try await DatabaseManager.shared.initializeDatabase()
    }
    
    // MARK: - Template CRUD
    
    func testSaveAndGetTemplate() throws {
        let template = try repo.saveAppTemplate(
            appId: testAppId,
            name: "home-screen",
            version: "1.0.0",
            template: "{\"type\":\"VStack\",\"children\":[]}",
            defaultData: "{\"title\":\"Hello\"}"
        )
        
        XCTAssertEqual(template.name, "home-screen")
        XCTAssertEqual(template.appId, testAppId)
        
        let fetched = try repo.getAppTemplate(appId: testAppId, name: "home-screen")
        XCTAssertNotNil(fetched)
        XCTAssertEqual(fetched?.template, "{\"type\":\"VStack\",\"children\":[]}")
        XCTAssertEqual(fetched?.defaultData, "{\"title\":\"Hello\"}")
    }
    
    func testListTemplates() throws {
        try repo.saveAppTemplate(appId: testAppId, name: "tmpl-a", version: "1.0.0", template: "{}")
        try repo.saveAppTemplate(appId: testAppId, name: "tmpl-b", version: "1.0.0", template: "{}")
        
        let list = try repo.listAppTemplates(appId: testAppId)
        XCTAssertGreaterThanOrEqual(list.count, 2)
        let names = Set(list.map(\.name))
        XCTAssertTrue(names.contains("tmpl-a"))
        XCTAssertTrue(names.contains("tmpl-b"))
    }
    
    func testDeleteTemplate() throws {
        try repo.saveAppTemplate(appId: testAppId, name: "to-delete", version: "1.0.0", template: "{}")
        try repo.deleteAppTemplate(appId: testAppId, name: "to-delete")
        
        let fetched = try repo.getAppTemplate(appId: testAppId, name: "to-delete")
        XCTAssertNil(fetched)
    }
    
    // MARK: - Script CRUD
    
    func testSaveAndGetScript() throws {
        let script = try repo.saveAppScript(
            appId: testAppId,
            name: "hello-world",
            source: "console.log('hello');",
            description: "A test script",
            capabilities: ["contacts"],
            version: "1.0.0"
        )
        
        XCTAssertEqual(script.name, "hello-world")
        XCTAssertEqual(script.appId, testAppId)
        
        let fetched = try repo.getAppScript(appId: testAppId, name: "hello-world")
        XCTAssertNotNil(fetched)
        XCTAssertEqual(fetched?.source, "console.log('hello');")
        XCTAssertEqual(fetched?.requiredCapabilities, ["contacts"])
    }
    
    func testListScripts() throws {
        try repo.saveAppScript(appId: testAppId, name: "script-a", source: "// a")
        try repo.saveAppScript(appId: testAppId, name: "script-b", source: "// b")
        
        let list = try repo.listAppScripts(appId: testAppId)
        XCTAssertGreaterThanOrEqual(list.count, 2)
    }
    
    func testDeleteScript() throws {
        try repo.saveAppScript(appId: testAppId, name: "temp-script", source: "// temp")
        try repo.deleteAppScript(appId: testAppId, name: "temp-script")
        
        let fetched = try repo.getAppScript(appId: testAppId, name: "temp-script")
        XCTAssertNil(fetched)
    }
    
    // MARK: - Cross-App Isolation
    
    func testCrossAppIsolation() throws {
        let appA = "app-a-\(UUID().uuidString.prefix(8))"
        let appB = "app-b-\(UUID().uuidString.prefix(8))"
        
        try repo.saveAppScript(appId: appA, name: "shared-name", source: "// from A")
        try repo.saveAppScript(appId: appB, name: "shared-name", source: "// from B")
        
        let fromA = try repo.getAppScript(appId: appA, name: "shared-name")
        let fromB = try repo.getAppScript(appId: appB, name: "shared-name")
        
        XCTAssertEqual(fromA?.source, "// from A")
        XCTAssertEqual(fromB?.source, "// from B")
        
        // Listing should only show scripts for the requested app
        let listA = try repo.listAppScripts(appId: appA)
        XCTAssertTrue(listA.allSatisfy { $0.appId == appA })
    }
    
    // MARK: - Revision CRUD
    
    func testSaveAndGetRevision() throws {
        let revision = try repo.saveBundleRevision(
            appId: testAppId,
            status: .draft,
            summary: "Initial draft",
            bundleJSON: "{\"schemaVersion\":\"1.0.0\"}"
        )
        
        XCTAssertEqual(revision.status, .draft)
        
        let fetched = try repo.getBundleRevision(id: revision.id)
        XCTAssertNotNil(fetched)
        XCTAssertEqual(fetched?.bundleJSON, "{\"schemaVersion\":\"1.0.0\"}")
    }
    
    func testPromoteRevision() throws {
        let revision = try repo.saveBundleRevision(
            appId: testAppId,
            bundleJSON: "{}"
        )
        
        try repo.promoteBundleRevision(id: revision.id)
        
        let promoted = try repo.getBundleRevision(id: revision.id)
        XCTAssertEqual(promoted?.status, .promoted)
        XCTAssertNotNil(promoted?.promotedAt)
    }
    
    func testListRevisions() throws {
        try repo.saveBundleRevision(appId: testAppId, bundleJSON: "{\"v\":1}")
        try repo.saveBundleRevision(appId: testAppId, bundleJSON: "{\"v\":2}")
        
        let list = try repo.listBundleRevisions(appId: testAppId)
        XCTAssertGreaterThanOrEqual(list.count, 2)
    }

    func testGetRevisionIsAppScopedWhenRequested() throws {
        let appA = "rev-a-\(UUID().uuidString.prefix(8))"
        let appB = "rev-b-\(UUID().uuidString.prefix(8))"
        let revision = try repo.saveBundleRevision(appId: appA, bundleJSON: "{\"v\":1}")

        let inAppA = try repo.getBundleRevision(id: revision.id, appId: appA)
        let inAppB = try repo.getBundleRevision(id: revision.id, appId: appB)

        XCTAssertNotNil(inAppA)
        XCTAssertNil(inAppB)
    }
    
    // MARK: - Run + Repair
    
    func testRunLifecycle() throws {
        let revision = try repo.saveBundleRevision(appId: testAppId, bundleJSON: "{}")
        let run = try repo.saveRun(appId: testAppId, revisionId: revision.id, entrypoint: "main")
        
        XCTAssertEqual(run.status, .running)
        
        try repo.updateRunStatus(id: run.id, status: .success)
    }
    
    func testRepairAttempt() throws {
        let revision = try repo.saveBundleRevision(appId: testAppId, bundleJSON: "{}")
        let run = try repo.saveRun(appId: testAppId, revisionId: revision.id, entrypoint: "main")
        
        try repo.saveRepairAttempt(
            runId: run.id,
            appId: testAppId,
            revisionId: revision.id,
            attemptNo: 1,
            patchSummary: "Fixed null check",
            outcome: .success
        )
        
        let attempts = try repo.listRepairAttempts(runId: run.id)
        XCTAssertEqual(attempts.count, 1)
        XCTAssertEqual(attempts.first?.outcome, .success)
    }

    func testRunStatusKeepsEndedAtNilWhileRunningOrRepairing() throws {
        let revision = try repo.saveBundleRevision(appId: testAppId, bundleJSON: "{}")
        let run = try repo.saveRun(appId: testAppId, revisionId: revision.id, entrypoint: "main")

        try repo.updateRunStatus(id: run.id, status: .repairing)
        let repairing = try repo.getRun(id: run.id)
        XCTAssertEqual(repairing?.status, .repairing)
        XCTAssertNil(repairing?.endedAt)

        try repo.updateRunStatus(id: run.id, status: .success)
        let succeeded = try repo.getRun(id: run.id)
        XCTAssertEqual(succeeded?.status, .success)
        XCTAssertNotNil(succeeded?.endedAt)
    }

    // MARK: - Bindings

    func testBindingIdsAreIsolatedAcrossApps() throws {
        let appA = "bind-a-\(UUID().uuidString.prefix(8))"
        let appB = "bind-b-\(UUID().uuidString.prefix(8))"
        let bindingId = "home.refresh"

        _ = try repo.saveAppBinding(
            appId: appA,
            id: bindingId,
            template: "home",
            componentPath: "props.children[0].props.action",
            actionJSON: "{\"type\":\"run_script\",\"script\":\"main\"}"
        )
        _ = try repo.saveAppBinding(
            appId: appB,
            id: bindingId,
            template: "home",
            componentPath: "props.children[0].props.action",
            actionJSON: "{\"type\":\"run_script\",\"script\":\"main\"}"
        )

        let appABindings = try repo.listAppBindings(appId: appA)
        let appBBindings = try repo.listAppBindings(appId: appB)

        XCTAssertTrue(appABindings.contains { $0.id == bindingId && $0.appId == appA })
        XCTAssertTrue(appBBindings.contains { $0.id == bindingId && $0.appId == appB })
    }
    
    // MARK: - Sandbox Path Convention
    
    func testAppScriptSandboxPath() {
        let path = DatabaseManager.appScriptSandboxPath(appId: "my-app", name: "weather")
        XCTAssertEqual(path, "/apps/my-app/scripts/weather.ts")
    }
}
