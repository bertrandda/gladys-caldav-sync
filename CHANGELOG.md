# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

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
