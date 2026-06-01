import { EventDto } from '@api/integrations/event/event.dto';
import { PrismaRepository } from '@api/repository/repository.service';
import { WAMonitoringService } from '@api/services/monitor.service';
import { wa } from '@api/types/wa.types';
import { configService, Log, Webhook } from '@config/env.config';
import { Logger } from '@config/logger.config';
// import { BadRequestException } from '@exceptions';
import axios, { AxiosInstance, AxiosResponse } from 'axios';
import * as jwt from 'jsonwebtoken';

import { EmitData, EventController, EventControllerInterface } from '../event.controller';
import { WebhookHistoryEntry, webhookHistoryService, WebhookHistoryStatus } from './webhook.history.service';

export class WebhookController extends EventController implements EventControllerInterface {
  private readonly logger = new Logger('WebhookController');

  constructor(prismaRepository: PrismaRepository, waMonitor: WAMonitoringService) {
    super(prismaRepository, waMonitor, true, 'webhook');
  }

  override async set(instanceName: string, data: EventDto): Promise<wa.LocalWebHook> {
    // if (!/^(https?:\/\/)/.test(data.webhook.url)) {
    //   throw new BadRequestException('Invalid "url" property');
    // }

    const incoming = data.webhook ?? ({} as NonNullable<EventDto['webhook']>);
    const enabled = incoming.enabled ?? false;
    const currentEvents = Array.isArray(incoming.events) ? incoming.events : [];

    let normalizedEvents: string[];
    if (!enabled) {
      // Preserve the existing events list when the webhook is just being
      // toggled off — otherwise the user has to re-pick every event after
      // re-enabling, which was the symptom behind "webhook gone on refresh".
      const existing = await this.prisma.webhook.findUnique({
        where: { instanceId: this.monitor.waInstances[instanceName].instanceId },
        select: { events: true },
      });
      const existingEvents = Array.isArray(existing?.events) ? (existing.events as string[]) : [];
      normalizedEvents = currentEvents.length > 0 ? currentEvents : existingEvents;
    } else {
      normalizedEvents = currentEvents.length > 0 ? currentEvents : EventController.events;
    }

    data.webhook = {
      ...incoming,
      enabled,
      events: normalizedEvents,
      url: incoming.url ?? '',
      base64: incoming.base64 ?? false,
      byEvents: incoming.byEvents ?? false,
    };

    return this.prisma.webhook.upsert({
      where: {
        instanceId: this.monitor.waInstances[instanceName].instanceId,
      },
      update: {
        enabled: data.webhook.enabled,
        events: data.webhook.events,
        url: data.webhook.url,
        headers: data.webhook.headers,
        webhookBase64: data.webhook.base64,
        webhookByEvents: data.webhook.byEvents,
      },
      create: {
        enabled: data.webhook.enabled,
        events: data.webhook.events,
        instanceId: this.monitor.waInstances[instanceName].instanceId,
        url: data.webhook.url,
        headers: data.webhook.headers,
        webhookBase64: data.webhook.base64,
        webhookByEvents: data.webhook.byEvents,
      },
    });
  }

