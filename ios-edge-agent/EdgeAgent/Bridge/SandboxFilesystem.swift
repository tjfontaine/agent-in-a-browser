import Foundation
import OSLog

/// WASI Filesystem Error Codes
enum WasiError: Int32, Error {
    case success = 0
    case toobig = 1
    case access = 2
    case addrinuse = 3
    case addrnotavail = 4
    case afnosupport = 5
    case again = 6
    case already = 7
    case badf = 8            // Bad file descriptor
    case badmsg = 9
    case busy = 10
    case canceled = 11
    case child = 12
    case connaborted = 13
    case connrefused = 14
    case connreset = 15
    case deadlk = 16
    case destaddrreq = 17
    case dom = 18
    case dquot = 19
    case exist = 20          // File exists
    case fault = 21
    case fbig = 22
    case hostunreach = 23
    case idrm = 24
    case ilseq = 25
    case inprogress = 26
    case intr = 27
    case inval = 28          // Invalid argument
    case io = 29
    case isconn = 30
    case isdir = 31          // Is a directory
    case loop = 32
    case mfile = 33
    case mlink = 34
    case msgsize = 35
    case multihop = 36
    case nametoolong = 37
    case netdown = 38
    case netreset = 39
    case netunreach = 40
    case nfile = 41
    case nobufs = 42
    case nodev = 43
    case noent = 44          // No such file or directory
    case noexec = 45
    case nolck = 46
    case nolink = 47
    case nomem = 48
    case nomsg = 49
    case noprotoopt = 50
    case nospc = 51
    case nosys = 52          // Function not implemented
    case notconn = 53
    case notdir = 54         // Not a directory
    case notempty = 55
    case notrecoverable = 56
    case notsock = 57
    case notsup = 58         // Not supported
    case notty = 59
    case nxio = 60
    case overflow = 61
    case ownerdead = 62
    case perm = 63           // Operation not permitted
    case pipe = 64
    case proto = 65
    case protonosupport = 66
    case prototype = 67
    case range = 68
    case rofs = 69           // Read-only file system
    case spipe = 70
    case srch = 71
    case stale = 72
    case timedout = 73
    case txtbsy = 74
    case xdev = 75
    case notcapable = 76     // Not capable
}

/// WASI File Type
enum WasiFileType: UInt8 {
    case unknown = 0
    case blockDevice = 1
    case characterDevice = 2
    case directory = 3
    case regularFile = 4
    case socketDgram = 5
    case socketStream = 6
    case symbolicLink = 7
}

/// WASI File Stat structure
struct WasiFileStat {
    var dev: UInt64 = 0
    var ino: UInt64 = 0
    var filetype: WasiFileType = .unknown
    var nlink: UInt64 = 1
    var size: UInt64 = 0
    var atim: UInt64 = 0
    var mtim: UInt64 = 0
    var ctim: UInt64 = 0
}

/// Open file entry in the FD table
class OpenFile {
    let path: String
    var handle: FileHandle?
    var isDirectory: Bool
    var position: UInt64 = 0
    
    init(path: String, handle: FileHandle?, isDirectory: Bool) {
        self.path = path
        self.handle = handle
        self.isDirectory = isDirectory
    }
}

/// iOS sandbox filesystem implementation
/// Provides WASI preview1 filesystem access rooted at Documents/sandbox
@MainActor
class SandboxFilesystem {
    
    static let shared = SandboxFilesystem()
    
    /// Root directory for the sandbox (Documents/sandbox)
    let rootURL: URL
    
    /// File descriptor table
    /// FD 0, 1, 2 are reserved for stdin, stdout, stderr
    private var fdTable: [Int32: OpenFile] = [:]
    private var nextFd: Int32 = 3
    
    /// Preopened directory FD (typically 3 for WASI)
    let preopenedFd: Int32 = 3
    
    private init() {
        // Create sandbox in Documents directory
        let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first!
        rootURL = docs.appendingPathComponent("sandbox", isDirectory: true)
        
        // Ensure sandbox directory exists
        try? FileManager.default.createDirectory(at: rootURL, withIntermediateDirectories: true)
        
        // Preopen the root directory as FD 3
        let rootFile = OpenFile(path: "/", handle: nil, isDirectory: true)
        fdTable[preopenedFd] = rootFile
        nextFd = 4
        
        Log.wasi.info("SandboxFilesystem initialized at \(self.rootURL.path)")
    }
    
    // MARK: - Path Resolution
    
