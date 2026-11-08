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
//   const subscriptions = await client.listSubscriptions();
//   const { text, version } = await client.fetchSubscription(subscriptions[0]);
//
// Objects are read with tsdav's two-step fetch (calendar-query for the hrefs,
// calendar-multiget for the data). tsdav fails the whole calendar when ONE
// href of the multiget answers an error, which Google does (404) on some
// calendars: the fallback is a single calendar-query returning the data,
// where the objects the server cannot return are skipped, not fatal.
//
// Webcal subscriptions of the account (Nextcloud, iCloud…) sit in the
// calendar home as `<cs:subscribed/>` collections, not `<c:calendar/>` ones:
// tsdav's fetchCalendars ignores them. Their `<cs:source>` is the URL of a
// public iCalendar feed, read with a plain GET, WITHOUT the CalDAV
// credentials (the feed is usually hosted by a third party).
// -----------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import { createLogger } from '@gladysassistant/integration-sdk';
import { DAVClient, getDAVAttribute, urlMatches } from 'tsdav';

const logger = createLogger({ name: 'caldav' });

// Hrefs of skipped objects quoted in a warning (all of them at debug level).
const MAX_HREFS_LOGGED = 5;

// Per-request timeout: a server that never answers must not freeze the sync
// queue of every other user.
const REQUEST_TIMEOUT_MS = 30_000;

// Biggest webcal feed read: a whole feed is held in memory and parsed at once.
const MAX_FEED_BYTES = 20 * 1024 * 1024;

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

// iCalendar UTC date-time of a Date, as the time-range filter wants it.
function icalUtc(date) {
  return `${date.toISOString().slice(0, 19).replace(/[-:]/g, '')}Z`;
}

function pathOf(url) {
  try {
    return new URL(url).pathname;
  } catch {
    return String(url);
  }
}

// calendar-data as parsed by tsdav: a string, or `{ _cdata }` / `{ _text }`.
function calendarDataOf(response) {
  const data = response.props?.calendarData;
  if (typeof data === 'string') {
    return data;
  }
  if (data && typeof data === 'object') {
    return [data._cdata, data._text].find((value) => typeof value === 'string');
  }
  return undefined;
}

/**
 * HTTP(S) URL of a webcal subscription source: `webcal://` and `webcals://`
 * are read over https (the fallback to http is up to the caller).
 * @param {string} source `<cs:source>` of the subscription
 * @returns {URL}
 */
export function feedUrl(source) {
  const text = typeof source === 'string' ? source.trim() : '';
  const url = new URL(text.replace(/^webcals?:\/\//i, 'https://'));
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`unsupported subscription URL scheme "${url.protocol}"`);
  }
  return url;
}

