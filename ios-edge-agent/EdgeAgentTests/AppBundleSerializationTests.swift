import XCTest
@testable import EdgeAgent

final class AppBundleSerializationTests: XCTestCase {
    
    let testAppId = "serial-test-\(UUID().uuidString.prefix(8))"

    // MARK: - Roundtrip

    func testEncodeDecodeRoundtrip() throws {
        let manifest = AppManifest(
            appId: "my-app",
            bundleVersion: "2.0.0",
            entrypoints: ["main": AppEntrypoint(script: "main-script", action: "run")],
            repairPolicy: RepairPolicy(enabled: true, maxAttempts: 3, timeBudgetMs: 15000)
        )
        
        let bundle = AppBundle(
            manifest: manifest,
            templates: [
                BundleTemplate(name: "home", version: "1.0", template: ["type": "VStack"])
            ],
            scripts: [
                BundleScript(name: "main-script", version: "1.0.0", source: "console.log('hi');")
            ],
            bindings: [
                BundleBinding(
                    id: "b1",
                    template: "home",
                    componentPath: "children[0]",
                    action: BundleAction(type: "run_script", script: "main-script", scriptAction: "run")
                )
            ],
            policy: BundlePolicy(grants: ["contacts", "location"])
        )
        
        let encoder = JSONEncoder()
        encoder.outputFormatting = .sortedKeys
        let data = try encoder.encode(bundle)
        
        let decoded = try JSONDecoder().decode(AppBundle.self, from: data)
        
        XCTAssertEqual(decoded.schemaVersion, "1.0.0")
        XCTAssertEqual(decoded.manifest.appId, "my-app")
        XCTAssertEqual(decoded.manifest.bundleVersion, "2.0.0")
        XCTAssertEqual(decoded.manifest.repairPolicy.maxAttempts, 3)
        XCTAssertEqual(decoded.templates.count, 1)
        XCTAssertEqual(decoded.templates.first?.name, "home")
        XCTAssertEqual(decoded.scripts.count, 1)
        XCTAssertEqual(decoded.scripts.first?.source, "console.log('hi');")
        XCTAssertEqual(decoded.bindings.count, 1)
        XCTAssertEqual(decoded.policy.grants, ["contacts", "location"])
    }

    // MARK: - Empty Bundle

    func testEmptyBundleIsValid() throws {
        let manifest = AppManifest(appId: "empty-app")
        let bundle = AppBundle(manifest: manifest)
        
        let data = try JSONEncoder().encode(bundle)
        let decoded = try JSONDecoder().decode(AppBundle.self, from: data)
        
        XCTAssertEqual(decoded.schemaVersion, "1.0.0")
        XCTAssertTrue(decoded.templates.isEmpty)
        XCTAssertTrue(decoded.scripts.isEmpty)
        XCTAssertTrue(decoded.bindings.isEmpty)
    }

    // MARK: - Build & Restore

    func testBuildAndRestore() throws {
        let repo = AppBundleRepository()
        
        // Save some app-scoped data
        try repo.saveAppTemplate(
            appId: testAppId,
            name: "detail-view",
            version: "1.0.0",
            template: "{\"type\":\"Text\",\"props\":{\"text\":\"Hello\"}}"
        )
        try repo.saveAppScript(
            appId: testAppId,
            name: "helper",
            source: "export function greet() { return 'hi'; }",
            description: "Helper functions"
        )
        
        // Build bundle from DB
        let bundle = try AppBundle.build(appId: testAppId)
        
        XCTAssertEqual(bundle.manifest.appId, testAppId)
        XCTAssertGreaterThanOrEqual(bundle.templates.count, 1)
        XCTAssertGreaterThanOrEqual(bundle.scripts.count, 1)
        
        let templateNames = bundle.templates.map(\.name)
        XCTAssertTrue(templateNames.contains("detail-view"))
        
        let scriptNames = bundle.scripts.map(\.name)
        XCTAssertTrue(scriptNames.contains("helper"))
        
        // Restore to a different app
        let targetApp = "restore-target-\(UUID().uuidString.prefix(8))"
        try bundle.restore(appId: targetApp)
        
        // Verify the target app now has the same data
        let restoredTemplate = try repo.getAppTemplate(appId: targetApp, name: "detail-view")
        XCTAssertNotNil(restoredTemplate)
        
        let restoredScript = try repo.getAppScript(appId: targetApp, name: "helper")
        XCTAssertNotNil(restoredScript)
        XCTAssertEqual(restoredScript?.source, "export function greet() { return 'hi'; }")
    }