    /// Convert a WASI path to an absolute iOS filesystem path
    private func resolvePath(dirFd: Int32, subpath: String) -> Result<URL, WasiError> {
        guard let dirFile = fdTable[dirFd] else {
            return .failure(.badf)
        }
        
        // Normalize the path
        var normalized = subpath
        if normalized.hasPrefix("/") {
            normalized = String(normalized.dropFirst())
        }
        
        // Handle escaping attempts
        let components = normalized.components(separatedBy: "/")
        var resolvedComponents: [String] = []
        for component in components {
            if component == ".." {
                if !resolvedComponents.isEmpty {
                    resolvedComponents.removeLast()
                }
            } else if component != "." && !component.isEmpty {
                resolvedComponents.append(component)
            }
        }
        
        // Build the final path relative to root
        var basePath = rootURL
        if dirFile.path != "/" {
            basePath = rootURL.appendingPathComponent(String(dirFile.path.dropFirst()))
        }
        
        for component in resolvedComponents {
            basePath = basePath.appendingPathComponent(component)
        }
        
        // Ensure we're still within the sandbox
        let resolvedPath = basePath.standardizedFileURL.path
        let rootPath = rootURL.standardizedFileURL.path
        guard resolvedPath.hasPrefix(rootPath) else {
            Log.wasi.warning("Path escape attempt: \(subpath) -> \(resolvedPath)")
            return .failure(.notcapable)
        }
        
        return .success(basePath)
    }
    
    /// Get the sandbox-relative path from an absolute URL
    private func relativePath(for url: URL) -> String {
        let absolutePath = url.standardizedFileURL.path
        let rootPath = rootURL.standardizedFileURL.path
        if absolutePath.hasPrefix(rootPath) {
            let relative = String(absolutePath.dropFirst(rootPath.count))
            return relative.isEmpty ? "/" : relative
        }
        return absolutePath
    }
    
    // MARK: - File Operations
    
    /// Open a file or directory
    func pathOpen(
        dirFd: Int32,
        path: String,
        oflags: UInt32,  // O_CREAT=1, O_DIRECTORY=2, O_EXCL=4, O_TRUNC=8
        fdflags: UInt32  // FDFLAGS_APPEND=1, FDFLAGS_DSYNC=2, etc.
    ) -> Result<Int32, WasiError> {
        let urlResult = resolvePath(dirFd: dirFd, subpath: path)
        guard case .success(let url) = urlResult else {
            return .failure(urlResult.failure!)
        }
        
        let fm = FileManager.default
        let exists = fm.fileExists(atPath: url.path)
        var isDir: ObjCBool = false
        fm.fileExists(atPath: url.path, isDirectory: &isDir)
        
        let oCreate = (oflags & 1) != 0
        let oDirectory = (oflags & 2) != 0
        let oExcl = (oflags & 4) != 0
        let oTrunc = (oflags & 8) != 0
        
        // Handle O_EXCL - fail if exists
        if oExcl && exists {
            return .failure(.exist)
        }
        
        // Handle O_CREAT - create if doesn't exist
        if oCreate && !exists {
            if oDirectory {
                do {
                    try fm.createDirectory(at: url, withIntermediateDirectories: true)
                } catch {
                    Log.wasi.error("Failed to create directory \(url.path): \(error)")
                    return .failure(.io)
                }
            } else {
                let success = fm.createFile(atPath: url.path, contents: nil)
                if !success {
                    Log.wasi.error("Failed to create file \(url.path)")
                    return .failure(.io)
                }
            }
        }
        
        // Check if path exists now
        if !fm.fileExists(atPath: url.path, isDirectory: &isDir) {
            return .failure(.noent)
        }
        
        // Handle O_DIRECTORY - must be a directory
        if oDirectory && !isDir.boolValue {
            return .failure(.notdir)
        }
        
        // Handle O_TRUNC - truncate existing file
        if oTrunc && !isDir.boolValue && exists {
            fm.createFile(atPath: url.path, contents: nil)
        }
        
        // Open file handle for regular files
        var handle: FileHandle? = nil
        if !isDir.boolValue {
            do {
                handle = try FileHandle(forUpdating: url)
            } catch {
                // Try read-only
                handle = FileHandle(forReadingAtPath: url.path)
            }
        }
        
        // Allocate FD
        let fd = nextFd
        nextFd += 1
        
        let relativePath = self.relativePath(for: url)
        let openFile = OpenFile(path: relativePath, handle: handle, isDirectory: isDir.boolValue)
        fdTable[fd] = openFile
        
        Log.wasi.debug("pathOpen: \(path) -> fd=\(fd)")
        return .success(fd)
    }
    
    /// Close a file descriptor
    func fdClose(_ fd: Int32) -> Result<Void, WasiError> {
        guard let openFile = fdTable[fd] else {
            return .failure(.badf)
        }
        
        // Don't close the preopened directory
        if fd == preopenedFd {
            return .failure(.badf)
        }
        
        try? openFile.handle?.close()
        fdTable.removeValue(forKey: fd)
        
        Log.wasi.debug("fdClose: fd=\(fd)")
        return .success(())
    }
    
