//! Hybrid module resolver for URL and local imports.

use rquickjs::loader::Resolver;
use rquickjs::{Ctx, Result};

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
    // Case A: Absolute URL - pass through
    if specifier.starts_with("https://") || specifier.starts_with("http://") {
        return specifier.to_string();
    }

    // Case B: Root-relative import from esm.sh (e.g., "/axios@1.13.2/es2022/axios.mjs")
    // When the base is an esm.sh URL, these should resolve to esm.sh
    if specifier.starts_with('/') && base.contains("esm.sh") {
        return format!("https://esm.sh{}", specifier);
    }

    // Case C: Relative import - resolve against base
    if specifier.starts_with("./") || specifier.starts_with("../") {
        return join_paths(base, specifier);
    }

    // Case D: Bare specifier - rewrite to esm.sh
    format!("https://esm.sh/{}", specifier)
}

/// Join a base path with a relative path.
fn join_paths(base: &str, relative: &str) -> String {
    // Extract scheme and path
    let (scheme, base_path) = if base.starts_with("https://") {
        ("https://", &base[8..])
    } else if base.starts_with("http://") {
        ("http://", &base[7..])
    } else {
        ("", base)
    };

    // Get the directory of the base path
    let base_dir = match base_path.rsplit_once('/') {
        Some((dir, _)) => dir,
        None => base_path, // Fallback, though usually base has a path
    };

    // Handle ./ prefix
    let relative = relative.strip_prefix("./").unwrap_or(relative);

    // Handle ../ prefixes
    let mut parts: Vec<&str> = base_dir.split('/').filter(|s| !s.is_empty()).collect();
    let mut rel_parts: Vec<&str> = relative.split('/').collect();

    while !rel_parts.is_empty() && rel_parts[0] == ".." {
        rel_parts.remove(0);
        if !parts.is_empty() {
            parts.pop();
        }
    }

    parts.extend(rel_parts);

    let joined = parts.join("/");

    if !scheme.is_empty() {
        format!("{}{}", scheme, joined)
    } else if joined.starts_with('/') {
        joined
    } else {
        format!("/{}", joined)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
