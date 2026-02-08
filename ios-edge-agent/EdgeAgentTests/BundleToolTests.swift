import XCTest
@testable import EdgeAgent

final class BundleToolTests: XCTestCase {
    
    let repo = AppBundleRepository()
    let testAppId = "bundle-test-\(UUID().uuidString.prefix(8))"
    
    // MARK: - bundle_get: Live Build
    
    func testBundleBuildFromLiveState() throws {
        // Seed templates and scripts
        try repo.saveAppTemplate(
            appId: testAppId,
            name: "home",
            version: "1.0.0",
            template: "{\"type\":\"VStack\"}",
            defaultData: "{\"title\":\"Hello\"}"
        )
        try repo.saveAppScript(
            appId: testAppId,
            name: "main",
            source: "console.log('hello');",
            description: "entry",
            capabilities: ["contacts"],
            version: "1.0.0"
        )
        
        // Build live bundle
        let bundle = try AppBundle.build(appId: testAppId)
        
        XCTAssertEqual(bundle.manifest.appId, testAppId)
        XCTAssertEqual(bundle.schemaVersion, "1.0.0")
        XCTAssertEqual(bundle.templates.count, 1)
        XCTAssertEqual(bundle.templates.first?.name, "home")
        XCTAssertEqual(bundle.scripts.count, 1)
        XCTAssertEqual(bundle.scripts.first?.name, "main")
        XCTAssertEqual(bundle.scripts.first?.source, "console.log('hello');")
    }
    
    // MARK: - bundle_get: Stored Revision
    
    func testBundleGetStoredRevision() throws {
        let bundleJSON = "{\"schemaVersion\":\"1.0.0\",\"manifest\":{\"appId\":\"\(testAppId)\",\"bundleVersion\":\"1.0.0\",\"entrypoints\":{},\"repairPolicy\":{\"enabled\":true,\"maxAttempts\":2,\"timeBudgetMs\":30000,\"allowedSurfaces\":[],\"disallowedOps\":[]}},\"templates\":[],\"scripts\":[],\"bindings\":[],\"policy\":{\"grants\":[],\"lastUpdatedAt\":\"2025-01-01T00:00:00Z\"}}"
        
        let revision = try repo.saveBundleRevision(
            appId: testAppId,
            status: .draft,
            summary: "Test revision",
            bundleJSON: bundleJSON
        )
        
        let fetched = try repo.getBundleRevision(id: revision.id)
        XCTAssertNotNil(fetched)
        XCTAssertEqual(fetched?.bundleJSON, bundleJSON)
        XCTAssertEqual(fetched?.status, .draft)
    }
    
    // MARK: - bundle_put: Draft vs Promote
    
    func testBundlePutDraft() throws {
        let revision = try repo.saveBundleRevision(
            appId: testAppId,
            status: .draft,
            summary: "Draft test",
            bundleJSON: "{}"
        )
        
        XCTAssertEqual(revision.status, .draft)
        XCTAssertNil(revision.promotedAt)
    }
    
    func testBundlePutPromote() throws {
        let revision = try repo.saveBundleRevision(
            appId: testAppId,
            status: .promoted,
            summary: "Promote test",
            bundleJSON: "{}"
        )
        
        try repo.promoteBundleRevision(id: revision.id)
        
        let fetched = try repo.getBundleRevision(id: revision.id)
        XCTAssertEqual(fetched?.status, .promoted)
        XCTAssertNotNil(fetched?.promotedAt)
    }
    
    // MARK: - bundle_put: Restore from bundle
    
    func testBundleRestore() throws {
        let restoreAppId = "restore-\(UUID().uuidString.prefix(8))"
        
        let bundle = AppBundle(
            manifest: AppManifest(appId: restoreAppId),
            templates: [
                BundleTemplate(name: "restored-view", version: "2.0.0", template: ["type": "Text"])
            ],
            scripts: [
                BundleScript(name: "restored-script", version: "1.1.0", source: "// restored")
            ]
        )
        
        try bundle.restore(appId: restoreAppId)
        
        // Verify templates were restored
        let templates = try repo.listAppTemplates(appId: restoreAppId)
        XCTAssertEqual(templates.count, 1)
        XCTAssertEqual(templates.first?.name, "restored-view")
        XCTAssertEqual(templates.first?.version, "2.0.0")
        
        // Verify scripts were restored
        let scripts = try repo.listAppScripts(appId: restoreAppId)
        XCTAssertEqual(scripts.count, 1)
        XCTAssertEqual(scripts.first?.name, "restored-script")
        XCTAssertEqual(scripts.first?.source, "// restored")
    }
    
    // MARK: - bundle_run: getRun + status lifecycle
    
    func testGetRunReturnsNilForMissing() throws {
        let result = try repo.getRun(id: "nonexistent-run-id")
        XCTAssertNil(result)
    }
    
    func testRunLifecycleWithGetRun() throws {
        let revision = try repo.saveBundleRevision(appId: testAppId, bundleJSON: "{}")
        let run = try repo.saveRun(
            appId: testAppId,
            revisionId: revision.id,
            entrypoint: "main",
            status: .running
        )
        
        // Fetch the run
        let fetched = try repo.getRun(id: run.id)
        XCTAssertNotNil(fetched)
        XCTAssertEqual(fetched?.status, .running)
        XCTAssertEqual(fetched?.entrypoint, "main")
        XCTAssertEqual(fetched?.appId, testAppId)
        XCTAssertNil(fetched?.endedAt)
        
        // Update to success
        try repo.updateRunStatus(id: run.id, status: .success)
        
        let updated = try repo.getRun(id: run.id)
        XCTAssertEqual(updated?.status, .success)
        XCTAssertNotNil(updated?.endedAt)
    }
    