    /// Read from a file descriptor
    func fdRead(_ fd: Int32, length: UInt32) -> Result<Data, WasiError> {
        guard let openFile = fdTable[fd] else {
            return .failure(.badf)
        }
        
        guard let handle = openFile.handle else {
            return .failure(.badf)
        }
        
        guard !openFile.isDirectory else {
            return .failure(.isdir)
        }
        
        do {
            let data = try handle.read(upToCount: Int(length)) ?? Data()
            openFile.position += UInt64(data.count)
            return .success(data)
        } catch {
            Log.wasi.error("fdRead error: \(error)")
            return .failure(.io)
        }
    }
    
    /// Write to a file descriptor
    func fdWrite(_ fd: Int32, data: Data) -> Result<UInt32, WasiError> {
        guard let openFile = fdTable[fd] else {
            return .failure(.badf)
        }
        
        guard let handle = openFile.handle else {
            return .failure(.badf)
        }
        
        guard !openFile.isDirectory else {
            return .failure(.isdir)
        }
        
        do {
            try handle.write(contentsOf: data)
            openFile.position += UInt64(data.count)
            return .success(UInt32(data.count))
        } catch {
            Log.wasi.error("fdWrite error: \(error)")
            return .failure(.io)
        }
    }
    
    /// Seek within a file
    func fdSeek(_ fd: Int32, offset: Int64, whence: UInt8) -> Result<UInt64, WasiError> {
        guard let openFile = fdTable[fd] else {
            return .failure(.badf)
        }
        
        guard let handle = openFile.handle else {
            return .failure(.badf)
        }
        
        do {
            let endOffset = try handle.seekToEnd()
            
            var newPosition: UInt64
            switch whence {
            case 0: // SEEK_SET
                newPosition = UInt64(max(0, offset))
            case 1: // SEEK_CUR
                newPosition = UInt64(max(0, Int64(openFile.position) + offset))
            case 2: // SEEK_END
                newPosition = UInt64(max(0, Int64(endOffset) + offset))
            default:
                return .failure(.inval)
            }
            
            try handle.seek(toOffset: newPosition)
            openFile.position = newPosition
            return .success(newPosition)
        } catch {
            Log.wasi.error("fdSeek error: \(error)")
            return .failure(.io)
        }
    }
    
    /// Get current position
    func fdTell(_ fd: Int32) -> Result<UInt64, WasiError> {
        guard let openFile = fdTable[fd] else {
            return .failure(.badf)
        }
        return .success(openFile.position)
    }
    
    /// Get file stat
    func fdFilestatGet(_ fd: Int32) -> Result<WasiFileStat, WasiError> {
        guard let openFile = fdTable[fd] else {
            return .failure(.badf)
        }
        
        let url = rootURL.appendingPathComponent(String(openFile.path.dropFirst()))
        return getFileStat(at: url, isDirectory: openFile.isDirectory)
    }
    
    /// Get file stat at path
    func pathFilestatGet(dirFd: Int32, path: String) -> Result<WasiFileStat, WasiError> {
        let urlResult = resolvePath(dirFd: dirFd, subpath: path)
        guard case .success(let url) = urlResult else {
            return .failure(urlResult.failure!)
        }
        
        let fm = FileManager.default
        var isDir: ObjCBool = false
        guard fm.fileExists(atPath: url.path, isDirectory: &isDir) else {
            return .failure(.noent)
        }
        
        return getFileStat(at: url, isDirectory: isDir.boolValue)
    }
    
    private func getFileStat(at url: URL, isDirectory: Bool) -> Result<WasiFileStat, WasiError> {
        do {
            let attrs = try FileManager.default.attributesOfItem(atPath: url.path)
            
            var stat = WasiFileStat()
            stat.filetype = isDirectory ? .directory : .regularFile
            stat.size = (attrs[.size] as? UInt64) ?? 0
            
            if let mtime = attrs[.modificationDate] as? Date {
                stat.mtim = UInt64(mtime.timeIntervalSince1970 * 1_000_000_000)
            }
            if let ctime = attrs[.creationDate] as? Date {
                stat.ctim = UInt64(ctime.timeIntervalSince1970 * 1_000_000_000)
            }
            stat.atim = stat.mtim
            
            return .success(stat)
        } catch {
            Log.wasi.error("getFileStat error: \(error)")
            return .failure(.io)
        }
    }
    
    /// Create a directory
    func pathCreateDirectory(dirFd: Int32, path: String) -> Result<Void, WasiError> {
        let urlResult = resolvePath(dirFd: dirFd, subpath: path)
        guard case .success(let url) = urlResult else {
            return .failure(urlResult.failure!)
        }
        
        do {
            try FileManager.default.createDirectory(at: url, withIntermediateDirectories: false)
            Log.wasi.debug("pathCreateDirectory: \(path)")
            return .success(())
        } catch CocoaError.fileWriteFileExists {
            return .failure(.exist)
        } catch {
            Log.wasi.error("pathCreateDirectory error: \(error)")
            return .failure(.io)
        }
    }
    
