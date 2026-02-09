// ios-bridge.js — JavaScript shim for the ios.* SDK
// Low-level __iosBridge_* functions are provided by Rust.
// This shim exposes them as the user-facing `ios` global namespace.

(function () {
    'use strict';

    const ios = {
        storage: {
            get: function (key) {
                const raw = __iosBridge_storage_get(String(key));
                return raw === null || raw === undefined ? undefined : raw;
            },
            set: function (key, value) {
                __iosBridge_storage_set(String(key), String(value));
            },
            remove: function (key) {
                return __iosBridge_storage_remove(String(key));
            },
            keys: function (prefix) {
                const raw = __iosBridge_storage_keys(prefix !== undefined && prefix !== null ? String(prefix) : null);
                try { return JSON.parse(raw); } catch { return []; }
            }
        },

        device: {
            info: function () {
                try { return JSON.parse(__iosBridge_device_info()); } catch { return {}; }
            },
            connectivity: function () {
                try { return JSON.parse(__iosBridge_device_connectivity()); } catch { return {}; }
            },
            locale: function () {
                try { return JSON.parse(__iosBridge_device_locale()); } catch { return {}; }
            }
        },

        render: {
            show: function (layout) {
                const json = typeof layout === 'string' ? layout : JSON.stringify(layout);
                return __iosBridge_render_show(json);
            },
            patch: function (patches) {
                const json = typeof patches === 'string' ? patches : JSON.stringify(patches);
                return __iosBridge_render_patch(json);
            }
        },

        permissions: {
            request: function (capability) {
                return __iosBridge_permissions_request(String(capability));
            },
            revoke: function (capability) {
                return __iosBridge_permissions_revoke(String(capability));
            },
            check: function (capability) {
                return __iosBridge_permissions_check(String(capability));
            }
        },

        // ── Tier 2 ───────────────────────────────────────────────────

        contacts: {
            search: function (query, limit) {
                try { return JSON.parse(__iosBridge_contacts_search(String(query || ''), limit)); } catch { return []; }
            },
            get: function (id) {
                const raw = __iosBridge_contacts_get(String(id));
                if (raw === null || raw === undefined) return undefined;
                try { return JSON.parse(raw); } catch { return raw; }
            },
            authorizationStatus: function () {
                return __iosBridge_contacts_authorizationStatus();
            }
        },

        calendar: {
            calendars: function () {
                try { return JSON.parse(__iosBridge_calendar_calendars()); } catch { return []; }
            },
            events: function (startISO, endISO, calendarId) {
                try { return JSON.parse(__iosBridge_calendar_events(String(startISO), String(endISO), calendarId || null)); } catch { return []; }
            },
            createEvent: function (eventSpec) {
                const json = typeof eventSpec === 'string' ? eventSpec : JSON.stringify(eventSpec);
                return __iosBridge_calendar_createEvent(json);
            },
            reminders: function (calendarId) {
                try { return JSON.parse(__iosBridge_calendar_reminders(calendarId || null)); } catch { return []; }
            },
            authorizationStatus: function () {
                return __iosBridge_calendar_authorizationStatus();
            }
        },

        notifications: {
            schedule: function (title, body, trigger) {
                const triggerJson = trigger ? (typeof trigger === 'string' ? trigger : JSON.stringify(trigger)) : null;
                return __iosBridge_notifications_schedule(String(title), String(body), triggerJson);
            },
            cancel: function (id) {
                __iosBridge_notifications_cancel(String(id));
            },
            pending: function () {
                try { return JSON.parse(__iosBridge_notifications_pending()); } catch { return []; }
            }
        },

        clipboard: {
            get: function () {
                const raw = __iosBridge_clipboard_getString();
                return raw === null ? undefined : raw;
            },
            set: function (value) {
                __iosBridge_clipboard_setString(String(value));
            }
        },

        // ── Tier 3 ───────────────────────────────────────────────────

        location: {
            current: function () {
                try { return JSON.parse(__iosBridge_location_current()); } catch { return {}; }
            },
            geocode: function (address) {
                try { return JSON.parse(__iosBridge_location_geocode(String(address))); } catch { return []; }
            },
            reverseGeocode: function (lat, lng) {
                try { return JSON.parse(__iosBridge_location_reverseGeocode(Number(lat), Number(lng))); } catch { return {}; }
            }
        },

        health: {
            query: function (typeId, startISO, endISO, limit) {
                try { return JSON.parse(__iosBridge_health_query(String(typeId), String(startISO), String(endISO), limit)); } catch { return []; }
            },
            statistics: function (typeId, startISO, endISO) {
                try { return JSON.parse(__iosBridge_health_statistics(String(typeId), String(startISO), String(endISO))); } catch { return {}; }
            },
            authorizationStatus: function (typeId) {
                return __iosBridge_health_authorizationStatus(String(typeId));
            }
        },

        keychain: {
            get: function (service, account) {
                const raw = __iosBridge_keychain_get(String(service), String(account));
                return raw === null ? undefined : raw;
            },
            set: function (service, account, value) {
                return __iosBridge_keychain_set(String(service), String(account), String(value));
            },
            remove: function (service, account) {
                return __iosBridge_keychain_remove(String(service), String(account));
            }
        },

        photos: {
            search: function (options) {
                const json = typeof options === 'string' ? options : JSON.stringify(options || {});
                try { return JSON.parse(__iosBridge_photos_search(json)); } catch { return []; }
            },
            asset: function (id) {
                const raw = __iosBridge_photos_asset(String(id));
                if (raw === null || raw === undefined) return undefined;
                try { return JSON.parse(raw); } catch { return raw; }
            },
            albums: function () {
                try { return JSON.parse(__iosBridge_photos_albums()); } catch { return []; }
            }
        }
    };

    globalThis.ios = ios;
})();
