//! iOS Bridge module — native host API bindings.
//!
//! Registers low-level `__iosBridge_*` globals on QuickJS that call into
//! WIT-generated import functions (`ios::bridge::{storage, device, render}`).
//! The user-facing `ios.*` namespace is provided by an embedded JS shim.

use rquickjs::{Ctx, Function, Result, Value};

const IOS_BRIDGE_JS: &str = include_str!("shims/ios_bridge.js");

/// Install the iOS bridge API on the global object.
pub fn install(ctx: &Ctx<'_>) -> Result<()> {
    let globals = ctx.globals();

    // ── storage ──────────────────────────────────────────────────────

    // __iosBridge_storage_get(key: string) -> string | null
    globals.set(
        "__iosBridge_storage_get",
        Function::new(
            ctx.clone(),
            |args: rquickjs::prelude::Rest<Value>| -> Option<String> {
                let key = args
                    .0
                    .first()
                    .and_then(|v| v.as_string())
                    .and_then(|s| s.to_string().ok())?;
                crate::bindings::ios::bridge::storage::get(&key)
            },
        )?,
    )?;

    // __iosBridge_storage_set(key: string, value: string) -> void
    globals.set(
        "__iosBridge_storage_set",
        Function::new(ctx.clone(), |args: rquickjs::prelude::Rest<Value>| {
            let key = args
                .0
                .first()
                .and_then(|v| v.as_string())
                .and_then(|s| s.to_string().ok());
            let value = args
                .0
                .get(1)
                .and_then(|v| v.as_string())
                .and_then(|s| s.to_string().ok());
            if let (Some(k), Some(v)) = (key, value) {
                crate::bindings::ios::bridge::storage::set(&k, &v);
            }
        })?,
    )?;

    // __iosBridge_storage_remove(key: string) -> bool
    globals.set(
        "__iosBridge_storage_remove",
        Function::new(
            ctx.clone(),
            |args: rquickjs::prelude::Rest<Value>| -> bool {
                let key = args
                    .0
                    .first()
                    .and_then(|v| v.as_string())
                    .and_then(|s| s.to_string().ok());
                match key {
                    Some(k) => crate::bindings::ios::bridge::storage::remove(&k),
                    None => false,
                }
            },
        )?,
    )?;

    // __iosBridge_storage_keys(prefix: string | null) -> string (JSON array)
    globals.set(
        "__iosBridge_storage_keys",
        Function::new(
            ctx.clone(),
            |args: rquickjs::prelude::Rest<Value>| -> String {
                let prefix = args.0.first().and_then(|v| {
                    if v.is_null() || v.is_undefined() {
                        None
                    } else {
                        v.as_string().and_then(|s| s.to_string().ok())
                    }
                });
                let keys = crate::bindings::ios::bridge::storage::keys(prefix.as_deref());
                serde_json::to_string(&keys).unwrap_or_else(|_| "[]".to_string())
            },
        )?,
    )?;

    // ── device ───────────────────────────────────────────────────────

    // __iosBridge_device_info() -> string (JSON)
    globals.set(
        "__iosBridge_device_info",
        Function::new(
            ctx.clone(),
            |_args: rquickjs::prelude::Rest<Value>| -> String {
                crate::bindings::ios::bridge::device::info()
            },
        )?,
    )?;

    // __iosBridge_device_connectivity() -> string (JSON)
    globals.set(
        "__iosBridge_device_connectivity",
        Function::new(
            ctx.clone(),
            |_args: rquickjs::prelude::Rest<Value>| -> String {
                crate::bindings::ios::bridge::device::connectivity()
            },
        )?,
    )?;

    // __iosBridge_device_locale() -> string (JSON)
    globals.set(
        "__iosBridge_device_locale",
        Function::new(
            ctx.clone(),
            |_args: rquickjs::prelude::Rest<Value>| -> String {
                crate::bindings::ios::bridge::device::locale()
            },
        )?,
    )?;

    // ── render ────────────────────────────────────────────────────────

    // __iosBridge_render_show(layoutJson: string) -> string
    globals.set(
        "__iosBridge_render_show",
        Function::new(
            ctx.clone(),
            |args: rquickjs::prelude::Rest<Value>| -> String {
                let json = args
                    .0
                    .first()
                    .and_then(|v| v.as_string())
                    .and_then(|s| s.to_string().ok())
                    .unwrap_or_else(|| "{}".to_string());
                crate::bindings::ios::bridge::render::show(&json)
            },
        )?,
    )?;

    // __iosBridge_render_patch(patchesJson: string) -> string
    globals.set(
        "__iosBridge_render_patch",
        Function::new(
            ctx.clone(),
            |args: rquickjs::prelude::Rest<Value>| -> String {
                let json = args
                    .0
                    .first()
                    .and_then(|v| v.as_string())
                    .and_then(|s| s.to_string().ok())
                    .unwrap_or_else(|| "[]".to_string());
                crate::bindings::ios::bridge::render::patch(&json)
            },
        )?,
    )?;
    // ── permissions ───────────────────────────────────────────────────

    globals.set(
        "__iosBridge_permissions_request",
        Function::new(
            ctx.clone(),
            |args: rquickjs::prelude::Rest<Value>| -> bool {
                let capability = args
                    .0
                    .first()
                    .and_then(|v| v.as_string())
                    .and_then(|s| s.to_string().ok())
                    .unwrap_or_default();
                crate::bindings::ios::bridge::permissions::request(&capability)
            },
        )?,
    )?;

    globals.set(
        "__iosBridge_permissions_revoke",
        Function::new(
            ctx.clone(),
            |args: rquickjs::prelude::Rest<Value>| -> bool {
                let capability = args
                    .0
                    .first()
                    .and_then(|v| v.as_string())
                    .and_then(|s| s.to_string().ok())
                    .unwrap_or_default();
                crate::bindings::ios::bridge::permissions::revoke(&capability)
            },
        )?,
    )?;

    globals.set(
        "__iosBridge_permissions_check",
        Function::new(
            ctx.clone(),
            |args: rquickjs::prelude::Rest<Value>| -> bool {
                let capability = args
                    .0
                    .first()
                    .and_then(|v| v.as_string())
                    .and_then(|s| s.to_string().ok())
                    .unwrap_or_default();
                crate::bindings::ios::bridge::permissions::check(&capability)
            },
        )?,
    )?;

    // ── contacts ─────────────────────────────────────────────────────

    globals.set(
        "__iosBridge_contacts_search",
        Function::new(
            ctx.clone(),
            |args: rquickjs::prelude::Rest<Value>| -> String {
                let query = args
                    .0
                    .first()
                    .and_then(|v| v.as_string())
                    .and_then(|s| s.to_string().ok())
                    .unwrap_or_default();
                let limit = args.0.get(1).and_then(|v| v.as_number()).map(|n| n as u32);
                crate::bindings::ios::bridge::contacts::search(&query, limit)
            },
        )?,
    )?;

    globals.set(
        "__iosBridge_contacts_get",
        Function::new(
            ctx.clone(),
            |args: rquickjs::prelude::Rest<Value>| -> Option<String> {
                let id = args
                    .0
                    .first()
                    .and_then(|v| v.as_string())
                    .and_then(|s| s.to_string().ok())?;
                crate::bindings::ios::bridge::contacts::get(&id)
            },
        )?,
    )?;

    globals.set(
        "__iosBridge_contacts_authorizationStatus",
        Function::new(
            ctx.clone(),
            |_args: rquickjs::prelude::Rest<Value>| -> String {
                crate::bindings::ios::bridge::contacts::authorization_status()
            },
        )?,
    )?;

    // ── calendar ─────────────────────────────────────────────────────

    globals.set(
        "__iosBridge_calendar_calendars",
        Function::new(
            ctx.clone(),
            |_args: rquickjs::prelude::Rest<Value>| -> String {
                crate::bindings::ios::bridge::calendar::calendars()
            },
        )?,
    )?;

    globals.set(
        "__iosBridge_calendar_events",
        Function::new(
            ctx.clone(),
            |args: rquickjs::prelude::Rest<Value>| -> String {
                let start = args
                    .0
                    .first()
                    .and_then(|v| v.as_string())
                    .and_then(|s| s.to_string().ok())
                    .unwrap_or_default();
                let end = args
                    .0
                    .get(1)
                    .and_then(|v| v.as_string())
                    .and_then(|s| s.to_string().ok())
                    .unwrap_or_default();
                let cal_id = args.0.get(2).and_then(|v| {
                    if v.is_null() || v.is_undefined() {
                        None
                    } else {
                        v.as_string().and_then(|s| s.to_string().ok())
                    }
                });
                crate::bindings::ios::bridge::calendar::events(&start, &end, cal_id.as_deref())
            },
        )?,
    )?;

    globals.set(
        "__iosBridge_calendar_createEvent",
        Function::new(
            ctx.clone(),
            |args: rquickjs::prelude::Rest<Value>| -> String {
                let json = args
                    .0
                    .first()
                    .and_then(|v| v.as_string())
                    .and_then(|s| s.to_string().ok())
                    .unwrap_or_else(|| "{}".to_string());
                crate::bindings::ios::bridge::calendar::create_event(&json)
            },
        )?,
    )?;

    globals.set(
        "__iosBridge_calendar_reminders",
        Function::new(
            ctx.clone(),
            |args: rquickjs::prelude::Rest<Value>| -> String {
                let cal_id = args.0.first().and_then(|v| {
                    if v.is_null() || v.is_undefined() {
                        None
                    } else {
                        v.as_string().and_then(|s| s.to_string().ok())
                    }
                });
                crate::bindings::ios::bridge::calendar::reminders(cal_id.as_deref())
            },
        )?,
    )?;

    globals.set(
        "__iosBridge_calendar_authorizationStatus",
        Function::new(
            ctx.clone(),
            |_args: rquickjs::prelude::Rest<Value>| -> String {
                crate::bindings::ios::bridge::calendar::authorization_status()
            },
        )?,
    )?;

    // ── notifications ────────────────────────────────────────────────

    globals.set(
        "__iosBridge_notifications_schedule",
        Function::new(
            ctx.clone(),
            |args: rquickjs::prelude::Rest<Value>| -> String {
                let title = args
                    .0
                    .first()
                    .and_then(|v| v.as_string())
                    .and_then(|s| s.to_string().ok())
                    .unwrap_or_default();
                let body = args
                    .0
                    .get(1)
                    .and_then(|v| v.as_string())
                    .and_then(|s| s.to_string().ok())
                    .unwrap_or_default();
                let trigger = args.0.get(2).and_then(|v| {
                    if v.is_null() || v.is_undefined() {
                        None
                    } else {
                        v.as_string().and_then(|s| s.to_string().ok())
                    }
                });
                crate::bindings::ios::bridge::notifications::schedule(
                    &title,
                    &body,
                    trigger.as_deref(),
                )
            },
        )?,
    )?;

    globals.set(
        "__iosBridge_notifications_cancel",
        Function::new(ctx.clone(), |args: rquickjs::prelude::Rest<Value>| {
            if let Some(id) = args
                .0
                .first()
                .and_then(|v| v.as_string())
                .and_then(|s| s.to_string().ok())
            {
                crate::bindings::ios::bridge::notifications::cancel(&id);
            }
        })?,
    )?;

    globals.set(
        "__iosBridge_notifications_pending",
        Function::new(
            ctx.clone(),
            |_args: rquickjs::prelude::Rest<Value>| -> String {
                crate::bindings::ios::bridge::notifications::pending()
            },
        )?,
    )?;

    // ── clipboard ────────────────────────────────────────────────────

    globals.set(
        "__iosBridge_clipboard_getString",
        Function::new(
            ctx.clone(),
            |_args: rquickjs::prelude::Rest<Value>| -> Option<String> {
                crate::bindings::ios::bridge::clipboard::get_string()
            },
        )?,
    )?;

    globals.set(
        "__iosBridge_clipboard_setString",
        Function::new(ctx.clone(), |args: rquickjs::prelude::Rest<Value>| {
            if let Some(val) = args
                .0
                .first()
                .and_then(|v| v.as_string())
                .and_then(|s| s.to_string().ok())
            {
                crate::bindings::ios::bridge::clipboard::set_string(&val);
            }
        })?,
    )?;

    // ── location ─────────────────────────────────────────────────────

    globals.set(
        "__iosBridge_location_current",
        Function::new(
            ctx.clone(),
            |_args: rquickjs::prelude::Rest<Value>| -> String {
                crate::bindings::ios::bridge::location::current()
            },
        )?,
    )?;

    globals.set(
        "__iosBridge_location_geocode",
        Function::new(
            ctx.clone(),
            |args: rquickjs::prelude::Rest<Value>| -> String {
                let address = args
                    .0
                    .first()
                    .and_then(|v| v.as_string())
                    .and_then(|s| s.to_string().ok())
                    .unwrap_or_default();
                crate::bindings::ios::bridge::location::geocode(&address)
            },
        )?,
    )?;

    globals.set(
        "__iosBridge_location_reverseGeocode",
        Function::new(
            ctx.clone(),
            |args: rquickjs::prelude::Rest<Value>| -> String {
                let lat = args.0.first().and_then(|v| v.as_number()).unwrap_or(0.0);
                let lng = args.0.get(1).and_then(|v| v.as_number()).unwrap_or(0.0);
                crate::bindings::ios::bridge::location::reverse_geocode(lat, lng)
            },
        )?,
    )?;

    // ── health ───────────────────────────────────────────────────────

    globals.set(
        "__iosBridge_health_query",
        Function::new(
            ctx.clone(),
            |args: rquickjs::prelude::Rest<Value>| -> String {
                let type_id = args
                    .0
                    .first()
                    .and_then(|v| v.as_string())
                    .and_then(|s| s.to_string().ok())
                    .unwrap_or_default();
                let start = args
                    .0
                    .get(1)
                    .and_then(|v| v.as_string())
                    .and_then(|s| s.to_string().ok())
                    .unwrap_or_default();
                let end = args
                    .0
                    .get(2)
                    .and_then(|v| v.as_string())
                    .and_then(|s| s.to_string().ok())
                    .unwrap_or_default();
                let limit = args.0.get(3).and_then(|v| v.as_number()).map(|n| n as u32);
                crate::bindings::ios::bridge::health::query(&type_id, &start, &end, limit)
            },
        )?,
    )?;

    globals.set(
        "__iosBridge_health_statistics",
        Function::new(
            ctx.clone(),
            |args: rquickjs::prelude::Rest<Value>| -> String {
                let type_id = args
                    .0
                    .first()
                    .and_then(|v| v.as_string())
                    .and_then(|s| s.to_string().ok())
                    .unwrap_or_default();
                let start = args
                    .0
                    .get(1)
                    .and_then(|v| v.as_string())
                    .and_then(|s| s.to_string().ok())
                    .unwrap_or_default();
                let end = args
                    .0
                    .get(2)
                    .and_then(|v| v.as_string())
                    .and_then(|s| s.to_string().ok())
                    .unwrap_or_default();
                crate::bindings::ios::bridge::health::statistics(&type_id, &start, &end)
            },
        )?,
    )?;

    globals.set(
        "__iosBridge_health_authorizationStatus",
        Function::new(
            ctx.clone(),
            |args: rquickjs::prelude::Rest<Value>| -> String {
                let type_id = args
                    .0
                    .first()
                    .and_then(|v| v.as_string())
                    .and_then(|s| s.to_string().ok())
                    .unwrap_or_default();
                crate::bindings::ios::bridge::health::authorization_status(&type_id)
            },
        )?,
    )?;

    // ── keychain ─────────────────────────────────────────────────────

    globals.set(
        "__iosBridge_keychain_get",
        Function::new(
            ctx.clone(),
            |args: rquickjs::prelude::Rest<Value>| -> Option<String> {
                let service = args
                    .0
                    .first()
                    .and_then(|v| v.as_string())
                    .and_then(|s| s.to_string().ok())?;
                let account = args
                    .0
                    .get(1)
                    .and_then(|v| v.as_string())
                    .and_then(|s| s.to_string().ok())?;
                crate::bindings::ios::bridge::keychain::get(&service, &account)
            },
        )?,
    )?;

    globals.set(
        "__iosBridge_keychain_set",
        Function::new(
            ctx.clone(),
            |args: rquickjs::prelude::Rest<Value>| -> bool {
                let service = args
                    .0
                    .first()
                    .and_then(|v| v.as_string())
                    .and_then(|s| s.to_string().ok());
                let account = args
                    .0
                    .get(1)
                    .and_then(|v| v.as_string())
                    .and_then(|s| s.to_string().ok());
                let value = args
                    .0
                    .get(2)
                    .and_then(|v| v.as_string())
                    .and_then(|s| s.to_string().ok());
                match (service, account, value) {
                    (Some(s), Some(a), Some(v)) => {
                        crate::bindings::ios::bridge::keychain::set(&s, &a, &v)
                    }
                    _ => false,
                }
            },
        )?,
    )?;

    globals.set(
        "__iosBridge_keychain_remove",
        Function::new(
            ctx.clone(),
            |args: rquickjs::prelude::Rest<Value>| -> bool {
                let service = args
                    .0
                    .first()
                    .and_then(|v| v.as_string())
                    .and_then(|s| s.to_string().ok());
                let account = args
                    .0
                    .get(1)
                    .and_then(|v| v.as_string())
                    .and_then(|s| s.to_string().ok());
                match (service, account) {
                    (Some(s), Some(a)) => crate::bindings::ios::bridge::keychain::remove(&s, &a),
                    _ => false,
                }
            },
        )?,
    )?;

    // ── photos ───────────────────────────────────────────────────────

    globals.set(
        "__iosBridge_photos_search",
        Function::new(
            ctx.clone(),
            |args: rquickjs::prelude::Rest<Value>| -> String {
                let opts = args
                    .0
                    .first()
                    .and_then(|v| v.as_string())
                    .and_then(|s| s.to_string().ok())
                    .unwrap_or_else(|| "{}".to_string());
                crate::bindings::ios::bridge::photos::search(&opts)
            },
        )?,
    )?;

    globals.set(
        "__iosBridge_photos_asset",
        Function::new(
            ctx.clone(),
            |args: rquickjs::prelude::Rest<Value>| -> Option<String> {
                let id = args
                    .0
                    .first()
                    .and_then(|v| v.as_string())
                    .and_then(|s| s.to_string().ok())?;
                crate::bindings::ios::bridge::photos::asset(&id)
            },
        )?,
    )?;

    globals.set(
        "__iosBridge_photos_albums",
        Function::new(
            ctx.clone(),
            |_args: rquickjs::prelude::Rest<Value>| -> String {
                crate::bindings::ios::bridge::photos::albums()
            },
        )?,
    )?;

    // ── JS shim ──────────────────────────────────────────────────────
    ctx.eval::<(), _>(IOS_BRIDGE_JS)?;

    Ok(())
}
