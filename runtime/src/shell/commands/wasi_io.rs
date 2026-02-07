//! WASI-compatible IO implementation for turso_core
//!
//! Provides persistent file-backed database storage using WASI filesystem APIs.

use std::collections::HashMap;
use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::sync::{Arc, Mutex};

use turso_core::io::clock::{Clock, Instant};
use turso_core::io::{Buffer, Completion, OpenFlags, IO};
use turso_core::Result;

/// WASI-compatible IO implementation
pub struct WasiIO {
    files: Mutex<HashMap<String, Arc<WasiFile>>>,
}

impl WasiIO {
    pub fn new() -> Self {
        Self {
            files: Mutex::new(HashMap::new()),
        }
    }
}

impl Default for WasiIO {
    fn default() -> Self {
        Self::new()
    }
}

/// Clock implementation - uses WASI on WASM, std::time on native
impl Clock for WasiIO {
    fn now(&self) -> Instant {
        #[cfg(target_family = "wasm")]
        {
            // Use WASI wall clock
            let datetime = wasi::clocks::wall_clock::now();
            Instant {
                secs: datetime.seconds as i64,
                micros: (datetime.nanoseconds / 1000) as u32,
            }
        }
        #[cfg(not(target_family = "wasm"))]
        {
            // Use std::time for native builds
            use std::time::{SystemTime, UNIX_EPOCH};
            let now = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default();
            Instant {
                secs: now.as_secs() as i64,
                micros: now.subsec_micros(),
            }
        }
    }
}

impl IO for WasiIO {
    fn open_file(
        &self,
        path: &str,
        flags: OpenFlags,
        _direct: bool,
    ) -> Result<Arc<dyn turso_core::io::File>> {
        let mut files = self.files.lock().unwrap();

        // Check if already open
        if let Some(file) = files.get(path) {
            return Ok(file.clone());
        }

        // Open or create file
        let mut opts = OpenOptions::new();
        opts.read(true);

        if flags.contains(OpenFlags::Create) {
            opts.write(true).create(true);
        } else if !flags.contains(OpenFlags::ReadOnly) {
            opts.write(true);
        }

        // std::io::Error automatically converts to LimboError via From impl
        let file = opts.open(path)?;

        let wasi_file = Arc::new(WasiFile {
            path: path.to_string(),
            file: Mutex::new(file),
        });

        files.insert(path.to_string(), wasi_file.clone());
        Ok(wasi_file)
    }

    fn remove_file(&self, path: &str) -> Result<()> {
        let mut files = self.files.lock().unwrap();
        files.remove(path);
        std::fs::remove_file(path)?;
        Ok(())
    }
}

/// WASI-compatible file implementation
pub struct WasiFile {
    #[allow(dead_code)]
    path: String,
    file: Mutex<File>,
}

// Safety: File operations are protected by mutex
unsafe impl Send for WasiFile {}
unsafe impl Sync for WasiFile {}

impl turso_core::io::File for WasiFile {
    fn lock_file(&self, _exclusive: bool) -> Result<()> {
        // WASI doesn't support file locking - no-op
        Ok(())
    }

    fn unlock_file(&self) -> Result<()> {
        // WASI doesn't support file locking - no-op
        Ok(())
    }

    fn pread(&self, pos: u64, c: Completion) -> Result<Completion> {
        let r = c.as_read();
        let buf_len = r.buf().len();

        if buf_len == 0 {
            c.complete(0);
            return Ok(c);
        }

        let mut file = self.file.lock().unwrap();
        file.seek(SeekFrom::Start(pos))?;

        let read_buf = r.buf().as_mut_slice();
        let bytes_read = file.read(read_buf)?;

        c.complete(bytes_read as i32);
        Ok(c)
    }

    fn pwrite(&self, pos: u64, buffer: Arc<Buffer>, c: Completion) -> Result<Completion> {
        let buf_len = buffer.len();

        if buf_len == 0 {
            c.complete(0);
            return Ok(c);
        }

        let mut file = self.file.lock().unwrap();
        file.seek(SeekFrom::Start(pos))?;

        let bytes_written = file.write(buffer.as_slice())?;

        c.complete(bytes_written as i32);
        Ok(c)
    }

    fn sync(&self, c: Completion) -> Result<Completion> {
        let file = self.file.lock().unwrap();
        file.sync_all()?;
        c.complete(0);
        Ok(c)
    }

    fn size(&self) -> Result<u64> {
        let file = self.file.lock().unwrap();
        let metadata = file.metadata()?;
        Ok(metadata.len())
    }

    fn truncate(&self, len: u64, c: Completion) -> Result<Completion> {
        let file = self.file.lock().unwrap();
        file.set_len(len)?;
        c.complete(0);
        Ok(c)
    }
}
