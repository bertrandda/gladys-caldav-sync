# Gladys CalDAV

External integration for [Gladys Assistant](https://gladysassistant.com) that
syncs **CalDAV calendars** (Nextcloud, iCloud, Fastmail, Baïkal, Radicale,
SOGo, Synology…) into the Gladys calendar, built with the JavaScript SDK
[`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js)
and the structure of the official
[JavaScript template](https://github.com/GladysAssistant/integration-template-js).

It is a **calendar provider** (manifest `type: "calendar"`, Gladys ≥ 5.2.0):
_the integration syncs, the core stores_. Every Gladys user enables it for
themselves in the "My calendars" block of the Configuration screen, with their
own server and credentials; their calendars and events then feed the calendar
view, the `calendar.event-is-coming` scene trigger and the assistant, like the
built-in CalDAV calendars. The sync is one-way: Gladys never writes to the
CalDAV server.

User documentation: [English](docs/en.md) · [Français](docs/fr.md).

## How it works

```
every enabled user, every `sync_interval` minutes, one at a time:
  CalDAV server ──tsdav──▶ calendars + iCalendar objects of the window
                 ──ical.js──▶ occurrences (recurrences expanded, time zones resolved)
                 ──SDK──▶ publishCalendars / publishCalendarEvents(window) / deleteCalendar
```

- **Discovery** — `tsdav` resolves the principal and calendar home from the
  URL the user typed (`/.well-known/caldav` included) and lists the
  event-capable calendars (task lists are skipped).
- **Window** — from `past_days` before to `future_days` after today. Events are
  published **with the window**: Gladys prunes the events of the window absent
  from the list, which is how a deletion on the server propagates. More than
  500 events are split into disjoint sub-windows (one request each). The
  window bounds sit at 12:00 UTC so that full-day events, stored by Gladys at
  the midnights of the instance timezone, overlap the same windows whatever
  that timezone.
- **Recurrences** are expanded client-side with `ical.js` (RRULE, RDATE,
  EXDATE, RECURRENCE-ID overrides, cancelled occurrences), up to the end of
  the window. A `TZID` without `VTIMEZONE` is resolved through the IANA
  database.
- **External ids are forever** — `ext:<selector>:<user>:cal-<sha256(url)>` for a
  calendar, `ext:<selector>:<user>:evt-<sha256(uid)>[:<occurrence>]` for an
  event: user-scoped, short, and independent of the calendar (an event moved
  between calendars is moved in Gladys, not duplicated).
- **No useless writes** — a calendar whose `ctag` / `sync-token` and window did
  not change since the previous pass is not re-published, nor is an unchanged
  calendar list. Every write goes through a sliding-window limiter (25/min,
  the host API accepting 30 calendar writes per minute per integration), with
  one retry on a `429`.
- **User-owned toggles** — a calendar the user switched off (`sync: false`) is
  skipped; a calendar removed from the server is deleted from Gladys. The
  account events (`onCalendarAccountUpdated`) are lost while disconnected, so
  the accounts are re-read on every connection.
- **Status** — the Configuration screen shows how many accounts fail to sync;
  the details (never a password) go to the logs.

## Project structure

```
.
├─ index.js                          # SDK bootstrap: new GladysIntegration() + registerHandlers()
├─ src/
│  ├─ app.js                         # SDK wiring (connected, account updates, config, sync_now action)
│  ├─ scheduler.js                   # SyncManager (one loop per user, one queue) + WriteLimiter
│  ├─ sync.js                        # one pass of one account: calendars, deletions, events, windows
│  ├─ caldav.js                      # CalDAV client (tsdav): discovery, calendars, time-range query
│  ├─ ical.js                        # iCalendar parsing + recurrence expansion (ical.js)
│  ├─ mapping.js                     # external ids, CalDAV → Gladys inputs, contract bounds
│  └─ config.js                      # config defaults + normalization, account normalization
├─ docs/en.md, docs/fr.md            # user documentation (re-hosted by Gladys)
├─ test/                             # node --test, fake Gladys of the SDK + in-memory CalDAV
├─ gladys-assistant-integration.json # manifest
├─ Dockerfile                        # Node 24 Alpine, read-only rootfs ready
├─ CHANGELOG.md                      # Keep a Changelog, rolled by the Release workflow
├─ .github/workflows/                # CI (format, lint, tests, Docker build) + release
└─ caldav.jpg                        # catalog cover, 800×534 px
```

Runtime dependencies: the SDK, [`tsdav`](https://github.com/natelindev/tsdav)
(CalDAV) and [`ical.js`](https://github.com/kewisch/ical.js) (iCalendar).

## Configuration

Integration-wide settings (`config_schema`, administrators):

| Key             | Default | Range  | Meaning                                    |
| --------------- | ------- | ------ | ------------------------------------------ |
| `sync_interval` | 15      | 5–1440 | minutes between two passes of each account |
| `past_days`     | 30      | 0–365  | days of history synced                     |
| `future_days`   | 365     | 7–730  | days ahead synced (recurrence horizon)     |

Per-user account (`account_schema`, "My calendars" block): `server_url`,
`username`, `password` (secret). The **Sync now** action (`sync_now`) re-reads
every account and answers a summary.

## Run it locally

```bash
npm install
GLADYS_HOST_API_URL="http://localhost:1443" \
GLADYS_INTEGRATION_TOKEN="<token>" \
GLADYS_INTEGRATION_SELECTOR="caldav" \
LOG_LEVEL=debug \
npm start
```

The three `GLADYS_*` variables are injected by the Gladys supervisor when the
integration runs inside its sandboxed container. The SDK reads them
automatically.

## Quality checks

```bash
npm run format:check   # Prettier
npm run lint           # ESLint
npm test               # node --test (no network: fake Gladys + in-memory CalDAV)
npx github:GladysAssistant/integration-store .   # store admission checks
```

The CI runs the first three on Node 22 and 24 and builds the Docker image.

## Publish

1. Add the GitHub topic `gladys-assistant-integration` to the repository.
2. Describe your changes under `## [Unreleased]` in
   [`CHANGELOG.md`](CHANGELOG.md), then run **Actions → Release → Run
   workflow** (`patch`, `minor` or `major`): it bumps `package.json` and the
   manifest `version` / `docker_image`, rolls the changelog, tags, builds the
   `linux/amd64` + `linux/arm64` image to `ghcr.io/bertrandda/gladys-caldav-sync`
   and publishes the GitHub Release.
3. The store indexer picks up the new manifest `version`; Gladys offers a
   one-click install / update.

The manifest `cover_image` and the documentation are read from the `master`
branch.

## License

Apache-2.0
