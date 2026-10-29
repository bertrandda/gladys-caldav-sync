import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expandEvents } from '../src/ical.js';
import { PARIS_VTIMEZONE, ics } from './helpers.js';

const window = {
  from: new Date('2026-09-28T12:00:00Z'),
  to: new Date('2027-01-01T12:00:00Z'),
};

test('a timed event with a VTIMEZONE is converted to UTC', () => {
  const [event] = expandEvents(
    [
      ics(
        PARIS_VTIMEZONE,
        `BEGIN:VEVENT
UID:dentist@example.com
DTSTART;TZID=Europe/Paris:20261014T090000
DTEND;TZID=Europe/Paris:20261014T093000
SUMMARY:Dentist
LOCATION:12 rue de la Paix
DESCRIPTION:Bring the X-rays
URL:https://example.com/booking/42
END:VEVENT`,
      ),
    ],
    window,
  );
  assert.deepEqual(event, {
    uid: 'dentist@example.com',
    occurrence: null,
    summary: 'Dentist',
    description: 'Bring the X-rays',
    location: '12 rue de la Paix',
    url: 'https://example.com/booking/42',
    start: '2026-10-14T07:00:00.000Z',
    end: '2026-10-14T07:30:00.000Z',
    allDay: false,
  });
});

test('a TZID without VTIMEZONE is resolved through the IANA database', () => {
  const [summer, winter] = expandEvents(
    [
      ics(`BEGIN:VEVENT
UID:winter
DTSTART;TZID=America/New_York:20261210T090000
DTEND;TZID=America/New_York:20261210T100000
SUMMARY:Winter
END:VEVENT`),
      ics(`BEGIN:VEVENT
UID:summer
DTSTART;TZID=America/New_York:20261001T090000
DURATION:PT1H
SUMMARY:Summer
END:VEVENT`),
    ],
    window,
  ).sort((a, b) => a.uid.localeCompare(b.uid));
  assert.equal(summer.start, '2026-10-01T13:00:00.000Z');
  assert.equal(summer.end, '2026-10-01T14:00:00.000Z');
  assert.equal(winter.start, '2026-12-10T14:00:00.000Z');
});

test('a full-day event keeps its calendar dates, end exclusive', () => {
  const [single, defaultEnd] = expandEvents(
    [
      ics(`BEGIN:VEVENT
UID:holidays
DTSTART;VALUE=DATE:20261019
DTEND;VALUE=DATE:20261102
SUMMARY:Holidays
END:VEVENT
BEGIN:VEVENT
UID:birthday
DTSTART;VALUE=DATE:20261103
SUMMARY:Birthday
END:VEVENT`),
    ],
    window,
  );
  assert.equal(single.allDay, true);
  assert.equal(single.start, '2026-10-19');
  assert.equal(single.end, '2026-11-02');
  assert.equal(defaultEnd.start, '2026-11-03');
  assert.equal(defaultEnd.end, '2026-11-04');
});

test('a recurring event is expanded, with EXDATE and a modified occurrence', () => {
  const events = expandEvents(
    [
      ics(
        PARIS_VTIMEZONE,
        `BEGIN:VEVENT
UID:weekly
DTSTART;TZID=Europe/Paris:20261005T090000
DTEND;TZID=Europe/Paris:20261005T100000
RRULE:FREQ=WEEKLY;COUNT=6
EXDATE;TZID=Europe/Paris:20261012T090000
SUMMARY:Weekly
END:VEVENT
BEGIN:VEVENT
UID:weekly
RECURRENCE-ID;TZID=Europe/Paris:20261019T090000
DTSTART;TZID=Europe/Paris:20261019T140000
DTEND;TZID=Europe/Paris:20261019T150000
SUMMARY:Weekly (moved)
END:VEVENT`,
      ),
    ],
    window,
  );
  assert.deepEqual(
    events.map((e) => [e.occurrence, e.summary, e.start]),
    [
      ['20261005T070000Z', 'Weekly', '2026-10-05T07:00:00.000Z'],
      ['20261019T070000Z', 'Weekly (moved)', '2026-10-19T12:00:00.000Z'],
      // After the switch to winter time: still 09:00 in Paris.
      ['20261026T080000Z', 'Weekly', '2026-10-26T08:00:00.000Z'],
      ['20261102T080000Z', 'Weekly', '2026-11-02T08:00:00.000Z'],
      ['20261109T080000Z', 'Weekly', '2026-11-09T08:00:00.000Z'],
    ],
  );
});

test('an endless recurrence stops at the end of the window', () => {
  const events = expandEvents(
    [
      ics(`BEGIN:VEVENT
UID:daily
DTSTART:20200101T060000Z
DTEND:20200101T061500Z
RRULE:FREQ=DAILY
SUMMARY:Daily
END:VEVENT`),
    ],
    window,
  );
  // 28/09 12:00 → 01/01 12:00: the 28/09 06:00 one ended before the window.
  assert.equal(events[0].start, '2026-09-29T06:00:00.000Z');
  assert.equal(events.at(-1).start, '2027-01-01T06:00:00.000Z');
  assert.equal(events.length, 95);
});

test('a recurring full-day event is expanded by dates', () => {
  const events = expandEvents(
    [
      ics(`BEGIN:VEVENT
UID:bins
DTSTART;VALUE=DATE:20261001
DTEND;VALUE=DATE:20261002
RRULE:FREQ=MONTHLY;BYMONTHDAY=1
SUMMARY:Bins
END:VEVENT`),
    ],
    window,
  );
  assert.deepEqual(
    events.map((e) => [e.occurrence, e.start, e.end]),
    [
      ['20261001', '2026-10-01', '2026-10-02'],
      ['20261101', '2026-11-01', '2026-11-02'],
      ['20261201', '2026-12-01', '2026-12-02'],
      // The window ends on 01/01 at noon UTC: that day overlaps it.
      ['20270101', '2027-01-01', '2027-01-02'],
    ],
  );
});

test('cancelled events, cancelled occurrences and events outside the window are left out', () => {
  const events = expandEvents(
    [
      ics(`BEGIN:VEVENT
UID:cancelled
DTSTART:20261010T100000Z
STATUS:CANCELLED
SUMMARY:Cancelled
END:VEVENT
BEGIN:VEVENT
UID:old
DTSTART:20250110T100000Z
DTEND:20250110T110000Z
SUMMARY:Old
END:VEVENT
BEGIN:VEVENT
UID:series
DTSTART:20261001T100000Z
RRULE:FREQ=DAILY;COUNT=2
SUMMARY:Series
END:VEVENT
BEGIN:VEVENT
UID:series
RECURRENCE-ID:20261002T100000Z
DTSTART:20261002T100000Z
STATUS:CANCELLED
SUMMARY:Series
END:VEVENT
BEGIN:VTODO
UID:todo
DTSTART:20261010T100000Z
SUMMARY:A task
END:VTODO`),
    ],
    window,
  );
  assert.deepEqual(
    events.map((e) => e.uid + '/' + e.occurrence),
    ['series/20261001T100000Z'],
  );
});

test('an unreadable object is reported and the others are kept', () => {
  const errors = [];
  const events = expandEvents(
    [
      'not an iCalendar object',
      ics(`BEGIN:VEVENT
UID:ok
DTSTART:20261010T100000Z
SUMMARY:OK
END:VEVENT`),
    ],
    window,
    { onError: (error) => errors.push(error) },
  );
  assert.equal(errors.length, 1);
  assert.deepEqual(
    events.map((e) => e.uid),
    ['ok'],
  );
});
