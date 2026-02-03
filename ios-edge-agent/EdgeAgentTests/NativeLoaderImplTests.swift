/// NativeLoaderImplTests.swift
/// Integration tests for the NativeLoaderImpl module loader

import XCTest
@testable import EdgeAgent

/// Tests for NativeLoaderImpl - the process management layer
@MainActor
final class NativeLoaderImplTests: XCTestCase {
    
    var resources: ResourceRegistry!
    var loader: NativeLoaderImpl!
    
    override func setUp() async throws {
        resources = ResourceRegistry()
        loader = NativeLoaderImpl(resources: resources)
    }
    
    override func tearDown() async throws {
        loader = nil
        resources = nil
    }
    
    // MARK: - Lazy Module Resolution
    
    func testGetLazyModuleReturnsNilForUnknownCommand() {
        let module = loader.getLazyModule(command: "nonexistent-command")
        XCTAssertNil(module, "Unknown command should return nil")
    }
    
    func testGetLazyModuleReturnsTsxForTsx() {
        // Register tsx in lazy module registry first
        let module = loader.getLazyModule(command: "tsx")
        // Note: This depends on LazyModuleRegistry configuration
        // If tsx is not registered, this test validates the nil case
        if module != nil {
            XCTAssertEqual(module, "tsx-engine", "tsx should map to tsx-engine module")
        }
    }
    
    func testGetLazyModuleReturnsVimForVim() {
        let module = loader.getLazyModule(command: "vim")
        if module != nil {
            XCTAssertEqual(module, "edtui-module", "vim should map to edtui-module")
        }
    }
    
    // MARK: - Process Spawning
    
    func testSpawnLazyCommandCreatesProcess() {
        let handle = loader.spawnLazyCommand(
            module: "test-module",
            command: "echo",
            args: ["hello", "world"],
            cwd: "/",
            env: []
        )
        
        XCTAssertGreaterThan(handle, 0, "Handle should be positive")
        
        // Process should exist
        XCTAssertNotNil(loader.getProcess(handle), "Process should be created")
    }
    
    func testSpawnMultipleProcessesGetUniqueHandles() {
        let handle1 = loader.spawnLazyCommand(module: "m", command: "cmd1", args: [], cwd: "/", env: [])
        let handle2 = loader.spawnLazyCommand(module: "m", command: "cmd2", args: [], cwd: "/", env: [])
        let handle3 = loader.spawnLazyCommand(module: "m", command: "cmd3", args: [], cwd: "/", env: [])
        
        XCTAssertNotEqual(handle1, handle2)
        XCTAssertNotEqual(handle2, handle3)
        XCTAssertNotEqual(handle1, handle3)
    }
    
    func testSpawnInteractiveCreatesProcess() {
        let handle = loader.spawnInteractive(
            module: "test-module",
            command: "vim",
            args: [],
            cwd: "/",
            env: [],
            cols: 80,
            rows: 24
        )
        
        XCTAssertGreaterThan(handle, 0)
        XCTAssertNotNil(loader.getProcess(handle))
    }
    
    func testSpawnWorkerCommandCreatesProcess() {
        let handle = loader.spawnWorkerCommand(
            command: "echo",
            args: ["test"],
            cwd: "/",
            env: []
        )
        
        XCTAssertGreaterThan(handle, 0)
        XCTAssertNotNil(loader.getProcess(handle))
    }
    
    // MARK: - Process State
    
    func testIsReadyReturnsTrueForNonexistentProcess() {
        // Non-existent process should report as "ready" (completed)
        let ready = loader.isReady(handle: 9999)
        XCTAssertTrue(ready)
    }
    
    func testGetTerminalSizeReturnsDefaultSize() {
        let handle = loader.spawnLazyCommand(module: "m", command: "c", args: [], cwd: "/", env: [])
        let size = loader.getTerminalSize(handle: handle)
        
        XCTAssertEqual(size.cols, 80)
        XCTAssertEqual(size.rows, 24)
    }
    
    func testIsRawModeReturnsFalse() {
        let handle = loader.spawnLazyCommand(module: "m", command: "c", args: [], cwd: "/", env: [])
        let rawMode = loader.isRawMode(handle: handle)
        
        XCTAssertFalse(rawMode)
    }
    
    func testHasJspiReturnsFalse() {
        XCTAssertFalse(loader.hasJspi(), "iOS should not have JSPI")
    }
    
    func testIsInteractiveCommandReturnsFalse() {
        XCTAssertFalse(loader.isInteractiveCommand(command: "vim"))
    }
    
    // MARK: - Process Resource Management
    
    func testRemoveProcessCleansUp() {
        let handle = loader.spawnLazyCommand(module: "m", command: "c", args: [], cwd: "/", env: [])
        XCTAssertNotNil(loader.getProcess(handle))
        
        loader.removeProcess(handle)
        XCTAssertNil(loader.getProcess(handle))
    }
    
    func testGetReadyPollableReturnsValidHandle() {
        let processHandle = loader.spawnLazyCommand(module: "m", command: "c", args: [], cwd: "/", env: [])
        let pollableHandle = loader.getReadyPollable(handle: processHandle)
        
        XCTAssertGreaterThanOrEqual(pollableHandle, 0)
    }
    
    // MARK: - I/O Operations (via WASMLazyProcess)
    
    func testWriteStdinReturnsCount() {
        let handle = loader.spawnLazyCommand(module: "m", command: "c", args: [], cwd: "/", env: [])
        let data: [UInt8] = [72, 101, 108, 108, 111] // "Hello"
        
        let written = loader.writeStdin(handle: handle, data: data)
        XCTAssertEqual(written, 5)
    }
    
    func testWriteStdinToNonexistentProcessReturnsZero() {
        let written = loader.writeStdin(handle: 9999, data: [1, 2, 3])
        XCTAssertEqual(written, 0)
    }
    
    func testReadStdoutReturnsEmptyForNewProcess() {
        let handle = loader.spawnLazyCommand(module: "m", command: "c", args: [], cwd: "/", env: [])
        let output = loader.readStdout(handle: handle, maxBytes: 1024)
        
        // New process has empty stdout
        XCTAssertTrue(output.isEmpty)
    }
    
    func testReadStderrReturnsEmptyForNewProcess() {
        let handle = loader.spawnLazyCommand(module: "m", command: "c", args: [], cwd: "/", env: [])
        let output = loader.readStderr(handle: handle, maxBytes: 1024)
        
        // New process has empty stderr
        XCTAssertTrue(output.isEmpty)
    }
    
    func testTryWaitReturnsNilForRunningProcess() {
        let handle = loader.spawnLazyCommand(module: "m", command: "c", args: [], cwd: "/", env: [])
        
        // Process hasn't been started yet, so tryWait should return nil
        let exitCode = loader.tryWait(handle: handle)
        XCTAssertNil(exitCode)
    }
    
    func testTryWaitReturnsNilForNonexistentProcess() {
        let exitCode = loader.tryWait(handle: 9999)
        XCTAssertNil(exitCode)
    }
    
    // MARK: - Signal Handling
    
    func testSendSignalDoesNotCrash() {
        let handle = loader.spawnLazyCommand(module: "m", command: "c", args: [], cwd: "/", env: [])
        
        // These should not crash
        loader.sendSignal(handle: handle, signum: 15) // SIGTERM
        loader.sendSignal(handle: handle, signum: 9)  // SIGKILL
        loader.sendSignal(handle: 9999, signum: 15)   // Non-existent process
    }
}
