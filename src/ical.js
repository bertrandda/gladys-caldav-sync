// -----------------------------------------------------------------------------
// iCalendar parsing and recurrence expansion (ical.js).
//
// Gladys stores occurrences, not rules: every recurring event is expanded here
// into its occurrences over the sync window (RRULE, RDATE, EXDATE handled by
// the ical.js iterator, modified occurrences taken from their RECURRENCE-ID
// override).
//
// Output, one entry per occurrence overlapping the window:
//   { uid, occurrence, summary, description, location, url, start, end, allDay }
//   - `occurrence` is null for a non-recurring event, else a compact UTC stamp
//     of its RECURRENCE-ID (`20261005T070000Z`, or `20261005` for a date);
//   - a timed event has ISO UTC `start` / `end`;
//   - a full-day event has `YYYY-MM-DD` dates, `end` EXCLUSIVE (iCalendar
//     DTEND convention), what Gladys expects with `full_day: true`.
// -----------------------------------------------------------------------------

import ICAL from 'ical.js';

// Upper bound of iterations per recurring event: a rule without end that
// starts long before the window must not loop forever.
const MAX_ITERATIONS = 20_000;
const DAY_MS = 24 * 60 * 60 * 1000;

const pad = (n) => String(n).padStart(2, '0');

function dateString(time) {
  return `${time.year}-${pad(time.month)}-${pad(time.day)}`;
}

// Offset (ms) of an IANA zone at a given instant, through Intl.
function zoneOffsetMs(timeZone, instantMs) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(instantMs));
  const get = (type) => Number(parts.find((part) => part.type === type).value);
  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second'),
  );
  return asUtc - instantMs;
}

function isKnownIanaZone(tzid) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tzid });
    return true;
  } catch {
    return false;
  }
}

/**
 * Instant (ms) of a timed ICAL.Time. A TZID without matching VTIMEZONE (RFC
 * 7809 lets servers omit the standard ones) leaves ical.js with a floating
 * time: resolve it through the IANA database instead. A truly floating time is
 * read in the container timezone (UTC in the Docker image).
 */
function toInstantMs(time, tzid) {
  const floating = !time.zone || time.zone.tzid === 'floating';
  if (floating && tzid && isKnownIanaZone(tzid)) {
    const wallAsUtc = Date.UTC(
      time.year,
      time.month - 1,
      time.day,
      time.hour,
      time.minute,
      time.second,
    );
    // Two passes settle the offset across a DST change.
    let instant = wallAsUtc - zoneOffsetMs(tzid, wallAsUtc);
    instant = wallAsUtc - zoneOffsetMs(tzid, instant);
    return instant;
  }
  return time.toJSDate().getTime();
}

function compactStamp(time, tzid) {
  if (time.isDate) {
    return `${time.year}${pad(time.month)}${pad(time.day)}`;
  }
  return new Date(toInstantMs(time, tzid)).toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
}

function tzidOf(component, propertyName) {
  return component.getFirstProperty(propertyName)?.getParameter('tzid') ?? null;
}

function textProperty(component, name) {
  const value = component.getFirstPropertyValue(name);
  return typeof value === 'string' ? value : value ? String(value) : '';
}

function addDays(date, days) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d) + days * DAY_MS).toISOString().slice(0, 10);
}

/**
 * Build one occurrence from its component (the master, or the override of a
 * modified occurrence) and its effective start / end.
 */
function buildOccurrence(component, startTime, endTime, occurrence) {
  const startTzid = tzidOf(component, 'dtstart');
  const endTzid = tzidOf(component, 'dtend') ?? startTzid;
  const base = {
    uid: textProperty(component, 'uid'),
    occurrence,
    summary: textProperty(component, 'summary'),
    description: textProperty(component, 'description'),
    location: textProperty(component, 'location'),
    url: textProperty(component, 'url'),
  };
  if (startTime.isDate) {
    const start = dateString(startTime);
    let end = endTime ? dateString(endTime) : addDays(start, 1);
    if (end <= start) {
      end = addDays(start, 1);
    }
    return { ...base, start, end, allDay: true };
  }
  const startMs = toInstantMs(startTime, startTzid);
  let endMs = endTime ? toInstantMs(endTime, endTzid) : startMs;
  if (endMs < startMs) {
    endMs = startMs;
  }
  return {
    ...base,
    start: new Date(startMs).toISOString(),
    end: new Date(endMs).toISOString(),
    allDay: false,
  };
}

