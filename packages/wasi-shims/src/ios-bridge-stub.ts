/**
 * Stub implementations for ios:bridge/* WIT interfaces.
 *
 * These are iOS-only native host APIs provided by IosBridgeProvider in the
 * WasmKit runtime. In the browser build they are unreachable — the tsx-engine
 * WASM component imports them but the browser never invokes the code paths
 * that call through. Every function throws so any accidental call surfaces
 * immediately rather than silently returning garbage.
 *
 * JCO's `--map 'ios:bridge/*': '…#*'` glob imports each WIT interface as a
 * named export (namespace object), so we export `calendar`, `clipboard`, etc.
 */

function notAvailable(name: string): never {
  throw new Error(`ios:bridge/${name} is not available in the browser`);
}

// ios:bridge/calendar
export const calendar = {
  authorizationStatus: (): never => notAvailable('calendar'),
  calendars: (): never => notAvailable('calendar'),
  createEvent: (_eventJson: string): never => notAvailable('calendar'),
  events: (_startIso: string, _endIso: string, _calendarId?: string): never => notAvailable('calendar'),
  reminders: (_calendarId?: string): never => notAvailable('calendar'),
};

// ios:bridge/clipboard
export const clipboard = {
  getString: (): never => notAvailable('clipboard'),
  setString: (_value: string): never => notAvailable('clipboard'),
};

// ios:bridge/contacts
export const contacts = {
  authorizationStatus: (): never => notAvailable('contacts'),
  get: (_identifier: string): never => notAvailable('contacts'),
  search: (_query: string, _limit?: number): never => notAvailable('contacts'),
};

// ios:bridge/device
export const device = {
  connectivity: (): never => notAvailable('device'),
  info: (): never => notAvailable('device'),
  locale: (): never => notAvailable('device'),
};

// ios:bridge/health
export const health = {
  authorizationStatus: (_typeId: string): never => notAvailable('health'),
  query: (_typeId: string, _startIso: string, _endIso: string, _limit?: number): never => notAvailable('health'),
  statistics: (_typeId: string, _startIso: string, _endIso: string): never => notAvailable('health'),
};

// ios:bridge/keychain
export const keychain = {
  get: (_service: string, _account: string): never => notAvailable('keychain'),
  remove: (_service: string, _account: string): never => notAvailable('keychain'),
  set: (_service: string, _account: string, _value: string): never => notAvailable('keychain'),
};

// ios:bridge/location
export const location = {
  current: (): never => notAvailable('location'),
  geocode: (_address: string): never => notAvailable('location'),
  reverseGeocode: (_lat: number, _lng: number): never => notAvailable('location'),
};

// ios:bridge/notifications
export const notifications = {
  cancel: (_identifier: string): never => notAvailable('notifications'),
  pending: (): never => notAvailable('notifications'),
  schedule: (_title: string, _body: string, _triggerJson?: string): never => notAvailable('notifications'),
};

// ios:bridge/permissions
export const permissions = {
  check: (_capability: string): never => notAvailable('permissions'),
  request: (_capability: string): never => notAvailable('permissions'),
  revoke: (_capability: string): never => notAvailable('permissions'),
};

// ios:bridge/photos
export const photos = {
  albums: (): never => notAvailable('photos'),
  asset: (_identifier: string): never => notAvailable('photos'),
  search: (_optionsJson: string): never => notAvailable('photos'),
};

// ios:bridge/render
export const render = {
  patch: (_patchesJson: string): never => notAvailable('render'),
  show: (_layoutJson: string): never => notAvailable('render'),
};

// ios:bridge/storage
export const storage = {
  get: (_key: string): never => notAvailable('storage'),
  keys: (_prefix?: string): never => notAvailable('storage'),
  remove: (_key: string): never => notAvailable('storage'),
  set: (_key: string, _value: string): never => notAvailable('storage'),
};
