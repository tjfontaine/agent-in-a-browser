//! Hybrid module resolver for URL and local imports.

use rquickjs::loader::Resolver;
use rquickjs::{Ctx, Result};
use serde_json::Value;
use std::path::{Component, Path, PathBuf};

#[derive(Clone, Copy)]
enum ResolveMode {
    Import,
    Require,
}

/// Hybrid resolver that routes URL imports to network and relative imports to OPFS.
pub struct HybridResolver;

impl Resolver for HybridResolver {
    fn resolve<'js>(&mut self, _ctx: &Ctx<'js>, base: &str, name: &str) -> Result<String> {
        Ok(resolve(base, name))
    }
}

/// Resolve a module specifier to an absolute path or URL.
///
/// Resolution strategy:
/// 1. Absolute URLs (`https://...`) - pass through unchanged
/// 2. Root-relative URLs from esm.sh (`/axios@1.13.2/...`) - resolve to esm.sh origin
/// 3. Relative paths (`./...`, `../...`) - resolve against base path
/// 4. Bare specifiers (`lodash`) - rewrite to esm.sh URL
pub fn resolve(base: &str, specifier: &str) -> String {
    resolve_mode(base, specifier, ResolveMode::Import)
}

/// Resolve for CommonJS `require()` semantics.
pub fn resolve_for_require(base: &str, specifier: &str) -> String {
    resolve_mode(base, specifier, ResolveMode::Require)
}

/// Convert a `file://` URL to a local absolute path.
///
/// Supports:
/// - `file:///tmp/a.ts`
/// - `file://localhost/tmp/a.ts`
pub fn file_url_to_path(url: &str) -> Option<String> {
    let rest = url.strip_prefix("file://")?;
    let path_part = if rest.starts_with('/') {
        rest.to_string()
    } else if let Some(after_host) = rest.strip_prefix("localhost/") {
        format!("/{}", after_host)
    } else if let Some((_host, path)) = rest.split_once('/') {
        format!("/{}", path)
    } else {
        return Some("/".to_string());
    };
    Some(percent_decode(&path_part))
}

fn resolve_mode(base: &str, specifier: &str, mode: ResolveMode) -> String {
    // Case A: Absolute URL - pass through
    if specifier.starts_with("https://")
        || specifier.starts_with("http://")
        || specifier.starts_with("file://")
    {
        return specifier.to_string();
    }

    // Case B: Root-relative import
    // - For esm.sh, keep resolving to esm.sh origin.
    // - For other HTTP(S) bases, resolve to same origin.
    // - For local filesystem-style execution, preserve absolute path.
    if specifier.starts_with('/') {
        if base.contains("esm.sh") {
            return format!("https://esm.sh{}", specifier);
        }
        if base.starts_with("https://") || base.starts_with("http://") {
            let (scheme, rest) = if let Some(rest) = base.strip_prefix("https://") {
                ("https://", rest)
            } else if let Some(rest) = base.strip_prefix("http://") {
                ("http://", rest)
            } else {
                ("", base)
            };
            let authority = rest.split('/').next().unwrap_or(rest);
            return format!("{}{}{}", scheme, authority, specifier);
        }
        if base.starts_with("file://") {
            return normalize_path_string(specifier);
        }
        return specifier.to_string();
    }

    if specifier.starts_with('#') {
        if let Some(resolved) = resolve_package_imports(base, specifier, mode) {
            return resolved;
        }
        return specifier.to_string();
    }

    // Case C: Relative import - resolve against base
    if specifier.starts_with("./") || specifier.starts_with("../") {
        let resolved = join_paths(base, specifier);
        if is_http_like(&resolved) {
            return resolved;
        }
        return resolve_local_candidate(&resolved).unwrap_or(resolved);
    }

    // Case D: Bare specifier - resolve in local node_modules first
    if let Some(resolved) = resolve_node_module_specifier(base, specifier, mode) {
        return resolved;
    }

    // Case E: Bare specifier fallback - rewrite to esm.sh
    format!("https://esm.sh/{}", specifier)
}

