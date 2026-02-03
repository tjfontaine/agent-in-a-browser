import Foundation
import WasmKit
import WasmParser
import OSLog

/// Shared WASI import implementations for WasmKit hosts.
/// Both NativeAgentHost and NativeMCPHost can use these.
@MainActor
enum SharedWASIImports {
    
    // MARK: - wasi_snapshot_preview1
    
    static func registerPreview1(
        _ imports: inout Imports,
        store: Store,
        resources: ResourceRegistry,
        filesystem: SandboxFilesystem? = nil
    ) {
        let module = "wasi_snapshot_preview1"
        let fs = filesystem ?? SandboxFilesystem.shared
        
        // environ_get: (environ_ptr, environ_buf_ptr) -> errno
        imports.define(module: module, name: "environ_get",
            Function(store: store, parameters: [.i32, .i32], results: [.i32]) { _, _ in
                return [.i32(0)]  // Success, no env vars
            }
        )
        
        // environ_sizes_get: (count_ptr, buf_size_ptr) -> errno
        imports.define(module: module, name: "environ_sizes_get",
            Function(store: store, parameters: [.i32, .i32], results: [.i32]) { caller, args in
                if let memory = caller.instance?.exports[memory: "memory"] {
                    let countPtr = UInt(args[0].i32)
                    let sizePtr = UInt(args[1].i32)
                    memory.withUnsafeMutableBufferPointer(offset: countPtr, count: 4) { buffer in
                        buffer.storeBytes(of: UInt32(0).littleEndian, as: UInt32.self)
                    }
                    memory.withUnsafeMutableBufferPointer(offset: sizePtr, count: 4) { buffer in
                        buffer.storeBytes(of: UInt32(0).littleEndian, as: UInt32.self)
                    }
                }
                return [.i32(0)]
            }
        )
        
        // fd_close
        imports.define(module: module, name: "fd_close",
            Function(store: store, parameters: [.i32], results: [.i32]) { _, args in
                let fd = Int32(bitPattern: args[0].i32)
                let result = fs.fdClose(fd)
                switch result {
                case .success: return [.i32(0)]
                case .failure(let error): return [.i32(UInt32(error.rawValue))]
                }
            }
        )
        
        // fd_prestat_get: (fd, prestat_ptr) -> errno
        imports.define(module: module, name: "fd_prestat_get",
            Function(store: store, parameters: [.i32, .i32], results: [.i32]) { caller, args in
                let fd = Int32(bitPattern: args[0].i32)
                let prestatPtr = UInt(args[1].i32)
                
                let result = fs.fdPrestatGet(fd: fd)
                guard case .success(let (prType, path)) = result else {
                    return [.i32(8)]  // EBADF
                }
                
                // Write prestat struct: { u8 pr_type, [3 bytes padding], u32 pr_name_len }
                if let memory = caller.instance?.exports[memory: "memory"] {
                    let pathLen = UInt32(path.utf8.count)
                    memory.withUnsafeMutableBufferPointer(offset: prestatPtr, count: 8) { buffer in
                        buffer[0] = UInt8(prType)  // PR_TYPE_DIR = 0
                        buffer[1] = 0
                        buffer[2] = 0
                        buffer[3] = 0
                        buffer.storeBytes(of: pathLen.littleEndian, toByteOffset: 4, as: UInt32.self)
                    }
                }
                return [.i32(0)]
            }
        )
        
        // fd_prestat_dir_name
        imports.define(module: module, name: "fd_prestat_dir_name",
            Function(store: store, parameters: [.i32, .i32, .i32], results: [.i32]) { caller, args in
                let fd = Int32(bitPattern: args[0].i32)
                let pathPtr = UInt(args[1].i32)
                let pathLen = Int(args[2].i32)
                
                let result = fs.fdPrestatGet(fd: fd)
                guard case .success(let (_, path)) = result else {
                    return [.i32(8)]  // EBADF
                }
                
                // Write path to memory
                if let memory = caller.instance?.exports[memory: "memory"] {
                    let pathBytes = Array(path.utf8)
                    let writeLen = min(pathLen, pathBytes.count)
                    memory.withUnsafeMutableBufferPointer(offset: pathPtr, count: writeLen) { buffer in
                        for (i, byte) in pathBytes.prefix(writeLen).enumerated() {
                            buffer[i] = byte
                        }
                    }
                }
                return [.i32(0)]
            }
        )
        
        // fd_read
        imports.define(module: module, name: "fd_read",
            Function(store: store, parameters: [.i32, .i32, .i32, .i32], results: [.i32]) { caller, args in
                guard let memory = caller.instance?.exports[memory: "memory"] else {
                    return [.i32(8)]  // EBADF
                }
                
                let fd = Int32(bitPattern: args[0].i32)
                let iovsPtr = UInt(args[1].i32)
                let iovsLen = Int(args[2].i32)
                let nreadPtr = UInt(args[3].i32)
                
                // Stdin (fd 0) returns empty
                if fd == 0 {
                    memory.withUnsafeMutableBufferPointer(offset: nreadPtr, count: 4) { buffer in
                        buffer.storeBytes(of: UInt32(0).littleEndian, as: UInt32.self)
                    }
                    return [.i32(0)]
                }
                
                // Calculate total requested bytes
                var totalRequested: UInt32 = 0
                for i in 0..<iovsLen {
                    let iovOffset = iovsPtr + UInt(i * 8)
                    var len: UInt32 = 0
                    memory.withUnsafeMutableBufferPointer(offset: iovOffset, count: 8) { buffer in
                        len = buffer.load(fromByteOffset: 4, as: UInt32.self).littleEndian
                    }
                    totalRequested += len
                }
                
                // Read from filesystem
                let result = fs.fdRead(fd, length: totalRequested)
                guard case .success(let data) = result else {
                    if case .failure(let error) = result {
                        return [.i32(UInt32(error.rawValue))]
                    }
                    return [.i32(8)]  // EBADF fallback
                }
                
                // Copy data to iovecs
                var offset = 0
                var totalRead: UInt32 = 0
                for i in 0..<iovsLen {
                    if offset >= data.count { break }
                    let iovOffset = iovsPtr + UInt(i * 8)
                    var ptr: UInt32 = 0
                    var len: UInt32 = 0
                    memory.withUnsafeMutableBufferPointer(offset: iovOffset, count: 8) { buffer in
                        ptr = buffer.load(as: UInt32.self).littleEndian
                        len = buffer.load(fromByteOffset: 4, as: UInt32.self).littleEndian
                    }
                    let copyLen = min(Int(len), data.count - offset)
                    if copyLen > 0 {
                        memory.withUnsafeMutableBufferPointer(offset: UInt(ptr), count: copyLen) { buffer in
                            for j in 0..<copyLen {
                                buffer[j] = data[offset + j]
                            }
                        }
                        offset += copyLen
                        totalRead += UInt32(copyLen)
                    }
                }
                
                // Write bytes read
                memory.withUnsafeMutableBufferPointer(offset: nreadPtr, count: 4) { buffer in
                    buffer.storeBytes(of: totalRead.littleEndian, as: UInt32.self)
                }
                return [.i32(0)]
            }
        )
        
        // fd_write - write to stdout/stderr
        imports.define(module: module, name: "fd_write",
            Function(store: store, parameters: [.i32, .i32, .i32, .i32], results: [.i32]) { caller, args in
                guard let memory = caller.instance?.exports[memory: "memory"] else {
                    return [.i32(8)]  // EBADF
                }
                
                let fd = Int(args[0].i32)
                let iovs = UInt(args[1].i32)
                let iovsLen = Int(args[2].i32)
                let nwrittenPtr = UInt(args[3].i32)
                
                var totalWritten: UInt32 = 0
                
                for i in 0..<iovsLen {
                    let iovOffset = iovs + UInt(i * 8)
                    var ptr: UInt32 = 0
                    var len: UInt32 = 0
                    
                    memory.withUnsafeMutableBufferPointer(offset: iovOffset, count: 8) { buffer in
                        ptr = buffer.load(as: UInt32.self).littleEndian
                        len = buffer.load(fromByteOffset: 4, as: UInt32.self).littleEndian
                    }
                    
                    if len > 0 {
                        var bytes = [UInt8](repeating: 0, count: Int(len))
                        memory.withUnsafeMutableBufferPointer(offset: UInt(ptr), count: Int(len)) { buffer in
                            for j in 0..<Int(len) {
                                bytes[j] = buffer[j]
                            }
                        }
                        
                        if let str = String(bytes: bytes, encoding: .utf8) {
                            if fd == 1 {
                                Log.wasi.info("[STDOUT] \(str)")
                            } else if fd == 2 {
                                Log.wasi.warning("[STDERR] \(str)")
                            }
                        }
                        totalWritten += len
                    }
                }
                
                memory.withUnsafeMutableBufferPointer(offset: nwrittenPtr, count: 4) { buffer in
                    buffer.storeBytes(of: totalWritten.littleEndian, as: UInt32.self)
                }
                
                return [.i32(0)]
            }
        )
        
        // fd_seek
        imports.define(module: module, name: "fd_seek",
            Function(store: store, parameters: [.i32, .i64, .i32, .i32], results: [.i32]) { caller, args in
                let fd = Int32(bitPattern: args[0].i32)
                let offset = Int64(bitPattern: args[1].i64)
                let whence = UInt8(args[2].i32)
                let newOffsetPtr = UInt(args[3].i32)
                
                let result = fs.fdSeek(fd, offset: offset, whence: whence)
                switch result {
                case .success(let newOffset):
                    if let memory = caller.instance?.exports[memory: "memory"] {
                        memory.withUnsafeMutableBufferPointer(offset: newOffsetPtr, count: 8) { buffer in
                            buffer.storeBytes(of: newOffset.littleEndian, as: UInt64.self)
                        }
                    }
                    return [.i32(0)]
                case .failure(let error):
                    return [.i32(UInt32(error.rawValue))]
                }
            }
        )
        
        // fd_filestat_get
        imports.define(module: module, name: "fd_filestat_get",
            Function(store: store, parameters: [.i32, .i32], results: [.i32]) { caller, args in
                let fd = Int32(bitPattern: args[0].i32)
                let statPtr = UInt(args[1].i32)
                
                let result = fs.fdFilestatGet(fd)
                switch result {
                case .success(let stat):
                    // Write filestat struct (64 bytes)
                    if let memory = caller.instance?.exports[memory: "memory"] {
                        memory.withUnsafeMutableBufferPointer(offset: statPtr, count: 64) { buffer in
                            buffer.storeBytes(of: stat.dev.littleEndian, toByteOffset: 0, as: UInt64.self)
                            buffer.storeBytes(of: stat.ino.littleEndian, toByteOffset: 8, as: UInt64.self)
                            buffer[16] = stat.filetype.rawValue  // filetype
                            buffer.storeBytes(of: stat.nlink.littleEndian, toByteOffset: 24, as: UInt64.self)
                            buffer.storeBytes(of: stat.size.littleEndian, toByteOffset: 32, as: UInt64.self)
                            buffer.storeBytes(of: stat.atim.littleEndian, toByteOffset: 40, as: UInt64.self)
                            buffer.storeBytes(of: stat.mtim.littleEndian, toByteOffset: 48, as: UInt64.self)
                            buffer.storeBytes(of: stat.ctim.littleEndian, toByteOffset: 56, as: UInt64.self)
                        }
                    }
                    return [.i32(0)]
                case .failure(let error):
                    return [.i32(UInt32(error.rawValue))]
                }
            }
        )
        
        // fd_filestat_set_size
        imports.define(module: module, name: "fd_filestat_set_size",
            Function(store: store, parameters: [.i32, .i64], results: [.i32]) { _, _ in
                return [.i32(8)]  // EBADF
            }
        )
        
        // fd_tell
        imports.define(module: module, name: "fd_tell",
            Function(store: store, parameters: [.i32, .i32], results: [.i32]) { caller, args in
                let fd = Int32(bitPattern: args[0].i32)
                let offsetPtr = UInt(args[1].i32)
                
                let result = fs.fdTell(fd)
                switch result {
                case .success(let offset):
                    if let memory = caller.instance?.exports[memory: "memory"] {
                        memory.withUnsafeMutableBufferPointer(offset: offsetPtr, count: 8) { buffer in
                            buffer.storeBytes(of: offset.littleEndian, as: UInt64.self)
                        }
                    }
                    return [.i32(0)]
                case .failure(let error):
                    return [.i32(UInt32(error.rawValue))]
                }
            }
        )
        
        // fd_readdir
        imports.define(module: module, name: "fd_readdir",
            Function(store: store, parameters: [.i32, .i32, .i32, .i64, .i32], results: [.i32]) { _, _ in
                return [.i32(8)]  // EBADF
            }
        )
        
        // path_create_directory
        imports.define(module: module, name: "path_create_directory",
            Function(store: store, parameters: [.i32, .i32, .i32], results: [.i32]) { caller, args in
                let fd = Int32(bitPattern: args[0].i32)
                let pathPtr = UInt(args[1].i32)
                let pathLen = Int(args[2].i32)
                
                guard let memory = caller.instance?.exports[memory: "memory"] else {
                    return [.i32(8)]  // EBADF
                }
                
                // Read path from memory
                var pathBytes = [UInt8](repeating: 0, count: pathLen)
                memory.withUnsafeMutableBufferPointer(offset: pathPtr, count: pathLen) { buffer in
                    for i in 0..<pathLen { pathBytes[i] = buffer[i] }
                }
                let path = String(bytes: pathBytes, encoding: .utf8) ?? ""
                
                let result = fs.pathCreateDirectory(dirFd: fd, path: path)
                switch result {
                case .success: return [.i32(0)]
                case .failure(let error): return [.i32(UInt32(error.rawValue))]
                }
            }
        )
        
        // path_open
        imports.define(module: module, name: "path_open",
            Function(store: store, parameters: [.i32, .i32, .i32, .i32, .i32, .i64, .i64, .i32, .i32], results: [.i32]) { caller, args in
                let dirFd = Int32(bitPattern: args[0].i32)
                // args[1] = dirflags (lookup flags)
                let pathPtr = UInt(args[2].i32)
                let pathLen = Int(args[3].i32)
                let oflags = args[4].i32
                // args[5] = rights_base
                // args[6] = rights_inheriting
                let fdflags = args[7].i32
                let fdPtr = UInt(args[8].i32)
                
                guard let memory = caller.instance?.exports[memory: "memory"] else {
                    return [.i32(8)]  // EBADF
                }
                
                // Read path
                var pathBytes = [UInt8](repeating: 0, count: pathLen)
                memory.withUnsafeMutableBufferPointer(offset: pathPtr, count: pathLen) { buffer in
                    for i in 0..<pathLen { pathBytes[i] = buffer[i] }
                }
                let path = String(bytes: pathBytes, encoding: .utf8) ?? ""
                
                let result = fs.pathOpen(dirFd: dirFd, path: path, oflags: oflags, fdflags: fdflags)
                switch result {
                case .success(let newFd):
                    memory.withUnsafeMutableBufferPointer(offset: fdPtr, count: 4) { buffer in
                        buffer.storeBytes(of: UInt32(bitPattern: newFd).littleEndian, as: UInt32.self)
                    }
                    return [.i32(0)]
                case .failure(let error):
                    return [.i32(UInt32(error.rawValue))]
                }
            }
        )
        
        // path_unlink_file
        imports.define(module: module, name: "path_unlink_file",
            Function(store: store, parameters: [.i32, .i32, .i32], results: [.i32]) { caller, args in
                let fd = Int32(bitPattern: args[0].i32)
                let pathPtr = UInt(args[1].i32)
                let pathLen = Int(args[2].i32)
                
                guard let memory = caller.instance?.exports[memory: "memory"] else {
                    return [.i32(8)]  // EBADF
                }
                
                var pathBytes = [UInt8](repeating: 0, count: pathLen)
                memory.withUnsafeMutableBufferPointer(offset: pathPtr, count: pathLen) { buffer in
                    for i in 0..<pathLen { pathBytes[i] = buffer[i] }
                }
                let path = String(bytes: pathBytes, encoding: .utf8) ?? ""
                
                let result = fs.pathUnlinkFile(dirFd: fd, path: path)
                switch result {
                case .success: return [.i32(0)]
                case .failure(let error): return [.i32(UInt32(error.rawValue))]
                }
            }
        )
        
        // path_remove_directory
        imports.define(module: module, name: "path_remove_directory",
            Function(store: store, parameters: [.i32, .i32, .i32], results: [.i32]) { caller, args in
                let fd = Int32(bitPattern: args[0].i32)
                let pathPtr = UInt(args[1].i32)
                let pathLen = Int(args[2].i32)
                
                guard let memory = caller.instance?.exports[memory: "memory"] else {
                    return [.i32(8)]  // EBADF
                }
                
                var pathBytes = [UInt8](repeating: 0, count: pathLen)
                memory.withUnsafeMutableBufferPointer(offset: pathPtr, count: pathLen) { buffer in
                    for i in 0..<pathLen { pathBytes[i] = buffer[i] }
                }
                let path = String(bytes: pathBytes, encoding: .utf8) ?? ""
                
                let result = fs.pathRemoveDirectory(dirFd: fd, path: path)
                switch result {
                case .success: return [.i32(0)]
                case .failure(let error): return [.i32(UInt32(error.rawValue))]
                }
            }
        )
        
        // path_rename
        imports.define(module: module, name: "path_rename",
            Function(store: store, parameters: [.i32, .i32, .i32, .i32, .i32, .i32], results: [.i32]) { caller, args in
                let srcFd = Int32(bitPattern: args[0].i32)
                let srcPathPtr = UInt(args[1].i32)
                let srcPathLen = Int(args[2].i32)
                let dstFd = Int32(bitPattern: args[3].i32)
                let dstPathPtr = UInt(args[4].i32)
                let dstPathLen = Int(args[5].i32)
                
                guard let memory = caller.instance?.exports[memory: "memory"] else {
                    return [.i32(8)]  // EBADF
                }
                
                var srcPathBytes = [UInt8](repeating: 0, count: srcPathLen)
                memory.withUnsafeMutableBufferPointer(offset: srcPathPtr, count: srcPathLen) { buffer in
                    for i in 0..<srcPathLen { srcPathBytes[i] = buffer[i] }
                }
                let srcPath = String(bytes: srcPathBytes, encoding: .utf8) ?? ""
                
                var dstPathBytes = [UInt8](repeating: 0, count: dstPathLen)
                memory.withUnsafeMutableBufferPointer(offset: dstPathPtr, count: dstPathLen) { buffer in
                    for i in 0..<dstPathLen { dstPathBytes[i] = buffer[i] }
                }
                let dstPath = String(bytes: dstPathBytes, encoding: .utf8) ?? ""
                
                let result = fs.pathRename(srcDirFd: srcFd, srcPath: srcPath, dstDirFd: dstFd, dstPath: dstPath)
                switch result {
                case .success: return [.i32(0)]
                case .failure(let error): return [.i32(UInt32(error.rawValue))]
                }
            }
        )
        
        // path_filestat_get
        imports.define(module: module, name: "path_filestat_get",
            Function(store: store, parameters: [.i32, .i32, .i32, .i32, .i32], results: [.i32]) { caller, args in
                let fd = Int32(bitPattern: args[0].i32)
                // args[1] = flags
                let pathPtr = UInt(args[2].i32)
                let pathLen = Int(args[3].i32)
                let statPtr = UInt(args[4].i32)
                
                guard let memory = caller.instance?.exports[memory: "memory"] else {
                    return [.i32(8)]  // EBADF
                }
                
                var pathBytes = [UInt8](repeating: 0, count: pathLen)
                memory.withUnsafeMutableBufferPointer(offset: pathPtr, count: pathLen) { buffer in
                    for i in 0..<pathLen { pathBytes[i] = buffer[i] }
                }
                let path = String(bytes: pathBytes, encoding: .utf8) ?? ""
                
                let result = fs.pathFilestatGet(dirFd: fd, path: path)
                switch result {
                case .success(let stat):
                    memory.withUnsafeMutableBufferPointer(offset: statPtr, count: 64) { buffer in
                        buffer.storeBytes(of: stat.dev.littleEndian, toByteOffset: 0, as: UInt64.self)
                        buffer.storeBytes(of: stat.ino.littleEndian, toByteOffset: 8, as: UInt64.self)
                        buffer[16] = stat.filetype.rawValue
                        buffer.storeBytes(of: stat.nlink.littleEndian, toByteOffset: 24, as: UInt64.self)
                        buffer.storeBytes(of: stat.size.littleEndian, toByteOffset: 32, as: UInt64.self)
                        buffer.storeBytes(of: stat.atim.littleEndian, toByteOffset: 40, as: UInt64.self)
                        buffer.storeBytes(of: stat.mtim.littleEndian, toByteOffset: 48, as: UInt64.self)
                        buffer.storeBytes(of: stat.ctim.littleEndian, toByteOffset: 56, as: UInt64.self)
                    }
                    return [.i32(0)]
                case .failure(let error):
                    return [.i32(UInt32(error.rawValue))]
                }
            }
        )
        
        // path_link
        imports.define(module: module, name: "path_link",
            Function(store: store, parameters: [.i32, .i32, .i32, .i32, .i32, .i32, .i32], results: [.i32]) { _, _ in
                return [.i32(76)]  // ENOENT
            }
        )
        
        // path_readlink
        imports.define(module: module, name: "path_readlink",
            Function(store: store, parameters: [.i32, .i32, .i32, .i32, .i32, .i32], results: [.i32]) { _, _ in
                return [.i32(76)]  // ENOENT
            }
        )
        
        // proc_exit
        imports.define(module: module, name: "proc_exit",
            Function(store: store, parameters: [.i32], results: []) { _, args in
                let code = args[0].i32
                Log.wasi.info("proc_exit called with code \(code)")
                return []
            }
        )
        
        // adapter_close_badfd
        imports.define(module: module, name: "adapter_close_badfd",
            Function(store: store, parameters: [.i32], results: [.i32]) { _, _ in
                return [.i32(8)]  // EBADF
            }
        )
        
        // clock_time_get: (clock_id, precision, timestamp_ptr) -> errno
        // tsx-engine requires this for timing operations
        imports.define(module: module, name: "clock_time_get",
            Function(store: store, parameters: [.i32, .i64, .i32], results: [.i32]) { caller, args in
                let clockId = args[0].i32
                // args[1] = precision (ignored)
                let timestampPtr = UInt(args[2].i32)
                
                guard let memory = caller.instance?.exports[memory: "memory"] else {
                    return [.i32(8)]  // EBADF
                }
                
                let timestamp: UInt64
                switch clockId {
                case 0:  // CLOCK_REALTIME
                    timestamp = UInt64(Date().timeIntervalSince1970 * 1_000_000_000)
                case 1:  // CLOCK_MONOTONIC
                    timestamp = UInt64(DispatchTime.now().uptimeNanoseconds)
                default:
                    timestamp = UInt64(DispatchTime.now().uptimeNanoseconds)
                }
                
                memory.withUnsafeMutableBufferPointer(offset: timestampPtr, count: 8) { buffer in
                    buffer.storeBytes(of: timestamp.littleEndian, as: UInt64.self)
                }
                return [.i32(0)]  // SUCCESS
            }
        )
        
        // fd_fdstat_get: (fd, fdstat_ptr) -> errno
        // Returns file descriptor status
        imports.define(module: module, name: "fd_fdstat_get",
            Function(store: store, parameters: [.i32, .i32], results: [.i32]) { caller, args in
                let fd = Int32(bitPattern: args[0].i32)
                let fdstatPtr = UInt(args[1].i32)
                
                guard let memory = caller.instance?.exports[memory: "memory"] else {
                    return [.i32(8)]  // EBADF
                }
                
                // fdstat struct: { u8 fs_filetype, u16 fs_flags, u64 fs_rights_base, u64 fs_rights_inheriting }
                // Total size: 24 bytes
                memory.withUnsafeMutableBufferPointer(offset: fdstatPtr, count: 24) { buffer in
                    let filetype: UInt8
                    let flags: UInt16 = 0
                    let rightsBase: UInt64 = 0xFFFFFFFFFFFFFFFF  // All rights
                    let rightsInheriting: UInt64 = 0xFFFFFFFFFFFFFFFF
                    
                    switch fd {
                    case 0: // stdin
                        filetype = 2  // CHARACTER_DEVICE
                    case 1, 2: // stdout, stderr
                        filetype = 2  // CHARACTER_DEVICE
                    default:
                        filetype = 4  // REGULAR_FILE
                    }
                    
                    buffer[0] = filetype
                    buffer[1] = 0  // padding
                    buffer.storeBytes(of: flags.littleEndian, toByteOffset: 2, as: UInt16.self)
                    buffer.storeBytes(of: rightsBase.littleEndian, toByteOffset: 8, as: UInt64.self)
                    buffer.storeBytes(of: rightsInheriting.littleEndian, toByteOffset: 16, as: UInt64.self)
                }
                return [.i32(0)]  // SUCCESS
            }
        )
    }
    
