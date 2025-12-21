//! Origin Private File System (OPFS) access.

use wasm_bindgen::prelude::*;
use wasm_bindgen_futures::JsFuture;
use web_sys::FileSystemDirectoryHandle;

/// Read a file from OPFS at the given path.
///
/// Path should be absolute (starting with `/`).
pub async fn read_file(path: &str) -> Result<String, String> {
    let root = get_opfs_root().await?;

    let parts: Vec<&str> = path
        .trim_start_matches('/')
        .split('/')
        .filter(|s| !s.is_empty())
        .collect();

    if parts.is_empty() {
        return Err("Empty path".to_string());
    }

    // Navigate to the file
    let mut current_dir = root;

    for (i, part) in parts.iter().enumerate() {
        if i == parts.len() - 1 {
            // Last part - get file
            let file_handle = get_file_handle(&current_dir, part).await?;
            return read_file_content(&file_handle).await;
        } else {
            // Navigate into directory
            current_dir = get_directory_handle(&current_dir, part).await?;
        }
    }

    Err("File not found".to_string())
}

/// Write a file to OPFS at the given path.
///
/// Creates parent directories as needed.
pub async fn write_file(path: &str, content: &str) -> Result<(), String> {
    let root = get_opfs_root().await?;

    let parts: Vec<&str> = path
        .trim_start_matches('/')
        .split('/')
        .filter(|s| !s.is_empty())
        .collect();

    if parts.is_empty() {
        return Err("Empty path".to_string());
    }

    // Navigate/create directories
    let mut current_dir = root;

    for (i, part) in parts.iter().enumerate() {
        if i == parts.len() - 1 {
            // Last part - create/write file
            let file_handle = get_or_create_file_handle(&current_dir, part).await?;
            return write_file_content(&file_handle, content).await;
        } else {
            // Navigate into directory (create if needed)
            current_dir = get_or_create_directory_handle(&current_dir, part).await?;
        }
    }

    Err("Unexpected error".to_string())
}

/// Get the OPFS root directory handle.
async fn get_opfs_root() -> Result<FileSystemDirectoryHandle, String> {
    let global = js_sys::global();

    // Try navigator.storage.getDirectory()
    let navigator = js_sys::Reflect::get(&global, &"navigator".into())
        .map_err(|_| "navigator not available")?;

    let storage =
        js_sys::Reflect::get(&navigator, &"storage".into()).map_err(|_| "storage not available")?;

    let get_directory = js_sys::Reflect::get(&storage, &"getDirectory".into())
        .map_err(|_| "getDirectory not available")?;

    let get_directory: js_sys::Function = get_directory
        .dyn_into()
        .map_err(|_| "getDirectory is not a function")?;

    let promise = get_directory
        .call0(&storage)
        .map_err(|e| format!("getDirectory call failed: {:?}", e))?;

    let root = JsFuture::from(js_sys::Promise::from(promise))
        .await
        .map_err(|e| format!("getDirectory failed: {:?}", e))?;

    root.dyn_into()
        .map_err(|_| "result is not a FileSystemDirectoryHandle".to_string())
}

async fn get_file_handle(
    dir: &FileSystemDirectoryHandle,
    name: &str,
) -> Result<web_sys::FileSystemFileHandle, String> {
    let promise = dir.get_file_handle(name);
    let handle = JsFuture::from(promise)
        .await
        .map_err(|e| format!("getFileHandle failed: {:?}", e))?;

    handle
        .dyn_into()
        .map_err(|_| "not a FileSystemFileHandle".to_string())
}

async fn get_or_create_file_handle(
    dir: &FileSystemDirectoryHandle,
    name: &str,
) -> Result<web_sys::FileSystemFileHandle, String> {
    let options = web_sys::FileSystemGetFileOptions::new();
    options.set_create(true);

    let promise = dir.get_file_handle_with_options(name, &options);
    let handle = JsFuture::from(promise)
        .await
        .map_err(|e| format!("getFileHandle failed: {:?}", e))?;

    handle
        .dyn_into()
        .map_err(|_| "not a FileSystemFileHandle".to_string())
}

async fn get_directory_handle(
    dir: &FileSystemDirectoryHandle,
    name: &str,
) -> Result<FileSystemDirectoryHandle, String> {
    let promise = dir.get_directory_handle(name);
    let handle = JsFuture::from(promise)
        .await
        .map_err(|e| format!("getDirectoryHandle failed: {:?}", e))?;

    handle
        .dyn_into()
        .map_err(|_| "not a FileSystemDirectoryHandle".to_string())
}

async fn get_or_create_directory_handle(
    dir: &FileSystemDirectoryHandle,
    name: &str,
) -> Result<FileSystemDirectoryHandle, String> {
    let options = web_sys::FileSystemGetDirectoryOptions::new();
    options.set_create(true);

    let promise = dir.get_directory_handle_with_options(name, &options);
    let handle = JsFuture::from(promise)
        .await
        .map_err(|e| format!("getDirectoryHandle failed: {:?}", e))?;

    handle
        .dyn_into()
        .map_err(|_| "not a FileSystemDirectoryHandle".to_string())
}

async fn read_file_content(file_handle: &web_sys::FileSystemFileHandle) -> Result<String, String> {
    let promise = file_handle.get_file();
    let file = JsFuture::from(promise)
        .await
        .map_err(|e| format!("getFile failed: {:?}", e))?;

    let file: web_sys::File = file.dyn_into().map_err(|_| "not a File".to_string())?;

    let promise = file.text();
    let text = JsFuture::from(promise)
        .await
        .map_err(|e| format!("text() failed: {:?}", e))?;

    text.as_string()
        .ok_or_else(|| "text is not a string".to_string())
}

async fn write_file_content(
    file_handle: &web_sys::FileSystemFileHandle,
    content: &str,
) -> Result<(), String> {
    // Get writable stream
    let promise = file_handle.create_writable();
    let writable = JsFuture::from(promise)
        .await
        .map_err(|e| format!("createWritable await failed: {:?}", e))?;

    let writable: web_sys::FileSystemWritableFileStream = writable
        .dyn_into()
        .map_err(|_| "not a FileSystemWritableFileStream".to_string())?;

    // Write content
    let promise = writable
        .write_with_str(content)
        .map_err(|e| format!("write failed: {:?}", e))?;
    JsFuture::from(promise)
        .await
        .map_err(|e| format!("write await failed: {:?}", e))?;

    // Close stream
    let promise = writable.close();
    JsFuture::from(promise)
        .await
        .map_err(|e| format!("close failed: {:?}", e))?;

    Ok(())
}
