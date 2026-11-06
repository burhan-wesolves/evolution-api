import { PrismaRepository } from '@api/repository/repository.service';
import { WAMonitoringService } from '@api/services/monitor.service';
import {
  downAlertEmail,
  eventsForRepair,
  InboundRecord,
  isTrackableInbound,
  recordTimestamp,
  recoveryEmail,
  stripHeavyFields,
  WATCHMAN_DELIVERED_EVENT,
  WATCHMAN_REPLAY_FIELD,
  webhookNeedsRepair,
} from '@api/services/watchman.rules';
import { Events } from '@api/types/wa.types';
import { configService, Watchman, Webhook } from '@config/env.config';
import { eventEmitter } from '@config/event.config';
import { Logger } from '@config/logger.config';
import nodemailer, { Transporter } from 'nodemailer';

/**
 * Watches one or more WhatsApp instances and guarantees their inbound messages
 * reach the downstream webhook.
 *
 * Why it exists: ingestion is push-only, so anything sent while an instance is
 * disconnected never reaches the webhook. Evolution stores those messages (live
 * as `append` upserts, or through history sync after a re-pair), but nothing
 * re-sends them. This keeps a ledger of every inbound 1:1 message on a watched
 * instance and what happened to it, re-sends whatever the webhook never
 * accepted, and emails when the link goes down or comes back.
 *
 * The ledger is the guarantee, not the transport: Evolution's webhook retries
 * live only in memory, and its RabbitMQ publisher drops events while its channel
 * is down. A row stays `pending` until the webhook returns 2xx, across restarts.
 *
 * Delivery here means "the downstream accepted it". Combined with the receiver's
 * own dedup by message id, at-least-once re-delivery becomes exactly-once
 * processing -- which is why re-sending is safe.
 */
export class WatchmanService {
  private readonly logger = new Logger('WatchmanService');
  private readonly config = configService.get<Watchman>('WATCHMAN');

  /** instanceName -> timer that fires the "still down" email. */
  private readonly alertTimers = new Map<string, NodeJS.Timeout>();
  /** instanceName -> when it went down, for instances we have alerted about. */
  private readonly alerted = new Map<string, Date>();
  /** instanceName -> when it went down, whether or not we have alerted yet. */
  private readonly downSince = new Map<string, Date>();
  /** Instances with a sweep in flight, so two triggers cannot overlap. */
  private readonly sweeping = new Set<string>();
  /** instanceName -> replay floor, cached after the first read. */
  private readonly baselines = new Map<string, number>();

  private sweepTimer?: NodeJS.Timeout;
  private transporter?: Transporter | null;

  constructor(
    private readonly prismaRepository: PrismaRepository,
    private readonly waMonitor: WAMonitoringService,
  ) {}

  public get enabled(): boolean {
    return this.config?.ENABLED === true && this.config.INSTANCES.length > 0;
  }

  public isWatched(instanceName?: string): boolean {
    if (!this.enabled || !instanceName) return false;
    return this.config.INSTANCES.includes(instanceName);
  }

  /** Start the periodic sweep and listen for webhook acceptances. */
  public init(): void {
    if (!this.enabled) {
      if (this.config?.ENABLED && this.config.INSTANCES.length === 0) {
        this.logger.warn('Watchman is enabled but WATCHMAN_INSTANCES is empty; nothing is being watched.');
      }
      return;
    }

    eventEmitter.on(WATCHMAN_DELIVERED_EVENT, async (payload: { instanceName: string; keyId: string }) => {
      try {
        await this.markDelivered(payload?.instanceName, payload?.keyId);
      } catch (error) {
        this.logger.error(['watchman: could not mark a message delivered', error?.message]);
      }
    });

    // Set the replay floor NOW, before any message can arrive. Created lazily on
    // the first message instead, that message's own timestamp is a moment older
    // than the floor being created for it, so it fails the `>= baseline` test and
    // is skipped -- and if the first messages arrive as one post-reconnect batch,
    // the whole batch is skipped. Found while testing a real disconnect.
    void this.seedBaselines();
    // Repair the delivery path immediately rather than waiting a sweep interval:
    // after a restart following an instance recreate, every message is stuck
    // until there is somewhere to send it.
    void this.repairDeliveryPaths();

    const seconds = Math.max(30, this.config.REDELIVERY_INTERVAL_SECONDS);
    this.sweepTimer = setInterval(() => void this.sweepAll(), seconds * 1000);
    this.sweepTimer.unref?.();
    this.logger.info(
      `Watchman is watching [${this.config.INSTANCES.join(', ')}]; re-delivery sweep every ${seconds}s.`,
    );
  }

