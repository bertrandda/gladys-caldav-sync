// -----------------------------------------------------------------------------
// Consistency checks between `gladys-assistant-integration.json` and the code.
// The manifest is validated by the store indexer, but nothing there can know
// which handlers the code actually registers — these tests keep both in sync.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { registerHandlers } from '../src/app.js';
import { ACCOUNT_KEYS, CONFIG_BOUNDS, DEFAULT_CONFIG } from '../src/config.js';

const manifest = JSON.parse(
  await readFile(new URL('../gladys-assistant-integration.json', import.meta.url), 'utf8'),
);
const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

// Every list of form fields the manifest declares (same field grammar).
const allFields = [
  ...(manifest.config_schema ?? []),
  ...(manifest.account_schema ?? []),
  ...(manifest.actions ?? []).flatMap((action) => action.fields ?? []),
];

// `type: "calendar"` and `account_schema` are rejected by older cores: the
// store validator refuses a `gladys_version` minimum below 5.2.0.
const CALENDAR_MIN_GLADYS_VERSION = [5, 2, 0];

const valueKeys = (fields) =>
  fields.filter((field) => field.type !== 'section').map((field) => field.key);

function minGladysVersion() {
  const match = manifest.gladys_version.match(/>=\s*(\d+)\.(\d+)\.(\d+)/);
  assert.ok(match, 'gladys_version must declare a minimum version');
  return match.slice(1).map(Number);
}

function isAtLeast(version, required) {
  for (let i = 0; i < required.length; i += 1) {
    if (version[i] !== required[i]) {
      return version[i] > required[i];
    }
  }
  return true;
}

test('a calendar integration requires Gladys >= 5.2.0', () => {
  assert.equal(manifest.type, 'calendar');
  assert.ok(
    isAtLeast(minGladysVersion(), CALENDAR_MIN_GLADYS_VERSION),
    `type "calendar" requires gladys_version >= 5.2.0, got "${manifest.gladys_version}"`,
  );
  assert.ok(manifest.categories.length >= 1 && manifest.categories.length <= 3);
});

test('every manifest action has a registered handler', async () => {
  const gladys = createFakeGladys();
  registerHandlers(gladys);
  for (const action of manifest.actions ?? []) {
    const ack = await gladys.fake.action(action.key, {});
    assert.equal(ack.success, true, `manifest action "${action.key}": ${JSON.stringify(ack)}`);
  }
});

test('config_schema defaults and bounds stay consistent with src/config.js', () => {
  const keys = valueKeys(manifest.config_schema);
  assert.deepEqual(keys.sort(), Object.keys(DEFAULT_CONFIG).sort());
  for (const field of manifest.config_schema.filter((f) => f.type !== 'section')) {
    assert.equal(DEFAULT_CONFIG[field.key], field.default, `default of ${field.key}`);
    assert.equal(CONFIG_BOUNDS[field.key].min, field.min, `min of ${field.key}`);
    assert.equal(CONFIG_BOUNDS[field.key].max, field.max, `max of ${field.key}`);
  }
});

test('account_schema keys are the ones normalizeAccount reads', () => {
  assert.deepEqual(valueKeys(manifest.account_schema), ACCOUNT_KEYS);
  const password = manifest.account_schema.find((field) => field.key === 'password');
  assert.equal(password.type, 'secret', 'the password must never be sent back to the frontend');
});

test('section fields are purely presentational', () => {
  const sections = allFields.filter((f) => f.type === 'section');
  for (const section of sections) {
    assert.equal(section.required, undefined, `section "${section.key}" must not be required`);
    assert.equal(section.default, undefined, `section "${section.key}" must not have a default`);
    assert.equal(section.placeholder, undefined, `section "${section.key}" has a placeholder`);
    for (const text of Object.values(section.description ?? {})) {
      assert.ok(text.length <= 1000, `section "${section.key}" text over 1000 characters`);
    }
  }
});

test('the manifest version matches package.json and tags docker_image', () => {
  assert.equal(manifest.version, pkg.version);
  assert.ok(
    manifest.docker_image.endsWith(`:${manifest.version}`),
    `docker_image must be tagged with ${manifest.version}`,
  );
});

test('the catalog description holds 10 to 100 characters per language', () => {
  for (const [lang, text] of Object.entries(manifest.description)) {
    assert.ok(text.length >= 10 && text.length <= 100, `description.${lang}: ${text.length}`);
  }
  assert.ok(manifest.name.length >= 3 && manifest.name.length <= 30);
});

test('every user-facing text is a bilingual object', () => {
  const texts = [
    manifest.description,
    ...allFields.flatMap((f) => [f.label, f.description, f.placeholder]),
    ...(manifest.actions ?? []).flatMap((a) => [a.label, a.description]),
  ].filter((text) => text !== undefined);
  for (const text of texts) {
    assert.equal(typeof text, 'object', `plain string text: ${JSON.stringify(text)}`);
    assert.ok(text.en && text.fr, `missing translation: ${JSON.stringify(text)}`);
  }
});

test('the user documentation exists in both languages', async () => {
  for (const lang of ['en', 'fr']) {
    const doc = await readFile(new URL(`../docs/${lang}.md`, import.meta.url), 'utf8');
    assert.ok(doc.length >= 300, `docs/${lang}.md must hold at least 300 characters`);
  }
});
