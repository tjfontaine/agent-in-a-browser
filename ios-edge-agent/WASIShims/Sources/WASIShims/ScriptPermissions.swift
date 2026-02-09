/// ScriptPermissions.swift
/// Per-script capability grants for ios.* SDK access.
///
/// Tier 1 capabilities (storage, device, render, clipboard) are auto-granted.
/// Tier 2 capabilities (contacts, calendar, notifications) require user consent.
/// Tier 3 capabilities (location, health, keychain, photos) require both user and iOS system consent.

import Foundation
import WASIP2Harness
import OSLog

/// Manages per-script capability grants for ios:bridge APIs.
/// Supports both legacy global scope and app-scoped permission management.
public final class ScriptPermissions: @unchecked Sendable {
    
    // MARK: - Capability Definitions
    
    public enum Capability: String, CaseIterable, Sendable {
        // Tier 1: auto-granted (low risk)
        case storage
        case device
        case render
        case clipboard
        
        // Tier 2: requires user consent
        case contacts
        case calendar
        case notifications
        
        // Tier 3: requires system + user consent
        case location
        case health
        case keychain
        case photos
        
        /// Whether this capability is automatically granted without prompting.
        public var isAutoGranted: Bool {
            switch self {
            case .storage, .device, .render, .clipboard:
                return true
            case .contacts, .calendar, .notifications,
                 .location, .health, .keychain, .photos:
                return false
            }
        }
        
        /// Human-readable description for permission prompts.
        public var promptDescription: String {
            switch self {
            case .storage: return "store data locally"
            case .device: return "read device information"
            case .render: return "display UI components"
            case .clipboard: return "access the clipboard"
            case .contacts: return "access your contacts"
            case .calendar: return "access your calendar and reminders"
            case .notifications: return "send notifications"
            case .location: return "access your location"
            case .health: return "access health data"
            case .keychain: return "store secure credentials"
            case .photos: return "access your photo library"
            }
        }
    }
    
    // MARK: - Singleton
    
    public static let shared = ScriptPermissions()
    
    private let defaults = UserDefaults.standard
    private let grantKeyPrefix = "scriptPermission:"
    private let consentHandlerLock = NSLock()
    private var _requestConsent: ((_ appId: String, _ scriptName: String, _ capability: Capability, _ completion: @escaping (Bool) -> Void) -> Void)?
    
    /// Audit callback for permission grant/revoke events.
    /// Signature: (appId, scriptName, capability, action, actor) -> Void
    public var onAudit: ((String, String, String, String, String) -> Void)?
    
    /// Callback used to ask the user whether a script should be granted a capability.
    /// If unset, non-auto-granted capability requests are denied.
    public var requestConsent: ((_ appId: String, _ scriptName: String, _ capability: Capability, _ completion: @escaping (Bool) -> Void) -> Void)? {
        get {
            consentHandlerLock.lock()
            defer { consentHandlerLock.unlock() }
            return _requestConsent
        }
        set {
            consentHandlerLock.lock()
            _requestConsent = newValue
            consentHandlerLock.unlock()
        }
    }
    
    private init() {}
    
    // MARK: - Grant Management (Global, backward-compatible)
    
    /// Check if a capability is granted for a given script context.
    /// Auto-granted capabilities always return true.
    public func isGranted(_ capability: Capability, script: String = "global") -> Bool {
        isGranted(capability, appId: "global", script: script)
    }
    
    /// Grant a capability for a script context.
    public func grant(_ capability: Capability, script: String = "global") {
        grant(capability, appId: "global", script: script, actor: "system")
    }
    
    /// Revoke a capability for a script context.
    public func revoke(_ capability: Capability, script: String = "global") {
        revoke(capability, appId: "global", script: script, actor: "system")
    }
    
    /// List all granted capabilities for a script.
    public func grantedCapabilities(for script: String = "global") -> [Capability] {
        grantedCapabilities(appId: "global", script: script)
    }
    
    /// Revoke all capabilities for a script.
    public func revokeAll(script: String = "global") {
        for cap in Capability.allCases where !cap.isAutoGranted {
            revoke(cap, appId: "global", script: script, actor: "system")
        }
    }
    
    // MARK: - App-Scoped Grant Management (Phase 4)
    
    /// Check if a capability is granted for a specific app and script.
    public func isGranted(_ capability: Capability, appId: String, script: String) -> Bool {
        if capability.isAutoGranted { return true }
        let key = grantKey(appId: appId, script: script, capability: capability)
        return defaults.bool(forKey: key)
    }
    
    /// Grant a capability for a specific app and script, with audit logging.
    public func grant(_ capability: Capability, appId: String, script: String, actor: String = "system") {
        let key = grantKey(appId: appId, script: script, capability: capability)
        defaults.set(true, forKey: key)
        Log.mcp.info("ScriptPermissions: granted \(capability.rawValue) for \(appId)/\(script)")
        
        if appId != "global" {
            onAudit?(appId, script, capability.rawValue, "grant", actor)
        }
    }
    
