import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { DEFAULT_CONFIG } from '../src/config.js';
import { calendarExternalId } from '../src/mapping.js';
import { splitWindow, syncAccount, syncWindow } from '../src/sync.js';
import { account, createFakeCalDav, ics, vevent } from './helpers.js';

const NOW = new Date('2026-10-01T08:00:00Z');
const SERVER = 'https://dav.example.com';
const WORK = `${SERVER}/calendars/john/work/`;
const HOME = `${SERVER}/calendars/john/home/`;

function setup(calendars) {
  const caldav = createFakeCalDav({ [SERVER]: { password: 'secret', calendars } });
  const john = account('john', SERVER);
  const gladys = createFakeGladys({ calendarAccounts: [john] });
  return { gladys, caldav, john };
}

async function run(gladys, caldav, john, cache = { ctags: new Map() }) {
  const client = await caldav.createClient({ server_url: SERVER, password: 'secret' });
  return syncAccount(gladys, john, {
    client,
    config: DEFAULT_CONFIG,
    now: NOW,
    cache,
    write: (fn) => fn(),
  });
}

test('syncWindow spans past_days to future_days, bounds at noon UTC', () => {
  const window = syncWindow(NOW, { past_days: 30, future_days: 365 });
  assert.equal(window.from.toISOString(), '2026-09-01T12:00:00.000Z');
  assert.equal(window.to.toISOString(), '2027-10-01T12:00:00.000Z');
});

test('calendars and events are published, user-scoped, with the window', async () => {
  const { gladys, caldav, john } = setup([
    {
      url: WORK,
      name: 'Work',
      color: '#0082c9',
      ctag: '1',
      objects: [ics(vevent('meeting', '20261005T090000Z', '20261005T100000Z', 'Meeting'))],
    },
    { url: HOME, name: 'Home', ctag: '1', objects: [] },
  ]);
  const summary = await run(gladys, caldav, john);

  assert.deepEqual(summary, { calendars: 2, events: 1, skipped: 0, errors: [] });
  const workId = calendarExternalId(gladys, 'john', WORK);
  assert.deepEqual(
    gladys.fake.calendars.map((c) => [
      c.external_id.startsWith('ext:test-integration:john:'),
      c.name,
    ]),
    [
      [true, 'Work'],
      [true, 'Home'],
    ],
  );
  const [event] = gladys.fake.calendarEvents;
  assert.equal(event.calendar_external_id, workId);
  assert.equal(event.name, 'Meeting');
  assert.equal(event.start, '2026-10-05T09:00:00.000Z');
  const batches = gladys.fake.publishedCalendarEvents;
  assert.equal(batches.length, 2);
  assert.deepEqual(batches[0].window, {
    from: '2026-09-01T12:00:00.000Z',
    to: '2027-10-01T12:00:00.000Z',
  });
});

test('an event deleted on the server is pruned from Gladys', async () => {
  const calendar = {
    url: WORK,
    name: 'Work',
    ctag: '1',
    objects: [
      ics(vevent('a', '20261005T090000Z', '20261005T100000Z')),
      ics(vevent('b', '20261006T090000Z', '20261006T100000Z')),
    ],
  };
  const { gladys, caldav, john } = setup([calendar]);
  const cache = { ctags: new Map() };
  await run(gladys, caldav, john, cache);
  assert.equal(gladys.fake.calendarEvents.length, 2);

  calendar.objects.pop();
  calendar.ctag = '2';
  await run(gladys, caldav, john, cache);
  assert.deepEqual(
    gladys.fake.calendarEvents.map((e) => e.name),
    ['a'],
  );
});

test('nothing is written again while the ctag and the window stay the same', async () => {
  const { gladys, caldav, john } = setup([
    {
      url: WORK,
      name: 'Work',
      ctag: '1',
      objects: [ics(vevent('a', '20261005T090000Z', '20261005T100000Z'))],
    },
  ]);
  const cache = { ctags: new Map() };
  await run(gladys, caldav, john, cache);
  const writes = gladys.fake.requests.filter((r) => r.method !== 'GET').length;

  const summary = await run(gladys, caldav, john, cache);
  assert.equal(summary.events, 1);
  assert.equal(gladys.fake.requests.filter((r) => r.method !== 'GET').length, writes);
  assert.equal(caldav.calls.filter((c) => c.type === 'fetchObjects').length, 1);
});