    /// Remove a file
    func pathUnlinkFile(dirFd: Int32, path: String) -> Result<Void, WasiError> {
        let urlResult = resolvePath(dirFd: dirFd, subpath: path)
        guard case .success(let url) = urlResult else {
            return .failure(urlResult.failure!)
        }
        
        var isDir: ObjCBool = false
        guard FileManager.default.fileExists(atPath: url.path, isDirectory: &isDir) else {
            return .failure(.noent)
        }
        
        if isDir.boolValue {
            return .failure(.isdir)
        }
        
        do {
            try FileManager.default.removeItem(at: url)
            Log.wasi.debug("pathUnlinkFile: \(path)")
            return .success(())
        } catch {
            Log.wasi.error("pathUnlinkFile error: \(error)")
            return .failure(.io)
        }
    }
    
    /// Remove a directory
    func pathRemoveDirectory(dirFd: Int32, path: String) -> Result<Void, WasiError> {
        let urlResult = resolvePath(dirFd: dirFd, subpath: path)
        guard case .success(let url) = urlResult else {
            return .failure(urlResult.failure!)
        }
        
        var isDir: ObjCBool = false
        guard FileManager.default.fileExists(atPath: url.path, isDirectory: &isDir) else {
            return .failure(.noent)
        }
        
        if !isDir.boolValue {
            return .failure(.notdir)
        }
        
        // Check if directory is empty
        do {
            let contents = try FileManager.default.contentsOfDirectory(atPath: url.path)
            if !contents.isEmpty {
                return .failure(.notempty)
            }
            try FileManager.default.removeItem(at: url)
            Log.wasi.debug("pathRemoveDirectory: \(path)")
            return .success(())
        } catch {
            Log.wasi.error("pathRemoveDirectory error: \(error)")
            return .failure(.io)
        }
    }
    
    /// Rename a file or directory
    func pathRename(
        srcDirFd: Int32, srcPath: String,
        dstDirFd: Int32, dstPath: String
    ) -> Result<Void, WasiError> {
        let srcResult = resolvePath(dirFd: srcDirFd, subpath: srcPath)
        guard case .success(let srcUrl) = srcResult else {
            return .failure(srcResult.failure!)
        }
        
        let dstResult = resolvePath(dirFd: dstDirFd, subpath: dstPath)
        guard case .success(let dstUrl) = dstResult else {
            return .failure(dstResult.failure!)
        }
        
        do {
            // Remove destination if it exists
            if FileManager.default.fileExists(atPath: dstUrl.path) {
                try FileManager.default.removeItem(at: dstUrl)
            }
            try FileManager.default.moveItem(at: srcUrl, to: dstUrl)
            Log.wasi.debug("pathRename: \(srcPath) -> \(dstPath)")
            return .success(())
        } catch {
            Log.wasi.error("pathRename error: \(error)")
            return .failure(.io)
        }
    }
    
    /// Read directory entries
    func fdReaddir(fd: Int32, bufLen: UInt32, cookie: UInt64) -> Result<[String], WasiError> {
        guard let openFile = fdTable[fd] else {
            return .failure(.badf)
        }
        
        guard openFile.isDirectory else {
            return .failure(.notdir)
        }
        
        let url = openFile.path == "/" ? rootURL : rootURL.appendingPathComponent(String(openFile.path.dropFirst()))
        
        do {
            let contents = try FileManager.default.contentsOfDirectory(atPath: url.path)
            let startIndex = Int(cookie)
            let entries = Array(contents.dropFirst(startIndex))
            return .success(entries)
        } catch {
            Log.wasi.error("fdReaddir error: \(error)")
            return .failure(.io)
        }
    }
    
    /// Get preopened directory info
    func fdPrestatGet(fd: Int32) -> Result<(Int32, String), WasiError> {
        guard fd == preopenedFd else {
            return .failure(.badf)
        }
        return .success((3, "/")) // PR_TYPE_DIR, path "/"
    }
    
    // MARK: - Sync
    
    /// Sync file to disk
    func fdSync(_ fd: Int32) -> Result<Void, WasiError> {
        guard let openFile = fdTable[fd] else {
            return .failure(.badf)
        }
        
        do {
            try openFile.handle?.synchronize()
            return .success(())
        } catch {
            return .failure(.io)
        }
    }
}

// MARK: - Result Extension

private extension Result {
    var failure: Failure? {
        if case .failure(let error) = self {
            return error
        }
        return nil
    }
}
