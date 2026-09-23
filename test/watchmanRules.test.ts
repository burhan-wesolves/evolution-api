import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  downAlertEmail,
  formatDuration,
  isDirectChat,
  isTrackableInbound,
  recordTimestamp,
  eventsForRepair,
  recoveryEmail,
  stripHeavyFields,
  WATCHMAN_REPLAY_FIELD,
  WATCHMAN_REQUIRED_EVENTS,
  webhookNeedsRepair,
} from '@api/services/watchman.rules';

const URL = 'http://localhost:54321/functions/v1/evolution-webhook';

const BASELINE = 1_700_000_000; // the moment the watchman started watching

const inbound = (over: Record<string, unknown> = {}) => ({
  keyId: 'MSG1',
  remoteJid: '919999999999@s.whatsapp.net',
  fromMe: false,
  messageTimestamp: BASELINE + 60,
  ...over,
});

// ── The replay floor ─────────────────────────────────────────────────────────
// History sync hands over a chat's entire past. None of it was ever tracked, so
// without the floor the first sweep would re-deliver months of old messages and
// the downstream would re-run every command in them.

test('a message sent after the watchman started watching is tracked', () => {
  assert.equal(isTrackableInbound(inbound(), BASELINE), true);
  assert.equal(isTrackableInbound(inbound({ messageTimestamp: BASELINE }), BASELINE), true);
});

test('history from before the watchman existed is never tracked', () => {
  assert.equal(isTrackableInbound(inbound({ messageTimestamp: BASELINE - 1 }), BASELINE), false);
  assert.equal(isTrackableInbound(inbound({ messageTimestamp: BASELINE - 86_400 * 90 }), BASELINE), false);
});

test('a message that cannot be dated is never tracked', () => {
  // It cannot be proven new, and replaying it would re-run a command.
  for (const ts of [undefined, null, 0, -5, 'soon', '', Number.NaN]) {
    assert.equal(isTrackableInbound(inbound({ messageTimestamp: ts }), BASELINE), false, String(ts));
  }
});

test('our own outbound messages are not tracked', () => {
  assert.equal(isTrackableInbound(inbound({ fromMe: true }), BASELINE), false);
});

test('only 1:1 chats are tracked, because the downstream ignores the rest', () => {
  assert.equal(isDirectChat('919999999999@s.whatsapp.net'), true);
  assert.equal(isDirectChat('123456@lid'), true);
  assert.equal(isDirectChat('120363000000000000@g.us'), false); // group
  assert.equal(isDirectChat('status@broadcast'), false);
  assert.equal(isDirectChat(undefined), false);
  assert.equal(isTrackableInbound(inbound({ remoteJid: '120363@g.us' }), BASELINE), false);
});

test('a message with no id is not tracked: there would be nothing to dedup on', () => {
  assert.equal(isTrackableInbound(inbound({ keyId: undefined }), BASELINE), false);
  assert.equal(isTrackableInbound(inbound({ keyId: '' }), BASELINE), false);
});

test('timestamps are read from the shapes Baileys uses', () => {
  assert.equal(recordTimestamp({ messageTimestamp: 1_790_093_516 }), 1_790_093_516);
  assert.equal(recordTimestamp({ messageTimestamp: '1790093516' }), 1_790_093_516);
  assert.equal(recordTimestamp({ messageTimestamp: 1_790_093_516.7 }), 1_790_093_516);
  assert.equal(recordTimestamp({ messageTimestamp: 'x' }), null);
  assert.equal(recordTimestamp({}), null);
});

// ── Snapshot hygiene ────────────────────────────────────────────────────────

test('base64 media is stripped from the stored snapshot', () => {
  // Rows keep a copy of the payload so a replay never needs the Message table;
  // base64 would make each row megabytes. The receiver fetches media by key.
  const payload = { key: { id: 'A' }, message: { base64: 'x'.repeat(5000), conversation: '/add 50 coffee' } };
  const stored: any = stripHeavyFields(payload);
  assert.equal(stored.message.base64, undefined);
  assert.equal(stored.message.conversation, '/add 50 coffee');
  // ...and the original is untouched.
  assert.equal(payload.message.base64.length, 5000);
});

test('stripping copes with payloads that have no message', () => {
  assert.deepEqual(stripHeavyFields({ key: { id: 'A' } }), { key: { id: 'A' } });
  assert.equal(stripHeavyFields(null), null);
  assert.equal(stripHeavyFields('text' as any), 'text');
});