    // MARK: - wasi:random
    
    static func registerRandom(
        _ imports: inout Imports,
        store: Store
    ) {
        // wasi:random/random@0.2.9#get-random-u64
        imports.define(module: "wasi:random/random@0.2.9", name: "get-random-u64",
            Function(store: store, parameters: [], results: [.i64]) { _, _ in
                return [.i64(UInt64.random(in: 0...UInt64.max))]
            }
        )
        
        // wasi:random/random@0.2.9#get-random-bytes
        imports.define(module: "wasi:random/random@0.2.9", name: "get-random-bytes",
            Function(store: store, parameters: [.i64, .i32], results: []) { caller, args in
                guard let memory = caller.instance?.exports[memory: "memory"],
                      let realloc = caller.instance?.exports[function: "cabi_realloc"] else {
                    return []
                }
                
                let count = Int(args[0].i64)
                let retPtr = UInt(args[1].i32)
                
                // Allocate memory for random bytes
                guard let result = try? realloc([.i32(0), .i32(0), .i32(1), .i32(UInt32(count))]),
                      let ptrVal = result.first, case let .i32(ptr) = ptrVal else {
                    return []
                }
                
                // Generate random bytes
                var bytes = [UInt8](repeating: 0, count: count)
                for i in 0..<count {
                    bytes[i] = UInt8.random(in: 0...255)
                }
                
                // Write to allocated memory
                memory.withUnsafeMutableBufferPointer(offset: UInt(ptr), count: count) { buffer in
                    for (i, byte) in bytes.enumerated() {
                        buffer[i] = byte
                    }
                }
                
                // Write result (ptr, len) to return location
                memory.withUnsafeMutableBufferPointer(offset: retPtr, count: 8) { buffer in
                    buffer.storeBytes(of: ptr.littleEndian, as: UInt32.self)
                    buffer.storeBytes(of: UInt32(count).littleEndian, toByteOffset: 4, as: UInt32.self)
                }
                
                return []
            }
        )
        
        // wasi:random/insecure-seed@0.2.4#insecure-seed
        imports.define(module: "wasi:random/insecure-seed@0.2.4", name: "insecure-seed",
            Function(store: store, parameters: [.i32], results: []) { caller, args in
                if let memory = caller.instance?.exports[memory: "memory"] {
                    let retPtr = UInt(args[0].i32)
                    let seed = UInt64.random(in: 0...UInt64.max)
                    memory.withUnsafeMutableBufferPointer(offset: retPtr, count: 16) { buffer in
                        buffer.storeBytes(of: seed.littleEndian, as: UInt64.self)
                        buffer.storeBytes(of: seed.littleEndian, toByteOffset: 8, as: UInt64.self)
                    }
                }
                return []
            }
        )
    }
    
