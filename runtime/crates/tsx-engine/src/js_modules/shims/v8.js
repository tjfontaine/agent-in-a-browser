// v8.js - Node.js v8 module stub (V8-specific APIs not available in QuickJS)

(function () {
    function getHeapStatistics() {
        return {
            total_heap_size: 0,
            total_heap_size_executable: 0,
            total_physical_size: 0,
            total_available_size: 0,
            used_heap_size: 0,
            heap_size_limit: 0,
            malloced_memory: 0,
            peak_malloced_memory: 0,
            does_zap_garbage: 0,
            number_of_native_contexts: 0,
            number_of_detached_contexts: 0
        };
    }

    function getHeapSpaceStatistics() {
        return [];
    }

    function getHeapCodeStatistics() {
        return {
            code_and_metadata_size: 0,
            bytecode_and_metadata_size: 0,
            external_script_source_size: 0
        };
    }

    function getHeapSnapshot() {
        return {
            read: function () { return null; }
        };
    }

    function writeHeapSnapshot(filename) {
        return filename || 'heapdump.heapsnapshot';
    }

    function setFlagsFromString(flags) {
        // no-op: V8 flags not applicable in QuickJS
    }

    function serialize(value) {
        return JSON.stringify(value);
    }

    function deserialize(buffer) {
        return JSON.parse(buffer);
    }

    function cachedDataVersionTag() {
        return 0;
    }

    function takeCoverage() {
        // no-op
    }

    function stopCoverage() {
        // no-op
    }

    var module = {
        getHeapStatistics: getHeapStatistics,
        getHeapSpaceStatistics: getHeapSpaceStatistics,
        getHeapCodeStatistics: getHeapCodeStatistics,
        getHeapSnapshot: getHeapSnapshot,
        writeHeapSnapshot: writeHeapSnapshot,
        setFlagsFromString: setFlagsFromString,
        serialize: serialize,
        deserialize: deserialize,
        cachedDataVersionTag: cachedDataVersionTag,
        takeCoverage: takeCoverage,
        stopCoverage: stopCoverage
    };

    globalThis.__tsxBuiltinModules.set('v8', module);
    globalThis.__tsxBuiltinModules.set('node:v8', module);
})();
