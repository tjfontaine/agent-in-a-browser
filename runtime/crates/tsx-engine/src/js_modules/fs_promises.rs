//! fs.promises module - Node.js filesystem API.
//!
//! Provides both sync and async filesystem operations backed by std::fs.
//! Sync operations use std::fs directly.
//! Async operations wrap sync in Promises (WASI fs is synchronous anyway).

use rquickjs::{Ctx, Function, Object, Result, Value};
use std::path::Path;

/// Install fs and fs.promises on the global object.
pub fn install(ctx: &Ctx<'_>) -> Result<()> {
    let globals = ctx.globals();
    
    // Create fs object
    let fs = Object::new(ctx.clone())?;
    
    // ========================================================================
    // Sync Functions
    // ========================================================================
    
    // fs.readFileSync(path, options?)
    let read_file_sync = Function::new(ctx.clone(), |path: String, options: Value| -> rquickjs::Result<String> {
        let _encoding = get_encoding(&options);
        std::fs::read_to_string(&path).map_err(rquickjs::Error::Io)
    })?;
    fs.set("readFileSync", read_file_sync)?;
    
    // fs.writeFileSync(path, data, options?)
    let write_file_sync = Function::new(ctx.clone(), |path: String, data: String| -> rquickjs::Result<()> {
        std::fs::write(&path, data.as_bytes()).map_err(rquickjs::Error::Io)
    })?;
    fs.set("writeFileSync", write_file_sync)?;
    
    // fs.existsSync(path)
    let exists_sync = Function::new(ctx.clone(), |path: String| -> bool {
        Path::new(&path).exists()
    })?;
    fs.set("existsSync", exists_sync)?;
    
    // fs.readdirSync(path)
    let readdir_sync = Function::new(ctx.clone(), |path: String| -> rquickjs::Result<Vec<String>> {
        match std::fs::read_dir(&path) {
            Ok(entries) => {
                let names: Vec<String> = entries
                    .filter_map(|e| e.ok())
                    .map(|e| e.file_name().to_string_lossy().to_string())
                    .collect();
                Ok(names)
            }
            Err(e) => Err(rquickjs::Error::Io(e)),
        }
    })?;
    fs.set("readdirSync", readdir_sync)?;
    
    // fs.__statSyncRaw(path) - returns raw stats as array [size, isFile, isDir, isSym, mode]
    // This avoids lifetime issues with returning objects from Rust
    let stat_sync_raw = Function::new(ctx.clone(), |path: String| -> rquickjs::Result<Vec<i64>> {
        match std::fs::metadata(&path) {
            Ok(meta) => {
                #[cfg(unix)]
                let mode = {
                    use std::os::unix::fs::MetadataExt;
                    meta.mode() as i64
                };
                #[cfg(not(unix))]
                let mode = 0i64;
                
                Ok(vec![
                    meta.len() as i64,
                    if meta.is_file() { 1 } else { 0 },
                    if meta.is_dir() { 1 } else { 0 },
                    if meta.file_type().is_symlink() { 1 } else { 0 },
                    mode,
                ])
            }
            Err(e) => Err(rquickjs::Error::Io(e)),
        }
    })?;
    fs.set("__statSyncRaw", stat_sync_raw)?;
    
    // fs.__lstatSyncRaw(path) - returns raw stats for symlink
    let lstat_sync_raw = Function::new(ctx.clone(), |path: String| -> rquickjs::Result<Vec<i64>> {
        match std::fs::symlink_metadata(&path) {
            Ok(meta) => {
                #[cfg(unix)]
                let mode = {
                    use std::os::unix::fs::MetadataExt;
                    meta.mode() as i64
                };
                #[cfg(not(unix))]
                let mode = 0i64;
                
                Ok(vec![
                    meta.len() as i64,
                    if meta.is_file() { 1 } else { 0 },
                    if meta.is_dir() { 1 } else { 0 },
                    if meta.file_type().is_symlink() { 1 } else { 0 },
                    mode,
                ])
            }
            Err(e) => Err(rquickjs::Error::Io(e)),
        }
    })?;
    fs.set("__lstatSyncRaw", lstat_sync_raw)?;
    
    // fs.mkdirSync(path, options?)
    let mkdir_sync = Function::new(ctx.clone(), |path: String, options: Value| -> rquickjs::Result<()> {
        let recursive = options.as_object()
            .and_then(|o| o.get::<_, bool>("recursive").ok())
            .unwrap_or(false);
        
        let result = if recursive {
            std::fs::create_dir_all(&path)
        } else {
            std::fs::create_dir(&path)
        };
        
        result.map_err(rquickjs::Error::Io)
    })?;
    fs.set("mkdirSync", mkdir_sync)?;
    
    // fs.rmdirSync(path)
    let rmdir_sync = Function::new(ctx.clone(), |path: String| -> rquickjs::Result<()> {
        std::fs::remove_dir(&path).map_err(rquickjs::Error::Io)
    })?;
    fs.set("rmdirSync", rmdir_sync)?;
    
    // fs.unlinkSync(path)
    let unlink_sync = Function::new(ctx.clone(), |path: String| -> rquickjs::Result<()> {
        std::fs::remove_file(&path).map_err(rquickjs::Error::Io)
    })?;
    fs.set("unlinkSync", unlink_sync)?;
    
    // fs.rmSync(path, options?)
    let rm_sync = Function::new(ctx.clone(), |path: String, options: Value| -> rquickjs::Result<()> {
        let recursive = options.as_object()
            .and_then(|o| o.get::<_, bool>("recursive").ok())
            .unwrap_or(false);
        
        let p = Path::new(&path);
        let result = if p.is_dir() {
            if recursive {
                std::fs::remove_dir_all(&path)
            } else {
                std::fs::remove_dir(&path)
            }
        } else {
            std::fs::remove_file(&path)
        };
        
        result.map_err(rquickjs::Error::Io)
    })?;
    fs.set("rmSync", rm_sync)?;
    
    // fs.renameSync(oldPath, newPath)
    let rename_sync = Function::new(ctx.clone(), |old_path: String, new_path: String| -> rquickjs::Result<()> {
        std::fs::rename(&old_path, &new_path).map_err(rquickjs::Error::Io)
    })?;
    fs.set("renameSync", rename_sync)?;
    
    // fs.copyFileSync(src, dest)
    let copy_file_sync = Function::new(ctx.clone(), |src: String, dest: String| -> rquickjs::Result<()> {
        std::fs::copy(&src, &dest).map(|_| ()).map_err(rquickjs::Error::Io)
    })?;
    fs.set("copyFileSync", copy_file_sync)?;
    
    // fs.appendFileSync(path, data)
    let append_file_sync = Function::new(ctx.clone(), |path: String, data: String| -> rquickjs::Result<()> {
        use std::fs::OpenOptions;
        use std::io::Write;
        
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .map_err(rquickjs::Error::Io)?;
        
        file.write_all(data.as_bytes()).map_err(rquickjs::Error::Io)
    })?;
    fs.set("appendFileSync", append_file_sync)?;
    
    // fs.constants
    let constants = Object::new(ctx.clone())?;
    constants.set("F_OK", 0)?;
    constants.set("R_OK", 4)?;
    constants.set("W_OK", 2)?;
    constants.set("X_OK", 1)?;
    fs.set("constants", constants)?;
    
    // ========================================================================
    // Set up fs on globals and create fs.promises wrappers and stat helpers
    // ========================================================================
    
    globals.set("fs", fs)?;
    
    // Create statSync/lstatSync wrappers and fs.promises
    ctx.eval::<(), _>(FS_HELPERS_JS)?;
    
    Ok(())
}

