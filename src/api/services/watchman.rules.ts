/**
 * Pure decisions for the instance watchman.
 *
 * Kept free of Prisma, Baileys and the network so each rule can be tested
 * directly. The stateful half lives in watchman.service.ts.
 */

/** Marks a re-delivered message in the webhook body, so the receiver can treat
 * a replay differently from live traffic (ours only re-runs slash commands). */
export const WATCHMAN_REPLAY_FIELD = 'watchmanReplay';

/** Internal EventEmitter2 events, so core files need only a one-line emit. */
export const WATCHMAN_DELIVERED_EVENT = 'watchman.delivered';

export type InboundRecord = {
  keyId?: string;
  remoteJid?: string;
  fromMe?: boolean;
  messageTimestamp?: number | string | null;
};

/** Unix seconds a record was sent, or null when it cannot be read. */
export function recordTimestamp(record: InboundRecord): number | null {
  const raw = record?.messageTimestamp;
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) return Math.floor(raw);
  if (typeof raw === 'string' && /^\d+$/.test(raw.trim())) {
    const value = Number.parseInt(raw.trim(), 10);
    return value > 0 ? value : null;
  }
  return null;
}

/** A user's 1:1 chat. Groups, broadcast/status and newsletters are not tracked:
 * the downstream ignores them, so re-delivering them would be pure noise. */
export function isDirectChat(remoteJid?: string): boolean {
  if (!remoteJid) return false;
  return /@(s\.whatsapp\.net|lid)$/i.test(remoteJid.trim());
}

/**
 * Should this message go in the ledger?
 *
 * `baselineUnixSeconds` is the replay floor: the moment the watchman first saw
 * this instance. Anything older is refused, and that is what makes the very
 * first reconnect safe. History sync hands over a chat's whole past, and none
 * of it was ever tracked, so without the floor the first sweep would re-deliver
 * months of old messages and the downstream would re-run every command in them.
 *
 * A record with no readable timestamp is refused for the same reason: a message
 * that cannot be dated cannot be proven to be new.
 */
export function isTrackableInbound(record: InboundRecord, baselineUnixSeconds: number): boolean {
  if (!record?.keyId || !isDirectChat(record?.remoteJid)) return false;
  if (record.fromMe === true) return false;
  const ts = recordTimestamp(record);
  if (ts === null) return false;
  return ts >= baselineUnixSeconds;
}

/**
 * Drop the parts of a payload that are huge and reproducible.
 *
 * A ledger row keeps a snapshot of what was sent so a replay never depends on
 * the Message table (history sync saves in bulk and returns no ids). base64
 * media would make those rows megabytes each; the receiver fetches media from
 * Evolution by message key instead.
 */
export function stripHeavyFields<T>(payload: T): T {
  if (!payload || typeof payload !== 'object') return payload;
  const clone: any = Array.isArray(payload) ? [...(payload as any)] : { ...(payload as any) };
  if (clone.message && typeof clone.message === 'object') {
    const { base64, ...rest } = clone.message as Record<string, unknown>;
    void base64;
    clone.message = rest;
  }
  return clone as T;
}

export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

export type DownAlert = { subject: string; text: string };

export function downAlertEmail(input: {
  instanceName: string;
  terminal: boolean;
  statusCode?: number;
  at: Date;
}): DownAlert {
  const { instanceName, terminal, statusCode, at } = input;
  const subject = terminal
    ? `[WhatsApp] ${instanceName} is disconnected and needs a QR scan`
    : `[WhatsApp] ${instanceName} is disconnected`;
  const cause = statusCode ? ` (close code ${statusCode})` : '';
  const text = terminal
    ? [
        `The WhatsApp instance "${instanceName}" logged out${cause} at ${at.toISOString()}.`,
        '',
        'It will NOT reconnect on its own: the session is gone and someone has to',
        'scan the QR code again. Messages people send meanwhile are held by',
        'WhatsApp and re-delivered once it is back.',
      ].join('\n')
    : [
        `The WhatsApp instance "${instanceName}" has been disconnected${cause} since ${at.toISOString()}.`,
        '',
        'It is retrying on its own with backoff. Messages that arrive while it is',
        'down are re-delivered once it reconnects, so no action is needed unless',
        'this alert keeps arriving.',
      ].join('\n');
  return { subject, text };
}

export function recoveryEmail(input: {
  instanceName: string;
  downSince: Date;
  at: Date;
  redelivered: number;
}): DownAlert {
  const { instanceName, downSince, at, redelivered } = input;
  return {
    subject: `[WhatsApp] ${instanceName} is back online`,
    text: [
      `The WhatsApp instance "${instanceName}" reconnected at ${at.toISOString()}.`,
      `It was down for ${formatDuration(at.getTime() - downSince.getTime())}.`,
      '',
      redelivered === 1
        ? '1 message that arrived while it was down has been re-delivered.'
        : `${redelivered} messages that arrived while it was down have been re-delivered.`,
    ].join('\n'),
  };
}

// ── Delivery path repair ────────────────────────────────────────────────────

/**
 * Events a restored webhook subscribes to, in the uppercase spelling the
 * Webhook row stores (EventController.events uses the same form).
 *
 * The minimum the downstream needs, not the full list: MESSAGES_UPSERT carries
 * every inbound command and every replay, CONNECTION_UPDATE lets the receiver
 * see the link state. A repair should restore what is required and no more.
 */
export const WATCHMAN_REQUIRED_EVENTS = ['MESSAGES_UPSERT', 'CONNECTION_UPDATE'];

export type WebhookConfig = { enabled?: boolean; url?: string; events?: unknown } | null | undefined;

/**
 * Does this instance's webhook configuration need restoring?
 *
 * Deleting and recreating an instance -- the normal way to re-pair after a
 * logout -- mints a new Instance row, and the Webhook row is keyed to the
 * instance id, so it cascades away. The recreated instance then has no webhook
 * at all and the integration is silently dead: nothing delivered, nothing
 * replayed, and no error anywhere, because an endpoint that does not exist
 * cannot refuse.
 *
 * A disabled row, or one pointing somewhere else, counts as needing repair too:
 * from the watchman's side those are the same failure as a missing one.
 */
export function webhookNeedsRepair(existing: WebhookConfig, wantedUrl: string): boolean {
  if (!wantedUrl) return false; // repair is opt-in; nothing to restore to
  if (!existing) return true;
  return existing.enabled !== true || existing.url !== wantedUrl;
}

/** Keep whatever events were configured, so a deliberate narrowing survives a
 * repair; fall back to the required set only when there is nothing to keep. */
export function eventsForRepair(existing: WebhookConfig): string[] {
  const current = existing?.events;
  return Array.isArray(current) && current.length > 0 ? (current as string[]) : [...WATCHMAN_REQUIRED_EVENTS];
}
