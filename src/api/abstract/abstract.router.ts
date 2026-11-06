import 'express-async-errors';

import { GetParticipant, GroupInvite } from '@api/dto/group.dto';
import { InstanceDto } from '@api/dto/instance.dto';
import { Logger } from '@config/logger.config';
import { BadRequestException } from '@exceptions';
import { Request } from 'express';
import { JSONSchema7 } from 'json-schema';
import { validate } from 'jsonschema';

type DataValidate<T> = {
  request: Request;
  schema: JSONSchema7;
  ClassRef: any;
  execute: (instance: InstanceDto, data: T) => Promise<any>;
};

const logger = new Logger('Validate');

export abstract class RouterBroker {
  constructor() {}
  public routerPath(path: string, param = true) {
    let route = '/' + path;
    param ? (route += '/:instanceName') : null;

    return route;
  }

  public async dataValidate<T>(args: DataValidate<T>) {
    const { request, schema, ClassRef, execute } = args;

    const ref = new ClassRef();
    const body = request.body;
    const instance = request.params as unknown as InstanceDto;

    const isInstanceCreate = request.originalUrl.includes('/instance/create');

    // The instance identity is authenticated by the guard via the URL
    // :instanceName param. Capture it BEFORE hydrating from query/body so
    // nothing downstream can clobber it (`instance` aliases request.params).
    const urlInstanceName = request.params?.instanceName;

    // Hydrate the DTO from the query string. On param-less listing routes
    // (e.g. GET /instance/fetchInstances?instanceId=…&number=…) this is where
    // the legitimate filters live, so they flow straight through.
    if (request?.query && Object.keys(request.query).length > 0) {
      Object.assign(instance, request.query as Record<string, any>);
    }

    if (isInstanceCreate) {
      // /instance/create is gated by the global API key, so the body is the
      // legitimate source for the new instance's name/id.
      Object.assign(instance, body);
    }

    Object.assign(ref, body);

    // When the route carries a URL :instanceName, that guard-validated value is
    // the single source of truth. Force it back onto both the DTO and the
    // schema ref and drop any instanceId slipped in via query/body, so a caller
    // can never redirect the request to a different instance (cross-instance
    // auth bypass — CVE-2435, #2549). Param-less routes have no URL identity
    // and keep their instanceId/instanceName query filters intact.
    if (urlInstanceName) {
      const attempted = (instance as unknown as Record<string, unknown>).instanceName;
      if (attempted && attempted !== urlInstanceName) {
        logger.warn(
          `Ignoring query/body instanceName "${attempted}" — URL param "${urlInstanceName}" is authoritative`,
        );
      }
      instance.instanceName = urlInstanceName;
      delete (instance as unknown as Record<string, unknown>).instanceId;
      (ref as any).instanceName = urlInstanceName;
    }

    const v = schema ? validate(ref, schema) : { valid: true, errors: [] };

    if (!v.valid) {
      const message: any[] = v.errors.map(({ stack, schema }) => {
        let message: string;
        if (schema['description']) {
          message = schema['description'];
        } else {
          message = stack.replace('instance.', '');
        }
        return message;
      });
      logger.error(message);
      throw new BadRequestException(message);
    }

    return await execute(instance, ref);
  }

  public async groupNoValidate<T>(args: DataValidate<T>) {
    const { request, ClassRef, schema, execute } = args;

    const instance = request.params as unknown as InstanceDto;

    const ref = new ClassRef();

    Object.assign(ref, request.body);

    const v = validate(ref, schema);

    if (!v.valid) {
      const message: any[] = v.errors.map(({ property, stack, schema }) => {
        let message: string;
        if (schema['description']) {
          message = schema['description'];
        } else {
          message = stack.replace('instance.', '');
        }
        return {
          property: property.replace('instance.', ''),
          message,
        };
      });
      logger.error([...message]);
      throw new BadRequestException(...message);
    }

    return await execute(instance, ref);
  }

  public async groupValidate<T>(args: DataValidate<T>) {
    const { request, ClassRef, schema, execute } = args;

    const instance = request.params as unknown as InstanceDto;
    const body = request.body;

    let groupJid = body?.groupJid;

    if (!groupJid) {
      if (request.query?.groupJid) {
        groupJid = request.query.groupJid;
      } else {
        throw new BadRequestException('The group id needs to be informed in the query', 'ex: "groupJid=120362@g.us"');
      }
    }

    if (!groupJid.endsWith('@g.us')) {
      groupJid = groupJid + '@g.us';
    }

    Object.assign(body, {
      groupJid: groupJid,
    });

    const ref = new ClassRef();

    Object.assign(ref, body);

    const v = validate(ref, schema);

    if (!v.valid) {
      const message: any[] = v.errors.map(({ property, stack, schema }) => {
        let message: string;
        if (schema['description']) {
          message = schema['description'];
        } else {
          message = stack.replace('instance.', '');
        }
        return {
          property: property.replace('instance.', ''),
          message,
        };
      });
      logger.error([...message]);
      throw new BadRequestException(...message);
    }

    return await execute(instance, ref);
  }

  public async inviteCodeValidate<T>(args: DataValidate<T>) {
    const { request, ClassRef, schema, execute } = args;

    const inviteCode = request.query as unknown as GroupInvite;

    if (!inviteCode?.inviteCode) {
      throw new BadRequestException(
        'The group invite code id needs to be informed in the query',
        'ex: "inviteCode=F1EX5QZxO181L3TMVP31gY" (Obtained from group join link)',
      );
    }

    const instance = request.params as unknown as InstanceDto;
    const body = request.body;

    const ref = new ClassRef();

    Object.assign(body, inviteCode);
    Object.assign(ref, body);

    const v = validate(ref, schema);

    if (!v.valid) {
      const message: any[] = v.errors.map(({ property, stack, schema }) => {
        let message: string;
        if (schema['description']) {
          message = schema['description'];
        } else {
          message = stack.replace('instance.', '');
        }
        return {
          property: property.replace('instance.', ''),
          message,
        };
      });
      logger.error([...message]);
      throw new BadRequestException(...message);
    }

    return await execute(instance, ref);
  }

  public async getParticipantsValidate<T>(args: DataValidate<T>) {
    const { request, ClassRef, schema, execute } = args;

    const getParticipants = request.query as unknown as GetParticipant;

    if (!getParticipants?.getParticipants) {
      throw new BadRequestException('The getParticipants needs to be informed in the query');
    }

    const instance = request.params as unknown as InstanceDto;
    const body = request.body;

    const ref = new ClassRef();

    Object.assign(body, getParticipants);
    Object.assign(ref, body);

    const v = validate(ref, schema);

    if (!v.valid) {
      const message: any[] = v.errors.map(({ property, stack, schema }) => {
        let message: string;
        if (schema['description']) {
          message = schema['description'];
        } else {
          message = stack.replace('instance.', '');
        }
        return {
          property: property.replace('instance.', ''),
          message,
        };
      });
      logger.error([...message]);
      throw new BadRequestException(...message);
    }

    return await execute(instance, ref);
  }
}
