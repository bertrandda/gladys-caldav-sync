// End-to-end wiring: src/app.js against the fake Gladys of the SDK and an
// in-memory CalDAV server.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { registerHandlers } from '../src/app.js';
import { WriteLimiter } from '../src/scheduler.js';
import { account, createFakeCalDav, ics, vevent } from './helpers.js';

const SERVER = 'https://dav.example.com';

function setup({ accounts, config = {} }) {
  const calendar = {
    url: `${SERVER}/calendars/john/work/`,
    name: 'Work',
    ctag: '1',
    objects: [ics(vevent('meeting', '20261005T090000Z', '20261005T100000Z', 'Meeting'))],
  };
  const caldav = createFakeCalDav({ [SERVER]: { password: 'secret', calendars: [calendar] } });
  const gladys = createFakeGladys({ calendarAccounts: accounts, config });
  const timers = [];
  const { manager } = registerHandlers(gladys, {
    createClient: caldav.createClient,
    now: () => new Date('2026-10-01T08:00:00Z'),
    setTimer: (fn, delay) => {
      const timer = { fn, delay, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => {
      timer.cleared = true;
    },
    limiter: new WriteLimiter({ sleep: async () => {} }),
  });
  return { gladys, caldav, manager, timers, calendar };
}

test('connecting syncs every enabled account and reports the status', async () => {
  const { gladys, timers } = setup({ accounts: [account('john', SERVER)] });
  await gladys.connect();

  assert.equal(gladys.fake.calendars.length, 1);
  assert.equal(gladys.fake.calendarEvents[0].name, 'Meeting');
  assert.equal(gladys.fake.connectionStatus.connected, true);
  // The next pass is armed at the default interval (15 minutes).
  const armed = timers.filter((timer) => !timer.cleared);
  assert.equal(armed.length, 1);
  assert.equal(armed[0].delay, 15 * 60_000);
});

test('a failing account is reported without leaking its credentials', async () => {
  const { gladys } = setup({
    accounts: [account('john', SERVER), account('jane', SERVER, 'wrong-password')],
  });
  await gladys.connect();

  assert.equal(gladys.fake.calendars.length, 1);
  const status = gladys.fake.connectionStatus;
  assert.equal(status.connected, false);
  assert.match(status.message.en, /^1 of 2 CalDAV account/);
  assert.match(status.message.fr, /^1 compte\(s\) CalDAV sur 2/);
  assert.equal(JSON.stringify(status).includes('wrong-password'), false);
});

test('an incomplete account is an error, not a crash', async () => {
  const { gladys, caldav } = setup({
    accounts: [{ user: { selector: 'john', language: 'en' }, config: { server_url: SERVER } }],
  });
  await gladys.connect();
  assert.equal(gladys.fake.connectionStatus.connected, false);
  assert.equal(caldav.calls.length, 0);
});

test('a user enabling the integration is synced at once, and forgotten once disabled', async () => {
  const { gladys, manager } = setup({ accounts: [] });
  await gladys.connect();
  assert.equal(gladys.fake.calendars.length, 0);

  gladys.fake.calendarAccounts = [account('john', SERVER)];
  await gladys.fake.calendarAccountUpdated('john');
  assert.equal(gladys.fake.calendarEvents.length, 1);

  // Disabling: the core destroys the calendars first, then notifies.
  gladys.fake.calendarAccounts = [];
  gladys.fake.calendars = [];
  gladys.fake.calendarEvents = [];
  await gladys.fake.calendarAccountUpdated('john');
  assert.equal(manager.accounts.size, 0);
  assert.equal(manager.timers.size, 0);
});

test('switching a calendar back on refills it', async () => {
  const { gladys } = setup({ accounts: [account('john', SERVER)] });
  await gladys.connect();

  gladys.fake.calendars[0].sync = false;
  gladys.fake.calendarEvents = [];
  await gladys.fake.calendarAccountUpdated('john');
  assert.equal(gladys.fake.calendarEvents.length, 0);

  gladys.fake.calendars[0].sync = true;
  await gladys.fake.calendarAccountUpdated('john');
  assert.equal(gladys.fake.calendarEvents.length, 1);
});

test('the sync_now action answers a bilingual summary', async () => {
  const { gladys } = setup({ accounts: [account('john', SERVER)] });
  await gladys.connect();
  const ack = await gladys.fake.action('sync_now', {});
  assert.equal(ack.success, true);
  assert.deepEqual(ack.data.message, {
    en: '1 account(s) synced: 1 calendar(s), 1 event(s).',
    fr: '1 compte(s) synchronisé(s) : 1 calendrier(s), 1 événement(s).',
  });
});

test('a new interval re-arms the loops, a new window re-syncs', async () => {
  const { gladys, caldav, timers } = setup({ accounts: [account('john', SERVER)] });
  await gladys.connect();

  await gladys.fake.configUpdated({ sync_interval: 60 });
  const armed = timers.filter((timer) => !timer.cleared);
  assert.equal(armed.length, 1);
  assert.equal(armed[0].delay, 60 * 60_000);
  const fetches = caldav.calls.filter((c) => c.type === 'fetchObjects').length;

  await gladys.fake.configUpdated({ sync_interval: 60, future_days: 30 });
  const last = caldav.calls.filter((c) => c.type === 'fetchObjects');
  assert.equal(last.length, fetches + 1);
  assert.equal(last.at(-1).window.to.toISOString(), '2026-10-31T12:00:00.000Z');
});

test('a timer firing runs the next pass', async () => {
  const { gladys, caldav, timers, calendar } = setup({ accounts: [account('john', SERVER)] });
  await gladys.connect();
  calendar.ctag = '2';
  calendar.objects.push(ics(vevent('lunch', '20261006T120000Z', '20261006T130000Z', 'Lunch')));

  const timer = timers.find((t) => !t.cleared);
  timer.fn();
  // Wait for the queued pass.
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(gladys.fake.calendarEvents.length, 2);
  assert.equal(caldav.calls.filter((c) => c.type === 'login').length, 2);
});

test('disconnecting stops the loops', async () => {
  const { gladys, manager } = setup({ accounts: [account('john', SERVER)] });
  await gladys.connect();
  await gladys.disconnect();
  assert.equal(manager.timers.size, 0);
});
