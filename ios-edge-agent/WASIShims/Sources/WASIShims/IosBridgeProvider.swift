/// IosBridgeProvider.swift
/// Type-safe WASI import provider for all ios:bridge interfaces.
///
/// Implements the host-side logic for the `ios:bridge@0.1.0` WIT package,
/// providing scripts with access to native iOS APIs via the WasmKit runtime.
/// Tier 2/3 interfaces are gated by ScriptPermissions.

import WasmKit
import WASIP2Harness
import OSLog
import Foundation
#if canImport(UIKit)
import UIKit
#endif
#if canImport(Network)
import Network
#endif
#if canImport(Contacts)
import Contacts
#endif
#if canImport(EventKit)
import EventKit
#endif
#if canImport(UserNotifications)
import UserNotifications
#endif
#if canImport(CoreLocation)
import CoreLocation
#endif
#if canImport(Security)
import Security
#endif
#if canImport(HealthKit)
import HealthKit
#endif
#if canImport(Photos)
import Photos
#endif

/// Provides type-safe WASI imports for ios:bridge interfaces.
/// When initialized with an execution context (appId, scriptName),
/// all permission checks are scoped to that app.
public final class IosBridgeProvider: WASIProvider {
    public static var moduleName: String { "ios:bridge" }
    
    private static let storagePrefix = "script:"
    
    /// Optional callback for render.show — dispatches component JSON to the UI layer.
    public var onRenderShow: ((String) -> String)?
    
    /// Execution context for app-scoped permission checks.
    public let appId: String
    public let scriptName: String
    
    public init(appId: String = "global", scriptName: String = "global") {
        self.appId = appId
        self.scriptName = scriptName
    }
    
    // MARK: - Blocking Async Helper
    
    /// Block the current (WASM background) thread while async work completes.
    /// Safe because WASM always runs on Task.detached, never on the main thread.
    private static func blockingAsync<T>(_ work: @escaping (@escaping (T) -> Void) -> Void) -> T {
        let semaphore = DispatchSemaphore(value: 0)
        var result: T!
        work { value in
            result = value
            semaphore.signal()
        }
        semaphore.wait()
        return result
    }
    
    public func register(into imports: inout Imports, store: Store) {
        // Tier 1 — auto-granted
        registerStorage(&imports, store: store)
        registerDevice(&imports, store: store)
        registerRender(&imports, store: store)
        registerPermissions(&imports, store: store)
        // Tier 2 — user consent
        registerContacts(&imports, store: store)
        registerCalendar(&imports, store: store)
        registerNotifications(&imports, store: store)
        registerClipboard(&imports, store: store)
        // Tier 3 — system + user consent
        registerLocation(&imports, store: store)
        registerHealth(&imports, store: store)
        registerKeychain(&imports, store: store)
        registerPhotos(&imports, store: store)
    }
    
    // MARK: - Storage
    
    private func registerStorage(_ imports: inout Imports, store: Store) {
        let module = "ios:bridge/storage@0.1.0"
        
        // get(key_ptr, key_len, ret_ptr) -> ()
        // ret_ptr layout: option<string> = discriminant (u8) | ptr (i32) | len (i32)
        imports.define(module: module, name: "get",
            Function(store: store, parameters: [.i32, .i32, .i32], results: []) { caller, args in
                guard let memory = caller.instance?.exports[memory: "memory"] else { return [] }
                
                let keyPtr = UInt(args[0].i32)
                let keyLen = Int(args[1].i32)
                let retPtr = UInt(args[2].i32)
                
                let key = Self.readString(from: memory, ptr: keyPtr, len: keyLen)
                let scopedKey = Self.storagePrefix + key
                let value = UserDefaults.standard.string(forKey: scopedKey)
                
                if let value = value {
                    // option<string> = Some: discriminant=1, then (ptr, len)
                    let (dataPtr, dataLen) = Self.writeStringToWasm(value, caller: caller, memory: memory)
                    memory.withUnsafeMutableBufferPointer(offset: retPtr, count: 12) { buf in
                        buf[0] = 1 // discriminant = Some
                        buf.storeBytes(of: dataPtr.littleEndian, toByteOffset: 4, as: UInt32.self)
                        buf.storeBytes(of: dataLen.littleEndian, toByteOffset: 8, as: UInt32.self)
                    }
                } else {
                    // option<string> = None: discriminant=0
                    memory.withUnsafeMutableBufferPointer(offset: retPtr, count: 12) { buf in
                        buf[0] = 0 // discriminant = None
                    }
                }
                return []
            }
        )
        
        // set(key_ptr, key_len, val_ptr, val_len) -> ()
        imports.define(module: module, name: "set",
            Function(store: store, parameters: [.i32, .i32, .i32, .i32], results: []) { caller, args in
                guard let memory = caller.instance?.exports[memory: "memory"] else { return [] }
                
                let key = Self.readString(from: memory, ptr: UInt(args[0].i32), len: Int(args[1].i32))
                let value = Self.readString(from: memory, ptr: UInt(args[2].i32), len: Int(args[3].i32))
                let scopedKey = Self.storagePrefix + key
                UserDefaults.standard.set(value, forKey: scopedKey)
                return []
            }
        )
        
        // remove(key_ptr, key_len) -> i32 (bool)
        imports.define(module: module, name: "remove",
            Function(store: store, parameters: [.i32, .i32], results: [.i32]) { caller, args in
                guard let memory = caller.instance?.exports[memory: "memory"] else { return [.i32(0)] }
                
                let key = Self.readString(from: memory, ptr: UInt(args[0].i32), len: Int(args[1].i32))
                let scopedKey = Self.storagePrefix + key
                let existed = UserDefaults.standard.object(forKey: scopedKey) != nil
                UserDefaults.standard.removeObject(forKey: scopedKey)
                return [.i32(existed ? 1 : 0)]
            }
        )
        
        // keys(opt_flag, prefix_ptr, prefix_len, ret_ptr) -> ()
        // ret_ptr layout: list<string> = ptr (i32) | len (i32)
        imports.define(module: module, name: "keys",
            Function(store: store, parameters: [.i32, .i32, .i32, .i32], results: []) { caller, args in
                guard let memory = caller.instance?.exports[memory: "memory"] else { return [] }
                
                let optFlag = args[0].i32
                let filterPrefix: String?
                if optFlag == 1 {
                    filterPrefix = Self.readString(from: memory, ptr: UInt(args[1].i32), len: Int(args[2].i32))
                } else {
                    filterPrefix = nil
                }
                let retPtr = UInt(args[3].i32)
                
                // Get all script-scoped keys
                let allKeys = UserDefaults.standard.dictionaryRepresentation().keys
                    .filter { $0.hasPrefix(Self.storagePrefix) }
                    .map { String($0.dropFirst(Self.storagePrefix.count)) }
                    .filter { key in
                        if let prefix = filterPrefix {
                            return key.hasPrefix(prefix)
                        }
                        return true
                    }
                    .sorted()
                
                // Write list<string> as array of (ptr, len) pairs
                guard let realloc = caller.instance?.exports[function: "cabi_realloc"] else {
                    memory.withUnsafeMutableBufferPointer(offset: retPtr, count: 8) { buf in
                        for i in 0..<8 { buf[i] = 0 }
                    }
                    return []
                }
                
                let entrySize = 8 // ptr (4) + len (4) per string
                let totalSize = UInt32(allKeys.count * entrySize)
                var arrayPtr: UInt32 = 0
                
                if totalSize > 0 {
                    if let result = try? realloc([.i32(0), .i32(0), .i32(4), .i32(totalSize)]),
                       let val = result.first, case let .i32(ptr) = val {
                        arrayPtr = ptr
                    }
                    
                    for (i, key) in allKeys.enumerated() {
                        let (strPtr, strLen) = Self.writeStringToWasm(key, caller: caller, memory: memory)
                        let offset = UInt(arrayPtr) + UInt(i * entrySize)
                        memory.withUnsafeMutableBufferPointer(offset: offset, count: entrySize) { buf in
                            buf.storeBytes(of: strPtr.littleEndian, as: UInt32.self)
                            buf.storeBytes(of: strLen.littleEndian, toByteOffset: 4, as: UInt32.self)
                        }
                    }
                }
                
                memory.withUnsafeMutableBufferPointer(offset: retPtr, count: 8) { buf in
                    buf.storeBytes(of: arrayPtr.littleEndian, as: UInt32.self)
                    buf.storeBytes(of: UInt32(allKeys.count).littleEndian, toByteOffset: 4, as: UInt32.self)
                }
                return []
            }
        )
    }
    