    func testRestoreReconstructsStateByRemovingStaleArtifacts() throws {
        let repo = AppBundleRepository()
        let targetApp = "reconstruct-\(UUID().uuidString.prefix(8))"

        // Seed target app with stale state that should be removed.
        try repo.saveAppTemplate(
            appId: targetApp,
            name: "old-template",
            version: "1.0.0",
            template: "{\"type\":\"Text\",\"props\":{\"text\":\"Old\"}}"
        )
        try repo.saveAppScript(
            appId: targetApp,
            name: "old-script",
            source: "console.log('old');"
        )
        try repo.saveAppBinding(
            appId: targetApp,
            id: "old.binding",
            template: "old-template",
            componentPath: "props.action",
            actionJSON: "{\"type\":\"run_script\",\"script\":\"old-script\"}"
        )

        // Restore a different bundle snapshot into the same app.
        let bundle = AppBundle(
            manifest: AppManifest(appId: "source-app"),
            templates: [BundleTemplate(name: "new-template", version: "1.0.0", template: ["type": "Text"])],
            scripts: [BundleScript(name: "new-script", version: "1.0.0", source: "console.log('new');")],
            bindings: [
                BundleBinding(
                    id: "new.binding",
                    template: "new-template",
                    componentPath: "props.action",
                    action: BundleAction(type: "run_script", script: "new-script")
                )
            ]
        )
        try bundle.restore(appId: targetApp)

        XCTAssertNil(try repo.getAppTemplate(appId: targetApp, name: "old-template"))
        XCTAssertNil(try repo.getAppScript(appId: targetApp, name: "old-script"))

        let templates = try repo.listAppTemplates(appId: targetApp)
        XCTAssertTrue(templates.contains { $0.name == "new-template" })
        let scripts = try repo.listAppScripts(appId: targetApp)
        XCTAssertTrue(scripts.contains { $0.name == "new-script" })
        let bindings = try repo.listAppBindings(appId: targetApp)
        XCTAssertTrue(bindings.contains { $0.id == "new.binding" })
        XCTAssertFalse(bindings.contains { $0.id == "old.binding" })
    }

    // MARK: - Optional Field Tolerance

    func testOptionalFieldsDecodeGracefully() throws {
        // Minimal JSON with only required fields
        let minimalJSON = """
        {
          "schemaVersion": "1.0.0",
          "manifest": {
            "appId": "minimal",
            "bundleVersion": "1.0.0",
            "entrypoints": {},
            "repairPolicy": {
              "enabled": false,
              "maxAttempts": 0,
              "timeBudgetMs": 0,
              "allowedSurfaces": [],
              "disallowedOps": []
            }
          },
          "templates": [],
          "scripts": [],
          "bindings": [],
          "policy": {
            "grants": [],
            "lastUpdatedAt": "2025-01-01T00:00:00Z"
          }
        }
        """
        
        let data = minimalJSON.data(using: .utf8)!
        let bundle = try JSONDecoder().decode(AppBundle.self, from: data)
        XCTAssertEqual(bundle.manifest.appId, "minimal")
        XCTAssertFalse(bundle.manifest.repairPolicy.enabled)
    }

    // MARK: - Schema Version

    func testSchemaVersionIs1() throws {
        let bundle = AppBundle(manifest: AppManifest(appId: "test"))
        XCTAssertEqual(bundle.schemaVersion, "1.0.0")
    }
}
