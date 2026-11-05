import { test } from 'node:test';
import assert from 'node:assert/strict';
import createDebug from 'debug';
import { debugLogsEnabled, setDebugLogs } from '../src/logging.js';

test('the detailed logs switch sets and restores LOG_LEVEL and the tsdav traces', () => {
  const logLevel = process.env.LOG_LEVEL;
  setDebugLogs(true);
  try {
    assert.equal(debugLogsEnabled(), true);
    assert.equal(process.env.LOG_LEVEL, 'debug');
    assert.equal(createDebug.enabled('tsdav:request'), true);
  } finally {
    setDebugLogs(false);
  }
  assert.equal(debugLogsEnabled(), false);
  assert.equal(process.env.LOG_LEVEL, logLevel);
  assert.equal(createDebug.enabled('tsdav:request'), false);
});