    // MARK: - Permissions
    
    private func registerPermissions(_ imports: inout Imports, store: Store) {
        let module = "ios:bridge/permissions@0.1.0"
        
        // request(cap_ptr, cap_len) -> i32 (bool)
        imports.define(module: module, name: "request",
            Function(store: store, parameters: [.i32, .i32], results: [.i32]) { caller, args in
                guard let memory = caller.instance?.exports[memory: "memory"] else { return [.i32(0)] }
                let rawCapability = Self.readString(from: memory, ptr: UInt(args[0].i32), len: Int(args[1].i32))
                guard let capability = ScriptPermissions.Capability(rawValue: rawCapability) else {
                    return [.i32(0)]
                }
                
                ScriptPermissions.shared.grant(capability, appId: self.appId, script: self.scriptName, actor: "script")
                return [.i32(1)]
            }
        )
        
        // revoke(cap_ptr, cap_len) -> i32 (bool)
        imports.define(module: module, name: "revoke",
            Function(store: store, parameters: [.i32, .i32], results: [.i32]) { caller, args in
                guard let memory = caller.instance?.exports[memory: "memory"] else { return [.i32(0)] }
                let rawCapability = Self.readString(from: memory, ptr: UInt(args[0].i32), len: Int(args[1].i32))
                guard let capability = ScriptPermissions.Capability(rawValue: rawCapability) else {
                    return [.i32(0)]
                }
                
                ScriptPermissions.shared.revoke(capability, appId: self.appId, script: self.scriptName, actor: "script")
                return [.i32(1)]
            }
        )
        
        // check(cap_ptr, cap_len) -> i32 (bool)
        imports.define(module: module, name: "check",
            Function(store: store, parameters: [.i32, .i32], results: [.i32]) { caller, args in
                guard let memory = caller.instance?.exports[memory: "memory"] else { return [.i32(0)] }
                let rawCapability = Self.readString(from: memory, ptr: UInt(args[0].i32), len: Int(args[1].i32))
                guard let capability = ScriptPermissions.Capability(rawValue: rawCapability) else {
                    return [.i32(0)]
                }
                
                return [.i32(ScriptPermissions.shared.isGranted(capability, appId: self.appId, script: self.scriptName) ? 1 : 0)]
            }
        )
    }
    
    // MARK: - Device
    
    private func registerDevice(_ imports: inout Imports, store: Store) {
        let module = "ios:bridge/device@0.1.0"
        
        // info(ret_ptr) -> () — writes (ptr, len) for JSON string
        imports.define(module: module, name: "info",
            Function(store: store, parameters: [.i32], results: []) { caller, args in
                guard let memory = caller.instance?.exports[memory: "memory"] else { return [] }
                let retPtr = UInt(args[0].i32)
                
                let info = Self.deviceInfoJSON()
                let (strPtr, strLen) = Self.writeStringToWasm(info, caller: caller, memory: memory)
                
                memory.withUnsafeMutableBufferPointer(offset: retPtr, count: 8) { buf in
                    buf.storeBytes(of: strPtr.littleEndian, as: UInt32.self)
                    buf.storeBytes(of: strLen.littleEndian, toByteOffset: 4, as: UInt32.self)
                }
                return []
            }
        )
        
        // connectivity(ret_ptr) -> ()
        imports.define(module: module, name: "connectivity",
            Function(store: store, parameters: [.i32], results: []) { caller, args in
                guard let memory = caller.instance?.exports[memory: "memory"] else { return [] }
                let retPtr = UInt(args[0].i32)
                
                let info = Self.connectivityJSON()
                let (strPtr, strLen) = Self.writeStringToWasm(info, caller: caller, memory: memory)
                
                memory.withUnsafeMutableBufferPointer(offset: retPtr, count: 8) { buf in
                    buf.storeBytes(of: strPtr.littleEndian, as: UInt32.self)
                    buf.storeBytes(of: strLen.littleEndian, toByteOffset: 4, as: UInt32.self)
                }
                return []
            }
        )
        
        // locale(ret_ptr) -> ()
        imports.define(module: module, name: "locale",
            Function(store: store, parameters: [.i32], results: []) { caller, args in
                guard let memory = caller.instance?.exports[memory: "memory"] else { return [] }
                let retPtr = UInt(args[0].i32)
                
                let info = Self.localeJSON()
                let (strPtr, strLen) = Self.writeStringToWasm(info, caller: caller, memory: memory)
                
                memory.withUnsafeMutableBufferPointer(offset: retPtr, count: 8) { buf in
                    buf.storeBytes(of: strPtr.littleEndian, as: UInt32.self)
                    buf.storeBytes(of: strLen.littleEndian, toByteOffset: 4, as: UInt32.self)
                }
                return []
            }
        )
    }
    
    // MARK: - Render
    
    private func registerRender(_ imports: inout Imports, store: Store) {
        let module = "ios:bridge/render@0.1.0"
        
        // show(json_ptr, json_len, ret_ptr) -> ()
        let onRenderShow = self.onRenderShow
        imports.define(module: module, name: "show",
            Function(store: store, parameters: [.i32, .i32, .i32], results: []) { caller, args in
                guard let memory = caller.instance?.exports[memory: "memory"] else { return [] }
                
                let jsonStr = Self.readString(from: memory, ptr: UInt(args[0].i32), len: Int(args[1].i32))
                let retPtr = UInt(args[2].i32)
                
                let viewId: String
                if let handler = onRenderShow {
                    viewId = handler(jsonStr)
                } else {
                    Log.mcp.warning("IosBridgeProvider: render.show called but no handler registered")
                    viewId = "no-handler"
                }
                
                let (strPtr, strLen) = Self.writeStringToWasm(viewId, caller: caller, memory: memory)
                memory.withUnsafeMutableBufferPointer(offset: retPtr, count: 8) { buf in
                    buf.storeBytes(of: strPtr.littleEndian, as: UInt32.self)
                    buf.storeBytes(of: strLen.littleEndian, toByteOffset: 4, as: UInt32.self)
                }
                return []
            }
        )
    }
    
    // MARK: - Helpers
    
    /// Read a UTF-8 string from WASM linear memory.
    private static func readString(from memory: Memory, ptr: UInt, len: Int) -> String {
        guard len > 0 else { return "" }
        var bytes = [UInt8](repeating: 0, count: len)
        memory.withUnsafeMutableBufferPointer(offset: ptr, count: len) { buf in
            for i in 0..<len { bytes[i] = buf[i] }
        }
        return String(bytes: bytes, encoding: .utf8) ?? ""
    }
    
    /// Write a string to WASM memory via cabi_realloc and return (ptr, len).
    private static func writeStringToWasm(_ str: String, caller: Caller, memory: Memory) -> (UInt32, UInt32) {
        let bytes = Array(str.utf8)
        let len = UInt32(bytes.count)
        guard len > 0 else { return (0, 0) }
        
        guard let realloc = caller.instance?.exports[function: "cabi_realloc"],
              let result = try? realloc([.i32(0), .i32(0), .i32(1), .i32(len)]),
              let val = result.first, case let .i32(ptr) = val else {
            return (0, 0)
        }
        
        memory.withUnsafeMutableBufferPointer(offset: UInt(ptr), count: bytes.count) { buf in
            for (i, byte) in bytes.enumerated() {
                buf[i] = byte
            }
        }
        return (ptr, len)
    }
    
