/**
 * Delay before the next WhatsApp reconnect attempt, in milliseconds.
 *
 * Why this exists: a Baileys close with status 408 (connection lost / timed out
 * -- an ordinary network drop) used to be treated as terminal, per upstream
 * #2501, to stop a tight reconnect loop. But the terminal branch emits
 * `logout.instance`, which WIPES the session credentials, so a network blip
 * forced a QR rescan, and messages sent while offline came back only through
 * history sync. The loop #2501 describes is a reconnect-too-fast problem, so it
 * is solved here with backoff instead of by logging the user out.
 *
 * The first retry keeps the historical 3 s so a transient drop still recovers
 * fast. Each consecutive failure doubles the wait, capped at 5 minutes, with
 * +/-20% jitter so many instances on one host do not retry in lockstep. The
 * attempt counter is reset by the caller once the connection is open again.
 */
export const RECONNECT_BASE_DELAY_MS = 3_000;
export const RECONNECT_MAX_DELAY_MS = 5 * 60_000;

export function reconnectDelayMs(attempt: number, random: () => number = Math.random): number {
  const n = Number.isFinite(attempt) && attempt > 0 ? Math.floor(attempt) : 0;
  if (n === 0) return RECONNECT_BASE_DELAY_MS;
  // 2 ** n overflows to Infinity long before it matters; the cap handles it.
  const raw = Math.min(RECONNECT_MAX_DELAY_MS, RECONNECT_BASE_DELAY_MS * 2 ** n);
  const jitter = 0.8 + 0.4 * Math.min(Math.max(random(), 0), 1);
  return Math.min(RECONNECT_MAX_DELAY_MS, Math.round(raw * jitter));
}
