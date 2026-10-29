// Shared test helpers: iCalendar fixtures and an in-memory CalDAV server.

import { expandEvents } from '../src/ical.js';

export const PARIS_VTIMEZONE = `BEGIN:VTIMEZONE
TZID:Europe/Paris
BEGIN:STANDARD
DTSTART:19701025T030000
RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU
TZOFFSETFROM:+0200
TZOFFSETTO:+0100
END:STANDARD
BEGIN:DAYLIGHT
DTSTART:19700329T020000
RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU
TZOFFSETFROM:+0100
TZOFFSETTO:+0200
END:DAYLIGHT
END:VTIMEZONE`;

/** Wrap components in a VCALENDAR, with CRLF line endings like a server. */
export function ics(...components) {
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//test//EN', ...components, 'END:VCALENDAR']
    .join('\n')
    .replace(/\n/g, '\r\n');
}

/** One timed VEVENT. */
export function vevent(uid, start, end, summary = uid) {
  return `BEGIN:VEVENT\nUID:${uid}\nDTSTART:${start}\nDTEND:${end}\nSUMMARY:${summary}\nEND:VEVENT`;
}

/**
 * In-memory CalDAV server: `servers[serverUrl] = { calendars: [{ url, name,
 * color, ctag, objects: [icsText] }] }`. Returns a `createClient` for
 * registerHandlers / SyncManager, and the log of the calls it served.
 */
export function createFakeCalDav(servers) {
  const calls = [];
  async function createClient(account) {
    calls.push({ type: 'login', account });
    const server = servers[account.server_url];
    if (!server || server.password !== account.password) {
      throw new Error('Unauthorized (401)');
    }
    return {
      async listCalendars() {
        calls.push({ type: 'listCalendars', server: account.server_url });
        return server.calendars.map((calendar) => ({
          url: calendar.url,
          name: calendar.name ?? '',
          description: calendar.description ?? '',
          color: calendar.color ?? '',
          ctag: calendar.ctag ?? '',
          raw: calendar,
        }));
      },
      async fetchObjects(calendar, window) {
        calls.push({ type: 'fetchObjects', url: calendar.url, window });
        if (calendar.raw.fail) {
          throw new Error('Server error (500)');
        }
        // Like a real time-range query: only the objects with an event in
        // the window.
        return calendar.raw.objects.filter((text) => expandEvents([text], window).length > 0);
      },
    };
  }
  return { createClient, calls };
}

/** A user who enabled the integration, with their account values. */
export function account(selector, serverUrl, password = 'secret', language = 'fr') {
  return {
    user: { selector, first_name: selector, language },
    config: { server_url: serverUrl, username: selector, password },
  };
}
