import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { RECONNECT_BASE_DELAY_MS, RECONNECT_MAX_DELAY_MS, reconnectDelayMs } from '@utils/reconnectBackoff';

// A Baileys 408 (an ordinary network drop) used to be terminal, and the terminal
// branch wipes the session credentials. It now reconnects with backoff instead,
// which is what stops the reconnect loop upstream #2501 was worried about.

test('the first retry keeps the historical 3 s, so a blip still recovers fast', () => {
  assert.equal(reconnectDelayMs(0), RECONNECT_BASE_DELAY_MS);
  assert.equal(reconnectDelayMs(0), 3_000);
});

test('consecutive failures back off exponentially', () => {
  const mid = () => 0.5; // jitter factor exactly 1.0
  assert.equal(reconnectDelayMs(1, mid), 6_000);
  assert.equal(reconnectDelayMs(2, mid), 12_000);
  assert.equal(reconnectDelayMs(3, mid), 24_000);
});

test('the wait is capped at 5 minutes, however long it has been failing', () => {
  for (const attempt of [7, 8, 20, 1_000, 10_000]) {
    for (const r of [0, 0.5, 1]) {
      assert.ok(reconnectDelayMs(attempt, () => r) <= RECONNECT_MAX_DELAY_MS, `attempt ${attempt}, random ${r}`);
    }
  }
  assert.equal(RECONNECT_MAX_DELAY_MS, 300_000);
});

test('jitter stays within +/-20%, so instances on one host do not retry in lockstep', () => {
  assert.equal(reconnectDelayMs(2, () => 0), Math.round(12_000 * 0.8));
  assert.equal(reconnectDelayMs(2, () => 1), Math.round(12_000 * 1.2));
});

test('a misbehaving random source cannot push the delay out of range', () => {
  assert.equal(reconnectDelayMs(2, () => -5), Math.round(12_000 * 0.8));
  assert.equal(reconnectDelayMs(2, () => 99), Math.round(12_000 * 1.2));
});

test('a nonsense attempt count is treated as the first retry', () => {
  for (const attempt of [-1, Number.NaN, Number.NEGATIVE_INFINITY]) {
    assert.equal(reconnectDelayMs(attempt), RECONNECT_BASE_DELAY_MS);
  }
});
