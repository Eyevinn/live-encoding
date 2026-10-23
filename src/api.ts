import fastify from 'fastify';
import cors from '@fastify/cors';
import swagger from '@fastify/swagger';
import swaggerUI from '@fastify/swagger-ui';
import { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { Static, Type } from '@sinclair/typebox';
import { FastifyPluginCallback } from 'fastify';

const HelloWorld = Type.String({
  description: 'The magical words!'
});

export interface HealthcheckOptions {
  title: string;
}

const healthcheck: FastifyPluginCallback<HealthcheckOptions> = (
  fastify,
  opts,
  next
) => {
  fastify.get<{ Reply: Static<typeof HelloWorld> }>(
    '/',
    {
      schema: {
        description: 'Say hello',
        response: {
          200: HelloWorld
        }
      }
    },
    async (_, reply) => {
      reply.send('Hello, world! I am ' + opts.title);
    }
  );
  next();
};

export interface ApiOptions {
  title: string;
}

export const API_PREFIX = '/api';

// True for /api, /api/... and /api?..., but not for e.g. /apiary.
export function isApiPath(url: string): boolean {
  return (
    url === API_PREFIX ||
    url.startsWith(API_PREFIX + '/') ||
    url.startsWith(API_PREFIX + '?')
  );
}

export default (opts: ApiOptions) => {
  const api = fastify({
    ignoreTrailingSlash: true
  }).withTypeProvider<TypeBoxTypeProvider>();

  // register the cors plugin, configure it for better security
  api.register(cors);

  // Every response under /api (encoder status/control, healthcheck, Swagger UI)
  // is dynamic or tied to the running instance, so a CDN or browser must never
  // store it. The /api routes come from several plugins (healthcheck, swagger-ui,
  // the encoder routes registered by the server), so the hook sits on the root
  // instance and is scoped to the /api prefix by path. onSend runs after the
  // handlers, so it also overrides the header @fastify/static sets for the
  // Swagger UI assets.
  //
  // Error responses (status >= 400) outside /api are marked no-store as well.
  // @fastify/static only sets the per-type /origin header and the UI header
  // for files it finds, so a 404 for an index.m3u8 that ffmpeg has not written
  // yet (before the stream starts, or right after cleanup() on a (re)start)
  // would otherwise carry no Cache-Control and a CDN would cache it for its
  // default TTL, keeping the stream unplayable after it goes live.
  api.addHook('onSend', async (request, reply, payload) => {
    if (isApiPath(request.raw.url ?? request.url) || reply.statusCode >= 400) {
      reply.header('Cache-Control', 'no-store');
    }
    return payload;
  });

  // register the swagger plugins, it will automagically do magic
  api.register(swagger, {
    swagger: {
      info: {
        title: opts.title,
        description: 'Live Encoder Management API',
        version: 'v1'
      }
    }
  });
  api.register(swaggerUI, {
    routePrefix: '/api/docs'
  });

  api.register(healthcheck, { title: opts.title, prefix: '/api' });

  return api;
};
