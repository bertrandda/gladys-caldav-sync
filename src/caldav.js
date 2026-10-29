// -----------------------------------------------------------------------------
// CalDAV client: the only module that talks to the user's CalDAV server.
//
// Built on tsdav, which handles the service discovery (/.well-known/caldav,
// current-user-principal, calendar-home-set) and the WebDAV requests. The rest
// of the integration only sees this small surface, so the tests replace it with
// an in-memory fake (see `createClient` in src/app.js):
//
//   const client = await createCalDavClient(account);
//   const calendars = await client.listCalendars();
//   const icsTexts = await client.fetchObjects(calendars[0], { from, to });
// -----------------------------------------------------------------------------

import { DAVClient } from 'tsdav';

// Per-request timeout: a server that never answers must not freeze the sync
// queue of every other user.
const REQUEST_TIMEOUT_MS = 30_000;

function fetchWithTimeout(input, init = {}) {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
  return fetch(input, { ...init, signal });
}

// tsdav returns the display name as a string, or as an object when the server
// adds attributes to the XML element.
function textOf(value) {
  if (typeof value === 'string') {
    return value;
  }
  if (value && typeof value === 'object' && typeof value._text === 'string') {
    return value._text;
  }
  return '';
}

/**
 * Connect to a CalDAV server with Basic authentication.
 * @param {{ server_url: string, username: string, password: string }} account
 *   normalized account (see normalizeAccount in src/config.js)
 * @returns {Promise<{ listCalendars: Function, fetchObjects: Function }>}
 */
export async function createCalDavClient(account) {
  const client = new DAVClient({
    serverUrl: account.server_url,
    credentials: { username: account.username, password: account.password },
    authMethod: 'Basic',
    defaultAccountType: 'caldav',
    fetch: fetchWithTimeout,
  });
  // Service discovery: resolves the principal and the calendar home.
  await client.login();

  return {
    /**
     * Calendars of the account, event-capable ones only (a task list is no
     * calendar for Gladys).
     * @returns {Promise<Array<{ url, name, description, color, ctag, raw }>>}
     */
    async listCalendars() {
      const calendars = await client.fetchCalendars();
      return calendars
        .filter((calendar) => {
          const components = calendar.components ?? [];
          return components.length === 0 || components.includes('VEVENT');
        })
        .map((calendar) => ({
          url: calendar.url,
          name: textOf(calendar.displayName),
          description: textOf(calendar.description),
          color: typeof calendar.calendarColor === 'string' ? calendar.calendarColor : '',
          // Changes whenever an object of the calendar changes (RFC 6578
          // sync-token, or the older CalendarServer getctag).
          ctag: calendar.syncToken || calendar.ctag || '',
          raw: calendar,
        }));
    },

    /**
     * Raw iCalendar texts of the objects having an event in the window. The
     * recurrences are expanded by src/ical.js, not by the server: `<expand>`
     * support varies too much between servers.
     * @param {{ raw: object }} calendar one of listCalendars()
     * @param {{ from: Date, to: Date }} window
     * @returns {Promise<string[]>}
     */
    async fetchObjects(calendar, window) {
      const objects = await client.fetchCalendarObjects({
        calendar: calendar.raw,
        timeRange: { start: window.from.toISOString(), end: window.to.toISOString() },
        // tsdav keeps only `.ics` URLs by default; some servers (Google,
        // iCloud) name their objects otherwise.
        urlFilter: () => true,
      });
      return objects.map((object) => object.data).filter((data) => typeof data === 'string');
    },
  };
}
