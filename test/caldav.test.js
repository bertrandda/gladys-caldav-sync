// -----------------------------------------------------------------------------
// src/caldav.js against an in-memory DAV server: a fake `fetch` answering the
// requests tsdav sends (discovery, calendar listing, calendar-query,
// calendar-multiget). No network.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCalDavClient, readObjectResponses } from '../src/caldav.js';
import { ics, vevent } from './helpers.js';

const SERVER = 'https://dav.example.com';
const HOME = '/calendars/john/';
const CALENDAR = `${HOME}main/`;

const WINDOW = {
  from: new Date('2026-10-01T12:00:00Z'),
  to: new Date('2026-12-01T12:00:00Z'),
};

const escapeXml = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;');

const multistatus = (responses) =>
  `<?xml version="1.0" encoding="utf-8"?>
<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/">
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
 */
function fakeServer({ objects, missing = [], listCollection = false, dataQueryStatus = 207 }) {
  const requests = [];
  const xml = (body, status = 207) =>
    new Response(body, { status, headers: { 'content-type': 'application/xml; charset=utf-8' } });

  async function fetch(input, init = {}) {
    const url = new URL(typeof input === 'string' ? input : input.url);
    const body = typeof init.body === 'string' ? init.body : '';
    const method = init.method ?? 'GET';
    requests.push({ method, path: url.pathname, body });

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