  /** Give every watched instance a replay floor at startup. */
  private async seedBaselines(): Promise<void> {
    try {
      for (const instanceName of this.config.INSTANCES) await this.baselineFor(instanceName);
    } catch (error) {
      this.logger.error(['watchman: could not seed replay floors', error?.message]);
    }
  }

  // ── Delivery path repair ──────────────────────────────────────────────────

  /** Check every watched instance has somewhere to deliver to. */
  private async repairDeliveryPaths(): Promise<void> {
    for (const instanceName of this.config.INSTANCES) {
      try {
        await this.ensureWebhook(instanceName);
      } catch (error) {
        this.logger.error([`watchman: could not repair the webhook for ${instanceName}`, error?.message]);
      }
    }
  }

  /**
   * Make sure a watched instance still has somewhere to deliver to.
   *
   * Deleting and recreating an instance is the normal way to re-pair after a
   * logout, and it mints a new Instance row. The Webhook row is keyed to the
   * instance id and cascades away with it, so the recreated instance -- same
   * name, same QR, apparently healthy -- has NO webhook configuration at all.
   *
   * The failure that causes is the worst kind: entirely silent. Live messages
   * are never sent, the replay sweep sends into nothing, and no error appears
   * anywhere, because an endpoint that does not exist cannot refuse. Observed
   * exactly that way -- an instance recreated under the same name stopped
   * processing both the messages missed during the outage AND every new message
   * after it, with a clean console.
   *
   * The ledger already survives a recreate (it is keyed by instance NAME), so
   * repairing the endpoint is the last piece: the pending messages then replay
   * on the next sweep and the guarantee holds across a re-pair.
   *
   * Returns true when it actually had to repair something.
   */
  public async ensureWebhook(instanceName: string): Promise<boolean> {
    const url = this.config?.WEBHOOK_URL;
    if (!this.isWatched(instanceName) || !url) return false;

    const instanceId = this.waMonitor.waInstances[instanceName]?.instanceId;
    if (!instanceId) return false;

    const existing = await this.prismaRepository.webhook.findUnique({
      where: { instanceId },
      select: { enabled: true, url: true, events: true },
    });
    if (!webhookNeedsRepair(existing, url)) return false;

    const events = eventsForRepair(existing);

    await this.prismaRepository.webhook.upsert({
      where: { instanceId },
      update: { enabled: true, url, events },
      create: { enabled: true, url, events, instanceId, webhookByEvents: false, webhookBase64: false },
    });
    this.logger.warn(
      `watchman: ${instanceName} had no usable webhook configuration; restored it to ${url}. ` +
        'Expected right after an instance is deleted and recreated.',
    );

    // Messages parked as `failed` were parked for want of an endpoint, not
    // because anything was wrong with them, so give them their attempts back.
    // Only on an actual repair -- a rare event -- so a webhook that is merely
    // refusing can never resurrect the same messages in a loop.
    const revived = await this.prismaRepository.messageDelivery.updateMany({
      where: { instanceName, status: 'failed' },
      data: { status: 'pending', attempts: 0, lastError: 'retrying: delivery endpoint was restored' },
    });
    if (revived.count > 0) {
      this.logger.info(`watchman: ${revived.count} message(s) parked with no endpoint are pending again.`);
    }
    return true;
  }