/// Join a base path with a relative path.
fn join_paths(base: &str, relative: &str) -> String {
    if let Some(local_base) = file_url_to_path(base) {
        return join_paths(&local_base, relative);
    }

    // Extract scheme and path
    let (scheme, base_path) = if base.starts_with("https://") {
        ("https://", &base[8..])
    } else if base.starts_with("http://") {
        ("http://", &base[7..])
    } else {
        ("", base)
    };

    // Handle ./ prefix
    let relative = relative.strip_prefix("./").unwrap_or(relative);

    if !scheme.is_empty() {
        let (authority, base_file_path) = match base_path.split_once('/') {
            Some((host, path)) => (host, path),
            None => (base_path, ""),
        };
        let base_dir = match base_file_path.rsplit_once('/') {
            Some((dir, _)) => dir,
            None => base_file_path,
        };

        let mut parts: Vec<&str> = base_dir.split('/').filter(|s| !s.is_empty()).collect();
        let mut rel_parts: Vec<&str> = relative.split('/').collect();

        while !rel_parts.is_empty() && rel_parts[0] == ".." {
            rel_parts.remove(0);
            if !parts.is_empty() {
                parts.pop();
            }
        }

        parts.extend(rel_parts);
        let joined_path = if parts.is_empty() {
            "/".to_string()
        } else {
            format!("/{}", parts.join("/"))
        };

        format!("{}{}{}", scheme, authority, joined_path)
    } else {
        // Get the directory of the base path
        let base_dir = match base_path.rsplit_once('/') {
            Some((dir, _)) => dir,
            None => base_path,
        };

        let mut parts: Vec<&str> = base_dir.split('/').filter(|s| !s.is_empty()).collect();
        let mut rel_parts: Vec<&str> = relative.split('/').collect();

        while !rel_parts.is_empty() && rel_parts[0] == ".." {
            rel_parts.remove(0);
            if !parts.is_empty() {
                parts.pop();
            }
        }

        parts.extend(rel_parts);
        format!("/{}", parts.join("/"))
    }
}

fn is_http_like(path: &str) -> bool {
    path.starts_with("https://") || path.starts_with("http://")
}

fn resolve_local_candidate(path: &str) -> Option<String> {
    let candidate = Path::new(path);
    if candidate.is_file() {
        return Some(normalize_path_string(path));
    }

    if candidate.extension().is_none() {
        for ext in ["ts", "tsx", "js", "mjs", "cjs", "json"] {
            let with_ext = format!("{}.{}", path, ext);
            if Path::new(&with_ext).is_file() {
                return Some(normalize_path_string(&with_ext));
            }
        }
    }

    if candidate.is_dir() {
        for idx in [
            "index.ts",
            "index.tsx",
            "index.js",
            "index.mjs",
            "index.cjs",
            "index.json",
        ] {
            let idx_path = format!("{}/{}", path, idx);
            if Path::new(&idx_path).is_file() {
                return Some(normalize_path_string(&idx_path));
            }
        }
    }

    None
}

fn base_dir_for_local(base: &str) -> Option<PathBuf> {
    if is_http_like(base) {
        return None;
    }
    let base = if let Some(local) = file_url_to_path(base) {
        local
    } else {
        base.to_string()
    };
    let base_path = Path::new(&base);
    if base_path.is_dir() {
        Some(base_path.to_path_buf())
    } else {
        base_path.parent().map(|p| p.to_path_buf())
    }
}

fn parse_package_specifier(specifier: &str) -> Option<(&str, Option<&str>)> {
    if specifier.is_empty() {
        return None;
    }
    if let Some(stripped) = specifier.strip_prefix('@') {
        let mut parts = stripped.splitn(3, '/');
        let scope = parts.next()?;
        let name = parts.next()?;
        let package_len = 1 + scope.len() + 1 + name.len();
        let package = &specifier[..package_len];
        let subpath = specifier.get(package_len + 1..);
        Some((package, subpath))
    } else {
        let mut parts = specifier.splitn(2, '/');
        let package = parts.next()?;
        let subpath = parts.next();
        Some((package, subpath))
    }
}

fn find_nearest_package_json(start_dir: &Path) -> Option<PathBuf> {
    let mut dir = Some(start_dir.to_path_buf());
    while let Some(current) = dir {
        let pkg = current.join("package.json");
        if pkg.is_file() {
            return Some(pkg);
        }
        dir = current.parent().map(|p| p.to_path_buf());
    }
    None
}