/// Get encoding option from options object
fn get_encoding(options: &Value) -> Option<String> {
    if let Some(s) = options.as_string() {
        return Some(s.to_string().unwrap_or_default());
    }
    options.as_object()
        .and_then(|o| o.get::<_, String>("encoding").ok())
}

// JavaScript helpers for statSync and fs.promises
const FS_HELPERS_JS: &str = r#"
// Create Stats-like object from raw array [size, isFile, isDir, isSym, mode]
function makeStats(raw) {
    const _isFile = raw[1] === 1;
    const _isDir = raw[2] === 1;
    const _isSym = raw[3] === 1;
    return {
        size: raw[0],
        mode: raw[4],
        isFile: function() { return _isFile; },
        isDirectory: function() { return _isDir; },
        isSymbolicLink: function() { return _isSym; },
        isBlockDevice: function() { return false; },
        isCharacterDevice: function() { return false; },
        isFIFO: function() { return false; },
        isSocket: function() { return false; }
    };
}

// Wrap raw stat functions to return Stats objects
fs.statSync = function(path) {
    return makeStats(fs.__statSyncRaw(path));
};

fs.lstatSync = function(path) {
    return makeStats(fs.__lstatSyncRaw(path));
};

// Wrap functions that have optional options parameter
// Store internal versions
const _readFileSync = fs.readFileSync;
const _mkdirSync = fs.mkdirSync;
const _rmSync = fs.rmSync;