  /** True when the instance has somewhere to deliver to at all. */
  private async hasDeliveryEndpoint(instanceName: string): Promise<boolean> {
    const instanceId = this.waMonitor.waInstances[instanceName]?.instanceId;
    if (!instanceId) return false;
    const webhook = await this.prismaRepository.webhook.findUnique({
      where: { instanceId },
      select: { enabled: true, url: true },
    });
    if (webhook?.enabled && webhook.url) return true;
    const global = configService.get<Webhook>('WEBHOOK')?.GLOBAL;
    return Boolean(global?.ENABLED && global?.URL);
  }

  public stop(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = undefined;
    for (const timer of this.alertTimers.values()) clearTimeout(timer);
    this.alertTimers.clear();
  }

  // ── Ledger ────────────────────────────────────────────────────────────────

  /**
   * Record inbound messages as pending, before they are sent to the webhook.
   *
   * Called with the exact payload the webhook will receive, so a replay is
   * byte-identical to the original delivery. Duplicates are ignored, which is
   * what makes it safe to call from both the live path and history sync for the
   * same message.
   */
  public async recordInbound(
    instanceName: string,
    instanceId: string,
    records: { record: InboundRecord; payload: unknown }[],
  ): Promise<number> {
    if (!this.isWatched(instanceName) || records.length === 0) return 0;

    try {
      const baseline = await this.baselineFor(instanceName);
      const rows = records
        .filter(({ record }) => isTrackableInbound(record, baseline))
        .map(({ record, payload }) => ({
          instanceName,
          instanceId: instanceId || null,
          keyId: String(record.keyId),
          remoteJid: String(record.remoteJid).slice(0, 100),
          messageTimestamp: recordTimestamp(record) as number,
          payload: stripHeavyFields(payload) as any,
        }));
      if (rows.length === 0) return 0;

      // skipDuplicates: the same message can reach us twice (a live upsert and a
      // history sync). The (instanceId, keyId) unique index makes the second a
      // no-op rather than a second delivery.
      const created = await this.prismaRepository.messageDelivery.createMany({ data: rows, skipDuplicates: true });
      return created.count;
    } catch (error) {
      // Never let bookkeeping break message handling.
      this.logger.error(['watchman: could not record inbound messages', error?.message]);
      return 0;
    }
  }

  /** The downstream accepted this message; stop tracking it. */
  public async markDelivered(instanceName?: string, keyId?: string): Promise<void> {
    if (!this.isWatched(instanceName) || !keyId) return;

    await this.prismaRepository.messageDelivery.updateMany({
      where: { instanceName, keyId, status: { not: 'delivered' } },
      // payload is cleared: it exists only so a pending message can be re-sent.
      data: { status: 'delivered', deliveredAt: new Date(), payload: null, lastError: null },
    });
  }

  // ── Connection ────────────────────────────────────────────────────────────

  /**
   * The link dropped. A transient drop reconnects within seconds, so the email
   * waits: only a disconnection that outlives ALERT_DELAY_SECONDS is worth
   * telling someone about. A logout cannot recover on its own, so it alerts at
   * once.
   */
  public onConnectionClosed(instanceName: string, opts: { terminal: boolean; statusCode?: number }): void {
    if (!this.isWatched(instanceName)) return;
    if (!this.downSince.has(instanceName)) this.downSince.set(instanceName, new Date());

    if (opts.terminal) {
      this.clearAlertTimer(instanceName);
      void this.raiseDownAlert(instanceName, opts);
      return;
    }
    if (this.alertTimers.has(instanceName) || this.alerted.has(instanceName)) return;

    const delay = Math.max(0, this.config.ALERT_DELAY_SECONDS) * 1000;
    const timer = setTimeout(() => {
      this.alertTimers.delete(instanceName);
      // Still down? onConnectionOpen clears downSince, so this is the check.
      if (this.downSince.has(instanceName)) void this.raiseDownAlert(instanceName, opts);
    }, delay);
    timer.unref?.();
    this.alertTimers.set(instanceName, timer);
  }