// Body of a response, refused beyond `maxBytes` without reading it all.
async function readText(response, maxBytes) {
  const tooBig = () => new Error(`feed larger than ${Math.round(maxBytes / 1024 / 1024)} MB`);
  if (Number(response.headers.get('content-length')) > maxBytes) {
    throw tooBig();
  }
  if (!response.body) {
    return '';
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > maxBytes) {
      throw tooBig();
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Split the entries of a calendar-query multistatus: the calendar data of the
 * readable objects, and the hrefs the server answered an error (or nothing)
 * for. The collection itself, which some servers list, is neither.
 * @param {Array<object>} responses parsed by tsdav's davRequest
 * @param {string} calendarUrl
 * @returns {{ texts: string[], skipped: string[] }}
 */
export function readObjectResponses(responses, calendarUrl) {
  const texts = [];
  const skipped = [];
  for (const response of responses) {
    if (response.href && urlMatches(response.href, calendarUrl, calendarUrl)) {
      continue;
    }
    const data = calendarDataOf(response);
    if (response.ok && typeof data === 'string') {
      texts.push(data);
    } else {
      const status = [response.status ?? '?', response.statusText].filter(Boolean).join(' ');
      skipped.push(`${response.href ?? '?'} (${status})`);
    }
  }
  return { texts, skipped };
}

/**
 * Connect to a CalDAV server with Basic authentication.
 * @param {{ server_url: string, username: string, password: string }} account
 *   normalized account (see normalizeAccount in src/config.js)
 * @param {{ fetch?: typeof fetch }} [options] HTTP client (tests)
 * @returns {Promise<{ listCalendars: Function, fetchObjects: Function,
 *   listSubscriptions: Function, fetchSubscription: Function }>}
 */
export async function createCalDavClient(account, { fetch: fetchImpl } = {}) {
  const httpFetch = fetchImpl ?? fetchWithTimeout;
  const client = new DAVClient({
    serverUrl: account.server_url,
    credentials: { username: account.username, password: account.password },
    authMethod: 'Basic',
    defaultAccountType: 'caldav',
    fetch: httpFetch,
  });
  // Service discovery: resolves the principal and the calendar home.
  try {
    await client.login();
  } catch (error) {
    throw new Error(`CalDAV discovery failed: ${error.message}`, { cause: error });
  }
  logger.debug(
    `discovery: root ${client.account?.rootUrl}, principal ${client.account?.principalUrl}, ` +
      `calendar home ${client.account?.homeUrl}`,
  );

  /**
   * Fallback of fetchObjects: one calendar-query REPORT asking for the data
   * directly, tolerant of the entries the server answers an error for.
   */
  async function queryObjects(calendar, window) {
    const responses = await client.davRequest({
      url: calendar.url,
      init: {
        method: 'REPORT',
        namespace: 'c',
        headers: { depth: '1' },
        body: {
          'calendar-query': {
            _attributes: getDAVAttribute(['urn:ietf:params:xml:ns:caldav', 'DAV:']),
            'd:prop': { 'd:getetag': {}, 'c:calendar-data': {} },
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
    // A request-level failure comes back as one entry without multistatus.
    const [first] = responses;
    if (responses.length === 1 && first && !first.raw?.multistatus && !first.ok) {
      throw new Error(
        `calendar-query on ${pathOf(calendar.url)} failed: ${first.status} ${first.statusText}`,
      );
    }
    const { texts, skipped } = readObjectResponses(responses, calendar.url);
    if (skipped.length > 0) {
      logger.warn(
        `"${calendar.name}": ${skipped.length} object(s) the server could not return were skipped: ` +
          skipped.slice(0, MAX_HREFS_LOGGED).join(', ') +
          (skipped.length > MAX_HREFS_LOGGED ? ', …' : ''),
      );
      logger.debug(`"${calendar.name}": skipped objects: ${skipped.join(', ')}`);
    }
    return texts;
  }

  return {
    /**
     * Calendars of the account, event-capable ones only (a task list is no
     * calendar for Gladys).
     * @returns {Promise<Array<{ url, name, description, color, ctag, raw }>>}
     */
    async listCalendars() {
      const calendars = await client.fetchCalendars();
      logger.debug(`${calendars.length} collection(s) in the calendar home`);
      return calendars
        .filter((calendar) => {
          const components = calendar.components ?? [];
          const keep = components.length === 0 || components.includes('VEVENT');
          logger.debug(
            `calendar "${textOf(calendar.displayName)}" ${calendar.url}: ` +
              `components [${components.join(', ')}], ` +
              `${calendar.syncToken || calendar.ctag ? 'with' : 'without'} ctag` +
              (keep ? '' : ' -> ignored (no VEVENT)'),
          );
          return keep;
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
     * @param {{ name: string, url: string, raw: object }} calendar one of listCalendars()
     * @param {{ from: Date, to: Date }} window
     * @returns {Promise<string[]>}
     */
    async fetchObjects(calendar, window) {
      let objects;
      try {
        objects = await client.fetchCalendarObjects({
          calendar: calendar.raw,
          timeRange: { start: window.from.toISOString(), end: window.to.toISOString() },
          // tsdav keeps only `.ics` URLs by default; some servers (Google,
          // iCloud) name their objects otherwise. The collection itself,
          // listed by some servers, is no object: a multiget of it is a 404.
          urlFilter: (url) => !urlMatches(url, calendar.url, calendar.url),
        });
      } catch (error) {
        logger.warn(
          `"${calendar.name}" (${calendar.url}): ${error.message.trim()} ` +
            '-> retrying with a single calendar-query',
        );
        try {
          const texts = await queryObjects(calendar, window);
          logger.debug(`"${calendar.name}": ${texts.length} object(s) read by calendar-query`);
          return texts;
        } catch (fallbackError) {
          throw new Error(`${error.message.trim()}, then ${fallbackError.message}`, {
            cause: fallbackError,
          });
        }
      }
      const texts = objects.map((object) => object.data).filter((data) => typeof data === 'string');
      logger.debug(`"${calendar.name}": ${texts.length} object(s) read by calendar-multiget`);
      return texts;
    },

    /**
     * Webcal subscriptions of the account: the `<cs:subscribed/>` collections
     * of the calendar home that have a source URL.
     * @returns {Promise<Array<{ url, source, name, description, color, ctag, subscription, raw }>>}
     */
    async listSubscriptions() {
      const homeUrl = client.account?.homeUrl;
      if (!homeUrl) {
        return [];
      }
      const responses = await client.propfind({
        url: homeUrl,
        depth: '1',
        props: {
          'd:resourcetype': {},
          'd:displayname': {},
          'c:calendar-description': {},
          'ca:calendar-color': {},
          'cs:source': {},
        },
      });
      const [first] = responses;
      if (responses.length === 1 && first && !first.raw?.multistatus && !first.ok) {
        throw new Error(
          `subscription listing on ${pathOf(homeUrl)} failed: ${first.status} ${first.statusText}`,
        );
      }
      const subscriptions = [];
      for (const response of responses) {
        const props = response.props ?? {};
        if (!response.href || !Object.keys(props.resourcetype ?? {}).includes('subscribed')) {
          continue;
        }
        const source = textOf(props.source?.href ?? props.source).trim();
        const url = new URL(response.href, homeUrl).href;
        logger.debug(
          `subscription "${textOf(props.displayname)}" ${url}` +
            (source ? '' : ' -> ignored (no source URL)'),
        );
        if (source) {
          subscriptions.push({
            url,
            source,
            name: textOf(props.displayname),
            description: textOf(props.calendarDescription),
            color: textOf(props.calendarColor),
            // Unknown before the feed is read: see fetchSubscription().
            ctag: '',
            subscription: true,
            raw: response,
          });
        }
      }
      logger.debug(`${subscriptions.length} webcal subscription(s) in the calendar home`);
      return subscriptions;
    },

    /**
     * Read the iCalendar feed of a subscription. Errors name the feed host
     * only: a feed URL often carries a private token.
     * @param {{ name: string, source: string }} subscription one of listSubscriptions()
     * @returns {Promise<{ text: string, version: string }>} the feed and a
     *   hash of it (the feeds have no reliable ctag or ETag)
     */
    async fetchSubscription(subscription) {
      const url = feedUrl(subscription.source);
      const get = (target) =>
        httpFetch(target.href, { headers: { accept: 'text/calendar, */*;q=0.5' } });
      let response;
      try {
        response = await get(url);
      } catch (error) {
        // webcal:// does not say https or http: some feeds are http only.
        if (!/^webcal:/i.test(subscription.source.trim()) || error?.name !== 'TypeError') {
          throw new Error(`feed ${url.host}: ${error.message}`, { cause: error });
        }
        url.protocol = 'http:';
        logger.debug(`"${subscription.name}": https failed (${error.message}), trying http`);
        try {
          response = await get(url);
        } catch (httpError) {
          throw new Error(`feed ${url.host}: ${httpError.message}`, { cause: httpError });
        }
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw new Error(`feed ${url.host}: ${response.status} ${response.statusText}`.trim());
      }
      const text = await readText(response, MAX_FEED_BYTES).catch((error) => {
        throw new Error(`feed ${url.host}: ${error.message}`, { cause: error });
      });
      if (!text.includes('BEGIN:VCALENDAR')) {
        throw new Error(`feed ${url.host}: not an iCalendar feed`);
      }
      const version = createHash('sha256').update(text).digest('hex');
      logger.debug(`"${subscription.name}": feed read, ${text.length} characters`);
      return { text, version };
    },
  };
}
