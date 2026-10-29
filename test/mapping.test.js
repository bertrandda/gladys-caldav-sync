import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import {
  calendarExternalId,
  eventExternalId,
  normalizeColor,
  toCalendarInput,
  toEventInput,
} from '../src/mapping.js';

const gladys = createFakeGladys();
const user = { selector: 'john', language: 'fr' };

test('external ids are user-scoped, stable and short', () => {
  const longUrl = `https://dav.example.com/calendars/john/${'x'.repeat(400)}/`;
  const id = calendarExternalId(gladys, 'john', longUrl);
  assert.match(id, /^ext:test-integration:john:cal-[0-9a-f]{24}$/);
  assert.equal(id, calendarExternalId(gladys, 'john', longUrl));
  assert.notEqual(id, calendarExternalId(gladys, 'jane', longUrl));

  const eventId = eventExternalId(gladys, 'john', 'uid@example.com', null);
  assert.match(eventId, /^ext:test-integration:john:evt-[0-9a-f]{24}$/);
  assert.equal(
    eventExternalId(gladys, 'john', 'uid@example.com', '20261005T070000Z'),
    `${eventId}:20261005T070000Z`,
  );
});

test('normalizeColor keeps #rrggbb and drops the alpha channel', () => {
  assert.equal(normalizeColor('#FF2968FF'), '#ff2968');
  assert.equal(normalizeColor('#0082c9'), '#0082c9');
  assert.equal(normalizeColor('red'), null);
  assert.equal(normalizeColor(''), null);
  assert.equal(normalizeColor(undefined), null);
});

test('toCalendarInput maps the name, description and color', () => {
  assert.deepEqual(
    toCalendarInput(gladys, user, {
      url: 'https://dav.example.com/calendars/john/work/',
      name: 'Work',
      description: 'Office',
      color: '#0082C9FF',
    }),
    {
      external_id: calendarExternalId(
        gladys,
        'john',
        'https://dav.example.com/calendars/john/work/',
      ),
      name: 'Work',
      description: 'Office',
      color: '#0082c9',
    },
  );
});

test('toCalendarInput falls back on the URL for a nameless calendar', () => {
  const input = toCalendarInput(gladys, user, {
    url: 'https://dav.example.com/calendars/john/personal%20stuff/',
    name: '',
    description: '',
    color: '',
  });
  assert.equal(input.name, 'personal stuff');
  assert.equal('description' in input, false);
  assert.equal('color' in input, false);
});

test('toEventInput truncates to the Gladys bounds and keeps http(s) URLs only', () => {
  const input = toEventInput(gladys, user, {
    uid: 'uid-1',
    occurrence: null,
    summary: 'a'.repeat(300),
    description: 'd'.repeat(2000),
    location: 'l'.repeat(600),
    url: 'javascript:alert(1)',
    start: '2026-10-14T07:00:00.000Z',
    end: '2026-10-14T07:30:00.000Z',
    allDay: false,
  });
  assert.equal(input.name.length, 200);
  assert.equal(input.description.length, 1000);
  assert.equal(input.location.length, 500);
  assert.equal('url' in input, false);
  assert.equal('full_day' in input, false);
});

test('toEventInput names an untitled event in the user language', () => {
  const occurrence = {
    uid: 'uid-2',
    occurrence: '20261015',
    summary: '   ',
    description: '',
    location: '',
    url: 'https://example.com/e',
    start: '2026-10-15',
    end: '2026-10-16',
    allDay: true,
  };
  const fr = toEventInput(gladys, user, occurrence);
  assert.equal(fr.name, '(Sans titre)');
  assert.equal(fr.full_day, true);
  assert.equal(fr.url, 'https://example.com/e');
  assert.equal(
    toEventInput(gladys, { selector: 'jane', language: 'en' }, occurrence).name,
    '(No title)',
  );
});
