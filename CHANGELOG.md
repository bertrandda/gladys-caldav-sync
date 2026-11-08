# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Added

- Webcal subscriptions: the calendars the CalDAV account is subscribed to by
  URL (Nextcloud, iCloud, SOGo…) are synced like the other calendars. The
  integration reads each feed at its address, without the CalDAV credentials,
  and writes it to Gladys only when its content changed.

## [1.0.1] - 2026-11-05

### Added

- "Provider" list in the account form: Google, iCloud, Fastmail and
  Infomaniak no longer need a server URL. A typed URL is still used first,
  so existing accounts are unchanged.
- "Detailed logs" setting: debug logs of every step of the sync and of the
  CalDAV requests, to diagnose a calendar that fails.
- More context in the logs: URL of a failing calendar, skipped calendars,
  objects the server could not return.

### Fixed

- A calendar no longer fails entirely ("Collection query failed: 404 Not
  Found", seen on Google) when the server lists an object it then cannot
  return: the calendar is read again with a single query and only the
  unreadable objects are skipped.

## [1.0.0] - 2026-10-29

### Added

- One-way sync of CalDAV calendars into the Gladys calendar (Gladys 5.2.0 or
  later): every user enables the integration with their own server and
  credentials in the "My calendars" block.
- Recurring events expanded over the sync window (RRULE, EXDATE, modified
  occurrences), time zones and full-day events handled.
- Events deleted on the server, and calendars removed from it, are deleted
  from Gladys.
- Settings: sync interval, days of history and days ahead.
- "Sync now" action in the Configuration screen.
- Connection status reporting the accounts that fail to sync.

[Unreleased]: https://github.com/bertrandda/gladys-caldav-sync/compare/v1.0.1...HEAD
[1.0.1]: https://github.com/bertrandda/gladys-caldav-sync/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/bertrandda/gladys-caldav-sync/releases/tag/v1.0.0