    /// Revoke a capability for a specific app and script, with audit logging.
    public func revoke(_ capability: Capability, appId: String, script: String, actor: String = "system") {
        let key = grantKey(appId: appId, script: script, capability: capability)
        defaults.removeObject(forKey: key)
        Log.mcp.info("ScriptPermissions: revoked \(capability.rawValue) for \(appId)/\(script)")
        
        if appId != "global" {
            onAudit?(appId, script, capability.rawValue, "revoke", actor)
        }
    }
    
    /// List all granted capabilities for an app and script.
    public func grantedCapabilities(appId: String, script: String) -> [Capability] {
        Capability.allCases.filter { isGranted($0, appId: appId, script: script) }
    }
    
    /// List all granted capability raw value strings for an app (across all scripts).
    /// Used by AppBundle.build() to snapshot policy state.
    public func listGrants(forApp appId: String) -> [String] {
        var grants: [String] = []
        let keys = defaults.dictionaryRepresentation().keys
        let prefix = "\(grantKeyPrefix)\(appId):"
        for key in keys where key.hasPrefix(prefix) {
            if defaults.bool(forKey: key) {
                // Extract the script:cap portion
                let suffix = String(key.dropFirst(prefix.count))
                grants.append(suffix)
            }
        }
        return grants
    }

    /// Revoke every app-scoped grant for an app across all scripts.
    public func revokeAll(forApp appId: String) {
        let keys = defaults.dictionaryRepresentation().keys
        let prefix = "\(grantKeyPrefix)\(appId):"
        for key in keys where key.hasPrefix(prefix) {
            defaults.removeObject(forKey: key)
        }
    }
    
    /// Restore a grant from a bundled policy string (format: "script:capability").
    public func grant(_ grantString: String, forApp appId: String) {
        let parts = grantString.split(separator: ":", maxSplits: 1)
        guard parts.count == 2,
              let cap = Capability(rawValue: String(parts[1])) else { return }
        let script = String(parts[0])
        grant(cap, appId: appId, script: script, actor: "bundle_restore")
    }
    
    // MARK: - Permission Check (for providers)
    
    /// Check permission and return an error JSON string if denied.
    /// Returns nil if granted, or an error JSON string if denied.
    public func checkPermission(_ capability: Capability, script: String = "global") -> String? {
        checkPermission(capability, appId: "global", script: script)
    }
    
    /// App-scoped permission check.
    public func checkPermission(_ capability: Capability, appId: String, script: String) -> String? {
        guard isGranted(capability, appId: appId, script: script) else {
            return """
            {"error":"permission_denied","capability":"\(capability.rawValue)","message":"Script does not have permission to \(capability.promptDescription). Call ios.permissions.request('\(capability.rawValue)') first."}
            """
        }
        return nil
    }
    
    /// Request a non-auto-granted capability with explicit user mediation.
    /// Returns true only when the user approves within the timeout window.
    @discardableResult
    public func requestWithUserConsent(
        _ capability: Capability,
        appId: String,
        script: String,
        actor: String = "script",
        timeout: TimeInterval = 30
    ) -> Bool {
        if capability.isAutoGranted {
            return true
        }
        
        let handler: ((_ appId: String, _ scriptName: String, _ capability: Capability, _ completion: @escaping (Bool) -> Void) -> Void)?
        consentHandlerLock.lock()
        handler = _requestConsent
        consentHandlerLock.unlock()
        
        guard let handler else {
            Log.mcp.warning("ScriptPermissions: denying \(capability.rawValue) for \(appId)/\(script) (no consent handler)")
            return false
        }
        
        let semaphore = DispatchSemaphore(value: 0)
        let decisionLock = NSLock()
        var approved = false
        
        handler(appId, script, capability) { userApproved in
            decisionLock.lock()
            approved = userApproved
            decisionLock.unlock()
            semaphore.signal()
        }
        
        if semaphore.wait(timeout: .now() + timeout) == .timedOut {
            Log.mcp.warning("ScriptPermissions: timed out waiting for consent (\(capability.rawValue), \(appId)/\(script))")
            return false
        }
        
        decisionLock.lock()
        let finalDecision = approved
        decisionLock.unlock()
        
        if finalDecision {
            grant(capability, appId: appId, script: script, actor: actor)
            return true
        }
        
        Log.mcp.info("ScriptPermissions: user denied \(capability.rawValue) for \(appId)/\(script)")
        return false
    }
    
    // MARK: - Private
    
    private func grantKey(appId: String = "global", script: String, capability: Capability) -> String {
        "\(grantKeyPrefix)\(appId):\(script):\(capability.rawValue)"
    }
}