    func testRunFailureWithSignature() throws {
        let revision = try repo.saveBundleRevision(appId: testAppId, bundleJSON: "{}")
        let run = try repo.saveRun(
            appId: testAppId,
            revisionId: revision.id,
            entrypoint: "buggy-script"
        )
        
        try repo.updateRunStatus(
            id: run.id,
            status: .failed,
            failureSignature: "TypeError: undefined is not a function"
        )
        
        let fetched = try repo.getRun(id: run.id)
        XCTAssertEqual(fetched?.status, .failed)
        XCTAssertEqual(fetched?.failureSignature, "TypeError: undefined is not a function")
    }
    
    // MARK: - bundle_repair_trace
    
    func testRepairTraceReturnsOrderedAttempts() throws {
        let revision = try repo.saveBundleRevision(appId: testAppId, bundleJSON: "{}")
        let run = try repo.saveRun(appId: testAppId, revisionId: revision.id, entrypoint: "main")
        
        try repo.saveRepairAttempt(
            runId: run.id,
            appId: testAppId,
            revisionId: revision.id,
            attemptNo: 1,
            patchSummary: "Fixed null check",
            outcome: .failed
        )
        try repo.saveRepairAttempt(
            runId: run.id,
            appId: testAppId,
            revisionId: revision.id,
            attemptNo: 2,
            patchSummary: "Added fallback",
            outcome: .success
        )
        
        let attempts = try repo.listRepairAttempts(runId: run.id)
        XCTAssertEqual(attempts.count, 2)
        XCTAssertEqual(attempts[0].attemptNo, 1)
        XCTAssertEqual(attempts[0].outcome, .failed)
        XCTAssertEqual(attempts[1].attemptNo, 2)
        XCTAssertEqual(attempts[1].outcome, .success)
    }
    
    func testRepairTraceEmptyForCleanRun() throws {
        let revision = try repo.saveBundleRevision(appId: testAppId, bundleJSON: "{}")
        let run = try repo.saveRun(appId: testAppId, revisionId: revision.id, entrypoint: "main")
        
        let attempts = try repo.listRepairAttempts(runId: run.id)
        XCTAssertEqual(attempts.count, 0)
    }
    
    // MARK: - Bundle Codable Round-trip
    
    func testBundleEncodeDecodeCycle() throws {
        let bundle = AppBundle(
            manifest: AppManifest(appId: "round-trip-test", bundleVersion: "2.0.0"),
            templates: [
                BundleTemplate(name: "card", version: "1.0.0", template: ["type": "card", "title": "Hi"])
            ],
            scripts: [
                BundleScript(name: "main", version: "1.0.0", source: "console.log('test');")
            ]
        )
        
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let data = try encoder.encode(bundle)
        let decoded = try JSONDecoder().decode(AppBundle.self, from: data)
        
        XCTAssertEqual(decoded.schemaVersion, "1.0.0")
        XCTAssertEqual(decoded.manifest.appId, "round-trip-test")
        XCTAssertEqual(decoded.manifest.bundleVersion, "2.0.0")
        XCTAssertEqual(decoded.templates.count, 1)
        XCTAssertEqual(decoded.scripts.count, 1)
        XCTAssertEqual(decoded.scripts.first?.source, "console.log('test');")
    }
    
    // MARK: - EventHandler run_script Parsing
    
    func testRunScriptEventParsing() {
        let dict: [String: Any] = [
            "type": "run_script",
            "app_id": "test-app-123",
            "script": "weather",
            "scriptAction": "refresh",
            "args": ["--force"],
            "resultMode": "notify"
        ]
        
        let parsed = EventHandlerType.parse(from: dict, data: [:], itemData: nil)
        XCTAssertNotNil(parsed)
        
        if case .runScript(let appId, let script, let scriptAction, let args, let resultMode, _, _) = parsed {
            XCTAssertEqual(appId, "test-app-123")
            XCTAssertEqual(script, "weather")
            XCTAssertEqual(scriptAction, "refresh")
            XCTAssertEqual(args, ["--force"])
            XCTAssertEqual(resultMode, .notify)
        } else {
            XCTFail("Expected .runScript, got \(String(describing: parsed))")
        }
    }
    
    func testRunScriptEventMissingScript() {
        let dict: [String: Any] = [
            "type": "run_script",
            "app_id": "test-app-123"
            // Missing "script" key
        ]
        
        let parsed = EventHandlerType.parse(from: dict, data: [:], itemData: nil)
        XCTAssertNil(parsed, "Should return nil when 'script' is missing")
    }
    
    func testRunScriptEventMissingAppId() {
        let dict: [String: Any] = [
            "type": "run_script",
            "script": "weather"
            // Missing "app_id" key
        ]
        
        let parsed = EventHandlerType.parse(from: dict, data: [:], itemData: nil)
        XCTAssertNil(parsed, "Should return nil when 'app_id' is missing")
    }
}