    // MARK: - Device Info Helpers
    
    private static func deviceInfoJSON() -> String {
        #if canImport(UIKit)
        let device = UIDevice.current
        device.isBatteryMonitoringEnabled = true
        let batteryLevel = device.batteryLevel
        device.isBatteryMonitoringEnabled = false
        
        let thermalState: String
        switch ProcessInfo.processInfo.thermalState {
        case .nominal: thermalState = "nominal"
        case .fair: thermalState = "fair"
        case .serious: thermalState = "serious"
        case .critical: thermalState = "critical"
        @unknown default: thermalState = "unknown"
        }
        
        return """
        {"model":"\(device.model)","systemName":"\(device.systemName)","systemVersion":"\(device.systemVersion)","batteryLevel":\(batteryLevel),"thermalState":"\(thermalState)","isLowPowerMode":\(ProcessInfo.processInfo.isLowPowerModeEnabled)}
        """
        #else
        return "{\"model\":\"macOS\",\"systemName\":\"macOS\",\"systemVersion\":\"unknown\",\"batteryLevel\":-1,\"thermalState\":\"unknown\",\"isLowPowerMode\":false}"
        #endif
    }
    
    private static func connectivityJSON() -> String {
        #if canImport(Network)
        let monitor = NWPathMonitor()
        let path = monitor.currentPath
        
        let status: String
        if path.usesInterfaceType(.wifi) {
            status = "wifi"
        } else if path.usesInterfaceType(.cellular) {
            status = "cellular"
        } else if path.status == .satisfied {
            status = "other"
        } else {
            status = "none"
        }
        
        return """
        {"status":"\(status)","isExpensive":\(path.isExpensive),"isConstrained":\(path.isConstrained)}
        """
        #else
        return "{\"status\":\"unknown\",\"isExpensive\":false,\"isConstrained\":false}"
        #endif
    }
    
    private static func localeJSON() -> String {
        let locale = Locale.current
        let tz = TimeZone.current
        let languages = Locale.preferredLanguages
        
        let langArray = languages.map { "\"\($0)\"" }.joined(separator: ",")
        
        return """
        {"identifier":"\(locale.identifier)","timezone":"\(tz.identifier)","languages":[\(langArray)]}
        """
    }
    
    // MARK: - Tier 2: Contacts
    
    private func registerContacts(_ imports: inout Imports, store: Store) {
        let module = "ios:bridge/contacts@0.1.0"
        
        // search(query_ptr, query_len, opt_flag, limit, ret_ptr) -> ()
        imports.define(module: module, name: "search",
            Function(store: store, parameters: [.i32, .i32, .i32, .i32, .i32], results: []) { caller, args in
                guard let memory = caller.instance?.exports[memory: "memory"] else { return [] }
                let query = Self.readString(from: memory, ptr: UInt(args[0].i32), len: Int(args[1].i32))
                let retPtr = UInt(args[4].i32)
                
                if let error = ScriptPermissions.shared.checkPermission(.contacts, appId: self.appId, script: self.scriptName) {
                    Self.writeReturnString(error, retPtr: retPtr, caller: caller, memory: memory)
                    return []
                }
                
                #if canImport(Contacts)
                let contactStore = CNContactStore()
                let keysToFetch: [CNKeyDescriptor] = [
                    CNContactGivenNameKey as CNKeyDescriptor,
                    CNContactFamilyNameKey as CNKeyDescriptor,
                    CNContactEmailAddressesKey as CNKeyDescriptor,
                    CNContactPhoneNumbersKey as CNKeyDescriptor,
                    CNContactIdentifierKey as CNKeyDescriptor
                ]
                
                var results: [[String: Any]] = []
                let request = CNContactFetchRequest(keysToFetch: keysToFetch)
                request.predicate = CNContact.predicateForContacts(matchingName: query)
                
                let limit = args[2].i32 == 1 ? Int(args[3].i32) : 50
                do {
                    try contactStore.enumerateContacts(with: request) { contact, stop in
                        results.append([
                            "id": contact.identifier,
                            "givenName": contact.givenName,
                            "familyName": contact.familyName,
                            "emails": contact.emailAddresses.map { $0.value as String },
                            "phones": contact.phoneNumbers.map { $0.value.stringValue }
                        ])
                        if results.count >= limit { stop.pointee = true }
                    }
                } catch {
                    Log.mcp.error("IosBridgeProvider: contacts.search error: \(error)")
                }
                
                let json = (try? JSONSerialization.data(withJSONObject: results)).flatMap { String(data: $0, encoding: .utf8) } ?? "[]"
                #else
                let json = "[]"
                #endif
                
                Self.writeReturnString(json, retPtr: retPtr, caller: caller, memory: memory)
                return []
            }
        )
        
        // get(id_ptr, id_len, ret_ptr) -> () — writes option<string>
        imports.define(module: module, name: "get",
            Function(store: store, parameters: [.i32, .i32, .i32], results: []) { caller, args in
                guard let memory = caller.instance?.exports[memory: "memory"] else { return [] }
                let identifier = Self.readString(from: memory, ptr: UInt(args[0].i32), len: Int(args[1].i32))
                let retPtr = UInt(args[2].i32)
                
                if !ScriptPermissions.shared.isGranted(.contacts, appId: self.appId, script: self.scriptName) {
                    Self.writeOptionNone(retPtr: retPtr, memory: memory)
                    return []
                }
                
                #if canImport(Contacts)
                let contactStore = CNContactStore()
                let keysToFetch: [CNKeyDescriptor] = [
                    CNContactGivenNameKey as CNKeyDescriptor,
                    CNContactFamilyNameKey as CNKeyDescriptor,
                    CNContactEmailAddressesKey as CNKeyDescriptor,
                    CNContactPhoneNumbersKey as CNKeyDescriptor
                ]
                
                if let contact = try? contactStore.unifiedContact(withIdentifier: identifier, keysToFetch: keysToFetch) {
                    let dict: [String: Any] = [
                        "id": contact.identifier,
                        "givenName": contact.givenName,
                        "familyName": contact.familyName,
                        "emails": contact.emailAddresses.map { $0.value as String },
                        "phones": contact.phoneNumbers.map { $0.value.stringValue }
                    ]
                    if let data = try? JSONSerialization.data(withJSONObject: dict),
                       let json = String(data: data, encoding: .utf8) {
                        Self.writeOptionSome(json, retPtr: retPtr, caller: caller, memory: memory)
                    } else {
                        Self.writeOptionNone(retPtr: retPtr, memory: memory)
                    }
                } else {
                    Self.writeOptionNone(retPtr: retPtr, memory: memory)
                }
                #else
                Self.writeOptionNone(retPtr: retPtr, memory: memory)
                #endif
                return []
            }
        )
        
        // authorization-status(ret_ptr) -> () — writes string
        imports.define(module: module, name: "authorization-status",
            Function(store: store, parameters: [.i32], results: []) { caller, args in
                guard let memory = caller.instance?.exports[memory: "memory"] else { return [] }
                let retPtr = UInt(args[0].i32)
                
                #if canImport(Contacts)
                let status: String
                switch CNContactStore.authorizationStatus(for: .contacts) {
                case .authorized: status = "authorized"
                case .denied: status = "denied"
                case .restricted: status = "restricted"
                case .notDetermined: status = "notDetermined"
                @unknown default: status = "unknown"
                }
                #else
                let status = "unavailable"
                #endif
                
                Self.writeReturnString(status, retPtr: retPtr, caller: caller, memory: memory)
                return []
            }
        )
    }
    
    // MARK: - Tier 2: Calendar
    
