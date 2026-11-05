// -----------------------------------------------------------------------------
// "Detailed logs" switch of the integration settings.
//
// The Gladys supervisor owns the container environment, so an admin cannot
// set LOG_LEVEL or DEBUG to diagnose a sync. The switch does it at runtime:
//   - the SDK loggers read LOG_LEVEL on every call: setting it turns on the
//     debug lines of every module of the integration;
//   - tsdav traces its requests (discovery, PROPFIND, REPORT) through the
//     `debug` package: its `tsdav:*` namespaces are enabled and routed to the
//     integration logger, so they land in the integration logs like the rest.
// Switched off, both go back to what the environment says.
// -----------------------------------------------------------------------------

import createDebug from 'debug';
import { createLogger } from '@gladysassistant/integration-sdk';

const tsdavLogger = createLogger({ name: 'tsdav' });

const initialLogLevel = process.env.LOG_LEVEL;
const initialDebug = process.env.DEBUG;

let enabled = false;

/**
 * @param {boolean} on `debug_logs` of the normalized config
 */
export function setDebugLogs(on) {
  if (on === enabled) {
    return;
  }
  enabled = on;
  if (on) {
    process.env.LOG_LEVEL = 'debug';
    // Our logger already prints the date.
    createDebug.inspectOpts.hideDate = true;
    createDebug.log = (...args) => tsdavLogger.debug(...args);
    createDebug.enable([initialDebug, 'tsdav:*'].filter(Boolean).join(','));
    tsdavLogger.info('Detailed logs enabled');
  } else {
    tsdavLogger.info('Detailed logs disabled');
    if (initialLogLevel === undefined) {
      delete process.env.LOG_LEVEL;
    } else {
      process.env.LOG_LEVEL = initialLogLevel;
    }
    createDebug.enable(initialDebug ?? '');
  }
}

/** Whether the detailed logs are on (tests). */
export function debugLogsEnabled() {
  return enabled;
}
