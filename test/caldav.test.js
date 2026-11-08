// -----------------------------------------------------------------------------
// src/caldav.js against an in-memory DAV server: a fake `fetch` answering the
// requests tsdav sends (discovery, calendar listing, calendar-query,
// calendar-multiget). No network.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCalDavClient, feedUrl, readObjectResponses } from '../src/caldav.js';
import { ics, vevent } from './helpers.js';

const SERVER = 'https://dav.example.com';
const HOME = '/calendars/john/';
const CALENDAR = `${HOME}main/`;
const SUBSCRIPTION = `${HOME}holidays-subscription/`;
const FEED = 'webcal://feeds.example.org/holidays.ics';

const WINDOW = {
  from: new Date('2026-10-01T12:00:00Z'),
  to: new Date('2026-12-01T12:00:00Z'),
};

const escapeXml = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;');

const multistatus = (responses) =>
  `<?xml version="1.0" encoding="utf-8"?>
<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/" xmlns:ca="http://apple.com/ns/ical/">
${responses.join('\n')}
</d:multistatus>`;

const okResponse = (href, props) =>
  `<d:response><d:href>${href}</d:href><d:propstat><d:prop>${props}</d:prop>` +
  '<d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>';

const notFound = (href) =>
  `<d:response><d:href>${href}</d:href><d:status>HTTP/1.1 404 Not Found</d:status></d:response>`;

const objectResponse = (href, text) =>
  okResponse(
    href,
    `<d:getetag>"1"</d:getetag><c:calendar-data>${escapeXml(text)}</c:calendar-data>`,
  );

/**
 * @param {object} options
 * @param {Record<string, string>} options.objects href -> iCalendar text
 * @param {string[]} [options.missing] hrefs listed by the calendar-query but
 *   answered 404 by the multiget (the Google behaviour)
 * @param {boolean} [options.listCollection] the calendar-query also lists the
 *   calendar collection itself
 * @param {number} [options.dataQueryStatus] HTTP status of the calendar-query
 *   asking for the data
 * @param {Record<string, Response | Error>} [options.feeds] answers of the
 *   feed URLs (any host other than the DAV server)
 */
function fakeServer({
  objects,
  missing = [],
  listCollection = false,
  dataQueryStatus = 207,
  feeds = {},
}) {
  const requests = [];
  const xml = (body, status = 207) =>
    new Response(body, { status, headers: { 'content-type': 'application/xml; charset=utf-8' } });

  async function fetch(input, init = {}) {
    const url = new URL(typeof input === 'string' ? input : input.url);
    const body = typeof init.body === 'string' ? init.body : '';
    const method = init.method ?? 'GET';
    requests.push({ method, url: url.href, path: url.pathname, body, headers: init.headers });

    if (url.origin !== SERVER) {
      const answer = feeds[url.href];
      if (answer instanceof Error) {
        throw answer;
      }
      return answer ?? new Response('', { status: 404, statusText: 'Not Found' });
    }
    if (url.pathname.startsWith('/.well-known/')) {
      return new Response('', { status: 404 });
    }
    if (method === 'PROPFIND' && body.includes('current-user-principal')) {
      return xml(
        multistatus([
          okResponse(
            '/',
            '<d:current-user-principal><d:href>/principals/john/</d:href></d:current-user-principal>',
          ),
        ]),
      );
    }
    if (method === 'PROPFIND' && body.includes('calendar-home-set')) {
      return xml(
        multistatus([
          okResponse(
            '/principals/john/',
            `<c:calendar-home-set><d:href>${HOME}</d:href></c:calendar-home-set>`,
          ),
        ]),
      );
    }
    if (method === 'PROPFIND' && body.includes('supported-report-set')) {
      return xml(multistatus([okResponse(url.pathname, '')]));
    }
    if (method === 'PROPFIND' && url.pathname === HOME) {
      return xml(
        multistatus([
          okResponse(HOME, '<d:resourcetype><d:collection/></d:resourcetype>'),
          okResponse(
            CALENDAR,
            '<d:resourcetype><d:collection/><c:calendar/></d:resourcetype>' +
              '<d:displayname>Main</d:displayname><cs:getctag>ctag-1</cs:getctag>' +
              '<c:supported-calendar-component-set><c:comp name="VEVENT"/></c:supported-calendar-component-set>',
          ),
          okResponse(
            SUBSCRIPTION,
            '<d:resourcetype><d:collection/><cs:subscribed/></d:resourcetype>' +
              '<d:displayname>Holidays</d:displayname><ca:calendar-color>#FF0000FF</ca:calendar-color>' +
              `<cs:source><d:href>${FEED}</d:href></cs:source>`,
          ),
          okResponse(
            `${HOME}no-source/`,
            '<d:resourcetype><d:collection/><cs:subscribed/></d:resourcetype>',
          ),
        ]),
      );
    }
    if (method === 'REPORT' && body.includes('calendar-multiget')) {
      const hrefs = [...body.matchAll(/<d:href>([^<]+)<\/d:href>/g)].map((match) => match[1]);
      return xml(
        multistatus(
          hrefs.map((href) =>
            objects[href] && !missing.includes(href)
              ? objectResponse(href, objects[href])
              : notFound(href),
          ),
        ),
      );
    }
    if (method === 'REPORT' && body.includes('calendar-query') && body.includes('calendar-data')) {
      if (dataQueryStatus >= 400) {
        return new Response('Forbidden', { status: dataQueryStatus, statusText: 'Forbidden' });
      }
      return xml(
        multistatus(Object.entries(objects).map(([href, text]) => objectResponse(href, text))),
      );
    }
    if (method === 'REPORT' && body.includes('calendar-query')) {
      const hrefs = [...Object.keys(objects), ...missing];
      return xml(
        multistatus([
          ...(listCollection ? [okResponse(CALENDAR, '<d:getetag>"c"</d:getetag>')] : []),
          ...hrefs.map((href) => okResponse(href, '<d:getetag>"1"</d:getetag>')),
        ]),
      );
    }
    return new Response('', { status: 400, statusText: 'Unexpected request' });
  }
  return { fetch, requests };
}

