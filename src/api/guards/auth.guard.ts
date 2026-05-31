import { InstanceDto } from '@api/dto/instance.dto';
import { prismaRepository } from '@api/server.module';
import { Auth, configService, Database } from '@config/env.config';
import { Logger } from '@config/logger.config';
import { ForbiddenException, UnauthorizedException } from '@exceptions';
import { NextFunction, Request, Response } from 'express';

const logger = new Logger('GUARD');

// Manager UI paramless routes that identify the instance via per-instance
// token in the apikey header. authGuard resolves the instance and writes
// req.params.instanceName so downstream handlers behave like the regular
// path-param routes.
const PARAMLESS_INSTANCE_ROUTES = ['/instance/reconnect', '/instance/logout', '/instance/qr', '/instance/all'];
const isParamlessAlias = (url: string) => PARAMLESS_INSTANCE_ROUTES.includes(url.split('?')[0]);

async function apikey(req: Request, _: Response, next: NextFunction) {
  const env = configService.get<Auth>('AUTHENTICATION').API_KEY;
  const key = req.get('apikey');
  const db = configService.get<Database>('DATABASE');

  if (!key) {
    throw new UnauthorizedException();
  }

  if (env.KEY === key) {
    // Global key on a paramless alias: resolve via ?instanceName= (the UI
    // sends the per-instance token, so this branch only fires for clients
    // using the global key explicitly). Without an identifier we cannot
    // disambiguate, so reject with a clear 400 rather than silently 404ing.
    if (isParamlessAlias(req.originalUrl)) {
      const qName = (req.query?.instanceName as string) || (req.query?.instance as string);
      if (qName) {
        (req.params as any).instanceName = qName;
        return next();
      }
      // Fall through — let the existing routes match if any; otherwise 404.
    }
    return next();
  }

  if ((req.originalUrl.includes('/instance/create') || req.originalUrl.includes('/instance/fetchInstances')) && !key) {
    throw new ForbiddenException('Missing global api key', 'The global api key must be set');
  }
  const param = req.params as unknown as InstanceDto;

  try {
    if (param?.instanceName) {
      const instance = await prismaRepository.instance.findUnique({
        where: { name: param.instanceName },
      });
      if (instance.token === key) {
        return next();
      }
    } else {
      // No :instanceName in path. Look up by token and (for paramless aliases)
      // write the resolved name back into req.params so the route handler can
      // pick it up via dataValidate().
      if (
        (req.originalUrl.includes('/instance/fetchInstances') || isParamlessAlias(req.originalUrl)) &&
        db.SAVE_DATA.INSTANCE
      ) {
        const instanceByKey = await prismaRepository.instance.findFirst({
          where: { token: key },
        });
        if (instanceByKey) {
          if (isParamlessAlias(req.originalUrl)) {
            (req.params as any).instanceName = instanceByKey.name;
          }
          return next();
        }
      }
    }
  } catch (error) {
    logger.error(error);
  }

  throw new UnauthorizedException();
}

export const authGuard = { apikey };