/**
 * Whether an occurrence overlaps the window, by the rule of the Gladys core
 * (`start < to` and either `end > from` or `start >= from`). Full-day dates
 * are read as UTC midnights; the window bounds sit at UTC noon (see
 * src/sync.js), which gives the same answer whatever the instance timezone.
 */
export function overlapsWindow(event, window) {
  const from = window.from.getTime();
  const to = window.to.getTime();
  const start = Date.parse(event.start);
  const end = Date.parse(event.end);
  return start < to && (end > from || start >= from);
}

function isCancelled(component) {
  return textProperty(component, 'status').toUpperCase() === 'CANCELLED';
}

/**
 * Expand the VEVENTs of a set of iCalendar texts into the occurrences
 * overlapping the window.
 * @param {string[]} icsTexts calendar objects fetched from the server
 * @param {{ from: Date, to: Date }} window
 * @param {{ onError?: (error: Error) => void }} [options] called for every
 *   object that cannot be parsed (the others are still returned)
 * @returns {Array<object>} occurrences, see the header of this file
 */
export function expandEvents(icsTexts, window, { onError } = {}) {
  // Group the VEVENTs by UID across objects: a modified occurrence normally
  // sits in the same object as its master, but nothing forbids splitting them.
  const byUid = new Map();
  for (const text of icsTexts) {
    try {
      const calendar = new ICAL.Component(ICAL.parse(text));
      for (const vtimezone of calendar.getAllSubcomponents('vtimezone')) {
        ICAL.TimezoneService.register(vtimezone);
      }
      for (const vevent of calendar.getAllSubcomponents('vevent')) {
        const uid = textProperty(vevent, 'uid');
        if (uid === '' || !vevent.hasProperty('dtstart')) {
          continue;
        }
        if (!byUid.has(uid)) {
          byUid.set(uid, { master: null, exceptions: [] });
        }
        const entry = byUid.get(uid);
        if (vevent.hasProperty('recurrence-id')) {
          entry.exceptions.push(vevent);
        } else {
          entry.master = vevent;
        }
      }
    } catch (error) {
      onError?.(error);
    }
  }

  const occurrences = [];
  const keep = (occurrence) => {
    if (overlapsWindow(occurrence, window)) {
      occurrences.push(occurrence);
    }
  };

  for (const { master, exceptions } of byUid.values()) {
    try {
      if (!master) {
        // Orphan overrides (the master was not returned by the time-range
        // query): each one stands as a single occurrence.
        for (const exception of exceptions) {
          if (isCancelled(exception)) continue;
          const event = new ICAL.Event(exception);
          const recurrenceId = exception.getFirstPropertyValue('recurrence-id');
          keep(
            buildOccurrence(
              exception,
              event.startDate,
              event.endDate,
              compactStamp(recurrenceId, tzidOf(exception, 'recurrence-id')),
            ),
          );
        }
        continue;
      }

      const event = new ICAL.Event(master);
      for (const exception of exceptions) {
        event.relateException(exception);
      }

      if (!event.isRecurring()) {
        if (!isCancelled(master)) {
          keep(buildOccurrence(master, event.startDate, event.endDate, null));
        }
        continue;
      }

      const masterTzid = tzidOf(master, 'dtstart');
      const iterator = event.iterator();
      const toMs = window.to.getTime();
      for (let i = 0, next = iterator.next(); next && i < MAX_ITERATIONS; i += 1) {
        const details = event.getOccurrenceDetails(next);
        const component = details.item.component;
        const occurrenceStartMs = details.startDate.isDate
          ? Date.parse(dateString(details.startDate))
          : toInstantMs(details.startDate, tzidOf(component, 'dtstart'));
        // Overrides may move an occurrence later than its slot: stop only
        // once the regular slots are past the window.
        const slotMs = next.isDate ? Date.parse(dateString(next)) : toInstantMs(next, masterTzid);
        if (slotMs >= toMs && occurrenceStartMs >= toMs) {
          break;
        }
        if (!isCancelled(component)) {
          keep(
            buildOccurrence(
              component,
              details.startDate,
              details.endDate,
              compactStamp(details.recurrenceId, masterTzid),
            ),
          );
        }
        next = iterator.next();
      }
    } catch (error) {
      onError?.(error);
    }
  }

  occurrences.sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  return occurrences;
}
