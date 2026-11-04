import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_CONFIG,
  PROVIDER_URLS,
  isAccountComplete,
  normalizeAccount,
  normalizeConfig,
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
  });
  assert.deepEqual(normalizeConfig({ sync_interval: 1, past_days: -3, future_days: 5000 }), {
    sync_interval: 5,
    past_days: 0,
    future_days: 730,
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

test('normalizeAccount uses the URL of a hosted provider', () => {
  const google = normalizeAccount({
    provider: 'google',
    server_url: 'https://typed.example.com',
    username: 'john@gmail.com',
    password: 'app-password',
  });
  assert.equal(google.server_url, PROVIDER_URLS.google);
  assert.equal(isAccountComplete(google), true);
  assert.equal(
    isAccountComplete(normalizeAccount({ provider: 'icloud', username: 'a', password: 'b' })),
    true,
  );
});

test('normalizeAccount keeps the typed URL for "custom", a missing or unknown provider', () => {
  for (const provider of ['custom', undefined, '', 'unknown', 'hasOwnProperty']) {
    assert.equal(
      normalizeAccount({ provider, server_url: 'dav.example.com' }).server_url,
      'https://dav.example.com',
      `provider ${provider}`,
    );
  }
});

test('every hosted provider URL is an https URL', () => {
  for (const [provider, url] of Object.entries(PROVIDER_URLS)) {
    if (url !== null) {
      assert.equal(new URL(url).protocol, 'https:', provider);
    }
  }
});
