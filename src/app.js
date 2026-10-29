// -----------------------------------------------------------------------------
// SDK wiring of the CalDAV calendar integration (manifest `type: "calendar"`).
//
// "The integration syncs, the core stores": every Gladys user who enabled the
// integration in the "My calendars" block gets their CalDAV calendars and
// events mirrored into the Gladys calendar, one-way (Gladys never writes back
// to the server).
//
// Kept apart from index.js so the tests can run it against the fake Gladys of
// the SDK, with an in-memory CalDAV server in place of `createClient`.
// -----------------------------------------------------------------------------

import { logger } from '@gladysassistant/integration-sdk';
import { createCalDavClient } from './caldav.js';
import { normalizeConfig } from './config.js';
import { SyncManager } from './scheduler.js';

/**
 * Message displayed under the "Sync now" button.
 * @param {Map<string, object>} results
 */
export function syncNowMessage(results) {
  const all = [...results.values()];
  if (all.length === 0) {
    return {
      en: 'No user has enabled the integration yet: enable it in the "My calendars" block.',
      fr: "Aucun utilisateur n'a encore activé l'intégration : activez-la dans le bloc « Mes calendriers ».",
    };
  }
  const calendars = all.reduce((sum, result) => sum + result.calendars, 0);
  const events = all.reduce((sum, result) => sum + result.events, 0);
  const failed = all.filter((result) => !result.ok).length;
  const en = `${all.length} account(s) synced: ${calendars} calendar(s), ${events} event(s).`;
  const fr = `${all.length} compte(s) synchronisé(s) : ${calendars} calendrier(s), ${events} événement(s).`;
  if (failed === 0) {
    return { en, fr };
  }
  return {
    en: `${en} ${failed} account(s) in error, see the integration logs.`,
    fr: `${fr} ${failed} compte(s) en erreur, consultez les logs de l'intégration.`,
  };
}

/**
 * Register every handler on the SDK client. Call it BEFORE connect().
 * @param {import('@gladysassistant/integration-sdk').GladysIntegration} gladys
 * @param {object} [deps] injectable dependencies (tests)
 * @returns {{ manager: SyncManager }}
 */
export function registerHandlers(gladys, deps = {}) {
  let config = normalizeConfig();
  const manager = new SyncManager(gladys, {
    createClient: deps.createClient ?? createCalDavClient,
    getConfig: () => config,
    now: deps.now,
    setTimer: deps.setTimer,
    clearTimer: deps.clearTimer,
    limiter: deps.limiter,
  });

  // --- Connection: re-read everything ----------------------------------------
  // The account events are lost while disconnected: the enabled users and
  // their values are read again on every (re)connection.
  gladys.on('connected', async () => {
    try {
      config = normalizeConfig(await gladys.getConfig());
      await manager.reload(await gladys.getCalendarAccounts());
    } catch (err) {
      logger.error('Post-connection initialization failed', err);
      await gladys
        .setConnectionStatus(false, {
          en: 'Initialization failed, check the integration logs.',
          fr: "L'initialisation a échoué, consultez les logs de l'intégration.",
        })
        .catch(() => {});
    }
  });

  gladys.on('disconnected', () => {
    manager.stop();
  });

  // --- A user enabled, disabled or edited their account ------------------------
  // Also fired when they toggle the `sync` / `shared` flag of a calendar: the
  // user is re-synced from scratch (a calendar switched back on is refilled).
  gladys.onCalendarAccountUpdated(async (userSelector) => {
    logger.info(`onCalendarAccountUpdated <- ${userSelector}`);
    const accounts = await gladys.getCalendarAccounts();
    const account = accounts.find((candidate) => candidate.user.selector === userSelector);
    await manager.update(userSelector, account);
  });

  // --- Integration settings updated by the admin ------------------------------
  gladys.onConfigUpdated(async (newConfig) => {
    logger.info('onConfigUpdated -> new configuration received');
    const previous = config;
    config = normalizeConfig(newConfig);
    if (previous.past_days !== config.past_days || previous.future_days !== config.future_days) {
      // A new window changes what each calendar holds: re-sync everyone now.
      await manager.reload([...manager.accounts.values()]);
    } else {
      manager.reschedule();
    }
  });

  // --- Manifest action: the "Sync now" button ---------------------------------
  gladys.onAction('sync_now', async () => {
    logger.info('Action sync_now');
    return syncNowMessage(await manager.syncAll());
  });

  // --- Graceful shutdown -------------------------------------------------------
  gladys.handleShutdown((signal) => {
    logger.info(`Received ${signal} -> graceful shutdown`);
    manager.stop();
  });

  return { manager };
}
