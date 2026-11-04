// -----------------------------------------------------------------------------
// Integration configuration.
//
// Two levels of settings:
//   - the integration-wide `config_schema` (admin only): how often and how far
//     the calendars are synced. The SDK fetches it (`gladys.getConfig()`) and
//     notifies every change (`gladys.onConfigUpdated()`);
//   - the per-user `account_schema` ("My calendars" block): each user's own
//     CalDAV server and credentials, returned by `gladys.getCalendarAccounts()`.
//
// This module only provides defaults and normalizes the received objects, so
// the rest of the code never has to deal with `undefined` or with strings typed
// in a form.
// -----------------------------------------------------------------------------

// Bounds of the numeric settings: they MUST stay consistent with the `min` /
// `max` declared in the `config_schema` of the manifest.
export const CONFIG_BOUNDS = {
  sync_interval: { min: 5, max: 1440 },
  past_days: { min: 0, max: 365 },
  future_days: { min: 7, max: 730 },
};

// Defaults: they MUST stay consistent with the `default` values declared in the
// `config_schema` of the manifest.
export const DEFAULT_CONFIG = {
  // Minutes between two synchronizations of a user's calendars.
  sync_interval: 15,
  // Days of history kept in Gladys.
  past_days: 30,
  // Days ahead synced (recurrences are expanded over this horizon).
  future_days: 365,
};

// Keys of the manifest `account_schema` (sections aside).
export const ACCOUNT_KEYS = ['provider', 'server_url', 'username', 'password'];

// Hosted providers whose CalDAV URL is the same for every account: picking one
// in the "My calendars" block spares the user from finding the URL. `custom`
// (the default, and what accounts saved before this list read as) uses the
// typed `server_url`. MUST stay consistent with the `options` of the
// `provider` field of the manifest `account_schema`.
export const PROVIDER_URLS = {
  custom: null,
  icloud: 'https://caldav.icloud.com',
  // The endpoint accepting an app password (the documented v2 API requires
  // OAuth), the one the core CalDAV integration of Gladys used.
  google: 'https://www.google.com/calendar/dav',
  fastmail: 'https://caldav.fastmail.com',
  yahoo: 'https://caldav.calendar.yahoo.com',
  mailbox_org: 'https://dav.mailbox.org',
  posteo: 'https://posteo.de:8443',
};

export const DEFAULT_PROVIDER = 'custom';

function boundedNumber(value, key) {
  const { min, max } = CONFIG_BOUNDS[key];
  const number = Number(value);
  if (value === null || value === undefined || value === '' || !Number.isFinite(number)) {
    return DEFAULT_CONFIG[key];
  }
  return Math.min(max, Math.max(min, Math.round(number)));
}

/**
 * Merge the integration config with the defaults.
 * @param {Record<string, unknown>} raw config returned by the SDK
 */
export function normalizeConfig(raw = {}) {
  return {
    sync_interval: boundedNumber(raw.sync_interval, 'sync_interval'),
    past_days: boundedNumber(raw.past_days, 'past_days'),
    future_days: boundedNumber(raw.future_days, 'future_days'),
  };
}

/**
 * Normalize the account values a user typed in the "My calendars" block.
 * A hosted provider imposes its URL; otherwise the typed server URL is used,
 * a URL without scheme being assumed to be https.
 * @param {Record<string, unknown>} raw `config` of a CalendarAccount
 */
export function normalizeAccount(raw = {}) {
  const provider = Object.hasOwn(PROVIDER_URLS, raw.provider) ? raw.provider : DEFAULT_PROVIDER;
  let serverUrl = typeof raw.server_url === 'string' ? raw.server_url.trim() : '';
  if (PROVIDER_URLS[provider]) {
    serverUrl = PROVIDER_URLS[provider];
  } else if (serverUrl !== '' && !/^https?:\/\//i.test(serverUrl)) {
    serverUrl = `https://${serverUrl}`;
  }
  return {
    server_url: serverUrl,
    username: typeof raw.username === 'string' ? raw.username.trim() : '',
    // Never trimmed: a password may legitimately start or end with a space.
    password: typeof raw.password === 'string' ? raw.password : '',
  };
}

/**
 * Whether a normalized account has everything needed to connect.
 * @param {ReturnType<typeof normalizeAccount>} account
 */
export function isAccountComplete(account) {
  if (account.username === '' || account.password === '') {
    return false;
  }
  try {
    const url = new URL(account.server_url);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}
