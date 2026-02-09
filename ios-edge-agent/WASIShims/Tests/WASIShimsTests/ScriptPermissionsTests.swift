import Testing
import Foundation
@testable import WASIShims

@Suite("ScriptPermissions", .serialized)
struct ScriptPermissionsTests {
    @Test("requestWithUserConsent denies when no consent handler exists")
    func requestDeniedWithoutHandler() {
        let permissions = ScriptPermissions.shared
        let appId = "perm-no-handler-\(UUID().uuidString)"
        let script = "main"
        
        defer {
            permissions.requestConsent = nil
            permissions.revokeAll(forApp: appId)
        }
        
        permissions.requestConsent = nil
        let granted = permissions.requestWithUserConsent(.contacts, appId: appId, script: script, timeout: 0.1)
        
        #expect(granted == false)
        #expect(permissions.isGranted(.contacts, appId: appId, script: script) == false)
    }
    
    @Test("requestWithUserConsent grants when user approves")
    func requestGrantedWhenApproved() {
        let permissions = ScriptPermissions.shared
        let appId = "perm-approve-\(UUID().uuidString)"
        let script = "main"
        
        defer {
            permissions.requestConsent = nil
            permissions.revokeAll(forApp: appId)
        }
        
        permissions.requestConsent = { _, _, _, completion in
            completion(true)
        }
        
        let granted = permissions.requestWithUserConsent(.contacts, appId: appId, script: script, timeout: 0.5)
        
        #expect(granted == true)
        #expect(permissions.isGranted(.contacts, appId: appId, script: script) == true)
    }
    
    @Test("requestWithUserConsent does not grant when user denies")
    func requestDeniedWhenRejected() {
        let permissions = ScriptPermissions.shared
        let appId = "perm-deny-\(UUID().uuidString)"
        let script = "main"
        
        defer {
            permissions.requestConsent = nil
            permissions.revokeAll(forApp: appId)
        }
        
        permissions.requestConsent = { _, _, _, completion in
            completion(false)
        }
        
        let granted = permissions.requestWithUserConsent(.calendar, appId: appId, script: script, timeout: 0.5)
        
        #expect(granted == false)
        #expect(permissions.isGranted(.calendar, appId: appId, script: script) == false)
    }
    
    @Test("requestWithUserConsent short-circuits auto-granted capabilities")
    func requestAutoGrantedCapability() {
        let permissions = ScriptPermissions.shared
        let appId = "perm-auto-\(UUID().uuidString)"
        let script = "main"
        
        defer {
            permissions.requestConsent = nil
            permissions.revokeAll(forApp: appId)
        }
        
        permissions.requestConsent = nil
        let granted = permissions.requestWithUserConsent(.storage, appId: appId, script: script, timeout: 0.1)
        
        #expect(granted == true)
        #expect(permissions.isGranted(.storage, appId: appId, script: script) == true)
    }
}
