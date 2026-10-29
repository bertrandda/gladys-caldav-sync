# CLAUDE.md

Project rules for coding assistants (Claude Code reads this file) and for human
contributors.

## What this is

A Gladys Assistant **external integration** of type `calendar`: a Node.js
service (Node 22+, ESM, no build step) that runs in its own sandboxed Docker
container, reads the CalDAV calendars of the Gladys users who enabled it and
pushes their calendars and events to Gladys through
[`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js).
One-way: nothing is ever written to the CalDAV servers. It follows the
structure of the official JavaScript template.

## Commands

```bash
npm install
npm test                                  # node --test, the built-in runner
node --test test/sync.test.js             # one file
node --test --test-name-pattern "window"  # tests whose name matches
npm run lint                              # ESLint
npm run format:check                      # Prettier, as the CI runs it
npm run format                            # Prettier, fix in place
npx github:GladysAssistant/integration-store .   # store admission checks
```

The CI (`.github/workflows/ci.yml`) runs `format:check`, `lint` and `test` on
Node 22 and 24, and builds the Docker image: run the three commands before
pushing.

## Architecture

```
index.js            SDK bootstrap only
src/app.js          SDK wiring: handlers registered before connect()
src/scheduler.js    SyncManager (per-user loops, global queue, status) + WriteLimiter
src/sync.js         one pass of one account (calendars, deletions, windows, ctag cache)
src/caldav.js       the only module talking CalDAV (tsdav)
src/ical.js         iCalendar parsing + recurrence expansion (ical.js)
src/mapping.js      external ids + CalDAV → Gladys inputs + contract bounds
src/config.js       DEFAULT_CONFIG / CONFIG_BOUNDS (mirror the manifest) + normalization
test/               node --test, fake Gladys (integration-sdk/testing) + test/helpers.js
```

## Rules

- **External ids are forever.** Calendar and event ids are built in
  `src/mapping.js` from hashes of the calendar URL and the event UID. Changing
  the formula duplicates every event of every user: never do it.
- **Calendar contract.** Ids are user-scoped (`gladys.externalId(`${user}:…`)`);
  ≤ 50 calendars per user, ≤ 500 events per request (split the window),
  ≤ 10 000 per calendar; 30 calendar writes per minute per integration — every
  write goes through `write()` / `WriteLimiter`. Skip `sync: false` calendars
  (403 otherwise). Window bounds stay at 12:00 UTC (see `syncWindow`).
- **Personal data.** Calendars belong to the user who enabled the
  integration. Never log a password, never put account values in the
  connection status message.
- **The container rootfs is read-only.** Write only under `/data` (the
  integration currently keeps its state in memory).
- **Versions belong to the Release workflow** (Actions → Release). Never edit
  `version` in `package.json` or in the manifest, nor the `docker_image` tag,
  by hand. `test/manifest.test.js` checks they agree.
- **Changelog.** Every user-visible change adds a line under `## [Unreleased]`
  in `CHANGELOG.md`. Never write a version heading.
- **Manifest.** Texts are `{ "en": ..., "fr": ... }` objects. A calendar
  integration (`type`, `account_schema`) requires `gladys_version >= 5.2.0`.
  `test/manifest.test.js` ties the manifest to the code (defaults, bounds,
  account keys, action handlers): change both sides together.
- **User-facing text** is bilingual (English and French): action messages,
  status messages, manifest texts, and `docs/en.md` / `docs/fr.md`, kept in
  sync.
- **Style.** Prettier formats, ESLint catches mistakes. Comments explain why,
  in English. Tests never touch the network.
