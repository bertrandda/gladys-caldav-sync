// queryEventObjects against tsdav's real request layer (XML out, XML parsed
// back), with a fake fetch playing the server: no network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { davRequest } from 'tsdav';
import { queryEventObjects } from '../src/caldav.js';
import { ics, vevent } from './helpers.js';

const CALENDAR = 'https://apidata.googleusercontent.com/caldav/v2/john%40gmail.com/events/';
const PATH = '/caldav/v2/john%40gmail.com/events/';
const WINDOW = {
  from: new Date('2026-10-05T12:00:00Z'),
  to: new Date('2026-11-04T12:00:00Z'),
};

const escapeXml = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;');

function objectResponse(href, data) {
  return `<d:response><d:href>${href}</d:href><d:propstat><d:prop><d:getetag>"1"</d:getetag><c:calendar-data>${escapeXml(data)}</c:calendar-data></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
}

function etagOnlyResponse(href) {
  return `<d:response><d:href>${href}</d:href><d:propstat><d:prop><d:getetag>"1"</d:getetag></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
}

function notFoundResponse(href) {
  return `<d:response><d:href>${href}</d:href><d:status>HTTP/1.1 404 Not Found</d:status></d:response>`;
}

function multistatus(...responses) {
  return new Response(
    `<?xml version="1.0" encoding="UTF-8"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">${responses.join('')}</d:multistatus>`,
    { status: 207, headers: { 'content-type': 'application/xml; charset=UTF-8' } },
  );
}

/** A server answering the REPORTs with `reply(body)`; records the bodies. */
function fakeServer(reply) {
  const bodies = [];
  const request = (params) =>
    davRequest({
      ...params,
      fetch: async (url, init) => {
        bodies.push(init.body);
        return reply(init.body, url);
      },
    });
  return { request, bodies };
}

const meeting = ics(vevent('meeting', '20261020T090000Z', '20261020T100000Z'));
const lunch = ics(vevent('lunch@google.com', '20261021T120000Z', '20261021T130000Z'));

test('one calendar-query reads the objects with their data', async () => {
  const server = fakeServer(() =>
    multistatus(
      objectResponse(`${PATH}meeting.ics`, meeting),
      objectResponse(`${PATH}lunch%40google.com.ics`, lunch),
    ),
  );
  const { texts, skipped } = await queryEventObjects(server.request, CALENDAR, WINDOW);

  assert.deepEqual(texts, [meeting, lunch]);
  assert.deepEqual(skipped, []);
  assert.equal(server.bodies.length, 1, 'no multiget when the query returned the data');
  const [body] = server.bodies;
  assert.match(body, /<c:calendar-query/);
  assert.match(body, /<c:calendar-data\s*\/>/);
  assert.match(body, /<c:time-range start="20261005T120000Z" end="20261104T120000Z"\s*\/>/);
});

test('an object answering 404 is skipped, not the whole calendar', async () => {
  // What Google does on the main calendar of an account.
  const server = fakeServer(() =>
    multistatus(
      objectResponse(`${PATH}meeting.ics`, meeting),
      notFoundResponse(`${PATH}ghost.ics`),
    ),
  );
  const { texts, skipped } = await queryEventObjects(server.request, CALENDAR, WINDOW);

  assert.deepEqual(texts, [meeting]);
  assert.deepEqual(skipped, [{ href: `${PATH}ghost.ics`, status: 404 }]);
});

test('objects listed without data are read with a multiget, errors skipped', async () => {
  const server = fakeServer((body) =>
    body.includes('calendar-query')
      ? multistatus(
          objectResponse(`${PATH}meeting.ics`, meeting),
          etagOnlyResponse(`${PATH}lunch.ics`),
          etagOnlyResponse(`${PATH}ghost.ics`),
        )
      : multistatus(
          objectResponse(`${PATH}lunch.ics`, lunch),
          notFoundResponse(`${PATH}ghost.ics`),
        ),
  );
  const { texts, skipped } = await queryEventObjects(server.request, CALENDAR, WINDOW);

  assert.deepEqual(texts, [meeting, lunch]);
  assert.deepEqual(skipped, [{ href: `${PATH}ghost.ics`, status: 404 }]);
  assert.equal(server.bodies.length, 2);
  assert.match(server.bodies[1], /<c:calendar-multiget/);
  assert.match(server.bodies[1], new RegExp(`<d:href>${PATH}lunch.ics</d:href>`));
  assert.doesNotMatch(server.bodies[1], /meeting\.ics/);
});

test('an empty calendar is no error', async () => {
  for (const reply of [
    () => multistatus(),
    // Some servers answer an empty calendar with a 404 on the collection.
    () => multistatus(notFoundResponse(PATH)),
    () => new Response(null, { status: 207 }),
  ]) {
    const { texts, skipped } = await queryEventObjects(fakeServer(reply).request, CALENDAR, WINDOW);
    assert.deepEqual(texts, []);
    assert.deepEqual(skipped, []);
  }
});

test('a failure of the request itself still fails the calendar', async () => {
  const server = fakeServer(() => new Response('gone', { status: 404, statusText: 'Not Found' }));
  await assert.rejects(
    queryEventObjects(server.request, CALENDAR, WINDOW),
    /Calendar query failed: 404 Not Found/,
  );
  const html = fakeServer(
    () => new Response('<html></html>', { status: 200, headers: { 'content-type': 'text/html' } }),
  );
  await assert.rejects(
    queryEventObjects(html.request, CALENDAR, WINDOW),
    /expected a DAV multistatus response/,
  );
});
