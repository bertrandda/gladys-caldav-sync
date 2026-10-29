// -----------------------------------------------------------------------------
// Mapping between the CalDAV world and the Gladys calendar contract.
//
// External ids are forever: Gladys keys the calendars and their events on
// them, so changing how one is built duplicates every event of every user.
//   calendar: ext:<selector>:<user>:cal-<sha256(calendar URL)[0..24]>
//   event:    ext:<selector>:<user>:evt-<sha256(UID)[0..24]>[:<occurrence>]
// Hashes keep the ids short (≤ 255 characters) whatever the server puts in its
// URLs and UIDs. The event id does not depend on its calendar: an event moved
// to another calendar of the same user is moved in Gladys, not duplicated.
// -----------------------------------------------------------------------------

import { createHash } from 'node:crypto';

// Bounds of the Gladys calendar contract (see the SDK README).
export const LIMITS = {
  calendarsPerUser: 50,
  eventsPerRequest: 500,
  eventsPerCalendar: 10_000,
  calendarName: 100,
  calendarDescription: 500,
  eventName: 200,
  eventLocation: 500,
  eventDescription: 1000,
  eventUrl: 500,
};

const NO_TITLE = { en: '(No title)', fr: '(Sans titre)' };
const UNNAMED_CALENDAR = { en: 'Calendar', fr: 'Calendrier' };

const shortHash = (value) => createHash('sha256').update(value).digest('hex').slice(0, 24);

function translate(texts, language) {
  return typeof language === 'string' && language.toLowerCase().startsWith('fr')
    ? texts.fr
    : texts.en;
}

function truncate(value, max) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, max - 1)}…`;
}

export function calendarExternalId(gladys, userSelector, calendarUrl) {
  return gladys.externalId(`${userSelector}:cal-${shortHash(calendarUrl)}`);
}

export function eventExternalId(gladys, userSelector, uid, occurrence) {
  const base = `${userSelector}:evt-${shortHash(uid)}`;
  return gladys.externalId(occurrence ? `${base}:${occurrence}` : base);
}

/**
 * `#rrggbb` from a CalDAV calendar color (Apple's `calendar-color` property is
 * often `#RRGGBBAA`), or null when there is none or it is invalid.
 */
export function normalizeColor(color) {
  if (typeof color !== 'string') {
    return null;
  }
  const match = color.trim().match(/^#([0-9a-f]{6})([0-9a-f]{2})?$/i);
  return match ? `#${match[1].toLowerCase()}` : null;
}

// Last segment of a collection URL, a readable name of last resort.
function nameFromUrl(url) {
  try {
    const segments = new URL(url).pathname.split('/').filter(Boolean);
    return decodeURIComponent(segments.at(-1) ?? '');
  } catch {
    return '';
  }
}

/**
 * CalendarInput of publishCalendars for a calendar of listCalendars().
 */
export function toCalendarInput(gladys, user, calendar) {
  const name =
    truncate(calendar.name, LIMITS.calendarName) ||
    truncate(nameFromUrl(calendar.url), LIMITS.calendarName) ||
    translate(UNNAMED_CALENDAR, user.language);
  const input = {
    external_id: calendarExternalId(gladys, user.selector, calendar.url),
    name,
  };
  const description = truncate(calendar.description, LIMITS.calendarDescription);
  if (description) {
    input.description = description;
  }
  const color = normalizeColor(calendar.color);
  if (color) {
    input.color = color;
  }
  return input;
}

function httpUrl(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text.length === 0 || text.length > LIMITS.eventUrl || !/^https?:\/\//i.test(text)) {
    return null;
  }
  return text;
}

/**
 * CalendarEventInput of publishCalendarEvents for an occurrence of
 * expandEvents() (src/ical.js).
 */
export function toEventInput(gladys, user, occurrence) {
  const input = {
    external_id: eventExternalId(gladys, user.selector, occurrence.uid, occurrence.occurrence),
    name: truncate(occurrence.summary, LIMITS.eventName) || translate(NO_TITLE, user.language),
    start: occurrence.start,
    end: occurrence.end,
  };
  if (occurrence.allDay) {
    input.full_day = true;
  }
  const location = truncate(occurrence.location, LIMITS.eventLocation);
  if (location) {
    input.location = location;
  }
  const description = truncate(occurrence.description, LIMITS.eventDescription);
  if (description) {
    input.description = description;
  }
  const url = httpUrl(occurrence.url);
  if (url) {
    input.url = url;
  }
  return input;
}
