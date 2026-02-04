import Testing
import Foundation
@testable import WASIP2Harness

/// Tests for ResourceRegistry - the core handle management system
@Suite("ResourceRegistry")
struct ResourceRegistryTests {
    
    @Test("Register returns unique handles")
    func testRegisterReturnsUniqueHandles() {
        let registry = ResourceRegistry()
        
        let obj1 = NSObject()
        let obj2 = NSObject()
        let obj3 = NSObject()
        
        let handle1 = registry.register(obj1)
        let handle2 = registry.register(obj2)
        let handle3 = registry.register(obj3)
        
        #expect(handle1 != handle2)
        #expect(handle2 != handle3)
        #expect(handle1 != handle3)
    }
    
    @Test("Get returns correct resource")
    func testGetReturnsCorrectResource() {
        let registry = ResourceRegistry()
        
        let obj = NSObject()
        let handle = registry.register(obj)
        
        let retrieved: NSObject? = registry.get(handle)
        #expect(retrieved === obj)
    }
    
    @Test("Get returns nil for invalid handle")
    func testGetReturnsNilForInvalidHandle() {
        let registry = ResourceRegistry()
        
        let retrieved: NSObject? = registry.get(999)
        #expect(retrieved == nil)
    }
    
    @Test("Drop removes resource")
    func testDropRemovesResource() {
        let registry = ResourceRegistry()
        
        let obj = NSObject()
        let handle = registry.register(obj)
        
        // Verify it's there first
        let beforeDrop: NSObject? = registry.get(handle)
        #expect(beforeDrop != nil)
        
        // Drop it
        registry.drop(handle)
        
        // Verify it's gone
        let afterDrop: NSObject? = registry.get(handle)
        #expect(afterDrop == nil)
    }
    
    @Test("Concurrent access is thread-safe")
    func testConcurrentAccess() async {
        let registry = ResourceRegistry()
        let iterations = 100
        
        // Perform concurrent registrations
        await withTaskGroup(of: Int32.self) { group in
            for _ in 0..<iterations {
                group.addTask {
                    let obj = NSObject()
                    return registry.register(obj)
                }
            }
            
            var handles = Set<Int32>()
            for await handle in group {
                handles.insert(handle)
            }
            
            // All handles should be unique
            #expect(handles.count == iterations)
        }
    }
}
