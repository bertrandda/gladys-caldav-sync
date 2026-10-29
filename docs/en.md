# CalDAV

This integration copies your **CalDAV** calendars (Nextcloud, iCloud,
Fastmail, Baïkal, Radicale, SOGo, Synology Calendar…) into the Gladys
calendar. The events show up in the calendar view, can trigger scenes ("an
event is coming") and are known by the assistant.

The sync is **one way**: Gladys reads your CalDAV server and never writes to
it. An event created or edited in Gladys on a synced calendar is not sent back
to the server.

## Enable the integration for your account

Every Gladys user enables the integration **for themselves**: your calendars
are personal data, nothing is synced until you enable it.

1. Open the **CalDAV** integration, **Configuration** tab.
2. In the **My calendars** block, fill in:
   - the **CalDAV server URL** (see the table below);
   - your **username**;
   - your **password** — use an **app password** when your provider offers
     one.
3. Click **Enable**. Your calendars show up a few seconds later.

| Provider  | Server URL                                      | Notes                                        |
| --------- | ----------------------------------------------- | -------------------------------------------- |
| Nextcloud | `https://cloud.example.com/remote.php/dav`      | App password: Settings → Security            |
| iCloud    | `https://caldav.icloud.com`                     | Apple ID + app-specific password (mandatory) |
| Fastmail  | `https://caldav.fastmail.com`                   | App password with CalDAV access              |
| Baïkal    | `https://dav.example.com/dav.php`               |                                              |
| Radicale  | `https://dav.example.com` (or `http://ip:5232`) |                                              |
| SOGo      | `https://mail.example.com/SOGo/dav`             |                                              |
| Synology  | `https://nas.example.com:5001/caldav`           |                                              |

The integration discovers your calendars from that URL (principal and
calendar home): no need to enter the address of each calendar. Task lists are
ignored.

## Choose what to sync and share

Every synced calendar shows up in Gladys with two toggles:

- **Sync** — switch it off to skip a calendar: its events are removed from
  Gladys. Switched back on, it is refilled by the next sync.
- **Share** — a calendar starts **private**. Shared, it becomes visible to the
  whole household, and usable by the scenes.

The name, description and color of a calendar follow the server's.

## Settings (administrator)

These settings apply to every user:

- **Sync interval** — every 15 minutes by default (from 5 minutes to 24
  hours).
- **Days of history** — past events older than 30 days (by default) are not
  synced.
- **Days ahead** — 365 days by default (up to 730): recurring events are
  expanded up to that horizon.

The **Sync now** button reads every account right away and shows how many
calendars and events were synced.

## Good to know

- An event deleted on the server disappears from Gladys at the next sync; a
  calendar deleted on the server is deleted from Gladys with its events.
- Recurring events (exceptions and moved occurrences included) are expanded
  into individual occurrences.
- Cancelled events (`STATUS:CANCELLED`) are not imported.
- A "floating" time event (without time zone) is read as UTC.
- Gladys limits: 50 calendars per user, 10,000 events per calendar; texts too
  long are truncated.
- Disabling the integration for your account deletes your synced calendars
  from Gladys (they stay untouched on the server).

## Troubleshooting

The Configuration screen shows how many accounts fail. The most common
causes:

- **Wrong URL** — check the URL in a CalDAV client (Thunderbird, DAVx⁵); try
  the root URL of the server, the `/.well-known/caldav` discovery is
  automatic.
- **Credentials refused** — with two-factor authentication enabled, an app
  password is required.
- **Self-signed certificate** — the server must present a valid HTTPS
  certificate (or be reached over HTTP on the local network).

The administrator finds the details of the errors in the integration logs
(the integration page, supervision tab). Passwords never show up there.