    // MARK: - wasi:clocks
    
    static func registerClocks(
        _ imports: inout Imports,
        store: Store
    ) {
        // wasi:clocks/monotonic-clock@0.2.4#now
        imports.define(module: "wasi:clocks/monotonic-clock@0.2.4", name: "now",
            Function(store: store, parameters: [], results: [.i64]) { _, _ in
                return [.i64(UInt64(DispatchTime.now().uptimeNanoseconds))]
            }
        )
        
        // wasi:clocks/monotonic-clock@0.2.9#subscribe-duration
        imports.define(module: "wasi:clocks/monotonic-clock@0.2.9", name: "subscribe-duration",
            Function(store: store, parameters: [.i64], results: [.i32]) { _, args in
                // Return a dummy pollable handle
                let _ = args[0].i64  // duration in nanoseconds
                return [.i32(1)]  // Stub pollable handle
            }
        )
        
        // wasi:clocks/wall-clock@0.2.9#now
        imports.define(module: "wasi:clocks/wall-clock@0.2.9", name: "now",
            Function(store: store, parameters: [.i32], results: []) { caller, args in
                if let memory = caller.instance?.exports[memory: "memory"] {
                    let retPtr = UInt(args[0].i32)
                    let now = Date()
                    let seconds = UInt64(now.timeIntervalSince1970)
                    let nanos = UInt32((now.timeIntervalSince1970.truncatingRemainder(dividingBy: 1)) * 1_000_000_000)
                    
                    memory.withUnsafeMutableBufferPointer(offset: retPtr, count: 16) { buffer in
                        buffer.storeBytes(of: seconds.littleEndian, as: UInt64.self)
                        buffer.storeBytes(of: nanos.littleEndian, toByteOffset: 8, as: UInt32.self)
                    }
                }
                return []
            }
        )
    }
    
