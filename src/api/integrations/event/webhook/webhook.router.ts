import { RouterBroker } from '@api/abstract/abstract.router';
import { InstanceDto } from '@api/dto/instance.dto';
import { EventDto } from '@api/integrations/event/event.dto';
import { HttpStatus } from '@api/routes/index.router';
import { eventManager } from '@api/server.module';
import { ConfigService } from '@config/env.config';
import { instanceSchema, webhookSchema } from '@validate/validate.schema';
import { RequestHandler, Router } from 'express';

import { HistoryListQuery, webhookHistoryService, WebhookHistoryStatus } from './webhook.history.service';

export class WebhookRouter extends RouterBroker {
  constructor(
    readonly configService: ConfigService,
    ...guards: RequestHandler[]
  ) {
    super();
    this.router
      .post(this.routerPath('set'), ...guards, async (req, res) => {
        const response = await this.dataValidate<EventDto>({
          request: req,
          schema: webhookSchema,
          ClassRef: EventDto,
          execute: (instance, data) => eventManager.webhook.set(instance.instanceName, data),
        });

        res.status(HttpStatus.CREATED).json(response);
      })
      .get(this.routerPath('find'), ...guards, async (req, res) => {
        const response = await this.dataValidate<InstanceDto>({
          request: req,
          schema: instanceSchema,
          ClassRef: InstanceDto,
          execute: (instance) => eventManager.webhook.get(instance.instanceName),
        });

        res.status(HttpStatus.OK).json(response);
      })
      .get(this.routerPath('history'), ...guards, (req, res) => {
        const instanceName = req.params.instanceName;
        const query = parseHistoryQuery(req.query);
        const result = webhookHistoryService.list(instanceName, query);
        const stats = webhookHistoryService.stats(instanceName);
        res.status(HttpStatus.OK).json({
          enabled: webhookHistoryService.enabled,
          stats,
          query,
          ...result,
        });
      })
      .delete(this.routerPath('history'), ...guards, (req, res) => {
        const cleared = webhookHistoryService.clear(req.params.instanceName);
        res.status(HttpStatus.OK).json({ cleared });
      });
  }

  public readonly router: Router = Router();
}

const VALID_STATUS: WebhookHistoryStatus[] = ['success', 'failure', 'pending', 'skipped'];
const VALID_SORT = new Set(['startedAt', 'finishedAt', 'event', 'httpStatus', 'latencyMs', 'attempts']);

function parseHistoryQuery(raw: any): HistoryListQuery {
  const query: HistoryListQuery = {};
  if (typeof raw.event === 'string' && raw.event) query.event = raw.event;
  if (typeof raw.status === 'string' && (VALID_STATUS as string[]).includes(raw.status)) {
    query.status = raw.status as WebhookHistoryStatus;
  }
  if (raw.scope === 'instance' || raw.scope === 'global') query.scope = raw.scope;
  if (typeof raw.search === 'string' && raw.search) query.search = raw.search;
  if (typeof raw.from === 'string' && raw.from) {
    const n = Number(raw.from);
    if (Number.isFinite(n)) query.from = n;
  }
  if (typeof raw.to === 'string' && raw.to) {
    const n = Number(raw.to);
    if (Number.isFinite(n)) query.to = n;
  }
  if (typeof raw.sortBy === 'string' && VALID_SORT.has(raw.sortBy)) {
    query.sortBy = raw.sortBy as HistoryListQuery['sortBy'];
  }
  if (raw.sortOrder === 'asc' || raw.sortOrder === 'desc') query.sortOrder = raw.sortOrder;
  if (typeof raw.limit === 'string' && raw.limit) {
    const n = Number(raw.limit);
    if (Number.isFinite(n)) query.limit = n;
  }
  if (typeof raw.offset === 'string' && raw.offset) {
    const n = Number(raw.offset);
    if (Number.isFinite(n)) query.offset = n;
  }
  return query;
}
