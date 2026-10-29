// -----------------------------------------------------------------------------
// One synchronization pass of one user's CalDAV account into Gladys.
//
//   1. list the calendars of the server, publish them (publishCalendars);
//   2. delete the Gladys calendars that disappeared from the server;
//   3. for every calendar the user did not switch off (`sync: false`), fetch
//      the objects of the window, expand the recurrences and publish the
//      occurrences WITH the window: Gladys prunes the events of the window
//      absent from the list, which is how a deletion on the server propagates.
//
// Writes go through `write(fn)` (see src/scheduler.js), which keeps the
// integration under the host API quota (30 calendar writes per minute).
// Nothing is written when nothing changed: the calendar list and each
// calendar's ctag are remembered in `cache` between two passes.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { expandEvents, overlapsWindow } from './ical.js';
import { LIMITS, calendarExternalId, toCalendarInput, toEventInput } from './mapping.js';

const logger = createLogger({ name: 'sync' });

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Sync window: from `past_days` before to `future_days` after today. Both
 * bounds sit at 12:00 UTC: a full-day event is stored at the midnights of the
 * Gladys instance timezone, and a noon boundary gives the same overlap answer
 * for every offset between -12h and +12h.
 * @param {Date} now
 * @param {{ past_days: number, future_days: number }} config
 */
export function syncWindow(now, config) {
  const todayNoon = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 12);
  return {
    from: new Date(todayNoon - config.past_days * DAY_MS),
    to: new Date(todayNoon + config.future_days * DAY_MS),
  };
}

/**
 * Split a window into disjoint sub-windows holding at most `max` events each
 * (one request per sub-window). Halves on whole days, so every boundary stays
 * at noon UTC; an event straddling a boundary is part of both halves.
 * @returns {Array<{ window, events }>}
 */
export function splitWindow(window, events, max = LIMITS.eventsPerRequest) {
  if (events.length <= max) {
    return [{ window, events }];
  }
  const days = Math.round((window.to - window.from) / DAY_MS);
  if (days < 2) {
    logger.warn(`More than ${max} events in one day, keeping the first ${max}`);
    return [{ window, events: events.slice(0, max) }];
  }
  const middle = new Date(window.from.getTime() + Math.floor(days / 2) * DAY_MS);
  const halves = [
    { from: window.from, to: middle },
    { from: middle, to: window.to },
  ];
  return halves.flatMap((half) =>
    splitWindow(
      half,
      events.filter((event) => overlapsWindow(event, half)),
      max,
    ),
  );
}

function uniqueByExternalId(events) {
  const seen = new Set();
  return events.filter((event) => {
    if (seen.has(event.external_id)) {
      return false;
    }
    seen.add(event.external_id);
    return true;
  });
}

/**
 * Sync one account.
 * @param {import('@gladysassistant/integration-sdk').GladysIntegration} gladys
 * @param {{ user: { selector: string, language?: string } }} account
 * @param {object} deps
 * @param {{ listCalendars: Function, fetchObjects: Function }} deps.client
 *   connected CalDAV client (src/caldav.js)
 * @param {{ past_days: number, future_days: number }} deps.config
 * @param {Date} deps.now
 * @param {{ calendars?: string, ctags: Map<string, { key: string, events: number }> }} deps.cache
 *   per-user memory of the previous pass, mutated in place
 * @param {(fn: () => Promise<unknown>) => Promise<unknown>} deps.write
 * @returns {Promise<{ calendars: number, events: number, skipped: number, errors: string[] }>}
 */
export async function syncAccount(gladys, account, { client, config, now, cache, write }) {
  const { user } = account;
  const summary = { calendars: 0, events: 0, skipped: 0, errors: [] };

  // 1) Calendars of the server.
  let remoteCalendars = await client.listCalendars();
  if (remoteCalendars.length > LIMITS.calendarsPerUser) {
    logger.warn(
      `${user.selector}: ${remoteCalendars.length} calendars on the server, syncing the first ${LIMITS.calendarsPerUser}`,
    );
    remoteCalendars = [...remoteCalendars]
      .sort((a, b) => a.url.localeCompare(b.url))
      .slice(0, LIMITS.calendarsPerUser);
  }
  const inputs = remoteCalendars.map((calendar) => toCalendarInput(gladys, user, calendar));
  summary.calendars = inputs.length;

  const signature = JSON.stringify(inputs);
  if (inputs.length > 0 && cache.calendars !== signature) {
    await write(() => gladys.publishCalendars(user.selector, inputs));
    cache.calendars = signature;
  }

  // 2) Calendars known by Gladys: the ones gone from the server are deleted,
  // the ones the user switched off are skipped (a push would be a 403).
  const published = await gladys.getCalendars(user.selector);
  const remoteIds = new Set(inputs.map((input) => input.external_id));
  for (const calendar of published) {
    if (!remoteIds.has(calendar.external_id)) {
      logger.info(`${user.selector}: calendar "${calendar.name}" removed from the server`);
      await write(() => gladys.deleteCalendar(calendar.external_id));
      cache.ctags.delete(calendar.external_id);
    }
  }
  const disabled = new Set(published.filter((c) => c.sync === false).map((c) => c.external_id));

  // 3) Events, calendar by calendar: one failing calendar does not stop the
  // others.
  const window = syncWindow(now, config);
  const windowKey = `${window.from.toISOString()}/${window.to.toISOString()}`;
  for (const calendar of remoteCalendars) {
    const externalId = calendarExternalId(gladys, user.selector, calendar.url);
    if (disabled.has(externalId)) {
      cache.ctags.delete(externalId);
      summary.skipped += 1;
      continue;
    }
    // Same ctag and same window as the last pass: nothing changed.
    const cacheKey = calendar.ctag ? `${calendar.ctag}|${windowKey}` : null;
    const cached = cache.ctags.get(externalId);
    if (cacheKey && cached?.key === cacheKey) {
      summary.events += cached.events;
      continue;
    }
    try {
      const icsTexts = await client.fetchObjects(calendar, window);
      const occurrences = expandEvents(icsTexts, window, {
        onError: (error) =>
          logger.warn(
            `${user.selector}: unreadable object in "${calendar.name}": ${error.message}`,
          ),
      });
      let events = uniqueByExternalId(
        occurrences.map((occurrence) => toEventInput(gladys, user, occurrence)),
      );
      if (events.length > LIMITS.eventsPerCalendar) {
        logger.warn(
          `${user.selector}: ${events.length} events in "${calendar.name}", keeping the first ${LIMITS.eventsPerCalendar}`,
        );
        events = events.slice(0, LIMITS.eventsPerCalendar);
      }
      for (const batch of splitWindow(window, events)) {
        await write(() => gladys.publishCalendarEvents(externalId, batch.events, batch.window));
      }
      summary.events += events.length;
      if (cacheKey) {
        cache.ctags.set(externalId, { key: cacheKey, events: events.length });
      }
    } catch (error) {
      cache.ctags.delete(externalId);
      logger.error(`${user.selector}: sync of calendar "${calendar.name}" failed`, error);
      summary.errors.push(`${calendar.name || calendar.url}: ${error.message}`);
    }
  }
  return summary;
}