    private func registerCalendar(_ imports: inout Imports, store: Store) {
        let module = "ios:bridge/calendar@0.1.0"
        
        // calendars(ret_ptr) -> ()
        imports.define(module: module, name: "calendars",
            Function(store: store, parameters: [.i32], results: []) { caller, args in
                guard let memory = caller.instance?.exports[memory: "memory"] else { return [] }
                let retPtr = UInt(args[0].i32)
                
                if let error = ScriptPermissions.shared.checkPermission(.calendar, appId: self.appId, script: self.scriptName) {
                    Self.writeReturnString(error, retPtr: retPtr, caller: caller, memory: memory)
                    return []
                }
                
                #if canImport(EventKit)
                let eventStore = EKEventStore()
                let cals = eventStore.calendars(for: .event).map { ["id": $0.calendarIdentifier, "title": $0.title] }
                let json = (try? JSONSerialization.data(withJSONObject: cals)).flatMap { String(data: $0, encoding: .utf8) } ?? "[]"
                #else
                let json = "[]"
                #endif
                
                Self.writeReturnString(json, retPtr: retPtr, caller: caller, memory: memory)
                return []
            }
        )
        
        // events(start_ptr, start_len, end_ptr, end_len, opt_flag, cal_ptr, cal_len, ret_ptr) -> ()
        imports.define(module: module, name: "events",
            Function(store: store, parameters: [.i32, .i32, .i32, .i32, .i32, .i32, .i32, .i32], results: []) { caller, args in
                guard let memory = caller.instance?.exports[memory: "memory"] else { return [] }
                let retPtr = UInt(args[7].i32)
                
                if let error = ScriptPermissions.shared.checkPermission(.calendar, appId: self.appId, script: self.scriptName) {
                    Self.writeReturnString(error, retPtr: retPtr, caller: caller, memory: memory)
                    return []
                }
                
                let startISO = Self.readString(from: memory, ptr: UInt(args[0].i32), len: Int(args[1].i32))
                let endISO = Self.readString(from: memory, ptr: UInt(args[2].i32), len: Int(args[3].i32))
                
                #if canImport(EventKit)
                let formatter = ISO8601DateFormatter()
                let eventStore = EKEventStore()
                let startDate = formatter.date(from: startISO) ?? Date()
                let endDate = formatter.date(from: endISO) ?? Date().addingTimeInterval(86400)
                let predicate = eventStore.predicateForEvents(withStart: startDate, end: endDate, calendars: nil)
                let events = eventStore.events(matching: predicate).map {
                    ["id": $0.eventIdentifier ?? "", "title": $0.title ?? "", "start": formatter.string(from: $0.startDate), "end": formatter.string(from: $0.endDate)]
                }
                let json = (try? JSONSerialization.data(withJSONObject: events)).flatMap { String(data: $0, encoding: .utf8) } ?? "[]"
                #else
                let json = "[]"
                #endif
                
                Self.writeReturnString(json, retPtr: retPtr, caller: caller, memory: memory)
                return []
            }
        )
        
        // create-event(json_ptr, json_len, ret_ptr) -> ()
        imports.define(module: module, name: "create-event",
            Function(store: store, parameters: [.i32, .i32, .i32], results: []) { caller, args in
                guard let memory = caller.instance?.exports[memory: "memory"] else { return [] }
                let jsonStr = Self.readString(from: memory, ptr: UInt(args[0].i32), len: Int(args[1].i32))
                let retPtr = UInt(args[2].i32)
                
                if let error = ScriptPermissions.shared.checkPermission(.calendar, appId: self.appId, script: self.scriptName) {
                    Self.writeReturnString(error, retPtr: retPtr, caller: caller, memory: memory)
                    return []
                }
                
                #if canImport(EventKit)
                let eventStore = EKEventStore()
                if let data = jsonStr.data(using: .utf8),
                   let spec = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                    let event = EKEvent(eventStore: eventStore)
                    event.title = spec["title"] as? String ?? "Untitled"
                    let formatter = ISO8601DateFormatter()
                    event.startDate = (spec["start"] as? String).flatMap { formatter.date(from: $0) } ?? Date()
                    event.endDate = (spec["end"] as? String).flatMap { formatter.date(from: $0) } ?? Date().addingTimeInterval(3600)
                    event.calendar = eventStore.defaultCalendarForNewEvents
                    do {
                        try eventStore.save(event, span: .thisEvent)
                        Self.writeReturnString(event.eventIdentifier ?? "created", retPtr: retPtr, caller: caller, memory: memory)
                    } catch {
                        Self.writeReturnString("{\"error\":\"\(error.localizedDescription)\"}", retPtr: retPtr, caller: caller, memory: memory)
                    }
                } else {
                    Self.writeReturnString("{\"error\":\"invalid_json\"}", retPtr: retPtr, caller: caller, memory: memory)
                }
                #else
                Self.writeReturnString("{\"error\":\"unavailable\"}", retPtr: retPtr, caller: caller, memory: memory)
                #endif
                return []
            }
        )
        
        // reminders(opt_flag, cal_ptr, cal_len, ret_ptr) -> ()
        imports.define(module: module, name: "reminders",
            Function(store: store, parameters: [.i32, .i32, .i32, .i32], results: []) { caller, args in
                guard let memory = caller.instance?.exports[memory: "memory"] else { return [] }
                let retPtr = UInt(args[3].i32)
                
                if let error = ScriptPermissions.shared.checkPermission(.calendar, appId: self.appId, script: self.scriptName) {
                    Self.writeReturnString(error, retPtr: retPtr, caller: caller, memory: memory)
                    return []
                }
                
                #if canImport(EventKit)
                let eventStore = EKEventStore()
                let calId: String? = args[0].i32 == 1
                    ? Self.readString(from: memory, ptr: UInt(args[1].i32), len: Int(args[2].i32))
                    : nil
                
                let calendars: [EKCalendar]?
                if let calId = calId {
                    calendars = eventStore.calendars(for: .reminder).filter { $0.calendarIdentifier == calId }
                } else {
                    calendars = nil
                }
                
                let predicate = eventStore.predicateForReminders(in: calendars)
                let reminders: [EKReminder] = Self.blockingAsync { completion in
                    eventStore.fetchReminders(matching: predicate) { fetched in
                        completion(fetched ?? [])
                    }
                }
                
                let items: [[String: Any]] = reminders.map { r in
                    var dict: [String: Any] = [
                        "id": r.calendarItemIdentifier,
                        "title": r.title ?? "",
                        "isCompleted": r.isCompleted
                    ]
                    if let due = r.dueDateComponents {
                        dict["dueDate"] = Calendar.current.date(from: due).map { ISO8601DateFormatter().string(from: $0) } ?? ""
                    }
                    return dict
                }
                let json = (try? JSONSerialization.data(withJSONObject: items)).flatMap { String(data: $0, encoding: .utf8) } ?? "[]"
                #else
                let json = "[]"
                #endif
                
                Self.writeReturnString(json, retPtr: retPtr, caller: caller, memory: memory)
                return []
            }
        )
        
