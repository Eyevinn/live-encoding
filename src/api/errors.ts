import {
  FastifyReply,
  RawReplyDefaultExpression,
  RawRequestDefaultExpression,
  RawServerDefault
} from 'fastify';
import { Static, Type } from '@sinclair/typebox';
import { InvalidInputError, NotFoundError } from '../utils/error';

export const ErrorResponse = Type.Object({
  reason: Type.String({ description: 'Reason why something failed' })
});
export type ErrorResponse = Static<typeof ErrorResponse>;

export type ErrorReply = FastifyReply<
  RawServerDefault,
  RawRequestDefaultExpression,
  RawReplyDefaultExpression,
  { Reply: ErrorResponse }
>;

export const errorReply = (reply: ErrorReply, err: unknown) => {
  if (err instanceof NotFoundError) {
    reply.code(404).send({ reason: err.message });
  } else if (err instanceof InvalidInputError) {
    reply.code(400).send({ reason: err.message });
  } else {
    reply.code(500).send({ reason: 'Unhandled error: ' + err });
  }
};