fn read_json_file(path: &Path) -> Option<Value> {
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str::<Value>(&text).ok()
}

fn select_target_with_conditions(value: &Value, mode: ResolveMode) -> Option<String> {
    if let Some(s) = value.as_str() {
        return Some(s.to_string());
    }
    let map = value.as_object()?;
    let keys: &[&str] = match mode {
        ResolveMode::Import => &["import", "node", "default"],
        ResolveMode::Require => &["require", "node", "default"],
    };
    for key in keys {
        if let Some(v) = map.get(*key) {
            if let Some(target) = select_target_with_conditions(v, mode) {
                return Some(target);
            }
        }
    }
    for nested in map.values() {
        if let Some(target) = select_target_with_conditions(nested, mode) {
            return Some(target);
        }
    }
    None
}

fn resolve_package_imports(base: &str, specifier: &str, mode: ResolveMode) -> Option<String> {
    let start_dir = base_dir_for_local(base)?;
    let pkg_json_path = find_nearest_package_json(&start_dir)?;
    let pkg_dir = pkg_json_path.parent()?;
    let pkg_json = read_json_file(&pkg_json_path)?;
    let imports = pkg_json.get("imports")?.as_object()?;
    if let Some(target) = imports
        .get(specifier)
        .and_then(|v| select_target_with_conditions(v, mode))
    {
        let abs = if target.starts_with("./") {
            pkg_dir.join(target).to_string_lossy().to_string()
        } else {
            target.to_string()
        };
        return resolve_local_candidate(&abs).or(Some(normalize_path_string(&abs)));
    }

    for (key, target) in imports {
        if !key.contains('*') {
            continue;
        }
        let captured = match_wildcard(key, specifier)?;
        let target_str = select_target_with_conditions(target, mode)?;
        let expanded = target_str.replace('*', &captured);
        let abs = if expanded.starts_with("./") {
            pkg_dir.join(expanded).to_string_lossy().to_string()
        } else {
            expanded
        };
        return resolve_local_candidate(&abs).or(Some(normalize_path_string(&abs)));
    }
    None
}

fn resolve_package_exports(
    package_root: &Path,
    subpath: Option<&str>,
    mode: ResolveMode,
) -> Option<String> {
    let pkg_json_path = package_root.join("package.json");
    let pkg_json = read_json_file(&pkg_json_path)?;

    if let Some(exports) = pkg_json.get("exports").and_then(|v| v.as_object()) {
        let key = match subpath {
            Some(s) if !s.is_empty() => format!("./{}", s),
            _ => ".".to_string(),
        };
        if let Some(target) = exports
            .get(&key)
            .and_then(|v| select_target_with_conditions(v, mode))
        {
            let abs = package_root.join(target).to_string_lossy().to_string();
            return resolve_local_candidate(&abs).or(Some(normalize_path_string(&abs)));
        }
        for (pattern, target) in exports {
            if !pattern.contains('*') {
                continue;
            }
            let captured = match_wildcard(pattern, &key)?;
            let target_str = select_target_with_conditions(target, mode)?;
            let expanded = target_str.replace('*', &captured);
            let abs = package_root.join(expanded).to_string_lossy().to_string();
            return resolve_local_candidate(&abs).or(Some(normalize_path_string(&abs)));
        }
    }

    if let Some(main) = pkg_json.get("main").and_then(|v| v.as_str()) {
        let abs = package_root.join(main).to_string_lossy().to_string();
        if let Some(resolved) = resolve_local_candidate(&abs).or(Some(normalize_path_string(&abs)))
        {
            return Some(resolved);
        }
    }
    if let Some(module) = pkg_json.get("module").and_then(|v| v.as_str()) {
        let abs = package_root.join(module).to_string_lossy().to_string();
        if let Some(resolved) = resolve_local_candidate(&abs).or(Some(normalize_path_string(&abs)))
        {
            return Some(resolved);
        }
    }

    None
}

