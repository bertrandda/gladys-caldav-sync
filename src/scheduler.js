// -----------------------------------------------------------------------------
// Sync scheduling: one loop per enabled user, one global queue.
//
//   - every user gets a timer re-armed after each pass (never two passes of
//     the same user at once);
//   - all passes run one after the other through a single queue, and all the
//     calendar writes through a sliding-window limiter: the host API accepts
//     30 calendar writes per minute per integration, whatever the number of
//     users (429 beyond — the SDK does not retry);
//   - after each pass, the integration-level connection status shown in the
//     Configuration screen reflects the accounts that failed (no personal data
//     in the message, the details go to the logs).
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { isAccountComplete, normalizeAccount } from './config.js';
import { syncAccount } from './sync.js';

const logger = createLogger({ name: 'scheduler' });

const MINUTE_MS = 60_000;

/**
 * Sliding-window rate limiter for the calendar writes, with one retry after a
 * 429 (another process, or a previous container, may have used the quota).
 */
export class WriteLimiter {
  constructor({ limit = 25, intervalMs = MINUTE_MS, now = Date.now, sleep } = {}) {
    this.limit = limit;
    this.intervalMs = intervalMs;
    this.now = now;
    this.sleep = sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.timestamps = [];
  }

  async acquire() {
    for (;;) {
      const now = this.now();
      this.timestamps = this.timestamps.filter((t) => now - t < this.intervalMs);
      if (this.timestamps.length < this.limit) {
        this.timestamps.push(now);
        return;
      }
      await this.sleep(this.timestamps[0] + this.intervalMs - now);
    }
  }

  async run(fn) {
    await this.acquire();
    try {
      return await fn();
    } catch (error) {
      if (error?.status !== 429) {
        throw error;
      }
      logger.warn('Calendar write rate-limited by Gladys, retrying in one minute');
      await this.sleep(this.intervalMs);
      await this.acquire();
      return fn();
    }
  }
}

const statusMessage = (failed, total) => ({
  en: `${failed} of ${total} CalDAV account(s) failed to sync (server URL or credentials?), see the integration logs.`,
  fr: `${failed} compte(s) CalDAV sur ${total} en échec de synchronisation (URL du serveur ou identifiants ?), consultez les logs de l'intégration.`,
});

export class SyncManager {
  /**
   * @param {import('@gladysassistant/integration-sdk').GladysIntegration} gladys
   * @param {object} deps
   * @param {(account) => Promise<object>} deps.createClient CalDAV client factory
   * @param {() => object} deps.getConfig current normalized config
   * @param {() => Date} [deps.now]
   * @param {Function} [deps.setTimer] / [deps.clearTimer] timer functions (tests)
   * @param {WriteLimiter} [deps.limiter]
   */
  constructor(gladys, { createClient, getConfig, now, setTimer, clearTimer, limiter }) {
    this.gladys = gladys;
    this.createClient = createClient;
    this.getConfig = getConfig;
    this.now = now ?? (() => new Date());
    this.setTimer = setTimer ?? setTimeout;
    this.clearTimer = clearTimer ?? clearTimeout;
    this.limiter = limiter ?? new WriteLimiter();
    this.accounts = new Map(); // user selector -> CalendarAccount
    this.timers = new Map(); // user selector -> timer
    this.caches = new Map(); // user selector -> sync cache (see src/sync.js)
    this.results = new Map(); // user selector -> last pass summary or error
    this.pending = new Map(); // user selector -> queued pass promise
    this.queue = Promise.resolve();
    this.lastStatus = null;
    this.stopped = false;
  }

  /**
   * Replace the whole set of accounts (on every (re)connection: the account
   * events are lost while disconnected) and sync everyone.
   * @param {Array} accounts getCalendarAccounts()
   */
  async reload(accounts) {
    this.stopped = false;
    const selectors = new Set(accounts.map((account) => account.user.selector));
    for (const selector of this.accounts.keys()) {
      if (!selectors.has(selector)) {
        this.remove(selector);
      }
    }
    // A full republication after a reconnection: what changed meanwhile is
    // unknown (a calendar switched back on must be refilled).
    this.caches.clear();
    for (const account of accounts) {
      this.accounts.set(account.user.selector, account);
    }
    // A new connection: report the status again even if unchanged.
    this.lastStatus = null;
    await this.syncAll();
    await this.publishStatus();
  }