    // MARK: - wasi:cli
    
    static func registerCli(
        _ imports: inout Imports,
        store: Store,
        resources: ResourceRegistry
    ) {
        // wasi:cli/stderr@0.2.4#get-stderr
        let stderrHandle = resources.register(StderrOutputStream())
        imports.define(module: "wasi:cli/stderr@0.2.4", name: "get-stderr",
            Function(store: store, parameters: [], results: [.i32]) { _, _ in
                return [.i32(UInt32(bitPattern: stderrHandle))]
            }
        )
        
        // wasi:cli/terminal-stdout@0.2.9#get-terminal-stdout
        imports.define(module: "wasi:cli/terminal-stdout@0.2.9", name: "get-terminal-stdout",
            Function(store: store, parameters: [.i32], results: []) { caller, args in
                // Write none (no terminal)
                if let memory = caller.instance?.exports[memory: "memory"] {
                    let retPtr = UInt(args[0].i32)
                    memory.withUnsafeMutableBufferPointer(offset: retPtr, count: 4) { buffer in
                        buffer[0] = 0  // none
                    }
                }
                return []
            }
        )
        
        // wasi:cli/terminal-output@0.2.9#[resource-drop]terminal-output
        imports.define(module: "wasi:cli/terminal-output@0.2.9", name: "[resource-drop]terminal-output",
            Function(store: store, parameters: [.i32], results: []) { _, args in
                let handle = Int32(bitPattern: args[0].i32)
                resources.drop(handle)
                return []
            }
        )
    }
    