const ACCOUNT = { server_url: SERVER, username: 'john', password: 'secret' };

const OBJECTS = {
  [`${CALENDAR}a.ics`]: ics(vevent('a', '20261105T090000Z', '20261105T100000Z')),
  [`${CALENDAR}b.ics`]: ics(vevent('b', '20261106T090000Z', '20261106T100000Z')),
};

async function connect(server) {
  const client = await createCalDavClient(ACCOUNT, { fetch: server.fetch });
  const [calendar] = await client.listCalendars();
  return { client, calendar };
}

test('lists the calendars found by the discovery', async () => {
  const { calendar } = await connect(fakeServer({ objects: OBJECTS }));
  assert.equal(calendar.url, `${SERVER}${CALENDAR}`);
  assert.equal(calendar.name, 'Main');
  assert.equal(calendar.ctag, 'ctag-1');
});

test('reads the objects with a calendar-multiget', async () => {
  const server = fakeServer({ objects: OBJECTS });
  const { client, calendar } = await connect(server);
  const texts = await client.fetchObjects(calendar, WINDOW);
  assert.deepEqual(texts.sort(), Object.values(OBJECTS).sort());
  assert.ok(server.requests.some((request) => request.body.includes('calendar-multiget')));
});

test('never multigets the calendar collection itself', async () => {
  const server = fakeServer({ objects: OBJECTS, listCollection: true });
  const { client, calendar } = await connect(server);
  const texts = await client.fetchObjects(calendar, WINDOW);
  assert.equal(texts.length, 2);
  const multiget = server.requests.find((request) => request.body.includes('calendar-multiget'));
  assert.ok(!multiget.body.includes(`<d:href>${CALENDAR}</d:href>`));
});

test('an object the multiget answers 404 for no longer fails the calendar', async () => {
  const server = fakeServer({ objects: OBJECTS, missing: [`${CALENDAR}ghost`] });
  const { client, calendar } = await connect(server);
  const texts = await client.fetchObjects(calendar, WINDOW);
  // Read again by a single calendar-query returning the data.
  assert.deepEqual(texts.sort(), Object.values(OBJECTS).sort());
  const dataQuery = server.requests.find(
    (request) =>
      request.method === 'REPORT' &&
      request.body.includes('calendar-query') &&
      request.body.includes('calendar-data'),
  );
  assert.ok(dataQuery, 'fallback calendar-query sent');
  assert.match(dataQuery.body, /time-range start="20261001T120000Z" end="20261201T120000Z"/);
});

test('both reads failing: the error names the two requests', async () => {
  const server = fakeServer({
    objects: OBJECTS,
    missing: [`${CALENDAR}ghost`],
    dataQueryStatus: 403,
  });
  const { client, calendar } = await connect(server);
  await assert.rejects(client.fetchObjects(calendar, WINDOW), (error) => {
    assert.match(error.message, /404/);
    assert.match(error.message, /calendar-query on \/calendars\/john\/main\/ failed: 403/);
    return true;
  });
});

test('a failing discovery says so', async () => {
  const fetch = async () => new Response('', { status: 401, statusText: 'Unauthorized' });
  await assert.rejects(createCalDavClient(ACCOUNT, { fetch }), /^Error: CalDAV discovery failed/);
});