  /** The link is back: stop any pending alert, re-deliver, and report. */
  public async onConnectionOpen(instanceName: string): Promise<void> {
    if (!this.isWatched(instanceName)) return;
    this.clearAlertTimer(instanceName);
    const downSince = this.downSince.get(instanceName);
    this.downSince.delete(instanceName);

    // A newly watched instance has no floor yet; set it before its first
    // message can arrive, for the same reason seedBaselines runs at startup.
    await this.baselineFor(instanceName);

    // Before the sweep, not after: a recreated instance has no webhook row, so
    // without this the sweep would send every pending message into nothing and
    // burn an attempt on each.
    await this.ensureWebhook(instanceName);

    const redelivered = await this.sweep(instanceName);

    const alertedAt = this.alerted.get(instanceName);
    if (alertedAt) {
      this.alerted.delete(instanceName);
      await this.sendMail(
        recoveryEmail({ instanceName, downSince: downSince ?? alertedAt, at: new Date(), redelivered }),
      );
    }
  }

  private clearAlertTimer(instanceName: string): void {
    const timer = this.alertTimers.get(instanceName);
    if (timer) clearTimeout(timer);
    this.alertTimers.delete(instanceName);
  }

  private async raiseDownAlert(instanceName: string, opts: { terminal: boolean; statusCode?: number }): Promise<void> {
    if (this.alerted.has(instanceName)) return;
    const at = this.downSince.get(instanceName) ?? new Date();
    this.alerted.set(instanceName, at);
    await this.sendMail(downAlertEmail({ instanceName, terminal: opts.terminal, statusCode: opts.statusCode, at }));
  }

  // ── Re-delivery ───────────────────────────────────────────────────────────

  private async sweepAll(): Promise<void> {
    for (const instanceName of this.config.INSTANCES) {
      try {
        await this.sweep(instanceName);
      } catch (error) {
        this.logger.error([`watchman: sweep failed for ${instanceName}`, error?.message]);
      }
    }
  }