    // MARK: - wasi:io/poll
    
    static func registerPoll(
        _ imports: inout Imports,
        store: Store,
        resources: ResourceRegistry
    ) {
        // wasi:io/poll@0.2.0#[resource-drop]pollable
        imports.define(module: "wasi:io/poll@0.2.0", name: "[resource-drop]pollable",
            Function(store: store, parameters: [.i32], results: []) { _, args in
                let handle = Int32(bitPattern: args[0].i32)
                resources.drop(handle)
                return []
            }
        )
        
        // wasi:io/poll@0.2.9#[resource-drop]pollable
        imports.define(module: "wasi:io/poll@0.2.9", name: "[resource-drop]pollable",
            Function(store: store, parameters: [.i32], results: []) { _, args in
                let handle = Int32(bitPattern: args[0].i32)
                resources.drop(handle)
                return []
            }
        )
        
        // wasi:io/poll@0.2.9#[method]pollable.block
        imports.define(module: "wasi:io/poll@0.2.9", name: "[method]pollable.block",
            Function(store: store, parameters: [.i32], results: []) { _, args in
                let handle = args[0].i32
                Log.wasi.debug("pollable.block called, handle=\(handle)")
                // For sync MCP server, we don't need to block
                return []
            }
        )
    }
    
    // MARK: - wasi:io/error
    
    static func registerError(
        _ imports: inout Imports,
        store: Store,
        resources: ResourceRegistry
    ) {
        // wasi:io/error@0.2.4#[resource-drop]error
        imports.define(module: "wasi:io/error@0.2.4", name: "[resource-drop]error",
            Function(store: store, parameters: [.i32], results: []) { _, args in
                resources.drop(Int32(bitPattern: args[0].i32))
                return []
            }
        )
        
        // wasi:io/error@0.2.9#[resource-drop]error
        imports.define(module: "wasi:io/error@0.2.9", name: "[resource-drop]error",
            Function(store: store, parameters: [.i32], results: []) { _, args in
                resources.drop(Int32(bitPattern: args[0].i32))
                return []
            }
        )
        
        // wasi:io/error@0.2.4#[method]error.to-debug-string
        imports.define(module: "wasi:io/error@0.2.4", name: "[method]error.to-debug-string",
            Function(store: store, parameters: [.i32, .i32], results: []) { caller, args in
                if let memory = caller.instance?.exports[memory: "memory"] {
                    let retPtr = UInt(args[1].i32)
                    // Write empty string (ptr=0, len=0)
                    memory.withUnsafeMutableBufferPointer(offset: retPtr, count: 8) { buffer in
                        buffer.storeBytes(of: UInt32(0).littleEndian, as: UInt32.self)
                        buffer.storeBytes(of: UInt32(0).littleEndian, toByteOffset: 4, as: UInt32.self)
                    }
                }
                return []
            }
        )
    }
    
    // MARK: - wasi:io/streams
    
    static func registerStreams(
        _ imports: inout Imports,
        store: Store,
        resources: ResourceRegistry
    ) {
        // Resource drops for various stream versions
        for version in ["0.2.0", "0.2.4", "0.2.9"] {
            imports.define(module: "wasi:io/streams@\(version)", name: "[resource-drop]input-stream",
                Function(store: store, parameters: [.i32], results: []) { _, args in
                    resources.drop(Int32(bitPattern: args[0].i32))
                    return []
                }
            )
            
            imports.define(module: "wasi:io/streams@\(version)", name: "[resource-drop]output-stream",
                Function(store: store, parameters: [.i32], results: []) { _, args in
                    resources.drop(Int32(bitPattern: args[0].i32))
                    return []
                }
            )
        }
        
        // wasi:io/streams@0.2.4#[method]output-stream.blocking-write-and-flush
        imports.define(module: "wasi:io/streams@0.2.4", name: "[method]output-stream.blocking-write-and-flush",
            Function(store: store, parameters: [.i32, .i32, .i32, .i32], results: []) { caller, args in
                guard let memory = caller.instance?.exports[memory: "memory"] else { return [] }
                
                let dataPtr = UInt(args[1].i32)
                let dataLen = Int(args[2].i32)
                let retPtr = UInt(args[3].i32)
                
                if dataLen > 0 {
                    var bytes = [UInt8](repeating: 0, count: dataLen)
                    memory.withUnsafeMutableBufferPointer(offset: dataPtr, count: dataLen) { buffer in
                        for i in 0..<dataLen { bytes[i] = buffer[i] }
                    }
                    if let str = String(bytes: bytes, encoding: .utf8) {
                        Log.wasi.debug("[STREAM] \(str)")
                    }
                }
                
                // Write success: tag=0, value=dataLen
                memory.withUnsafeMutableBufferPointer(offset: retPtr, count: 16) { buffer in
                    buffer[0] = 0  // Ok tag
                }
                
                return []
            }
        )
        
        // NOTE: wasi:io/streams@0.2.9 functions are provided by IoStreamsProvider
        // to enable proper HTTP body handling. Do NOT register 0.2.9 stubs here.
    }
    
    // MARK: - wasi:sockets (stubs)
    
    static func registerSockets(
        _ imports: inout Imports,
        store: Store,
        resources: ResourceRegistry
    ) {
        // TCP socket drop
        imports.define(module: "wasi:sockets/tcp@0.2.0", name: "[resource-drop]tcp-socket",
            Function(store: store, parameters: [.i32], results: []) { _, args in
                resources.drop(Int32(bitPattern: args[0].i32))
                return []
            }
        )
        
        // UDP socket and stream drops
        imports.define(module: "wasi:sockets/udp@0.2.0", name: "[resource-drop]udp-socket",
            Function(store: store, parameters: [.i32], results: []) { _, args in
                resources.drop(Int32(bitPattern: args[0].i32))
                return []
            }
        )
        
        imports.define(module: "wasi:sockets/udp@0.2.0", name: "[resource-drop]incoming-datagram-stream",
            Function(store: store, parameters: [.i32], results: []) { _, args in
                resources.drop(Int32(bitPattern: args[0].i32))
                return []
            }
        )
        
        imports.define(module: "wasi:sockets/udp@0.2.0", name: "[resource-drop]outgoing-datagram-stream",
            Function(store: store, parameters: [.i32], results: []) { _, args in
                resources.drop(Int32(bitPattern: args[0].i32))
                return []
            }
        )
    }
    
    // MARK: - HTTP Client Imports
    