// Wrap with default options
fs.readFileSync = function(path, options) {
    return _readFileSync(path, options || {});
};

fs.mkdirSync = function(path, options) {
    return _mkdirSync(path, options || {});
};

fs.rmSync = function(path, options) {
    return _rmSync(path, options || {});
};

// Create fs.promises namespace
fs.promises = {
    readFile: function(path, options) {
        return new Promise((resolve, reject) => {
            try {
                resolve(fs.readFileSync(path, options));
            } catch (e) {
                reject(e);
            }
        });
    },
    writeFile: function(path, data, options) {
        return new Promise((resolve, reject) => {
            try {
                resolve(fs.writeFileSync(path, data, options));
            } catch (e) {
                reject(e);
            }
        });
    },
    readdir: function(path, options) {
        return new Promise((resolve, reject) => {
            try {
                resolve(fs.readdirSync(path, options));
            } catch (e) {
                reject(e);
            }
        });
    },
    stat: function(path) {
        return new Promise((resolve, reject) => {
            try {
                resolve(fs.statSync(path));
            } catch (e) {
                reject(e);
            }
        });
    },
    lstat: function(path) {
        return new Promise((resolve, reject) => {
            try {
                resolve(fs.lstatSync(path));
            } catch (e) {
                reject(e);
            }
        });
    },
    mkdir: function(path, options) {
        return new Promise((resolve, reject) => {
            try {
                resolve(fs.mkdirSync(path, options));
            } catch (e) {
                reject(e);
            }
        });
    },
    rmdir: function(path, options) {
        return new Promise((resolve, reject) => {
            try {
                resolve(fs.rmdirSync(path, options));
            } catch (e) {
                reject(e);
            }
        });
    },
    rm: function(path, options) {
        return new Promise((resolve, reject) => {
            try {
                resolve(fs.rmSync(path, options));
            } catch (e) {
                reject(e);
            }
        });
    },
    unlink: function(path) {
        return new Promise((resolve, reject) => {
            try {
                resolve(fs.unlinkSync(path));
            } catch (e) {
                reject(e);
            }
        });
    },
    rename: function(oldPath, newPath) {
        return new Promise((resolve, reject) => {
            try {
                resolve(fs.renameSync(oldPath, newPath));
            } catch (e) {
                reject(e);
            }
        });
    },
    copyFile: function(src, dest) {
        return new Promise((resolve, reject) => {
            try {
                resolve(fs.copyFileSync(src, dest));
            } catch (e) {
                reject(e);
            }
        });
    },
    appendFile: function(path, data, options) {
        return new Promise((resolve, reject) => {
            try {
                resolve(fs.appendFileSync(path, data, options));
            } catch (e) {
                reject(e);
            }
        });
    },
    access: function(path, mode) {
        return new Promise((resolve, reject) => {
            try {
                fs.statSync(path);
                resolve();
            } catch (e) {
                reject(e);
            }
        });
    }
};
"#;

