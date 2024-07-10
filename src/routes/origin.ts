import { FastifyPluginCallback } from 'fastify';
import fastifyStatic from '@fastify/static';

export interface RouteOriginOpts {
  mediaPath: string;
}

const origin: FastifyPluginCallback<RouteOriginOpts> = (
  fastify,
  opts,
  next
) => {
  fastify.register(fastifyStatic, {
    root: opts.mediaPath,
    prefix: '/origin'
  });

  next();
};

export default origin;