  public async emit({
    instanceName,
    origin,
    event,
    data,
    serverUrl,
    dateTime,
    sender,
    apiKey,
    local,
    integration,
    extra,
  }: EmitData): Promise<void> {
    if (integration && !integration.includes('webhook')) {
      return;
    }

    const instance = (await this.get(instanceName)) as wa.LocalWebHook;

    const webhookConfig = configService.get<Webhook>('WEBHOOK');
    const webhookLocal = instance?.events;
    const webhookHeaders = { ...((instance?.headers as Record<string, string>) || {}) };

    if (webhookHeaders && 'jwt_key' in webhookHeaders) {
      const jwtKey = webhookHeaders['jwt_key'];
      const jwtToken = this.generateJwtToken(jwtKey);
      webhookHeaders['Authorization'] = `Bearer ${jwtToken}`;

      delete webhookHeaders['jwt_key'];
    }

    const we = event.replace(/[.-]/gm, '_').toUpperCase();
    const transformedWe = we.replace(/_/gm, '-').toLowerCase();
    const enabledLog = configService.get<Log>('LOG').LEVEL.includes('WEBHOOKS');
    const regex = /^(https?:\/\/)/;

    const webhookData = {
      ...(extra ?? {}),
      event,
      instance: instanceName,
      data,
      destination: instance?.url || `${webhookConfig.GLOBAL.URL}/${transformedWe}`,
      date_time: dateTime,
      sender,
      server_url: serverUrl,
      apikey: apiKey,
    };

    if (local && instance?.enabled) {
      if (Array.isArray(webhookLocal) && webhookLocal.includes(we)) {
        let baseURL: string;

        if (instance?.webhookByEvents) {
          baseURL = `${instance?.url}/${transformedWe}`;
        } else {
          baseURL = instance?.url;
        }

        if (enabledLog) {
          const logData = {
            local: `${origin}.sendData-Webhook`,
            url: baseURL,
            ...webhookData,
          };

          this.logger.log(logData);
        }

        try {
          if (instance?.enabled && regex.test(instance.url)) {
            // Add custom headers for better webhook tracking and debugging
            const enhancedHeaders = {
              ...webhookHeaders,
              'Content-Type': 'application/json',
              'X-Instance-ID': this.monitor.waInstances[instanceName].instanceId,
              'X-Instance-Name': instanceName,
              'X-Event-Type': event,
              'X-Timestamp': Date.now().toString(),
              'User-Agent': 'EvolutionAPI-Webhook/2.3.7',
            };

            const httpService = axios.create({
              baseURL,
              headers: enhancedHeaders as Record<string, string>,
              timeout: webhookConfig.REQUEST?.TIMEOUT_MS ?? 30000,
            });

            await this.retryWebhookRequest(httpService, webhookData, `${origin}.sendData-Webhook`, baseURL, serverUrl, {
              instanceName,
              event,
              scope: 'instance',
              requestHeaders: enhancedHeaders as Record<string, string>,
            });
          }
        } catch (error) {
          this.logger.error({
            local: `${origin}.sendData-Webhook`,
            message: `Todas as tentativas falharam: ${error?.message}`,
            hostName: error?.hostname,
            syscall: error?.syscall,
            code: error?.code,
            error: error?.errno,
            stack: error?.stack,
            name: error?.name,
            url: baseURL,
            server_url: serverUrl,
          });
        }
      }
    }

    if (webhookConfig.GLOBAL?.ENABLED) {
      if (webhookConfig.EVENTS[we]) {
        let globalURL = webhookConfig.GLOBAL.URL;

        if (webhookConfig.GLOBAL.WEBHOOK_BY_EVENTS) {
          globalURL = `${globalURL}/${transformedWe}`;
        }

        if (enabledLog) {
          const logData = {
            local: `${origin}.sendData-Webhook-Global`,
            url: globalURL,
            ...webhookData,
          };

          this.logger.log(logData);
        }

        try {
          if (regex.test(globalURL)) {
            const httpService = axios.create({
              baseURL: globalURL,
              timeout: webhookConfig.REQUEST?.TIMEOUT_MS ?? 30000,
            });

            await this.retryWebhookRequest(
              httpService,
              webhookData,
              `${origin}.sendData-Webhook-Global`,
              globalURL,
              serverUrl,
              {
                instanceName,
                event,
                scope: 'global',
              },
            );
          }
        } catch (error) {
          this.logger.error({
            local: `${origin}.sendData-Webhook-Global`,
            message: `Todas as tentativas falharam: ${error?.message}`,
            hostName: error?.hostname,
            syscall: error?.syscall,
            code: error?.code,
            error: error?.errno,
            stack: error?.stack,
            name: error?.name,
            url: globalURL,
            server_url: serverUrl,
          });
        }
      }
    }
  }

