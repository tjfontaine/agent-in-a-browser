/**
 * ios-bridge.d.ts — TypeScript definitions for the ios.* SDK.
 * 
 * These APIs are available in scripts running on the Edge Agent iOS runtime.
 * They call directly into native iOS APIs via the WASM bridge (no HTTP/MCP overhead).
 */

declare namespace ios {
    namespace storage {
        /** Get a value by key. Returns undefined if not set. */
        function get(key: string): string | undefined;
        /** Set a key-value pair. */
        function set(key: string, value: string): void;
        /** Remove a key. Returns true if the key existed. */
        function remove(key: string): boolean;
        /** List keys matching an optional prefix filter. */
        function keys(prefix?: string): string[];
    }

    namespace device {
        interface DeviceInfo {
            model: string;
            systemName: string;
            systemVersion: string;
            batteryLevel: number;
            thermalState: 'nominal' | 'fair' | 'serious' | 'critical' | 'unknown';
            isLowPowerMode: boolean;
        }

        interface ConnectivityInfo {
            status: 'wifi' | 'cellular' | 'other' | 'none';
            isExpensive: boolean;
            isConstrained: boolean;
        }

        interface LocaleInfo {
            identifier: string;
            timezone: string;
            languages: string[];
        }

        /** Get device hardware and system info. */
        function info(): DeviceInfo;
        /** Get current network connectivity status. */
        function connectivity(): ConnectivityInfo;
        /** Get locale and language preferences. */
        function locale(): LocaleInfo;
    }

    namespace render {
        /**
         * Push a component tree to the native renderer.
         * Accepts a JSON string or an object (auto-serialized).
         * Returns the view ID assigned by the host.
         */
        function show(layout: string | Record<string, any>): string;
    }
    
    namespace permissions {
        type Capability =
            | 'storage' | 'device' | 'render' | 'clipboard'
            | 'contacts' | 'calendar' | 'notifications'
            | 'location' | 'health' | 'keychain' | 'photos';
        
        /** Grant a capability for the current script context. */
        function request(capability: Capability): boolean;
        /** Revoke a previously granted capability. */
        function revoke(capability: Capability): boolean;
        /** Check whether a capability is currently granted. */
        function check(capability: Capability): boolean;
    }

    // ── Tier 2 ────────────────────────────────────────────────────

    namespace contacts {
        interface Contact {
            id: string;
            givenName: string;
            familyName: string;
            emails: string[];
            phones: string[];
        }

        /** Search contacts by name. Returns parsed array. */
        function search(query: string, limit?: number): Contact[];
        /** Get a single contact by identifier. */
        function get(id: string): Contact | undefined;
        /** Check Contacts framework authorization status. */
        function authorizationStatus(): 'authorized' | 'denied' | 'restricted' | 'notDetermined' | 'unavailable';
    }

    namespace calendar {
        interface CalendarInfo {
            id: string;
            title: string;
        }

        interface CalendarEvent {
            id: string;
            title: string;
            start: string;
            end: string;
        }

        interface EventSpec {
            title: string;
            start: string;
            end: string;
            calendarId?: string;
        }

        /** List available calendars. */
        function calendars(): CalendarInfo[];
        /** Get events in a date range (ISO 8601). */
        function events(startISO: string, endISO: string, calendarId?: string): CalendarEvent[];
        /** Create a new calendar event. Returns the event ID or error JSON. */
        function createEvent(spec: EventSpec | string): string;
        /** Get reminders, optionally filtered by calendar. */
        function reminders(calendarId?: string): any[];
        /** Check EventKit authorization status. */
        function authorizationStatus(): 'authorized' | 'writeOnly' | 'denied' | 'restricted' | 'notDetermined' | 'unavailable';
    }

    namespace notifications {
        interface TriggerSpec {
            type: 'interval' | 'calendar';
            seconds?: number;
            dateComponents?: Record<string, number>;
        }

        /** Schedule a local notification. Returns the notification identifier. */
        function schedule(title: string, body: string, trigger?: TriggerSpec | string): string;
        /** Cancel a pending notification by ID. */
        function cancel(id: string): void;
        /** List pending notification identifiers. */
        function pending(): any[];
    }

    namespace clipboard {
        /** Get the current clipboard string, or undefined if empty. */
        function get(): string | undefined;
        /** Set the clipboard to a string value. */
        function set(value: string): void;
    }

    // ── Tier 3 ────────────────────────────────────────────────────

    namespace location {
        interface Location {
            lat: number;
            lng: number;
            altitude: number;
            accuracy: number;
        }

        interface GeocodedPlace {
            lat: number;
            lng: number;
            name?: string;
        }

        /** Get current device location (last known). */
        function current(): Location | { error: string };
        /** Forward geocode an address to coordinates. */
        function geocode(address: string): GeocodedPlace[];
        /** Reverse geocode coordinates to an address. */
        function reverseGeocode(lat: number, lng: number): Record<string, any>;
    }

    namespace health {
        /** Query HealthKit samples. */
        function query(typeId: string, startISO: string, endISO: string, limit?: number): any[];
        /** Get HealthKit statistics for a type and date range. */
        function statistics(typeId: string, startISO: string, endISO: string): Record<string, any>;
        /** Check HealthKit authorization for a sample type. */
        function authorizationStatus(typeId: string): string;
    }

    namespace keychain {
        /** Get a Keychain value. Returns undefined if not found. */
        function get(service: string, account: string): string | undefined;
        /** Set a Keychain value. Returns true on success. */
        function set(service: string, account: string, value: string): boolean;
        /** Remove a Keychain entry. Returns true if it existed. */
        function remove(service: string, account: string): boolean;
    }

    namespace photos {
        interface PhotoAsset {
            id: string;
            mediaType: string;
            creationDate?: string;
            width: number;
            height: number;
        }

        interface Album {
            id: string;
            title: string;
            count: number;
        }

        /** Search photos with options (JSON or object). */
        function search(options?: Record<string, any> | string): PhotoAsset[];
        /** Get a single photo asset by ID. */
        function asset(id: string): PhotoAsset | undefined;
        /** List photo albums. */
        function albums(): Album[];
    }
}