test('the replay flag has a stable name, because the receiver branches on it', () => {
  assert.equal(WATCHMAN_REPLAY_FIELD, 'watchmanReplay');
});

// ── Alerts ──────────────────────────────────────────────────────────────────

test('a logout says a QR scan is needed; a transient drop says it is retrying', () => {
  const at = new Date('2026-09-22T10:00:00.000Z');
  const loggedOut = downAlertEmail({ instanceName: 'snap', terminal: true, statusCode: 401, at });
  assert.match(loggedOut.subject, /needs a QR scan/);
  assert.match(loggedOut.text, /will NOT reconnect on its own/);
  assert.match(loggedOut.text, /close code 401/);

  const transient = downAlertEmail({ instanceName: 'snap', terminal: false, statusCode: 408, at });
  assert.doesNotMatch(transient.subject, /QR/);
  assert.match(transient.text, /retrying on its own/);
});

test('the recovery email reports the outage and what was re-delivered', () => {
  const mail = recoveryEmail({
    instanceName: 'snap',
    downSince: new Date('2026-09-22T10:00:00.000Z'),
    at: new Date('2026-09-22T10:07:30.000Z'),
    redelivered: 3,
  });
  assert.match(mail.subject, /back online/);
  assert.match(mail.text, /7m 30s/);
  assert.match(mail.text, /3 messages/);
  assert.match(recoveryEmail({ instanceName: 's', downSince: new Date(0), at: new Date(1000), redelivered: 1 }).text, /1 message that arrived/);
});

test('durations read naturally at every scale', () => {
  assert.equal(formatDuration(5_000), '5s');
  assert.equal(formatDuration(90_000), '1m 30s');
  assert.equal(formatDuration(3_600_000 + 120_000), '1h 2m');
  assert.equal(formatDuration(-1), '0s');
});

// ── Repairing the delivery path ─────────────────────────────────────────────
// Deleting and recreating an instance -- the normal way to re-pair after a
// logout -- cascades its Webhook row away. The recreated instance then has
// nowhere to deliver to, and the failure is silent in both directions: live
// messages are never sent and the replay sweep sends into nothing, with no
// error anywhere, because an endpoint that does not exist cannot refuse.

test('a recreated instance, which has no webhook at all, needs repair', () => {
  assert.equal(webhookNeedsRepair(null, URL), true);
  assert.equal(webhookNeedsRepair(undefined, URL), true);
});

test('a disabled or misdirected webhook counts as needing repair too', () => {
  // From the watchman's side these fail exactly like a missing one.
  assert.equal(webhookNeedsRepair({ enabled: false, url: URL }, URL), true);
  assert.equal(webhookNeedsRepair({ enabled: true, url: 'https://elsewhere.test/hook' }, URL), true);
  assert.equal(webhookNeedsRepair({ enabled: true, url: '' }, URL), true);
});

test('a healthy webhook is left alone', () => {
  assert.equal(webhookNeedsRepair({ enabled: true, url: URL }, URL), false);
});

test('repair is opt-in: with no URL configured nothing is touched', () => {
  // Otherwise enabling the watchman would silently rewrite webhook config.
  assert.equal(webhookNeedsRepair(null, ''), false);
  assert.equal(webhookNeedsRepair({ enabled: false, url: 'x' }, ''), false);
});

test('a repair keeps the events already configured', () => {
  // A deliberate narrowing must survive; only an empty list falls back.
  assert.deepEqual(eventsForRepair({ events: ['MESSAGES_UPSERT'] }), ['MESSAGES_UPSERT']);
  assert.deepEqual(eventsForRepair({ events: [] }), WATCHMAN_REQUIRED_EVENTS);
  assert.deepEqual(eventsForRepair(null), WATCHMAN_REQUIRED_EVENTS);
  assert.deepEqual(eventsForRepair({ events: 'nonsense' }), WATCHMAN_REQUIRED_EVENTS);
});

test('the restored subscription covers replays and link state', () => {
  // MESSAGES_UPSERT carries every inbound command AND every watchman replay;
  // without it a repair would look successful and deliver nothing.
  assert.ok(WATCHMAN_REQUIRED_EVENTS.includes('MESSAGES_UPSERT'));
  assert.ok(WATCHMAN_REQUIRED_EVENTS.includes('CONNECTION_UPDATE'));
});

test('the fallback event list cannot be mutated by a caller', () => {
  const first = eventsForRepair(null);
  first.push('OOPS');
  assert.equal(eventsForRepair(null).includes('OOPS'), false);
});