test('a calendar the user switched off is skipped, without any 403', async () => {
  const { gladys, caldav, john } = setup([
    {
      url: WORK,
      name: 'Work',
      ctag: '1',
      objects: [ics(vevent('a', '20261005T090000Z', '20261005T100000Z'))],
    },
  ]);
  await run(gladys, caldav, john);
  // The user flips the toggle: the core empties the calendar.
  gladys.fake.calendars[0].sync = false;
  gladys.fake.calendarEvents = [];

  const summary = await run(gladys, caldav, john);
  assert.equal(summary.skipped, 1);
  assert.deepEqual(summary.errors, []);
  assert.equal(gladys.fake.calendarEvents.length, 0);
  assert.equal(
    gladys.fake.requests.some((r) => r.status === 403),
    false,
  );
});

test('a calendar removed from the server is deleted from Gladys', async () => {
  const calendars = [
    { url: WORK, name: 'Work', ctag: '1', objects: [] },
    {
      url: HOME,
      name: 'Home',
      ctag: '1',
      objects: [ics(vevent('h', '20261005T090000Z', '20261005T100000Z'))],
    },
  ];
  const { gladys, caldav, john } = setup(calendars);
  await run(gladys, caldav, john);
  calendars.pop();

  await run(gladys, caldav, john);
  assert.deepEqual(
    gladys.fake.calendars.map((c) => c.name),
    ['Work'],
  );
  assert.equal(gladys.fake.calendarEvents.length, 0);
  assert.equal(gladys.fake.deletedCalendars.length, 1);
});

test('more than 500 events are published in disjoint sub-windows', async () => {
  // A 30-minute meeting every day at 09:00, with 3 occurrences per day.
  const objects = [];
  for (let day = 0; day < 400; day += 1) {
    const date = new Date(Date.UTC(2026, 9, 1) + day * 86_400_000)
      .toISOString()
      .slice(0, 10)
      .replace(/-/g, '');
    for (const hour of ['08', '12', '16']) {
      objects.push(
        ics(vevent(`e-${date}-${hour}`, `${date}T${hour}0000Z`, `${date}T${hour}3000Z`)),
      );
    }
  }
  const { gladys, caldav, john } = setup([{ url: WORK, name: 'Work', ctag: '1', objects }]);
  const summary = await run(gladys, caldav, john);

  const batches = gladys.fake.publishedCalendarEvents;
  assert.ok(batches.length > 1);
  for (const batch of batches) {
    assert.ok(batch.events.length <= 500);
    assert.match(batch.window.from, /T12:00:00.000Z$/);
  }
  // Contiguous, disjoint windows covering the sync window.
  for (let i = 1; i < batches.length; i += 1) {
    assert.equal(batches[i].window.from, batches[i - 1].window.to);
  }
  assert.equal(batches[0].window.from, '2026-09-01T12:00:00.000Z');
  assert.equal(batches.at(-1).window.to, '2027-10-01T12:00:00.000Z');
  assert.equal(gladys.fake.calendarEvents.length, summary.events);
});

test('splitWindow repeats an event straddling a boundary in both halves', () => {
  const window = {
    from: new Date('2026-10-01T12:00:00Z'),
    to: new Date('2026-10-05T12:00:00Z'),
  };
  const events = [
    { external_id: 'a', start: '2026-10-01T13:00:00Z', end: '2026-10-01T14:00:00Z' },
    { external_id: 'long', start: '2026-10-02T00:00:00Z', end: '2026-10-04T00:00:00Z' },
    { external_id: 'b', start: '2026-10-04T13:00:00Z', end: '2026-10-04T14:00:00Z' },
  ];
  const parts = splitWindow(window, events, 2);
  assert.deepEqual(
    parts.map((part) => [part.window.from.toISOString(), part.events.map((e) => e.external_id)]),
    [
      ['2026-10-01T12:00:00.000Z', ['a', 'long']],
      ['2026-10-03T12:00:00.000Z', ['long', 'b']],
    ],
  );
});

test('one failing calendar does not stop the others', async () => {
  const { gladys, caldav, john } = setup([
    { url: WORK, name: 'Work', ctag: '1', objects: [], fail: true },
    {
      url: HOME,
      name: 'Home',
      ctag: '1',
      objects: [ics(vevent('h', '20261005T090000Z', '20261005T100000Z'))],
    },
  ]);
  const summary = await run(gladys, caldav, john);
  assert.equal(summary.errors.length, 1);
  assert.match(summary.errors[0], /^Work: Server error/);
  assert.equal(gladys.fake.calendarEvents.length, 1);
});