        // authorization-status(ret_ptr) -> ()
        imports.define(module: module, name: "authorization-status",
            Function(store: store, parameters: [.i32], results: []) { caller, args in
                guard let memory = caller.instance?.exports[memory: "memory"] else { return [] }
                let retPtr = UInt(args[0].i32)
                
                #if canImport(EventKit)
                let status: String
                switch EKEventStore.authorizationStatus(for: .event) {
                case .authorized, .fullAccess: status = "authorized"
                case .writeOnly: status = "writeOnly"
                case .denied: status = "denied"
                case .restricted: status = "restricted"
                case .notDetermined: status = "notDetermined"
                @unknown default: status = "unknown"
                }
                #else
                let status = "unavailable"
                #endif
                
                Self.writeReturnString(status, retPtr: retPtr, caller: caller, memory: memory)
                return []
            }
        )
    }
    
    // MARK: - Tier 2: Notifications
    
    private func registerNotifications(_ imports: inout Imports, store: Store) {
        let module = "ios:bridge/notifications@0.1.0"
        
        // schedule(title_ptr, title_len, body_ptr, body_len, opt_flag, trigger_ptr, trigger_len, ret_ptr) -> ()
        imports.define(module: module, name: "schedule",
            Function(store: store, parameters: [.i32, .i32, .i32, .i32, .i32, .i32, .i32, .i32], results: []) { caller, args in
                guard let memory = caller.instance?.exports[memory: "memory"] else { return [] }
                let title = Self.readString(from: memory, ptr: UInt(args[0].i32), len: Int(args[1].i32))
                let body = Self.readString(from: memory, ptr: UInt(args[2].i32), len: Int(args[3].i32))
                let retPtr = UInt(args[7].i32)
                
                if let error = ScriptPermissions.shared.checkPermission(.notifications, appId: self.appId, script: self.scriptName) {
                    Self.writeReturnString(error, retPtr: retPtr, caller: caller, memory: memory)
                    return []
                }
                
                #if canImport(UserNotifications)
                let content = UNMutableNotificationContent()
                content.title = title
                content.body = body
                content.sound = .default
                
                let identifier = UUID().uuidString
                let trigger = UNTimeIntervalNotificationTrigger(timeInterval: 1, repeats: false)
                let request = UNNotificationRequest(identifier: identifier, content: content, trigger: trigger)
                UNUserNotificationCenter.current().add(request)
                Self.writeReturnString(identifier, retPtr: retPtr, caller: caller, memory: memory)
                #else
                Self.writeReturnString("{\"error\":\"unavailable\"}", retPtr: retPtr, caller: caller, memory: memory)
                #endif
                return []
            }
        )
        
        // cancel(id_ptr, id_len) -> ()
        imports.define(module: module, name: "cancel",
            Function(store: store, parameters: [.i32, .i32], results: []) { caller, args in
                guard let memory = caller.instance?.exports[memory: "memory"] else { return [] }
                let identifier = Self.readString(from: memory, ptr: UInt(args[0].i32), len: Int(args[1].i32))
                
                #if canImport(UserNotifications)
                UNUserNotificationCenter.current().removePendingNotificationRequests(withIdentifiers: [identifier])
                #endif
                return []
            }
        )
        
        // pending(ret_ptr) -> ()
        imports.define(module: module, name: "pending",
            Function(store: store, parameters: [.i32], results: []) { caller, args in
                guard let memory = caller.instance?.exports[memory: "memory"] else { return [] }
                let retPtr = UInt(args[0].i32)
                
                #if canImport(UserNotifications)
                let requests: [UNNotificationRequest] = Self.blockingAsync { completion in
                    UNUserNotificationCenter.current().getPendingNotificationRequests { reqs in
                        completion(reqs)
                    }
                }
                let items = requests.map { ["id": $0.identifier, "title": $0.content.title, "body": $0.content.body] }
                let json = (try? JSONSerialization.data(withJSONObject: items)).flatMap { String(data: $0, encoding: .utf8) } ?? "[]"
                #else
                let json = "[]"
                #endif
                
                Self.writeReturnString(json, retPtr: retPtr, caller: caller, memory: memory)
                return []
            }
        )
    }
    
    // MARK: - Tier 2: Clipboard
    
    private func registerClipboard(_ imports: inout Imports, store: Store) {
        let module = "ios:bridge/clipboard@0.1.0"
        
        // get-string(ret_ptr) -> () — writes option<string>
        imports.define(module: module, name: "get-string",
            Function(store: store, parameters: [.i32], results: []) { caller, args in
                guard let memory = caller.instance?.exports[memory: "memory"] else { return [] }
                let retPtr = UInt(args[0].i32)
                
                #if canImport(UIKit)
                if let str = UIPasteboard.general.string {
                    Self.writeOptionSome(str, retPtr: retPtr, caller: caller, memory: memory)
                } else {
                    Self.writeOptionNone(retPtr: retPtr, memory: memory)
                }
                #else
                Self.writeOptionNone(retPtr: retPtr, memory: memory)
                #endif
                return []
            }
        )
        
        // set-string(val_ptr, val_len) -> ()
        imports.define(module: module, name: "set-string",
            Function(store: store, parameters: [.i32, .i32], results: []) { caller, args in
                guard let memory = caller.instance?.exports[memory: "memory"] else { return [] }
                let value = Self.readString(from: memory, ptr: UInt(args[0].i32), len: Int(args[1].i32))
                
                #if canImport(UIKit)
                UIPasteboard.general.string = value
                #endif
                return []
            }
        )
    }
    
    // MARK: - Tier 3: Location
    
    private func registerLocation(_ imports: inout Imports, store: Store) {
        let module = "ios:bridge/location@0.1.0"
        
        // current(ret_ptr) -> ()
        imports.define(module: module, name: "current",
            Function(store: store, parameters: [.i32], results: []) { caller, args in
                guard let memory = caller.instance?.exports[memory: "memory"] else { return [] }
                let retPtr = UInt(args[0].i32)
                
                if let error = ScriptPermissions.shared.checkPermission(.location, appId: self.appId, script: self.scriptName) {
                    Self.writeReturnString(error, retPtr: retPtr, caller: caller, memory: memory)
                    return []
                }
                
                // CLLocationManager requires async; provide last known or stub
                #if canImport(CoreLocation)
                let manager = CLLocationManager()
                if let loc = manager.location {
                    let json = """
                    {"lat":\(loc.coordinate.latitude),"lng":\(loc.coordinate.longitude),"altitude":\(loc.altitude),"accuracy":\(loc.horizontalAccuracy)}
                    """
                    Self.writeReturnString(json, retPtr: retPtr, caller: caller, memory: memory)
                } else {
                    Self.writeReturnString("{\"error\":\"location_unavailable\"}", retPtr: retPtr, caller: caller, memory: memory)
                }
                #else
                Self.writeReturnString("{\"error\":\"unavailable\"}", retPtr: retPtr, caller: caller, memory: memory)
                #endif
                return []
            }
        )
        
        // geocode(addr_ptr, addr_len, ret_ptr) -> ()
        imports.define(module: module, name: "geocode",
            Function(store: store, parameters: [.i32, .i32, .i32], results: []) { caller, args in
                guard let memory = caller.instance?.exports[memory: "memory"] else { return [] }
                let address = Self.readString(from: memory, ptr: UInt(args[0].i32), len: Int(args[1].i32))
                let retPtr = UInt(args[2].i32)
                
                if let error = ScriptPermissions.shared.checkPermission(.location, appId: self.appId, script: self.scriptName) {
                    Self.writeReturnString(error, retPtr: retPtr, caller: caller, memory: memory)
                    return []
                }
                
                #if canImport(CoreLocation)
                let geocoder = CLGeocoder()
                let placemarks: [CLPlacemark] = Self.blockingAsync { completion in
                    geocoder.geocodeAddressString(address) { marks, error in
                        completion(marks ?? [])
                    }
                }
                
                let results: [[String: Any]] = placemarks.compactMap { pm in
                    guard let loc = pm.location else { return nil }
                    var dict: [String: Any] = [
                        "lat": loc.coordinate.latitude,
                        "lng": loc.coordinate.longitude
                    ]
                    if let name = pm.name { dict["name"] = name }
                    if let locality = pm.locality { dict["locality"] = locality }
                    if let country = pm.country { dict["country"] = country }
                    return dict
                }
                let json = (try? JSONSerialization.data(withJSONObject: results)).flatMap { String(data: $0, encoding: .utf8) } ?? "[]"
                #else
                let json = "[]"
                #endif
                
                Self.writeReturnString(json, retPtr: retPtr, caller: caller, memory: memory)
                return []
            }
        )
        
        // reverse-geocode(lat: f64, lng: f64, ret_ptr) -> ()
        imports.define(module: module, name: "reverse-geocode",
            Function(store: store, parameters: [.f64, .f64, .i32], results: []) { caller, args in
                guard let memory = caller.instance?.exports[memory: "memory"] else { return [] }
                let lat = Double(bitPattern: args[0].f64)
                let lng = Double(bitPattern: args[1].f64)
                let retPtr = UInt(args[2].i32)
                
                if let error = ScriptPermissions.shared.checkPermission(.location, appId: self.appId, script: self.scriptName) {
                    Self.writeReturnString(error, retPtr: retPtr, caller: caller, memory: memory)
                    return []
                }
                
                #if canImport(CoreLocation)
                let geocoder = CLGeocoder()
                let location = CLLocation(latitude: lat, longitude: lng)
                let placemarks: [CLPlacemark] = Self.blockingAsync { completion in
                    geocoder.reverseGeocodeLocation(location) { marks, error in
                        completion(marks ?? [])
                    }
                }
                
                if let pm = placemarks.first {
                    var dict: [String: Any] = [
                        "lat": lat,
                        "lng": lng
                    ]
                    if let name = pm.name { dict["name"] = name }
                    if let street = pm.thoroughfare { dict["street"] = street }
                    if let city = pm.locality { dict["city"] = city }
                    if let state = pm.administrativeArea { dict["state"] = state }
                    if let country = pm.country { dict["country"] = country }
                    if let postalCode = pm.postalCode { dict["postalCode"] = postalCode }
                    let json = (try? JSONSerialization.data(withJSONObject: dict)).flatMap { String(data: $0, encoding: .utf8) } ?? "{}"
                    Self.writeReturnString(json, retPtr: retPtr, caller: caller, memory: memory)
                } else {
                    Self.writeReturnString("{}", retPtr: retPtr, caller: caller, memory: memory)
                }
                #else
                Self.writeReturnString("{}", retPtr: retPtr, caller: caller, memory: memory)
                #endif
                return []
            }
        )
    }
    
    // MARK: - Tier 3: Health
    
    private func registerHealth(_ imports: inout Imports, store: Store) {
        let module = "ios:bridge/health@0.1.0"
        
        // query(type_ptr, type_len, start_ptr, start_len, end_ptr, end_len, opt_flag, limit, ret_ptr) -> ()
        imports.define(module: module, name: "query",
            Function(store: store, parameters: [.i32, .i32, .i32, .i32, .i32, .i32, .i32, .i32, .i32], results: []) { caller, args in
                guard let memory = caller.instance?.exports[memory: "memory"] else { return [] }
                let typeId = Self.readString(from: memory, ptr: UInt(args[0].i32), len: Int(args[1].i32))
                let startISO = Self.readString(from: memory, ptr: UInt(args[2].i32), len: Int(args[3].i32))
                let endISO = Self.readString(from: memory, ptr: UInt(args[4].i32), len: Int(args[5].i32))
                let optFlag = args[6].i32
                let limitVal = optFlag == 1 ? Int(args[7].i32) : 100
                let retPtr = UInt(args[8].i32)
                
                if let error = ScriptPermissions.shared.checkPermission(.health, appId: self.appId, script: self.scriptName) {
                    Self.writeReturnString(error, retPtr: retPtr, caller: caller, memory: memory)
                    return []
                }
                
                #if canImport(HealthKit)
                let healthStore = HKHealthStore()
                guard HKHealthStore.isHealthDataAvailable(),
                      let sampleType = Self.healthSampleType(for: typeId) else {
                    Self.writeReturnString("[]", retPtr: retPtr, caller: caller, memory: memory)
                    return []
                }
                
                let formatter = ISO8601DateFormatter()
                let startDate = formatter.date(from: startISO) ?? Date.distantPast
                let endDate = formatter.date(from: endISO) ?? Date()
                let predicate = HKQuery.predicateForSamples(withStart: startDate, end: endDate, options: .strictStartDate)
                let sortDesc = NSSortDescriptor(key: HKSampleSortIdentifierStartDate, ascending: false)
                
                let samples: [HKSample] = Self.blockingAsync { completion in
                    let query = HKSampleQuery(
                        sampleType: sampleType,
                        predicate: predicate,
                        limit: limitVal,
                        sortDescriptors: [sortDesc]
                    ) { _, results, error in
                        completion(results ?? [])
                    }
                    healthStore.execute(query)
                }
                
                let items: [[String: Any]] = samples.map { sample in
                    var dict: [String: Any] = [
                        "type": typeId,
                        "start": formatter.string(from: sample.startDate),
                        "end": formatter.string(from: sample.endDate)
                    ]
                    if let quantity = sample as? HKQuantitySample {
                        // Try common units
                        if let unit = Self.healthDefaultUnit(for: typeId) {
                            dict["value"] = quantity.quantity.doubleValue(for: unit)
                            dict["unit"] = unit.unitString
                        }
                    }
                    return dict
                }
                let json = (try? JSONSerialization.data(withJSONObject: items)).flatMap { String(data: $0, encoding: .utf8) } ?? "[]"
                #else
                let json = "[]"
                #endif
                
                Self.writeReturnString(json, retPtr: retPtr, caller: caller, memory: memory)
                return []
            }
        )
        
        // statistics(type_ptr, type_len, start_ptr, start_len, end_ptr, end_len, ret_ptr) -> ()
        imports.define(module: module, name: "statistics",
            Function(store: store, parameters: [.i32, .i32, .i32, .i32, .i32, .i32, .i32], results: []) { caller, args in
                guard let memory = caller.instance?.exports[memory: "memory"] else { return [] }
                let typeId = Self.readString(from: memory, ptr: UInt(args[0].i32), len: Int(args[1].i32))
                let startISO = Self.readString(from: memory, ptr: UInt(args[2].i32), len: Int(args[3].i32))
                let endISO = Self.readString(from: memory, ptr: UInt(args[4].i32), len: Int(args[5].i32))
                let retPtr = UInt(args[6].i32)
                
                if let error = ScriptPermissions.shared.checkPermission(.health, appId: self.appId, script: self.scriptName) {
                    Self.writeReturnString(error, retPtr: retPtr, caller: caller, memory: memory)
                    return []
                }
                
                #if canImport(HealthKit)
                let healthStore = HKHealthStore()
                guard HKHealthStore.isHealthDataAvailable(),
                      let quantityType = Self.healthQuantityType(for: typeId) else {
                    Self.writeReturnString("{}", retPtr: retPtr, caller: caller, memory: memory)
                    return []
                }
                
                let formatter = ISO8601DateFormatter()
                let startDate = formatter.date(from: startISO) ?? Date.distantPast
                let endDate = formatter.date(from: endISO) ?? Date()
                let predicate = HKQuery.predicateForSamples(withStart: startDate, end: endDate, options: .strictStartDate)
                
                let stats: HKStatistics? = Self.blockingAsync { completion in
                    let query = HKStatisticsQuery(
                        quantityType: quantityType,
                        quantitySamplePredicate: predicate,
                        options: [.cumulativeSum, .discreteAverage, .discreteMin, .discreteMax]
                    ) { _, result, error in
                        completion(result)
                    }
                    healthStore.execute(query)
                }
                
                if let stats = stats, let unit = Self.healthDefaultUnit(for: typeId) {
                    var dict: [String: Any] = [
                        "type": typeId,
                        "start": formatter.string(from: stats.startDate),
                        "end": formatter.string(from: stats.endDate)
                    ]
                    if let sum = stats.sumQuantity() { dict["sum"] = sum.doubleValue(for: unit) }
                    if let avg = stats.averageQuantity() { dict["average"] = avg.doubleValue(for: unit) }
                    if let min = stats.minimumQuantity() { dict["min"] = min.doubleValue(for: unit) }
                    if let max = stats.maximumQuantity() { dict["max"] = max.doubleValue(for: unit) }
                    dict["unit"] = unit.unitString
                    let json = (try? JSONSerialization.data(withJSONObject: dict)).flatMap { String(data: $0, encoding: .utf8) } ?? "{}"
                    Self.writeReturnString(json, retPtr: retPtr, caller: caller, memory: memory)
                } else {
                    Self.writeReturnString("{}", retPtr: retPtr, caller: caller, memory: memory)
                }
                #else
                Self.writeReturnString("{}", retPtr: retPtr, caller: caller, memory: memory)
                #endif
                return []
            }
        )
        
        // authorization-status(type_ptr, type_len, ret_ptr) -> ()
        imports.define(module: module, name: "authorization-status",
            Function(store: store, parameters: [.i32, .i32, .i32], results: []) { caller, args in
                guard let memory = caller.instance?.exports[memory: "memory"] else { return [] }
                let typeId = Self.readString(from: memory, ptr: UInt(args[0].i32), len: Int(args[1].i32))
                let retPtr = UInt(args[2].i32)
                
                #if canImport(HealthKit)
                let healthStore = HKHealthStore()
                guard HKHealthStore.isHealthDataAvailable(),
                      let objectType = Self.healthObjectType(for: typeId) else {
                    Self.writeReturnString("unavailable", retPtr: retPtr, caller: caller, memory: memory)
                    return []
                }
                let status: String
                switch healthStore.authorizationStatus(for: objectType) {
                case .notDetermined: status = "notDetermined"
                case .sharingDenied: status = "denied"
                case .sharingAuthorized: status = "authorized"
                @unknown default: status = "unknown"
                }
                #else
                let status = "unavailable"
                #endif
                Self.writeReturnString(status, retPtr: retPtr, caller: caller, memory: memory)
                return []
            }
        )
    }
    
    // MARK: - Tier 3: Keychain
    
    private func registerKeychain(_ imports: inout Imports, store: Store) {
        let module = "ios:bridge/keychain@0.1.0"
        
        // get(service_ptr, service_len, account_ptr, account_len, ret_ptr) -> () — option<string>
        imports.define(module: module, name: "get",
            Function(store: store, parameters: [.i32, .i32, .i32, .i32, .i32], results: []) { caller, args in
                guard let memory = caller.instance?.exports[memory: "memory"] else { return [] }
                let service = Self.readString(from: memory, ptr: UInt(args[0].i32), len: Int(args[1].i32))
                let account = Self.readString(from: memory, ptr: UInt(args[2].i32), len: Int(args[3].i32))
                let retPtr = UInt(args[4].i32)
                
                if !ScriptPermissions.shared.isGranted(.keychain, appId: self.appId, script: self.scriptName) {
                    Self.writeOptionNone(retPtr: retPtr, memory: memory)
                    return []
                }
                
                let query: [String: Any] = [
                    kSecClass as String: kSecClassGenericPassword,
                    kSecAttrService as String: "ios-bridge.\(service)",
                    kSecAttrAccount as String: account,
                    kSecReturnData as String: true,
                    kSecMatchLimit as String: kSecMatchLimitOne
                ]
                
                var result: AnyObject?
                let status = SecItemCopyMatching(query as CFDictionary, &result)
                
                if status == errSecSuccess, let data = result as? Data, let str = String(data: data, encoding: .utf8) {
                    Self.writeOptionSome(str, retPtr: retPtr, caller: caller, memory: memory)
                } else {
                    Self.writeOptionNone(retPtr: retPtr, memory: memory)
                }
                return []
            }
        )
        
        // set(service_ptr, service_len, account_ptr, account_len, val_ptr, val_len) -> i32 (bool)
        imports.define(module: module, name: "set",
            Function(store: store, parameters: [.i32, .i32, .i32, .i32, .i32, .i32], results: [.i32]) { caller, args in
                guard let memory = caller.instance?.exports[memory: "memory"] else { return [.i32(0)] }
                let service = Self.readString(from: memory, ptr: UInt(args[0].i32), len: Int(args[1].i32))
                let account = Self.readString(from: memory, ptr: UInt(args[2].i32), len: Int(args[3].i32))
                let value = Self.readString(from: memory, ptr: UInt(args[4].i32), len: Int(args[5].i32))
                
                guard ScriptPermissions.shared.isGranted(.keychain, appId: self.appId, script: self.scriptName) else { return [.i32(0)] }
                
                // Delete existing, then add
                let deleteQuery: [String: Any] = [
                    kSecClass as String: kSecClassGenericPassword,
                    kSecAttrService as String: "ios-bridge.\(service)",
                    kSecAttrAccount as String: account
                ]
                SecItemDelete(deleteQuery as CFDictionary)
                
                let addQuery: [String: Any] = [
                    kSecClass as String: kSecClassGenericPassword,
                    kSecAttrService as String: "ios-bridge.\(service)",
                    kSecAttrAccount as String: account,
                    kSecValueData as String: value.data(using: .utf8) ?? Data()
                ]
                let status = SecItemAdd(addQuery as CFDictionary, nil)
                return [.i32(status == errSecSuccess ? 1 : 0)]
            }
        )
        
        // remove(service_ptr, service_len, account_ptr, account_len) -> i32 (bool)
        imports.define(module: module, name: "remove",
            Function(store: store, parameters: [.i32, .i32, .i32, .i32], results: [.i32]) { caller, args in
                guard let memory = caller.instance?.exports[memory: "memory"] else { return [.i32(0)] }
                let service = Self.readString(from: memory, ptr: UInt(args[0].i32), len: Int(args[1].i32))
                let account = Self.readString(from: memory, ptr: UInt(args[2].i32), len: Int(args[3].i32))
                
                guard ScriptPermissions.shared.isGranted(.keychain, appId: self.appId, script: self.scriptName) else { return [.i32(0)] }
                
                let query: [String: Any] = [
                    kSecClass as String: kSecClassGenericPassword,
                    kSecAttrService as String: "ios-bridge.\(service)",
                    kSecAttrAccount as String: account
                ]
                let status = SecItemDelete(query as CFDictionary)
                return [.i32(status == errSecSuccess ? 1 : 0)]
            }
        )
    }
    
    // MARK: - Tier 3: Photos
    
    private func registerPhotos(_ imports: inout Imports, store: Store) {
        let module = "ios:bridge/photos@0.1.0"
        
        // search(opts_ptr, opts_len, ret_ptr) -> ()
        imports.define(module: module, name: "search",
            Function(store: store, parameters: [.i32, .i32, .i32], results: []) { caller, args in
                guard let memory = caller.instance?.exports[memory: "memory"] else { return [] }
                let optsJson = Self.readString(from: memory, ptr: UInt(args[0].i32), len: Int(args[1].i32))
                let retPtr = UInt(args[2].i32)
                
                if let error = ScriptPermissions.shared.checkPermission(.photos, appId: self.appId, script: self.scriptName) {
                    Self.writeReturnString(error, retPtr: retPtr, caller: caller, memory: memory)
                    return []
                }
                
                #if canImport(Photos)
                let fetchOptions = PHFetchOptions()
                fetchOptions.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: false)]
                
                // Parse options for limit and mediaType
                var limit = 50
                if let data = optsJson.data(using: .utf8),
                   let opts = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                    if let l = opts["limit"] as? Int { limit = l }
                    if let mediaType = opts["mediaType"] as? String {
                        switch mediaType {
                        case "image": fetchOptions.predicate = NSPredicate(format: "mediaType == %d", PHAssetMediaType.image.rawValue)
                        case "video": fetchOptions.predicate = NSPredicate(format: "mediaType == %d", PHAssetMediaType.video.rawValue)
                        default: break
                        }
                    }
                }
                fetchOptions.fetchLimit = limit
                
                let result = PHAsset.fetchAssets(with: fetchOptions)
                let formatter = ISO8601DateFormatter()
                var assets: [[String: Any]] = []
                result.enumerateObjects { asset, _, _ in
                    var dict: [String: Any] = [
                        "id": asset.localIdentifier,
                        "mediaType": asset.mediaType == .image ? "image" : asset.mediaType == .video ? "video" : "unknown",
                        "width": asset.pixelWidth,
                        "height": asset.pixelHeight
                    ]
                    if let date = asset.creationDate {
                        dict["creationDate"] = formatter.string(from: date)
                    }
                    assets.append(dict)
                }
                let json = (try? JSONSerialization.data(withJSONObject: assets)).flatMap { String(data: $0, encoding: .utf8) } ?? "[]"
                #else
                let json = "[]"
                #endif
                
                Self.writeReturnString(json, retPtr: retPtr, caller: caller, memory: memory)
                return []
            }
        )
        
        // asset(id_ptr, id_len, ret_ptr) -> () — option<string>
        imports.define(module: module, name: "asset",
            Function(store: store, parameters: [.i32, .i32, .i32], results: []) { caller, args in
                guard let memory = caller.instance?.exports[memory: "memory"] else { return [] }
                let identifier = Self.readString(from: memory, ptr: UInt(args[0].i32), len: Int(args[1].i32))
                let retPtr = UInt(args[2].i32)
                
                if !ScriptPermissions.shared.isGranted(.photos, appId: self.appId, script: self.scriptName) {
                    Self.writeOptionNone(retPtr: retPtr, memory: memory)
                    return []
                }
                
                #if canImport(Photos)
                let result = PHAsset.fetchAssets(withLocalIdentifiers: [identifier], options: nil)
                if let asset = result.firstObject {
                    let formatter = ISO8601DateFormatter()
                    var dict: [String: Any] = [
                        "id": asset.localIdentifier,
                        "mediaType": asset.mediaType == .image ? "image" : asset.mediaType == .video ? "video" : "unknown",
                        "width": asset.pixelWidth,
                        "height": asset.pixelHeight,
                        "duration": asset.duration,
                        "isFavorite": asset.isFavorite
                    ]
                    if let date = asset.creationDate {
                        dict["creationDate"] = formatter.string(from: date)
                    }
                    if let json = (try? JSONSerialization.data(withJSONObject: dict)).flatMap({ String(data: $0, encoding: .utf8) }) {
                        Self.writeOptionSome(json, retPtr: retPtr, caller: caller, memory: memory)
                    } else {
                        Self.writeOptionNone(retPtr: retPtr, memory: memory)
                    }
                } else {
                    Self.writeOptionNone(retPtr: retPtr, memory: memory)
                }
                #else
                Self.writeOptionNone(retPtr: retPtr, memory: memory)
                #endif
                return []
            }
        )
        
        // albums(ret_ptr) -> ()
        imports.define(module: module, name: "albums",
            Function(store: store, parameters: [.i32], results: []) { caller, args in
                guard let memory = caller.instance?.exports[memory: "memory"] else { return [] }
                let retPtr = UInt(args[0].i32)
                
                if let error = ScriptPermissions.shared.checkPermission(.photos, appId: self.appId, script: self.scriptName) {
                    Self.writeReturnString(error, retPtr: retPtr, caller: caller, memory: memory)
                    return []
                }
                
                #if canImport(Photos)
                let smartAlbums = PHAssetCollection.fetchAssetCollections(with: .smartAlbum, subtype: .any, options: nil)
                let userAlbums = PHAssetCollection.fetchAssetCollections(with: .album, subtype: .any, options: nil)
                
                var albums: [[String: Any]] = []
                for collection in [smartAlbums, userAlbums] {
                    collection.enumerateObjects { coll, _, _ in
                        let count = PHAsset.fetchAssets(in: coll, options: nil).count
                        albums.append([
                            "id": coll.localIdentifier,
                            "title": coll.localizedTitle ?? "Untitled",
                            "count": count
                        ])
                    }
                }
                let json = (try? JSONSerialization.data(withJSONObject: albums)).flatMap { String(data: $0, encoding: .utf8) } ?? "[]"
                #else
                let json = "[]"
                #endif
                
                Self.writeReturnString(json, retPtr: retPtr, caller: caller, memory: memory)
                return []
            }
        )
    }
    
    // MARK: - Option Helpers
    
    /// Write option<string> = Some(value) to WASM memory at retPtr.
    private static func writeOptionSome(_ value: String, retPtr: UInt, caller: Caller, memory: Memory) {
        let (dataPtr, dataLen) = writeStringToWasm(value, caller: caller, memory: memory)
        memory.withUnsafeMutableBufferPointer(offset: retPtr, count: 12) { buf in
            buf[0] = 1 // discriminant = Some
            buf.storeBytes(of: dataPtr.littleEndian, toByteOffset: 4, as: UInt32.self)
            buf.storeBytes(of: dataLen.littleEndian, toByteOffset: 8, as: UInt32.self)
        }
    }
    
    /// Write option<string> = None to WASM memory at retPtr.
    private static func writeOptionNone(retPtr: UInt, memory: Memory) {
        memory.withUnsafeMutableBufferPointer(offset: retPtr, count: 12) { buf in
            buf[0] = 0 // discriminant = None
        }
    }
    
    /// Write a string return value (ptr, len) to WASM memory at retPtr.
    private static func writeReturnString(_ value: String, retPtr: UInt, caller: Caller, memory: Memory) {
        let (strPtr, strLen) = writeStringToWasm(value, caller: caller, memory: memory)
        memory.withUnsafeMutableBufferPointer(offset: retPtr, count: 8) { buf in
            buf.storeBytes(of: strPtr.littleEndian, as: UInt32.self)
            buf.storeBytes(of: strLen.littleEndian, toByteOffset: 4, as: UInt32.self)
        }
    }
    
    // MARK: - HealthKit Type Helpers
    
    #if canImport(HealthKit)
    /// Map a string type ID (e.g. "stepCount") to an HKSampleType.
    private static func healthSampleType(for typeId: String) -> HKSampleType? {
        if let qt = healthQuantityType(for: typeId) { return qt }
        // Add category types if needed
        return nil
    }
    
    /// Map a string type ID to an HKQuantityType.
    private static func healthQuantityType(for typeId: String) -> HKQuantityType? {
        let identifier: HKQuantityTypeIdentifier
        switch typeId {
        case "stepCount": identifier = .stepCount
        case "heartRate": identifier = .heartRate
        case "activeEnergyBurned": identifier = .activeEnergyBurned
        case "basalEnergyBurned": identifier = .basalEnergyBurned
        case "distanceWalkingRunning": identifier = .distanceWalkingRunning
        case "distanceCycling": identifier = .distanceCycling
        case "flightsClimbed": identifier = .flightsClimbed
        case "bodyMass": identifier = .bodyMass
        case "height": identifier = .height
        case "bodyMassIndex": identifier = .bodyMassIndex
        case "bloodPressureSystolic": identifier = .bloodPressureSystolic
        case "bloodPressureDiastolic": identifier = .bloodPressureDiastolic
        case "bloodGlucose": identifier = .bloodGlucose
        case "oxygenSaturation": identifier = .oxygenSaturation
        case "bodyTemperature": identifier = .bodyTemperature
        case "respiratoryRate": identifier = .respiratoryRate
        default: return nil
        }
        return HKQuantityType.quantityType(forIdentifier: identifier)
    }
    
    /// Map a string type ID to an HKObjectType (for authorization checks).
    private static func healthObjectType(for typeId: String) -> HKObjectType? {
        return healthQuantityType(for: typeId)
    }
    
    /// Default unit for common HealthKit types.
    private static func healthDefaultUnit(for typeId: String) -> HKUnit? {
        switch typeId {
        case "stepCount", "flightsClimbed": return .count()
        case "heartRate": return HKUnit.count().unitDivided(by: .minute())
        case "activeEnergyBurned", "basalEnergyBurned": return .kilocalorie()
        case "distanceWalkingRunning", "distanceCycling": return .meter()
        case "bodyMass": return .gramUnit(with: .kilo)
        case "height": return .meterUnit(with: .centi)
        case "bodyMassIndex": return .count()
        case "bloodPressureSystolic", "bloodPressureDiastolic": return .millimeterOfMercury()
        case "bloodGlucose": return HKUnit.gramUnit(with: .milli).unitDivided(by: .literUnit(with: .deci))
        case "oxygenSaturation": return .percent()
        case "bodyTemperature": return .degreeCelsius()
        case "respiratoryRate": return HKUnit.count().unitDivided(by: .minute())
        default: return nil
        }
    }
    #endif
}
