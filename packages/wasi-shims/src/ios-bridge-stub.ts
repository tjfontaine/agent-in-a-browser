/**
 * Stub implementations for ios:bridge/* WIT interfaces.
 *
 * These are iOS-only native host APIs provided by IosBridgeProvider in the
 * WasmKit runtime. In the browser build they are unreachable — the tsx-engine
 * WASM component imports them but the browser never invokes the code paths
 * that call through. Every export throws so any accidental call surfaces
 * immediately rather than silently returning garbage.
 */

function notAvailable(name: string): never {
  throw new Error(`ios:bridge/${name} is not available in the browser`);
}

// ios:bridge/calendar
export const authorizationStatus = () => notAvailable('calendar');
export const calendars = () => notAvailable('calendar');
export const createEvent = () => notAvailable('calendar');
export const events = () => notAvailable('calendar');
export const reminders = () => notAvailable('calendar');

// ios:bridge/clipboard
export const getString = () => notAvailable('clipboard');
export const setString = () => notAvailable('clipboard');

// ios:bridge/contacts
export const get = () => notAvailable('contacts');
export const search = () => notAvailable('contacts');

// ios:bridge/device
export const connectivity = () => notAvailable('device');
export const info = () => notAvailable('device');
export const locale = () => notAvailable('device');

// ios:bridge/health
export const query = () => notAvailable('health');
export const statistics = () => notAvailable('health');

// ios:bridge/keychain
export const remove = () => notAvailable('keychain');
export const set = () => notAvailable('keychain');

// ios:bridge/location
export const current = () => notAvailable('location');
export const geocode = () => notAvailable('location');
export const reverseGeocode = () => notAvailable('location');

// ios:bridge/notifications
export const cancel = () => notAvailable('notifications');
export const pending = () => notAvailable('notifications');
export const schedule = () => notAvailable('notifications');

// ios:bridge/permissions
export const check = () => notAvailable('permissions');
export const request = () => notAvailable('permissions');
export const revoke = () => notAvailable('permissions');

// ios:bridge/photos
export const albums = () => notAvailable('photos');
export const asset = () => notAvailable('photos');

// ios:bridge/render
export const patch = () => notAvailable('render');
export const show = () => notAvailable('render');

// ios:bridge/storage
export const keys = () => notAvailable('storage');
