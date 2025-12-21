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
/// 2. Relative paths (`./...`, `../...`) - resolve against base path
/// 3. Bare specifiers (`lodash`) - rewrite to esm.sh URL
pub fn resolve(base: &str, specifier: &str) -> String {
    // Case A: Absolute URL - pass through
    if specifier.starts_with("https://") || specifier.starts_with("http://") {
        return specifier.to_string();
    }

    // Case B: Relative import - resolve against base
    if specifier.starts_with("./") || specifier.starts_with("../") {
        return join_paths(base, specifier);
    }

    // Case C: Bare specifier - rewrite to esm.sh
    format!("https://esm.sh/{}", specifier)
}

/// Join a base path with a relative path.
fn join_paths(base: &str, relative: &str) -> String {
    // Get the directory of the base path
    let base_dir = if base.starts_with("https://") || base.starts_with("http://") {
        match base.rsplit_once('/') {
            Some((dir, _)) => dir,
            None => base,
        }
    } else {
        match base.rsplit_once('/') {
            Some((dir, _)) => dir,
            None => "",
        }
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

    // Preserve URL scheme if present
    if base_dir.starts_with("https://") {
        format!("https://{}", parts.join("/"))
    } else if base_dir.starts_with("http://") {
        format!("http://{}", parts.join("/"))
    } else if parts.is_empty() {
        "/".to_string()
    } else {
        format!("/{}", parts.join("/"))
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
}