fn resolve_node_module_specifier(base: &str, specifier: &str, mode: ResolveMode) -> Option<String> {
    let start_dir = base_dir_for_local(base)?;
    let (package_name, subpath) = parse_package_specifier(specifier)?;

    let mut dir = Some(start_dir);
    while let Some(current) = dir {
        let package_root = current.join("node_modules").join(package_name);
        if package_root.exists() {
            if let Some(resolved) = resolve_package_exports(&package_root, subpath, mode) {
                return Some(resolved);
            }

            if let Some(sub) = subpath {
                let sub_abs = package_root.join(sub).to_string_lossy().to_string();
                if let Some(resolved) =
                    resolve_local_candidate(&sub_abs).or(Some(normalize_path_string(&sub_abs)))
                {
                    return Some(resolved);
                }
            } else if let Some(resolved) =
                resolve_local_candidate(&package_root.to_string_lossy()).or(Some(
                    normalize_path_string(&package_root.to_string_lossy()),
                ))
            {
                return Some(resolved);
            }
        }
        dir = current.parent().map(|p| p.to_path_buf());
    }

    None
}

fn normalize_path_string(path: &str) -> String {
    let mut normalized = PathBuf::new();
    for component in Path::new(path).components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                let _ = normalized.pop();
            }
            other => normalized.push(other.as_os_str()),
        }
    }
    normalized.to_string_lossy().to_string()
}

fn match_wildcard(pattern: &str, value: &str) -> Option<String> {
    let (prefix, suffix) = pattern.split_once('*')?;
    if !value.starts_with(prefix) || !value.ends_with(suffix) {
        return None;
    }
    let start = prefix.len();
    let end = value.len().saturating_sub(suffix.len());
    if end < start {
        return None;
    }
    Some(value[start..end].to_string())
}

fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = String::with_capacity(input.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let h1 = bytes[i + 1];
            let h2 = bytes[i + 2];
            if let (Some(a), Some(b)) = (hex_value(h1), hex_value(h2)) {
                out.push((a * 16 + b) as char);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i] as char);
        i += 1;
    }
    out
}

