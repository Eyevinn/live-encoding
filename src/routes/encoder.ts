import { FastifyPluginCallback } from 'fastify';
import { Encoder } from '../encoder';
import { ErrorReply, ErrorResponse, errorReply } from '../api/errors';
import {
  EncoderStartRequest,
  EncoderStartResponse,
  EncoderStatusResponse
} from '../model';

export interface RouteEncoderOpts {
  encoder: Encoder;
}

const encoder: FastifyPluginCallback<RouteEncoderOpts> = (
  fastify,
  opts,
  next
) => {
  const encoder = opts.encoder;

  fastify.setErrorHandler((error, request, reply) => {
    reply.code(500).send({ reason: error.message });
  });

  fastify.get<{
    Reply: EncoderStatusResponse | ErrorResponse;
  }>(
    '/encoder',
    {
      schema: {
        description: 'Get encoder status',
        response: {
          200: EncoderStatusResponse,
          500: ErrorResponse
        }
      }
    },
    async (request, reply) => {
      try {
        const status = await encoder.getStatus();
        reply.send({ status, playlist: encoder.getOriginPlaylist() });
      } catch (err) {
        errorReply(reply as ErrorReply, err);
      }
    }
  );

  fastify.post<{
    Body: EncoderStartRequest;
    Reply: EncoderStartResponse | ErrorResponse;
  }>(
    '/encoder',
    {
      schema: {
        description: 'Start encoder',
        body: EncoderStartRequest,
        response: {
          200: EncoderStartResponse,
          500: ErrorResponse
        }
      }
    },
    async (request, reply) => {
      try {
        const encoding = await encoder.start(request.body);
        reply.send(encoding);
      } catch (err) {
        errorReply(reply as ErrorReply, err);
      }
    }
  );

  fastify.delete<{
    Reply: EncoderStatusResponse | ErrorResponse;
  }>(
    '/encoder',
    {
      schema: {
        description: 'Stop encoder',
        response: {
          200: EncoderStatusResponse,
          500: ErrorResponse
        }
      }
    },
    async (request, reply) => {
      try {
        await encoder.stop();
        const status = await encoder.getStatus();
        reply.send({ status, playlist: encoder.getOriginPlaylist() });
      } catch (err) {
        errorReply(reply as ErrorReply, err);
      }
    }
  );

  next();
};

export default encoder;