  /**
   * A user enabled, disabled or changed their account (or toggled a
   * calendar): re-sync them from scratch, or forget them.
   * @param {string} selector
   * @param {object | undefined} account their CalendarAccount, undefined when disabled
   */
  async update(selector, account) {
    if (!account) {
      this.remove(selector);
      await this.publishStatus();
      return undefined;
    }
    this.accounts.set(selector, account);
    this.caches.delete(selector);
    return this.enqueue(selector);
  }

  // Forget a user: their calendars were already destroyed by Gladys.
  remove(selector) {
    this.clearUserTimer(selector);
    this.accounts.delete(selector);
    this.caches.delete(selector);
    this.results.delete(selector);
  }

  /**
   * Sync every account now, one after the other.
   * @returns {Promise<Map<string, object>>} the result of each user's pass
   */
  async syncAll() {
    await Promise.all([...this.accounts.keys()].map((selector) => this.enqueue(selector)));
    return new Map(this.results);
  }

  /** The timing settings changed: re-arm every loop. */
  reschedule() {
    for (const selector of this.accounts.keys()) {
      if (!this.pending.has(selector)) {
        this.armTimer(selector);
      }
    }
  }

  /** Stop every loop (disconnection, shutdown). Queued passes are dropped. */
  stop() {
    this.stopped = true;
    for (const selector of [...this.timers.keys()]) {
      this.clearUserTimer(selector);
    }
  }

  enqueue(selector) {
    // Already waiting in the queue: that pass will read the latest account.
    if (this.pending.has(selector)) {
      return this.pending.get(selector);
    }
    this.clearUserTimer(selector);
    const pass = this.queue.then(() => this.runPass(selector));
    this.pending.set(selector, pass);
    this.queue = pass.catch(() => {});
    return pass;
  }

  async runPass(selector) {
    this.pending.delete(selector);
    const account = this.accounts.get(selector);
    if (!account || this.stopped) {
      return undefined;
    }
    let result;
    try {
      const normalized = normalizeAccount(account.config);
      if (!isAccountComplete(normalized)) {
        throw new Error('incomplete account: server URL, username and password are required');
      }
      const client = await this.createClient(normalized);
      if (!this.caches.has(selector)) {
        this.caches.set(selector, { ctags: new Map() });
      }
      const summary = await syncAccount(this.gladys, account, {
        client,
        config: this.getConfig(),
        now: this.now(),
        cache: this.caches.get(selector),
        write: (fn) => this.limiter.run(fn),
      });
      result = { ok: summary.errors.length === 0, ...summary };
      logger.info(
        `${selector}: ${summary.calendars} calendar(s), ${summary.events} event(s) synced` +
          (summary.errors.length > 0 ? `, ${summary.errors.length} calendar(s) failed` : ''),
      );
    } catch (error) {
      // The account may have been disabled while the pass ran: Gladys answers
      // 404, nothing to report.
      if (!this.accounts.has(selector)) {
        return undefined;
      }
      logger.error(`${selector}: CalDAV sync failed`, error);
      this.caches.delete(selector);
      result = { ok: false, calendars: 0, events: 0, skipped: 0, errors: [error.message] };
    }
    if (this.accounts.has(selector)) {
      this.results.set(selector, result);
      this.armTimer(selector);
    }
    await this.publishStatus();
    return result;
  }

  armTimer(selector) {
    this.clearUserTimer(selector);
    if (this.stopped) {
      return;
    }
    const delay = this.getConfig().sync_interval * MINUTE_MS;
    const timer = this.setTimer(() => {
      this.timers.delete(selector);
      this.enqueue(selector).catch(() => {});
    }, delay);
    timer?.unref?.();
    this.timers.set(selector, timer);
  }

  clearUserTimer(selector) {
    if (this.timers.has(selector)) {
      this.clearTimer(this.timers.get(selector));
      this.timers.delete(selector);
    }
  }

  async publishStatus() {
    const results = [...this.results.values()];
    const failed = results.filter((result) => !result.ok).length;
    const key = `${failed}/${results.length}`;
    if (key === this.lastStatus) {
      return;
    }
    try {
      if (failed === 0) {
        await this.gladys.setConnectionStatus(true);
      } else {
        await this.gladys.setConnectionStatus(false, statusMessage(failed, results.length));
      }
      this.lastStatus = key;
    } catch (error) {
      logger.warn(`Could not report the connection status: ${error.message}`);
    }
  }
}
