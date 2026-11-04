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

import { createLogger } from '@gladysassistant/integration-sdk';
import { DAVClient, DAVNamespace, getDAVAttribute } from 'tsdav';

const logger = createLogger({ name: 'caldav' });

// Per-request timeout: a server that never answers must not freeze the sync
// queue of every other user.
const REQUEST_TIMEOUT_MS = 30_000;

// Hrefs per calendar-multiget request (fallback path only, see below).
const MULTIGET_BATCH = 100;

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
     * Raw iCalendar texts of the objects having an event in the window (see
     * queryEventObjects). The recurrences are expanded by src/ical.js, not by
     * the server: `<expand>` support varies too much between servers.
     * @param {{ url: string, name: string }} calendar one of listCalendars()
     * @param {{ from: Date, to: Date }} window
     * @returns {Promise<string[]>}
     */
    async fetchObjects(calendar, window) {
      const { texts, skipped } = await queryEventObjects(
        (params) => client.davRequest(params),
        calendar.url,
        window,
      );
      if (skipped.length > 0) {
        const statuses = [...new Set(skipped.map((object) => object.status))].join(', ');
        logger.warn(
          `${skipped.length} object(s) of calendar "${calendar.name}" unreadable on the server (${statuses}), skipped`,
        );
      }
      return texts;
    },
  };
}

// -----------------------------------------------------------------------------
// Event objects of a calendar.
//
// Not tsdav's fetchCalendarObjects: it lists the hrefs with a calendar-query,
// then re-reads them with a calendar-multiget, and fails the WHOLE calendar as
// soon as one href of the multiget answers an error. Google does that on the
// main calendar of an account (404 on an object it has just listed), so one
// such object made the whole calendar fail.
//
// Here one calendar-query asks for the data directly (RFC 4791 §7.8): a single
// request, no href round-trip, and an object answering an error is skipped on
// its own. The multiget is only a fallback for the objects a server listed
// without their data.
// -----------------------------------------------------------------------------

const CALDAV_ATTRIBUTES = getDAVAttribute([DAVNamespace.CALDAV, DAVNamespace.DAV]);
const OBJECT_PROPS = { 'd:getetag': {}, 'c:calendar-data': {} };

// iCalendar UTC date-time (20261104T120000Z), the time-range format.
function icalUtc(date) {
  return `${date.toISOString().slice(0, 19).replace(/[-:]/g, '')}Z`;
}

function calendarDataOf(response) {
  const value = response.props?.calendarData;
  const text = typeof value === 'string' ? value : (value?._cdata ?? value?._text);
  return typeof text === 'string' && text.trim() !== '' ? text : null;
}

function pathOf(href, base) {
  try {
    return decodeURIComponent(new URL(href, base).pathname).replace(/\/+$/, '');
  } catch {
    return href;
  }
}

/**
 * Sort the responses of a REPORT: data read, objects without data, objects in
 * error. A failure of the request itself (no multistatus) throws.
 * @param {object[]} responses tsdav davRequest() result
 * @param {string} calendarUrl
 * @param {string} context error message prefix
 */
function classify(responses, calendarUrl, context) {
  const result = { texts: [], missing: [], skipped: [] };
  for (const response of responses) {
    if (response.ok && !response.raw) {
      // Empty body: an empty calendar.
      continue;
    }
    if (!response.raw?.multistatus) {
      // Not a multistatus: the request itself failed (or the server is no
      // CalDAV server).
      if (!response.ok) {
        throw new Error(`${context}: ${response.status} ${response.statusText ?? ''}`.trim());
      }
      throw new Error(`${context}: expected a DAV multistatus response`);
    }
    if (typeof response.href !== 'string' || response.href === '') {
      // Empty multistatus: an empty calendar.
      continue;
    }
    if (!response.ok) {
      // Some servers answer an empty calendar with a 404 on the collection
      // itself: nothing to skip.
      if (pathOf(response.href, calendarUrl) !== pathOf(calendarUrl, calendarUrl)) {
        result.skipped.push({ href: response.href, status: response.status });
      }
      continue;
    }
    const text = calendarDataOf(response);
    if (text !== null) {
      result.texts.push(text);
    } else if (pathOf(response.href, calendarUrl) !== pathOf(calendarUrl, calendarUrl)) {
      result.missing.push(response.href);
    }
  }
  return result;
}

/**
 * Raw iCalendar texts of the objects of a calendar having an event in the
 * window.
 * @param {(params: object) => Promise<object[]>} request tsdav davRequest,
 *   authenticated (DAVClient#davRequest)
 * @param {string} calendarUrl
 * @param {{ from: Date, to: Date }} window
 * @returns {Promise<{ texts: string[], skipped: Array<{ href: string, status: number }> }>}
 */
export async function queryEventObjects(request, calendarUrl, window) {
  const query = await request({
    url: calendarUrl,
    init: {
      method: 'REPORT',
      namespace: 'c',
      headers: { depth: '1' },
      body: {
        'calendar-query': {
          _attributes: CALDAV_ATTRIBUTES,
          'd:prop': OBJECT_PROPS,
          filter: {
            'comp-filter': {
              _attributes: { name: 'VCALENDAR' },
              'comp-filter': {
                _attributes: { name: 'VEVENT' },
                'time-range': {
                  _attributes: { start: icalUtc(window.from), end: icalUtc(window.to) },
                },
              },
            },
          },
        },
      },
    },
  });
  const { texts, missing, skipped } = classify(query, calendarUrl, 'Calendar query failed');

  // Fallback: a server that ignored calendar-data in the query.
  for (let i = 0; i < missing.length; i += MULTIGET_BATCH) {
    const responses = await request({
      url: calendarUrl,
      init: {
        method: 'REPORT',
        namespace: 'c',
        headers: { depth: '1' },
        body: {
          'calendar-multiget': {
            _attributes: CALDAV_ATTRIBUTES,
            'd:prop': OBJECT_PROPS,
            'd:href': missing.slice(i, i + MULTIGET_BATCH),
          },
        },
      },
    });
    const batch = classify(responses, calendarUrl, 'Calendar multiget failed');
    texts.push(...batch.texts);
    skipped.push(...batch.skipped, ...batch.missing.map((href) => ({ href, status: 'no data' })));
  }
  return { texts, skipped };
}