test('readObjectResponses keeps the readable objects and lists the others', () => {
  const calendarUrl = `${SERVER}${CALENDAR}`;
  const { texts, skipped } = readObjectResponses(
    [
      { href: CALENDAR, ok: true, status: 200, props: {} },
      { href: `${CALENDAR}a.ics`, ok: true, status: 200, props: { calendarData: 'A' } },
      { href: `${CALENDAR}b.ics`, ok: true, status: 200, props: { calendarData: { _cdata: 'B' } } },
      { href: `${CALENDAR}c.ics`, ok: false, status: 404, statusText: 'Not Found', props: {} },
      { href: `${CALENDAR}d.ics`, ok: true, status: 200, props: {} },
    ],
    calendarUrl,
  );
  assert.deepEqual(texts, ['A', 'B']);
  assert.deepEqual(skipped, [`${CALENDAR}c.ics (404 Not Found)`, `${CALENDAR}d.ics (200)`]);
});

// --- Webcal subscriptions -----------------------------------------------------

const FEED_TEXT = ics(vevent('h', '20261111T090000Z', '20261111T100000Z', 'Holiday'));
const HTTPS_FEED = 'https://feeds.example.org/holidays.ics';

test('lists the webcal subscriptions apart from the calendars', async () => {
  const server = fakeServer({ objects: OBJECTS });
  const client = await createCalDavClient(ACCOUNT, { fetch: server.fetch });
  const calendars = await client.listCalendars();
  assert.deepEqual(
    calendars.map((calendar) => calendar.url),
    [`${SERVER}${CALENDAR}`],
  );
  const subscriptions = await client.listSubscriptions();
  assert.equal(subscriptions.length, 1);
  const [subscription] = subscriptions;
  assert.equal(subscription.url, `${SERVER}${SUBSCRIPTION}`);
  assert.equal(subscription.source, FEED);
  assert.equal(subscription.name, 'Holidays');
  assert.equal(subscription.color, '#FF0000FF');
  assert.equal(subscription.subscription, true);
});

test('reads a feed over https, without the CalDAV credentials', async () => {
  const server = fakeServer({
    objects: OBJECTS,
    feeds: { [HTTPS_FEED]: new Response(FEED_TEXT) },
  });
  const client = await createCalDavClient(ACCOUNT, { fetch: server.fetch });
  const [subscription] = await client.listSubscriptions();
  const feed = await client.fetchSubscription(subscription);
  assert.equal(feed.text, FEED_TEXT);
  assert.match(feed.version, /^[0-9a-f]{64}$/);
  const request = server.requests.find((r) => r.url === HTTPS_FEED);
  assert.equal(new Headers(request.headers).has('authorization'), false);
});

test('a webcal feed unreachable over https is read over http', async () => {
  const server = fakeServer({
    objects: OBJECTS,
    feeds: {
      [HTTPS_FEED]: new TypeError('fetch failed'),
      'http://feeds.example.org/holidays.ics': new Response(FEED_TEXT),
    },
  });
  const client = await createCalDavClient(ACCOUNT, { fetch: server.fetch });
  const [subscription] = await client.listSubscriptions();
  assert.equal((await client.fetchSubscription(subscription)).text, FEED_TEXT);
});

test('a failing feed names its host only', async () => {
  const subscription = { name: 'Holidays', source: 'https://feeds.example.org/private/token.ics' };
  const cases = [
    [new Response('', { status: 404, statusText: 'Not Found' }), /^feed feeds\.example\.org: 404/],
    [new Response('<html>login</html>'), /not an iCalendar feed/],
    [
      new Response('BEGIN:VCALENDAR', { headers: { 'content-length': String(50 * 1024 * 1024) } }),
      /feed larger than 20 MB/,
    ],
  ];
  for (const [answer, expected] of cases) {
    const server = fakeServer({ objects: OBJECTS, feeds: { [subscription.source]: answer } });
    const client = await createCalDavClient(ACCOUNT, { fetch: server.fetch });
    await assert.rejects(client.fetchSubscription(subscription), (error) => {
      assert.match(error.message, expected);
      assert.doesNotMatch(error.message, /token/);
      return true;
    });
  }
});

test('feedUrl turns webcal into https and refuses other schemes', () => {
  assert.equal(feedUrl('webcal://a.example/x.ics').href, 'https://a.example/x.ics');
  assert.equal(feedUrl(' WEBCALS://a.example/x.ics').href, 'https://a.example/x.ics');
  assert.equal(feedUrl('http://a.example/x.ics').href, 'http://a.example/x.ics');
  assert.throws(() => feedUrl('file:///etc/passwd'), /unsupported subscription URL scheme/);
  assert.throws(() => feedUrl('not a url'));
});