fn hex_value(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_root(name: &str) -> String {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        format!("/tmp/tsx-resolver-{}-{}", name, nanos)
    }

    #[test]
    fn test_url_passthrough() {
        assert_eq!(
            resolve("", "https://esm.sh/lodash"),
            "https://esm.sh/lodash"
        );
    }

    #[test]
    fn test_bare_specifier() {
        assert_eq!(resolve("", "lodash"), "https://esm.sh/lodash");
    }

    #[test]
    fn test_relative_import() {
        assert_eq!(resolve("/src/main.ts", "./utils.ts"), "/src/utils.ts");
    }

    #[test]
    fn test_esm_sh_root_relative() {
        // Test the specific case that was failing
        // Base: https://esm.sh/axios@1.13.2/es2022/axios.mjs
        // Import: /axios@1.13.2/es2022/unsafe/utils.mjs
        let base = "https://esm.sh/axios@1.13.2/es2022/axios.mjs";
        let specifier = "/axios@1.13.2/es2022/unsafe/utils.mjs";
        assert_eq!(
            resolve(base, specifier),
            "https://esm.sh/axios@1.13.2/es2022/unsafe/utils.mjs"
        );
    }

    #[test]
    fn test_url_relative_join() {
        // Test joining relative path with URL base
        let base = "https://esm.sh/axios@1.13.2/es2022/unsafe/core/buildFullPath.mjs";
        let specifier = "../../utils.mjs";
        // Expected: https://esm.sh/axios@1.13.2/es2022/utils.mjs
        // Explanation:
        // Base dir: https://esm.sh/axios@1.13.2/es2022/unsafe/core
        // .. -> https://esm.sh/axios@1.13.2/es2022/unsafe
        // .. -> https://esm.sh/axios@1.13.2/es2022
        // + utils.mjs -> https://esm.sh/axios@1.13.2/es2022/utils.mjs
        
        assert_eq!(
            resolve(base, specifier),
            "https://esm.sh/axios@1.13.2/es2022/utils.mjs"
        );
    }

    #[test]
    fn test_schema_preservation() {
        assert_eq!(
            join_paths("https://example.com/foo/bar.js", "./baz.js"),
            "https://example.com/foo/baz.js"
        );
        assert_eq!(
            join_paths("http://example.com/foo/bar.js", "../baz.js"),
            "http://example.com/baz.js"
        );
    }

    #[test]
    fn test_join_paths_caps_at_domain_root() {
        assert_eq!(
            join_paths("https://example.com/a/b/c.ts", "../../../../x.ts"),
            "https://example.com/x.ts"
        );
    }

    #[test]
    fn test_root_relative_non_esm_sh_resolves_same_origin() {
        assert_eq!(
            resolve("https://example.com/main.mjs", "/pkg/mod.mjs"),
            "https://example.com/pkg/mod.mjs"
        );
    }

    #[test]
    fn test_relative_import_preserves_query_string() {
        assert_eq!(
            resolve("https://example.com/src/main.mjs", "./dep.mjs?x=1"),
            "https://example.com/src/dep.mjs?x=1"
        );
    }

    #[test]
    fn test_root_relative_local_path_is_preserved() {
        assert_eq!(resolve("/tmp/entry.mjs", "/tmp/dep.ts"), "/tmp/dep.ts");
    }

    #[test]
    fn test_relative_extension_fallback_to_ts() {
        let root = temp_root("ext");
        let _ = std::fs::create_dir_all(&root);
        let entry = format!("{}/entry.ts", root);
        let dep = format!("{}/dep.ts", root);
        std::fs::write(&entry, "export {}").unwrap();
        std::fs::write(&dep, "export const v = 1;").unwrap();

        let resolved = resolve(&entry, "./dep");
        assert_eq!(resolved, dep);

        let _ = std::fs::remove_file(&entry);
        let _ = std::fs::remove_file(&dep);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn test_relative_directory_index_resolution() {
        let root = temp_root("index");
        let pkg_dir = format!("{}/pkg", root);
        let _ = std::fs::create_dir_all(&pkg_dir);
        let entry = format!("{}/entry.ts", root);
        let index = format!("{}/index.ts", pkg_dir);
        std::fs::write(&entry, "export {}").unwrap();
        std::fs::write(&index, "export const v = 2;").unwrap();

        let resolved = resolve(&entry, "./pkg");
        assert_eq!(resolved, index);

        let _ = std::fs::remove_file(&entry);
        let _ = std::fs::remove_file(&index);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn test_node_modules_package_json_exports_main() {
        let root = temp_root("exports-main");
        let pkg_root = format!("{}/node_modules/foo", root);
        let _ = std::fs::create_dir_all(format!("{}/dist", pkg_root));
        let entry = format!("{}/app/entry.ts", root);
        let _ = std::fs::create_dir_all(format!("{}/app", root));

        std::fs::write(
            format!("{}/package.json", pkg_root),
            r#"{"name":"foo","exports":{"." :"./dist/index.js"}}"#,
        )
        .unwrap();
        std::fs::write(format!("{}/dist/index.js", pkg_root), "export default 1;").unwrap();
        std::fs::write(&entry, "export {}").unwrap();

        let resolved = resolve(&entry, "foo");
        assert_eq!(resolved, format!("{}/dist/index.js", pkg_root));

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn test_node_modules_package_json_exports_subpath() {
        let root = temp_root("exports-subpath");
        let pkg_root = format!("{}/node_modules/foo", root);
        let _ = std::fs::create_dir_all(format!("{}/dist", pkg_root));
        let entry = format!("{}/entry.ts", root);

        std::fs::write(
            format!("{}/package.json", pkg_root),
            r#"{"name":"foo","exports":{"./bar":"./dist/bar.js"}}"#,
        )
        .unwrap();
        std::fs::write(format!("{}/dist/bar.js", pkg_root), "export const bar = 1;").unwrap();
        std::fs::write(&entry, "export {}").unwrap();

        let resolved = resolve(&entry, "foo/bar");
        assert_eq!(resolved, format!("{}/dist/bar.js", pkg_root));

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn test_package_imports_hash_alias() {
        let root = temp_root("imports");
        let src = format!("{}/src", root);
        let _ = std::fs::create_dir_all(&src);
        let entry = format!("{}/src/entry.ts", root);
        let lib = format!("{}/src/lib.ts", root);

        std::fs::write(
            format!("{}/package.json", root),
            r##"{"imports":{"#lib":"./src/lib.ts"}}"##,
        )
        .unwrap();
        std::fs::write(&entry, "export {}").unwrap();
        std::fs::write(&lib, "export const lib = 1;").unwrap();

        let resolved = resolve(&entry, "#lib");
        assert_eq!(resolved, lib);

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn test_package_imports_wildcard_alias() {
        let root = temp_root("imports-wildcard");
        let utils = format!("{}/src/utils", root);
        let _ = std::fs::create_dir_all(&utils);
        let entry = format!("{}/src/entry.ts", root);
        let helper = format!("{}/src/utils/helper.ts", root);

        std::fs::write(
            format!("{}/package.json", root),
            r##"{"imports":{"#utils/*":"./src/utils/*.ts"}}"##,
        )
        .unwrap();
        std::fs::write(&entry, "export {}").unwrap();
        std::fs::write(&helper, "export const h = 1;").unwrap();

        let resolved = resolve(&entry, "#utils/helper");
        assert_eq!(resolved, helper);

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn test_node_modules_package_json_exports_wildcard_subpath() {
        let root = temp_root("exports-wildcard");
        let pkg_root = format!("{}/node_modules/foo", root);
        let _ = std::fs::create_dir_all(format!("{}/dist", pkg_root));
        let entry = format!("{}/entry.ts", root);

        std::fs::write(
            format!("{}/package.json", pkg_root),
            r#"{"name":"foo","exports":{"./*":"./dist/*.js"}}"#,
        )
        .unwrap();
        std::fs::write(format!("{}/dist/math.js", pkg_root), "export const n = 1;").unwrap();
        std::fs::write(&entry, "export {}").unwrap();

        let resolved = resolve(&entry, "foo/math");
        assert_eq!(resolved, format!("{}/dist/math.js", pkg_root));

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn test_node_modules_package_json_exports_conditions_import_and_require() {
        let root = temp_root("exports-conditions");
        let pkg_root = format!("{}/node_modules/foo", root);
        let _ = std::fs::create_dir_all(format!("{}/dist", pkg_root));
        let entry = format!("{}/entry.ts", root);

        std::fs::write(
            format!("{}/package.json", pkg_root),
            r#"{"name":"foo","exports":{"." :{"import":"./dist/esm.js","require":"./dist/cjs.cjs","default":"./dist/default.js"}}}"#,
        )
        .unwrap();
        std::fs::write(format!("{}/dist/esm.js", pkg_root), "export const esm = 1;").unwrap();
        std::fs::write(
            format!("{}/dist/cjs.cjs", pkg_root),
            "module.exports = { cjs: 1 };",
        )
        .unwrap();
        std::fs::write(
            format!("{}/dist/default.js", pkg_root),
            "export const def = 1;",
        )
        .unwrap();
        std::fs::write(&entry, "export {}").unwrap();

        let import_resolved = resolve(&entry, "foo");
        let require_resolved = resolve_for_require(&entry, "foo");
        assert_eq!(import_resolved, format!("{}/dist/esm.js", pkg_root));
        assert_eq!(require_resolved, format!("{}/dist/cjs.cjs", pkg_root));

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn test_file_url_base_relative_import_resolves_to_local_path() {
        let resolved = resolve("file:///tmp/tsx-file-url/entry.ts", "./dep.ts");
        assert_eq!(resolved, "/tmp/tsx-file-url/dep.ts");
    }

    #[test]
    fn test_file_url_base_require_node_modules_package() {
        let root = temp_root("file-url-require");
        let pkg_root = format!("{}/node_modules/foo", root);
        let _ = std::fs::create_dir_all(format!("{}/dist", pkg_root));
        let entry_path = format!("{}/src/entry.ts", root);
        let _ = std::fs::create_dir_all(format!("{}/src", root));

        std::fs::write(
            format!("{}/package.json", pkg_root),
            r#"{"name":"foo","exports":{"." :{"require":"./dist/cjs.cjs"}}}"#,
        )
        .unwrap();
        std::fs::write(
            format!("{}/dist/cjs.cjs", pkg_root),
            "module.exports = { cjs: 1 };",
        )
        .unwrap();
        std::fs::write(&entry_path, "export {}").unwrap();

        let resolved = resolve_for_require(&format!("file://{}", entry_path), "foo");
        assert_eq!(resolved, format!("{}/dist/cjs.cjs", pkg_root));

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn test_file_url_percent_decoding_for_local_path() {
        let resolved = file_url_to_path("file:///tmp/with%20space/entry.ts").unwrap();
        assert_eq!(resolved, "/tmp/with space/entry.ts");
    }

    #[test]
    fn test_file_url_windows_drive_format_is_preserved_as_local_path() {
        let resolved = file_url_to_path("file:///C:/work/entry.ts").unwrap();
        assert_eq!(resolved, "/C:/work/entry.ts");
    }

    #[test]
    fn test_node_modules_exports_nested_conditions_import_and_require() {
        let root = temp_root("exports-nested-conditions");
        let pkg_root = format!("{}/node_modules/foo", root);
        let _ = std::fs::create_dir_all(format!("{}/dist", pkg_root));
        let entry = format!("{}/entry.ts", root);

        std::fs::write(
            format!("{}/package.json", pkg_root),
            r#"{"name":"foo","exports":{"." :{"node":{"import":"./dist/node-esm.js","require":"./dist/node-cjs.cjs"},"default":"./dist/default.js"}}}"#,
        )
        .unwrap();
        std::fs::write(format!("{}/dist/node-esm.js", pkg_root), "export const esm = 1;").unwrap();
        std::fs::write(
            format!("{}/dist/node-cjs.cjs", pkg_root),
            "module.exports = { cjs: 1 };",
        )
        .unwrap();
        std::fs::write(
            format!("{}/dist/default.js", pkg_root),
            "export const def = 1;",
        )
        .unwrap();
        std::fs::write(&entry, "export {}").unwrap();

        let import_resolved = resolve(&entry, "foo");
        let require_resolved = resolve_for_require(&entry, "foo");
        assert_eq!(import_resolved, format!("{}/dist/node-esm.js", pkg_root));
        assert_eq!(require_resolved, format!("{}/dist/node-cjs.cjs", pkg_root));

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn test_node_modules_exports_exact_match_precedence_over_wildcard() {
        let root = temp_root("exports-exact-vs-wildcard");
        let pkg_root = format!("{}/node_modules/foo", root);
        let _ = std::fs::create_dir_all(format!("{}/dist", pkg_root));
        let entry = format!("{}/entry.ts", root);

        std::fs::write(
            format!("{}/package.json", pkg_root),
            r#"{"name":"foo","exports":{"./feature":"./dist/exact.js","./*":"./dist/*.js"}}"#,
        )
        .unwrap();
        std::fs::write(format!("{}/dist/exact.js", pkg_root), "export const exact = 1;").unwrap();
        std::fs::write(
            format!("{}/dist/feature.js", pkg_root),
            "export const wildcard = 1;",
        )
        .unwrap();
        std::fs::write(&entry, "export {}").unwrap();

        let resolved = resolve(&entry, "foo/feature");
        assert_eq!(resolved, format!("{}/dist/exact.js", pkg_root));

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn test_node_modules_exports_require_falls_back_to_default_condition() {
        let root = temp_root("exports-require-default-fallback");
        let pkg_root = format!("{}/node_modules/foo", root);
        let _ = std::fs::create_dir_all(format!("{}/dist", pkg_root));
        let entry = format!("{}/entry.ts", root);

        std::fs::write(
            format!("{}/package.json", pkg_root),
            r#"{"name":"foo","exports":{"." :{"import":"./dist/esm.js","default":"./dist/default.js"}}}"#,
        )
        .unwrap();
        std::fs::write(format!("{}/dist/esm.js", pkg_root), "export const esm = 1;").unwrap();
        std::fs::write(
            format!("{}/dist/default.js", pkg_root),
            "module.exports = { fallback: 1 };",
        )
        .unwrap();
        std::fs::write(&entry, "export {}").unwrap();

        let resolved = resolve_for_require(&entry, "foo");
        assert_eq!(resolved, format!("{}/dist/default.js", pkg_root));

        let _ = std::fs::remove_dir_all(&root);
    }
}
