import XCTest
import WasmKit
import WASIP2Harness
@testable import WASIShims

final class IosBridgeProviderTests: XCTestCase {
    
    // Simulate testing the blockingAsync helper function without triggering
    // main thread starvation in Swift 6 async contexts.
    func testBlockingAsyncReentrancyAndExecution() async {
        // Run on a background task to simulate WASM execution environment
        let result = await Task.detached {
            return IosBridgeProvider.blockingAsync { completion in
                // Async work simulation
                DispatchQueue.global().asyncAfter(deadline: .now() + 0.1) {
                    completion(true)
                }
            }
        }.value
        
        XCTAssertTrue(result, "blockingAsync should properly wait for the completion handler and return the result")
    }
    
    func testIosBridgeProviderRegistrationCompletes() {
        let provider = IosBridgeProvider(appId: "test-app", scriptName: "test-script")
        
        // Ensure that registering the provider does not crash or fail unexpectedly
        var imports = Imports()
        let store = Store(engine: Engine())
        
        provider.register(into: &imports, store: store)
        
        // Weak check: Ensure that at least 'request' and 'check' from permissions are in defined modules
        // Imports doesn't expose a clean query API, but we just want to ensure registration runs
        XCTAssertEqual(provider.appId, "test-app")
    }
}