    /// Registers WASI HTTP client imports (wasi:http/types@0.2.9)
    /// Used by both NativeAgentHost and NativeMCPHost for making outgoing HTTP requests
    static func registerHttpClient(
        _ imports: inout Imports,
        store: Store,
        resources: ResourceRegistry,
        httpManager: HTTPRequestManager
    ) {
        let httpModule = "wasi:http/types@0.2.9"
        
        // [constructor]fields
        imports.define(module: httpModule, name: "[constructor]fields",
            Function(store: store, parameters: [], results: [.i32]) { _, _ in
                let handle = resources.register(HTTPFields())
                return [.i32(UInt32(bitPattern: handle))]
            }
        )
        
        // [constructor]request-options
        imports.define(module: httpModule, name: "[constructor]request-options",
            Function(store: store, parameters: [], results: [.i32]) { _, _ in
                let handle = resources.register(HTTPRequestOptions())
                return [.i32(UInt32(bitPattern: handle))]
            }
        )
        
        // [constructor]outgoing-request
        imports.define(module: httpModule, name: "[constructor]outgoing-request",
            Function(store: store, parameters: [.i32], results: [.i32]) { _, args in
                let handle = resources.register(HTTPOutgoingRequest(headers: args[0].i32))
                return [.i32(UInt32(bitPattern: handle))]
            }
        )
        
        // [method]fields.append
        imports.define(module: httpModule, name: "[method]fields.append",
            Function(store: store, parameters: [.i32, .i32, .i32, .i32, .i32, .i32], results: []) { caller, args in
                let fieldsHandle = Int32(bitPattern: args[0].i32)
                let namePtr = UInt(args[1].i32)
                let nameLen = Int(args[2].i32)
                let valuePtr = UInt(args[3].i32)
                let valueLen = Int(args[4].i32)
                let resultPtr = UInt(args[5].i32)
                
                guard let fields: HTTPFields = resources.get(fieldsHandle),
                      let memory = caller.instance?.exports[memory: "memory"] else {
                    if let memory = caller.instance?.exports[memory: "memory"] {
                        memory.withUnsafeMutableBufferPointer(offset: resultPtr, count: 1) { buffer in
                            buffer[0] = 1
                        }
                    }
                    return []
                }
                
                var nameBytes = [UInt8](repeating: 0, count: nameLen)
                memory.withUnsafeMutableBufferPointer(offset: namePtr, count: nameLen) { buffer in
                    for i in 0..<nameLen { nameBytes[i] = buffer[i] }
                }
                let name = String(bytes: nameBytes, encoding: .utf8) ?? ""
                
                var valueBytes = [UInt8](repeating: 0, count: valueLen)
                memory.withUnsafeMutableBufferPointer(offset: valuePtr, count: valueLen) { buffer in
                    for i in 0..<valueLen { valueBytes[i] = buffer[i] }
                }
                let value = String(bytes: valueBytes, encoding: .utf8) ?? ""
                
                fields.entries.append((name, value))
                
                memory.withUnsafeMutableBufferPointer(offset: resultPtr, count: 1) { buffer in
                    buffer[0] = 0
                }
                return []
            }
        )
        
        // [method]fields.set
        imports.define(module: httpModule, name: "[method]fields.set",
            Function(store: store, parameters: [.i32, .i32, .i32, .i32, .i32, .i32], results: []) { caller, args in
                let fieldsHandle = Int32(bitPattern: args[0].i32)
                let namePtr = UInt(args[1].i32)
                let nameLen = Int(args[2].i32)
                let valuePtr = UInt(args[3].i32)
                let valueLen = Int(args[4].i32)
                
                guard let fields: HTTPFields = resources.get(fieldsHandle),
                      let memory = caller.instance?.exports[memory: "memory"] else {
                    return []
                }
                
                var nameBytes = [UInt8](repeating: 0, count: nameLen)
                memory.withUnsafeMutableBufferPointer(offset: namePtr, count: nameLen) { buffer in
                    for i in 0..<nameLen { nameBytes[i] = buffer[i] }
                }
                let name = String(bytes: nameBytes, encoding: .utf8) ?? ""
                
                var valueBytes = [UInt8](repeating: 0, count: valueLen)
                memory.withUnsafeMutableBufferPointer(offset: valuePtr, count: valueLen) { buffer in
                    for i in 0..<valueLen { valueBytes[i] = buffer[i] }
                }
                let value = String(bytes: valueBytes, encoding: .utf8) ?? ""
                
                fields.entries.removeAll { $0.0.lowercased() == name.lowercased() }
                fields.entries.append((name, value))
                return []
            }
        )
        
        // [method]fields.entries - returns list of (name, value) tuples
        imports.define(module: httpModule, name: "[method]fields.entries",
            Function(store: store, parameters: [.i32, .i32], results: []) { caller, args in
                let fieldsHandle = Int32(bitPattern: args[0].i32)
                let resultPtr = UInt(args[1].i32)
                
                guard let fields: HTTPFields = resources.get(fieldsHandle),
                      let memory = caller.instance?.exports[memory: "memory"],
                      let realloc = caller.instance?.exports[function: "cabi_realloc"] else {
                    if let memory = caller.instance?.exports[memory: "memory"] {
                        memory.withUnsafeMutableBufferPointer(offset: resultPtr, count: 8) { buffer in
                            buffer.storeBytes(of: UInt32(0).littleEndian, as: UInt32.self)
                            buffer.storeBytes(of: UInt32(0).littleEndian, toByteOffset: 4, as: UInt32.self)
                        }
                    }
                    return []
                }
                
                let entries = fields.entries
                if entries.isEmpty {
                    memory.withUnsafeMutableBufferPointer(offset: resultPtr, count: 8) { buffer in
                        buffer.storeBytes(of: UInt32(0).littleEndian, as: UInt32.self)
                        buffer.storeBytes(of: UInt32(0).littleEndian, toByteOffset: 4, as: UInt32.self)
                    }
                    return []
                }
                
                let tupleArraySize = entries.count * 16
                var tupleArrayPtr: UInt32 = 0
                do {
                    let result = try realloc([.i32(0), .i32(0), .i32(4), .i32(UInt32(tupleArraySize))])
                    if let ptrVal = result.first, case let .i32(ptr) = ptrVal {
                        tupleArrayPtr = ptr
                    }
                } catch { }
                
                guard tupleArrayPtr != 0 else {
                    memory.withUnsafeMutableBufferPointer(offset: resultPtr, count: 8) { buffer in
                        buffer.storeBytes(of: UInt32(0).littleEndian, as: UInt32.self)
                        buffer.storeBytes(of: UInt32(0).littleEndian, toByteOffset: 4, as: UInt32.self)
                    }
                    return []
                }
                
                var tupleOffset = UInt(tupleArrayPtr)
                for (name, value) in entries {
                    let nameBytes = Array(name.utf8)
                    let valueBytes = Array(value.utf8)
                    
                    var namePtr: UInt32 = 0
                    if nameBytes.count > 0 {
                        do {
                            let result = try realloc([.i32(0), .i32(0), .i32(1), .i32(UInt32(nameBytes.count))])
                            if let ptrVal = result.first, case let .i32(ptr) = ptrVal { namePtr = ptr }
                        } catch { }
                        if namePtr != 0 {
                            memory.withUnsafeMutableBufferPointer(offset: UInt(namePtr), count: nameBytes.count) { buffer in
                                for (i, byte) in nameBytes.enumerated() { buffer[i] = byte }
                            }
                        }
                    }
                    
                    var valuePtr: UInt32 = 0
                    if valueBytes.count > 0 {
                        do {
                            let result = try realloc([.i32(0), .i32(0), .i32(1), .i32(UInt32(valueBytes.count))])
                            if let ptrVal = result.first, case let .i32(ptr) = ptrVal { valuePtr = ptr }
                        } catch { }
                        if valuePtr != 0 {
                            memory.withUnsafeMutableBufferPointer(offset: UInt(valuePtr), count: valueBytes.count) { buffer in
                                for (i, byte) in valueBytes.enumerated() { buffer[i] = byte }
                            }
                        }
                    }
                    
                    memory.withUnsafeMutableBufferPointer(offset: tupleOffset, count: 16) { buffer in
                        buffer.storeBytes(of: namePtr.littleEndian, as: UInt32.self)
                        buffer.storeBytes(of: UInt32(nameBytes.count).littleEndian, toByteOffset: 4, as: UInt32.self)
                        buffer.storeBytes(of: valuePtr.littleEndian, toByteOffset: 8, as: UInt32.self)
                        buffer.storeBytes(of: UInt32(valueBytes.count).littleEndian, toByteOffset: 12, as: UInt32.self)
                    }
                    tupleOffset += 16
                }
                
                memory.withUnsafeMutableBufferPointer(offset: resultPtr, count: 8) { buffer in
                    buffer.storeBytes(of: tupleArrayPtr.littleEndian, as: UInt32.self)
                    buffer.storeBytes(of: UInt32(entries.count).littleEndian, toByteOffset: 4, as: UInt32.self)
                }
                return []
            }
        )
        
        // [method]outgoing-request.set-method
        imports.define(module: httpModule, name: "[method]outgoing-request.set-method",
            Function(store: store, parameters: [.i32, .i32, .i32, .i32], results: [.i32]) { caller, args in
                let requestHandle = Int32(bitPattern: args[0].i32)
                let methodTag = args[1].i32
                let methodValPtr = UInt(args[2].i32)
                let methodValLen = Int(args[3].i32)
                
                guard let request: HTTPOutgoingRequest = resources.get(requestHandle) else {
                    return [.i32(1)]
                }
                
                switch methodTag {
                case 0: request.method = "GET"
                case 1: request.method = "HEAD"
                case 2: request.method = "POST"
                case 3: request.method = "PUT"
                case 4: request.method = "DELETE"
                case 5: request.method = "CONNECT"
                case 6: request.method = "OPTIONS"
                case 7: request.method = "TRACE"
                case 8: request.method = "PATCH"
                case 9: // Other
                    if let memory = caller.instance?.exports[memory: "memory"], methodValLen > 0 {
                        var methodBytes = [UInt8](repeating: 0, count: methodValLen)
                        memory.withUnsafeMutableBufferPointer(offset: methodValPtr, count: methodValLen) { buffer in
                            for i in 0..<methodValLen { methodBytes[i] = buffer[i] }
                        }
                        request.method = String(bytes: methodBytes, encoding: .utf8) ?? "GET"
                    }
                default: break
                }
                return [.i32(0)]
            }
        )
        
        // [method]outgoing-request.set-scheme
        imports.define(module: httpModule, name: "[method]outgoing-request.set-scheme",
            Function(store: store, parameters: [.i32, .i32, .i32, .i32, .i32], results: [.i32]) { caller, args in
                let requestHandle = Int32(bitPattern: args[0].i32)
                let hasScheme = args[1].i32
                let schemeTag = args[2].i32
                let schemeValPtr = UInt(args[3].i32)
                let schemeValLen = Int(args[4].i32)
                
                guard let request: HTTPOutgoingRequest = resources.get(requestHandle) else {
                    return [.i32(1)]
                }
                
                if hasScheme != 0 {
                    switch schemeTag {
                    case 0: request.scheme = "http"
                    case 1: request.scheme = "https"
                    case 2:
                        if let memory = caller.instance?.exports[memory: "memory"], schemeValLen > 0 {
                            var schemeBytes = [UInt8](repeating: 0, count: schemeValLen)
                            memory.withUnsafeMutableBufferPointer(offset: schemeValPtr, count: schemeValLen) { buffer in
                                for i in 0..<schemeValLen { schemeBytes[i] = buffer[i] }
                            }
                            request.scheme = String(bytes: schemeBytes, encoding: .utf8) ?? "https"
                        }
                    default: break
                    }
                }
                return [.i32(0)]
            }
        )
        
        // [method]outgoing-request.set-authority
        imports.define(module: httpModule, name: "[method]outgoing-request.set-authority",
            Function(store: store, parameters: [.i32, .i32, .i32, .i32], results: [.i32]) { caller, args in
                let requestHandle = Int32(bitPattern: args[0].i32)
                let hasAuthority = args[1].i32
                let authorityPtr = UInt(args[2].i32)
                let authorityLen = Int(args[3].i32)
                
                guard let request: HTTPOutgoingRequest = resources.get(requestHandle),
                      let memory = caller.instance?.exports[memory: "memory"] else {
                    return [.i32(1)]
                }
                
                if hasAuthority != 0 {
                    var authorityBytes = [UInt8](repeating: 0, count: authorityLen)
                    memory.withUnsafeMutableBufferPointer(offset: authorityPtr, count: authorityLen) { buffer in
                        for i in 0..<authorityLen { authorityBytes[i] = buffer[i] }
                    }
                    request.authority = String(bytes: authorityBytes, encoding: .utf8) ?? ""
                } else {
                    request.authority = ""
                }
                return [.i32(0)]
            }
        )
        
        // [method]outgoing-request.set-path-with-query
        imports.define(module: httpModule, name: "[method]outgoing-request.set-path-with-query",
            Function(store: store, parameters: [.i32, .i32, .i32, .i32], results: [.i32]) { caller, args in
                let requestHandle = Int32(bitPattern: args[0].i32)
                let hasPath = args[1].i32
                let pathPtr = UInt(args[2].i32)
                let pathLen = Int(args[3].i32)
                
                guard let request: HTTPOutgoingRequest = resources.get(requestHandle),
                      let memory = caller.instance?.exports[memory: "memory"] else {
                    return [.i32(1)]
                }
                
                if hasPath != 0 {
                    var pathBytes = [UInt8](repeating: 0, count: pathLen)
                    memory.withUnsafeMutableBufferPointer(offset: pathPtr, count: pathLen) { buffer in
                        for i in 0..<pathLen { pathBytes[i] = buffer[i] }
                    }
                    request.path = String(bytes: pathBytes, encoding: .utf8) ?? "/"
                } else {
                    request.path = ""
                }
                return [.i32(0)]
            }
        )
        
        // [method]outgoing-request.body
        imports.define(module: httpModule, name: "[method]outgoing-request.body",
            Function(store: store, parameters: [.i32, .i32], results: []) { caller, args in
                let requestHandle = Int32(bitPattern: args[0].i32)
                let resultPtr = UInt(args[1].i32)
                
                guard let request: HTTPOutgoingRequest = resources.get(requestHandle),
                      let memory = caller.instance?.exports[memory: "memory"] else {
                    if let memory = caller.instance?.exports[memory: "memory"] {
                        memory.withUnsafeMutableBufferPointer(offset: resultPtr, count: 8) { buffer in
                            buffer.storeBytes(of: UInt32(1).littleEndian, as: UInt32.self)
                        }
                    }
                    return []
                }
                
                if request.outgoingBodyHandle == nil {
                    let body = HTTPOutgoingBody()
                    let bodyHandle = resources.register(body)
                    request.outgoingBodyHandle = bodyHandle
                }
                
                memory.withUnsafeMutableBufferPointer(offset: resultPtr, count: 8) { buffer in
                    buffer.storeBytes(of: UInt32(0).littleEndian, as: UInt32.self)
                    buffer.storeBytes(of: UInt32(bitPattern: request.outgoingBodyHandle!).littleEndian, toByteOffset: 4, as: UInt32.self)
                }
                return []
            }
        )
        
        // [method]outgoing-body.write
        imports.define(module: httpModule, name: "[method]outgoing-body.write",
            Function(store: store, parameters: [.i32, .i32], results: []) { caller, args in
                let bodyHandle = Int32(bitPattern: args[0].i32)
                let resultPtr = UInt(args[1].i32)
                
                guard let body: HTTPOutgoingBody = resources.get(bodyHandle),
                      let memory = caller.instance?.exports[memory: "memory"] else {
                    if let memory = caller.instance?.exports[memory: "memory"] {
                        memory.withUnsafeMutableBufferPointer(offset: resultPtr, count: 8) { buffer in
                            buffer.storeBytes(of: UInt32(1).littleEndian, as: UInt32.self)
                        }
                    }
                    return []
                }
                
                if body.outputStreamHandle == nil {
                    let stream = WASIOutputStream(body: body)
                    let streamHandle = resources.register(stream)
                    body.outputStreamHandle = streamHandle
                }
                
                memory.withUnsafeMutableBufferPointer(offset: resultPtr, count: 8) { buffer in
                    buffer.storeBytes(of: UInt32(0).littleEndian, as: UInt32.self)
                    buffer.storeBytes(of: UInt32(bitPattern: body.outputStreamHandle!).littleEndian, toByteOffset: 4, as: UInt32.self)
                }
                return []
            }
        )
        
        // [static]outgoing-body.finish
        imports.define(module: httpModule, name: "[static]outgoing-body.finish",
            Function(store: store, parameters: [.i32, .i32, .i32, .i32], results: []) { caller, args in
                let bodyHandle = Int32(bitPattern: args[0].i32)
                let resultPtr = UInt(args[3].i32)
                
                if let body: HTTPOutgoingBody = resources.get(bodyHandle) {
                    body.finished = true
                }
                
                if let memory = caller.instance?.exports[memory: "memory"] {
                    memory.withUnsafeMutableBufferPointer(offset: resultPtr, count: 1) { buffer in
                        buffer[0] = 0
                    }
                }
                return []
            }
        )
        
        // [method]incoming-response.status
        imports.define(module: httpModule, name: "[method]incoming-response.status",
            Function(store: store, parameters: [.i32], results: [.i32]) { _, args in
                let responseHandle = Int32(bitPattern: args[0].i32)
                guard let response: HTTPIncomingResponse = resources.get(responseHandle) else {
                    return [.i32(500)]
                }
                return [.i32(UInt32(response.status))]
            }
        )
        
        // [method]incoming-response.headers
        imports.define(module: httpModule, name: "[method]incoming-response.headers",
            Function(store: store, parameters: [.i32], results: [.i32]) { _, args in
                let responseHandle = Int32(bitPattern: args[0].i32)
                guard let response: HTTPIncomingResponse = resources.get(responseHandle) else {
                    return [.i32(0)]
                }
                let fields = HTTPFields()
                fields.entries = response.headers
                let fieldsHandle = resources.register(fields)
                return [.i32(UInt32(bitPattern: fieldsHandle))]
            }
        )
        
        // [method]incoming-response.consume
        imports.define(module: httpModule, name: "[method]incoming-response.consume",
            Function(store: store, parameters: [.i32, .i32], results: []) { caller, args in
                let responseHandle = Int32(bitPattern: args[0].i32)
                let resultPtr = UInt(args[1].i32)
                
                guard let response: HTTPIncomingResponse = resources.get(responseHandle),
                      let memory = caller.instance?.exports[memory: "memory"] else {
                    if let memory = caller.instance?.exports[memory: "memory"] {
                        memory.withUnsafeMutableBufferPointer(offset: resultPtr, count: 8) { buffer in
                            buffer.storeBytes(of: UInt32(1).littleEndian, as: UInt32.self)
                        }
                    }
                    return []
                }
                
                if response.bodyConsumed {
                    memory.withUnsafeMutableBufferPointer(offset: resultPtr, count: 8) { buffer in
                        buffer.storeBytes(of: UInt32(1).littleEndian, as: UInt32.self)
                    }
                    return []
                }
                response.bodyConsumed = true
                
                let body = HTTPIncomingBody(response: response)
                let bodyHandle = resources.register(body)
                
                memory.withUnsafeMutableBufferPointer(offset: resultPtr, count: 8) { buffer in
                    buffer.storeBytes(of: UInt32(0).littleEndian, as: UInt32.self)
                    buffer.storeBytes(of: UInt32(bitPattern: bodyHandle).littleEndian, toByteOffset: 4, as: UInt32.self)
                }
                return []
            }
        )
        
        // [method]incoming-body.stream
        imports.define(module: httpModule, name: "[method]incoming-body.stream",
            Function(store: store, parameters: [.i32, .i32], results: []) { caller, args in
                let bodyHandle = Int32(bitPattern: args[0].i32)
                let resultPtr = UInt(args[1].i32)
                
                guard let body: HTTPIncomingBody = resources.get(bodyHandle),
                      let memory = caller.instance?.exports[memory: "memory"] else {
                    if let memory = caller.instance?.exports[memory: "memory"] {
                        memory.withUnsafeMutableBufferPointer(offset: resultPtr, count: 8) { buffer in
                            buffer.storeBytes(of: UInt32(1).littleEndian, as: UInt32.self)
                        }
                    }
                    return []
                }
                
                if body.inputStreamHandle == nil {
                    let stream = WASIInputStream(body: body)
                    let streamHandle = resources.register(stream)
                    body.inputStreamHandle = streamHandle
                }
                
                memory.withUnsafeMutableBufferPointer(offset: resultPtr, count: 8) { buffer in
                    buffer.storeBytes(of: UInt32(0).littleEndian, as: UInt32.self)
                    buffer.storeBytes(of: UInt32(bitPattern: body.inputStreamHandle!).littleEndian, toByteOffset: 4, as: UInt32.self)
                }
                return []
            }
        )
        
        // [static]incoming-body.finish - finishes reading body, returns future-trailers handle
        imports.define(module: httpModule, name: "[static]incoming-body.finish",
            Function(store: store, parameters: [.i32], results: [.i32]) { _, args in
                let bodyHandle = Int32(bitPattern: args[0].i32)
                resources.drop(bodyHandle)  // Done with the body
                // Create a future-trailers handle (trailers are rarely used in HTTP/1.1)
                let trailers = FutureTrailers()
                trailers.complete = true
                let handle = resources.register(trailers)
                return [.i32(UInt32(bitPattern: handle))]
            }
        )
        
        // HTTP Resource drops
        imports.define(module: httpModule, name: "[resource-drop]fields",
            Function(store: store, parameters: [.i32], results: []) { _, args in
                resources.drop(Int32(bitPattern: args[0].i32))
                return []
            }
        )
        
        imports.define(module: httpModule, name: "[resource-drop]outgoing-request",
            Function(store: store, parameters: [.i32], results: []) { _, args in
                resources.drop(Int32(bitPattern: args[0].i32))
                return []
            }
        )
        
        imports.define(module: httpModule, name: "[resource-drop]outgoing-body",
            Function(store: store, parameters: [.i32], results: []) { _, args in
                resources.drop(Int32(bitPattern: args[0].i32))
                return []
            }
        )
        
        imports.define(module: httpModule, name: "[resource-drop]incoming-response",
            Function(store: store, parameters: [.i32], results: []) { _, args in
                resources.drop(Int32(bitPattern: args[0].i32))
                return []
            }
        )
        
        imports.define(module: httpModule, name: "[resource-drop]incoming-body",
            Function(store: store, parameters: [.i32], results: []) { _, args in
                resources.drop(Int32(bitPattern: args[0].i32))
                return []
            }
        )
        
        imports.define(module: httpModule, name: "[resource-drop]future-incoming-response",
            Function(store: store, parameters: [.i32], results: []) { _, args in
                resources.drop(Int32(bitPattern: args[0].i32))
                return []
            }
        )
        
        imports.define(module: httpModule, name: "[resource-drop]request-options",
            Function(store: store, parameters: [.i32], results: []) { _, args in
                resources.drop(Int32(bitPattern: args[0].i32))
                return []
            }
        )
        
        imports.define(module: httpModule, name: "[resource-drop]future-trailers",
            Function(store: store, parameters: [.i32], results: []) { _, args in
                resources.drop(Int32(bitPattern: args[0].i32))
                return []
            }
        )
    }
}