  private async retryWebhookRequest(
    httpService: AxiosInstance,
    webhookData: any,
    origin: string,
    baseURL: string,
    serverUrl: string,
    historyCtx: {
      instanceName: string;
      event: string;
      scope: 'instance' | 'global';
      requestHeaders?: Record<string, string>;
    },
    maxRetries?: number,
    delaySeconds?: number,
  ): Promise<void> {
    const webhookConfig = configService.get<Webhook>('WEBHOOK');
    const maxRetryAttempts = maxRetries ?? webhookConfig.RETRY?.MAX_ATTEMPTS ?? 10;
    const initialDelay = delaySeconds ?? webhookConfig.RETRY?.INITIAL_DELAY_SECONDS ?? 5;
    const useExponentialBackoff = webhookConfig.RETRY?.USE_EXPONENTIAL_BACKOFF ?? true;
    const maxDelay = webhookConfig.RETRY?.MAX_DELAY_SECONDS ?? 300;
    const jitterFactor = webhookConfig.RETRY?.JITTER_FACTOR ?? 0.2;
    const nonRetryableStatusCodes = webhookConfig.RETRY?.NON_RETRYABLE_STATUS_CODES ?? [400, 401, 403, 404, 422];

    let attempts = 0;
    const startedAt = Date.now();

    while (attempts < maxRetryAttempts) {
      try {
        const response: AxiosResponse = await httpService.post('', webhookData);
        if (attempts > 0) {
          this.logger.log({
            local: `${origin}`,
            message: `Delivered successfully after ${attempts + 1} attempts`,
            url: baseURL,
          });
        }
        this.recordHistory({
          ...historyCtx,
          url: baseURL,
          status: 'success',
          httpStatus: response?.status,
          attempts: attempts + 1,
          startedAt,
          finishedAt: Date.now(),
          requestBody: webhookData,
          responseBody: response?.data,
        });
        return;
      } catch (error) {
        attempts++;

        const isTimeout = error.code === 'ECONNABORTED';

        if (error?.response?.status && nonRetryableStatusCodes.includes(error.response.status)) {
          this.logger.error({
            local: `${origin}`,
            message: `Non-recoverable error (${error.response.status}): ${error?.message}. Cancelling retries.`,
            statusCode: error?.response?.status,
            url: baseURL,
            server_url: serverUrl,
          });
          this.recordHistory({
            ...historyCtx,
            url: baseURL,
            status: 'failure',
            httpStatus: error?.response?.status,
            attempts,
            startedAt,
            finishedAt: Date.now(),
            errorMessage: error?.message,
            errorCode: error?.code,
            requestBody: webhookData,
            responseBody: error?.response?.data,
          });
          throw error;
        }

        this.logger.error({
          local: `${origin}`,
          message: `Attempt ${attempts}/${maxRetryAttempts} failed: ${isTimeout ? 'Request timeout' : error?.message}`,
          hostName: error?.hostname,
          syscall: error?.syscall,
          code: error?.code,
          isTimeout,
          statusCode: error?.response?.status,
          error: error?.errno,
          stack: error?.stack,
          name: error?.name,
          url: baseURL,
          server_url: serverUrl,
        });

        if (attempts === maxRetryAttempts) {
          this.recordHistory({
            ...historyCtx,
            url: baseURL,
            status: 'failure',
            httpStatus: error?.response?.status,
            attempts,
            startedAt,
            finishedAt: Date.now(),
            errorMessage: error?.message,
            errorCode: error?.code,
            requestBody: webhookData,
            responseBody: error?.response?.data,
          });
          throw error;
        }

        let nextDelay = initialDelay;
        if (useExponentialBackoff) {
          nextDelay = Math.min(initialDelay * Math.pow(2, attempts - 1), maxDelay);

          const jitter = nextDelay * jitterFactor * (Math.random() * 2 - 1);
          nextDelay = Math.max(initialDelay, nextDelay + jitter);
        }

        this.logger.log({
          local: `${origin}`,
          message: `Waiting ${nextDelay.toFixed(1)} seconds before next attempt`,
          url: baseURL,
        });

        await new Promise((resolve) => setTimeout(resolve, nextDelay * 1000));
      }
    }
  }

  private recordHistory(payload: {
    instanceName: string;
    event: string;
    scope: 'instance' | 'global';
    url: string;
    status: WebhookHistoryStatus;
    httpStatus?: number;
    attempts: number;
    startedAt: number;
    finishedAt: number;
    errorMessage?: string;
    errorCode?: string;
    requestHeaders?: Record<string, string>;
    requestBody?: unknown;
    responseBody?: unknown;
  }): void {
    if (!webhookHistoryService.enabled) return;
    try {
      const entry: Omit<WebhookHistoryEntry, 'id'> = {
        instanceName: payload.instanceName,
        scope: payload.scope,
        event: payload.event,
        url: payload.url,
        method: 'POST',
        status: payload.status,
        httpStatus: payload.httpStatus,
        attempts: payload.attempts,
        latencyMs: Math.max(0, payload.finishedAt - payload.startedAt),
        errorMessage: payload.errorMessage,
        errorCode: payload.errorCode,
        requestHeaders: this.scrubHeaders(payload.requestHeaders),
        requestBody: payload.requestBody,
        responseBody: payload.responseBody as string | undefined,
        startedAt: payload.startedAt,
        finishedAt: payload.finishedAt,
      };
      webhookHistoryService.record(entry);
    } catch (err) {
      this.logger.error({
        local: 'WebhookController.recordHistory',
        message: `Failed to record webhook history: ${err?.message}`,
      });
    }
  }

  private scrubHeaders(headers?: Record<string, string>): Record<string, string> | undefined {
    if (!headers) return undefined;
    const scrubbed: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) {
      const lower = k.toLowerCase();
      if (lower === 'authorization' || lower === 'cookie' || lower === 'set-cookie' || lower === 'x-api-key') {
        scrubbed[k] = '***';
      } else {
        scrubbed[k] = v;
      }
    }
    return scrubbed;
  }

  private generateJwtToken(authToken: string): string {
    try {
      const payload = {
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 600, // 10 min expiration
        app: 'evolution',
        action: 'webhook',
      };

      const token = jwt.sign(payload, authToken, { algorithm: 'HS256' });
      return token;
    } catch (error) {
      this.logger.error({
        local: 'WebhookController.generateJwtToken',
        message: `JWT generation failed: ${error?.message}`,
      });
      throw error;
    }
  }
}
