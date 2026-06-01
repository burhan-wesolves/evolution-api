import { configService, Webhook } from '@config/env.config';
import { Logger } from '@config/logger.config';
import { randomUUID } from 'crypto';

export type WebhookHistoryStatus = 'success' | 'failure' | 'pending' | 'skipped';

export type WebhookHistoryEntry = {
  id: string;
  instanceName: string;
  scope: 'instance' | 'global';
  event: string;
  url: string;
  method: 'POST';
  status: WebhookHistoryStatus;
  httpStatus?: number;
  attempts: number;
  latencyMs: number;
  errorMessage?: string;
  errorCode?: string;
  requestHeaders?: Record<string, string>;
  requestBody?: unknown;
  responseBody?: string;
  startedAt: number;
  finishedAt: number;
};

export type HistoryListQuery = {
  event?: string;
  status?: WebhookHistoryStatus;
  scope?: 'instance' | 'global';
  search?: string;
  from?: number;
  to?: number;
  sortBy?: 'startedAt' | 'finishedAt' | 'event' | 'httpStatus' | 'latencyMs' | 'attempts';
  sortOrder?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
};

const DEFAULT_LIMIT = 50;
const ABSOLUTE_MAX_LIMIT = 500;

class WebhookHistoryStore {
  private readonly logger = new Logger('WebhookHistoryService');
  private readonly buffers = new Map<string, WebhookHistoryEntry[]>();

  private get config() {
    return configService.get<Webhook>('WEBHOOK')?.HISTORY ?? {};
  }

  get enabled(): boolean {
    return this.config.ENABLED !== false;
  }

  private get maxEntries(): number {
    return this.config.MAX_ENTRIES_PER_INSTANCE ?? 500;
  }

  private get captureResponseBody(): boolean {
    return this.config.CAPTURE_RESPONSE_BODY !== false;
  }

  private get responseBodyMaxBytes(): number {
    return this.config.RESPONSE_BODY_MAX_BYTES ?? 4096;
  }

  record(entry: Omit<WebhookHistoryEntry, 'id'> & { id?: string }): WebhookHistoryEntry {
    const stored: WebhookHistoryEntry = {
      ...entry,
      id: entry.id ?? randomUUID(),
      responseBody: this.captureResponseBody ? this.truncateBody(entry.responseBody) : undefined,
    };

    const key = this.bucketKey(stored.instanceName);
    const bucket = this.buffers.get(key) ?? [];
    bucket.push(stored);
    if (bucket.length > this.maxEntries) {
      bucket.splice(0, bucket.length - this.maxEntries);
    }
    this.buffers.set(key, bucket);
    return stored;
  }

  list(
    instanceName: string,
    query: HistoryListQuery = {},
  ): { total: number; matched: number; items: WebhookHistoryEntry[] } {
    const all = this.buffers.get(this.bucketKey(instanceName)) ?? [];
    const filtered = all.filter((e) => this.match(e, query));

    const sortBy = query.sortBy ?? 'startedAt';
    const order = query.sortOrder === 'asc' ? 1 : -1;
    filtered.sort((a, b) => {
      const av = (a as any)[sortBy];
      const bv = (b as any)[sortBy];
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      if (av < bv) return -1 * order;
      if (av > bv) return 1 * order;
      return 0;
    });

    const offset = Math.max(0, query.offset ?? 0);
    const requested = query.limit ?? DEFAULT_LIMIT;
    const limit = Math.min(Math.max(1, requested), ABSOLUTE_MAX_LIMIT);
    const items = filtered.slice(offset, offset + limit);

    return { total: all.length, matched: filtered.length, items };
  }

  clear(instanceName: string): number {
    const key = this.bucketKey(instanceName);
    const previous = this.buffers.get(key)?.length ?? 0;
    this.buffers.delete(key);
    return previous;
  }

  stats(instanceName: string) {
    const all = this.buffers.get(this.bucketKey(instanceName)) ?? [];
    const counts: Record<WebhookHistoryStatus, number> = {
      success: 0,
      failure: 0,
      pending: 0,
      skipped: 0,
    };
    let totalLatency = 0;
    let withLatency = 0;
    for (const entry of all) {
      counts[entry.status] = (counts[entry.status] ?? 0) + 1;
      if (typeof entry.latencyMs === 'number' && entry.status !== 'pending') {
        totalLatency += entry.latencyMs;
        withLatency += 1;
      }
    }
    return {
      total: all.length,
      capacity: this.maxEntries,
      byStatus: counts,
      avgLatencyMs: withLatency > 0 ? Math.round(totalLatency / withLatency) : 0,
    };
  }

  private bucketKey(instanceName: string): string {
    return instanceName?.toLowerCase?.() ?? '_global';
  }

  private truncateBody(body: unknown): string | undefined {
    if (body == null) return undefined;
    const text =
      typeof body === 'string'
        ? body
        : (() => {
            try {
              return JSON.stringify(body);
            } catch {
              return String(body);
            }
          })();
    if (text.length <= this.responseBodyMaxBytes) return text;
    return text.slice(0, this.responseBodyMaxBytes) + `…[truncated ${text.length - this.responseBodyMaxBytes}B]`;
  }

  private match(entry: WebhookHistoryEntry, q: HistoryListQuery): boolean {
    if (q.event && entry.event !== q.event) return false;
    if (q.status && entry.status !== q.status) return false;
    if (q.scope && entry.scope !== q.scope) return false;
    if (typeof q.from === 'number' && entry.startedAt < q.from) return false;
    if (typeof q.to === 'number' && entry.startedAt > q.to) return false;
    if (q.search) {
      const needle = q.search.toLowerCase();
      const haystack = [
        entry.event,
        entry.url,
        entry.errorMessage,
        entry.errorCode,
        entry.responseBody,
        typeof entry.requestBody === 'string' ? entry.requestBody : safeStringify(entry.requestBody),
      ]
        .filter(Boolean)
        .join('\n')
        .toLowerCase();
      if (!haystack.includes(needle)) return false;
    }
    return true;
  }
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
}

export const webhookHistoryService = new WebhookHistoryStore();
