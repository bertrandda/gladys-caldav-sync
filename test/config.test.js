import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_CONFIG,
  isAccountComplete,
  normalizeAccount,
  normalizeConfig,
  PROVIDERS,
} from '../src/config.js';

test('normalizeConfig applies the defaults', () => {
  assert.deepEqual(normalizeConfig(), DEFAULT_CONFIG);
  assert.deepEqual(normalizeConfig({ sync_interval: '', past_days: null }), DEFAULT_CONFIG);
});

test('normalizeConfig converts form strings and clamps to the manifest bounds', () => {
  assert.deepEqual(normalizeConfig({ sync_interval: '30', past_days: '7', future_days: '90' }), {
    sync_interval: 30,
    past_days: 7,
    future_days: 90,
    debug_logs: false,
  });
  assert.deepEqual(normalizeConfig({ sync_interval: 1, past_days: -3, future_days: 5000 }), {
    sync_interval: 5,
    past_days: 0,
    future_days: 730,
    debug_logs: false,
  });
  assert.equal(normalizeConfig({ sync_interval: 'abc' }).sync_interval, 15);
});

test('normalizeAccount trims the values and defaults to https', () => {
  assert.deepEqual(
    normalizeAccount({
      server_url: '  cloud.example.com/remote.php/dav ',
      username: ' john ',
      password: ' p4ss ',
    }),
    {
      provider: 'other',
      server_url: 'https://cloud.example.com/remote.php/dav',
      username: 'john',
      password: ' p4ss ',
    },
  );
  assert.equal(
    normalizeAccount({ server_url: 'http://192.168.1.10:5232' }).server_url,
    'http://192.168.1.10:5232',
  );
});

test('isAccountComplete requires a URL, a username and a password', () => {
  const ok = normalizeAccount({
    server_url: 'https://dav.example.com',
    username: 'a',
    password: 'b',
  });
  assert.equal(isAccountComplete(ok), true);
  assert.equal(isAccountComplete({ ...ok, password: '' }), false);
  assert.equal(isAccountComplete({ ...ok, username: '' }), false);
  assert.equal(isAccountComplete(normalizeAccount({ username: 'a', password: 'b' })), false);
  assert.equal(isAccountComplete({ ...ok, server_url: 'https://' }), false);
});

test('normalizeConfig reads the detailed logs switch', () => {
  assert.equal(normalizeConfig({ debug_logs: true }).debug_logs, true);
  assert.equal(normalizeConfig({ debug_logs: 'true' }).debug_logs, true);
  assert.equal(normalizeConfig({ debug_logs: 'false' }).debug_logs, false);
  assert.equal(normalizeConfig({ debug_logs: 1 }).debug_logs, false);
});

test('normalizeAccount uses the URL of the chosen provider when none is typed', () => {
  assert.deepEqual(normalizeAccount({ provider: 'google', username: 'a', password: 'b' }), {
    provider: 'google',
    server_url: PROVIDERS.google,
    username: 'a',
    password: 'b',
  });
  assert.equal(
    normalizeAccount({ provider: 'icloud', server_url: '  ' }).server_url,
    PROVIDERS.icloud,
  );
});

test('normalizeAccount keeps a typed URL whatever the provider', () => {
  const account = normalizeAccount({ provider: 'google', server_url: 'dav.example.com' });
  assert.equal(account.server_url, 'https://dav.example.com');
  // Accounts created before the provider list have no provider.
  assert.equal(normalizeAccount({ server_url: 'https://dav.example.com' }).provider, 'other');
});

test('an unknown or "other" provider needs a typed URL', () => {
  for (const provider of ['other', 'unknown', 'toString', undefined]) {
    const account = normalizeAccount({ provider, username: 'a', password: 'b' });
    assert.equal(account.provider, 'other');
    assert.equal(isAccountComplete(account), false);
  }
});