  /**
   * Re-send everything the webhook never accepted for one instance.
   *
   * Sent through the instance's own sendDataWebhook restricted to `['webhook']`,
   * so a replay reuses the existing signing, JWT and retry logic and is NOT
   * re-published to RabbitMQ, SQS or websocket subscribers, which already saw
   * the message live.
   */
  public async sweep(instanceName: string): Promise<number> {
    if (!this.isWatched(instanceName) || this.sweeping.has(instanceName)) return 0;

    const waInstance = this.waMonitor.waInstances[instanceName];
    // Nothing can be delivered while the link is down; the next trigger retries.
    if (!waInstance || waInstance.connectionStatus?.state !== 'open') return 0;

    // With no endpoint configured, every send would silently do nothing while
    // still counting as a failed attempt, so ten sweeps would park ten perfectly
    // good messages as `failed`. Repair it if we can; otherwise wait, because
    // "nowhere to deliver" is a configuration problem and burning the retry
    // budget on it destroys the very messages the watchman exists to protect.
    await this.ensureWebhook(instanceName);
    if (!(await this.hasDeliveryEndpoint(instanceName))) {
      this.logger.warn(
        `watchman: ${instanceName} has no webhook configured, so nothing can be re-delivered. ` +
          'Set WATCHMAN_WEBHOOK_URL (or configure the instance webhook) -- messages stay pending until then.',
      );
      return 0;
    }

    this.sweeping.add(instanceName);
    let delivered = 0;
    try {
      const maxAttempts = Math.max(1, this.config.MAX_ATTEMPTS);
      const pending = await this.prismaRepository.messageDelivery.findMany({
        where: {
          instanceName,
          status: 'pending',
          attempts: { lt: maxAttempts },
          // Give the live webhook, which has its own retries, time to succeed.
          createdAt: { lt: new Date(Date.now() - Math.max(0, this.config.REDELIVERY_MIN_AGE_SECONDS) * 1000) },
        },
        orderBy: { messageTimestamp: 'asc' },
        take: Math.max(1, this.config.REDELIVERY_BATCH),
      });

      for (const row of pending) {
        if (!row.payload) {
          await this.prismaRepository.messageDelivery.update({
            where: { id: row.id },
            data: { status: 'failed', lastError: 'no payload snapshot to replay' },
          });
          continue;
        }

        // Count the attempt BEFORE sending: a crash mid-send must not let the
        // same message be retried for ever.
        const attempts = row.attempts + 1;
        await this.prismaRepository.messageDelivery.update({ where: { id: row.id }, data: { attempts } });

        let error = '';
        try {
          await waInstance.sendDataWebhook(Events.MESSAGES_UPSERT, row.payload as object, true, ['webhook'], {
            [WATCHMAN_REPLAY_FIELD]: true,
            watchmanAttempt: attempts,
          });
        } catch (err) {
          error = String(err?.message ?? err).slice(0, 500);
        }

        // sendDataWebhook swallows a final failure, so the ledger is the verdict:
        // the webhook controller marks a row delivered only on a 2xx.
        const after = await this.prismaRepository.messageDelivery.findUnique({
          where: { id: row.id },
          select: { status: true },
        });
        if (after?.status === 'delivered') {
          delivered += 1;
          continue;
        }

        await this.prismaRepository.messageDelivery.update({
          where: { id: row.id },
          data: {
            status: attempts >= maxAttempts ? 'failed' : 'pending',
            lastError: (error || 'webhook did not accept the message').slice(0, 500),
          },
        });
        // The endpoint is refusing; stop hammering it and let the next sweep try.
        break;
      }

      if (delivered > 0) {
        this.logger.info(`watchman: re-delivered ${delivered} message(s) for ${instanceName}`);
      }
    } finally {
      this.sweeping.delete(instanceName);
    }
    return delivered;
  }

  // ── Replay floor ──────────────────────────────────────────────────────────

  /**
   * Unix seconds before which nothing is ever tracked, set once per instance.
   *
   * History sync hands over a chat's entire past. None of it was tracked, so
   * without this floor the first sweep would re-deliver months of old messages
   * and the downstream would re-run every command in them. Messages missed
   * before the watchman existed were already lost, so refusing them loses
   * nothing that was not already gone.
   */
  private async baselineFor(instanceName: string): Promise<number> {
    const cached = this.baselines.get(instanceName);
    if (cached !== undefined) return cached;

    const row = await this.prismaRepository.watchmanInstance.upsert({
      where: { instanceName },
      create: { instanceName },
      update: {},
    });
    const seconds = Math.floor(new Date(row.watchingSince).getTime() / 1000);
    this.baselines.set(instanceName, seconds);
    return seconds;
  }

  // ── Email ─────────────────────────────────────────────────────────────────

  private async sendMail(mail: { subject: string; text: string }): Promise<void> {
    const smtp = this.config.SMTP;
    if (!smtp?.HOST || this.config.ALERT_TO.length === 0) {
      this.logger.warn(`watchman: no SMTP configured, alert not sent -- ${mail.subject}`);
      return;
    }
    try {
      if (this.transporter === undefined) {
        this.transporter = nodemailer.createTransport({
          host: smtp.HOST,
          port: smtp.PORT,
          secure: smtp.SECURE,
          auth: smtp.USER ? { user: smtp.USER, pass: smtp.PASS } : undefined,
        });
      }
      await this.transporter.sendMail({
        from: smtp.FROM || smtp.USER,
        to: this.config.ALERT_TO.join(','),
        subject: mail.subject,
        text: mail.text,
      });
      this.logger.info(`watchman: alert sent -- ${mail.subject}`);
    } catch (error) {
      // An alert that cannot be sent must never take the instance down with it.
      this.logger.error(['watchman: could not send an alert email', mail.subject, error?.message]);
    }
  }
}
