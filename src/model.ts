import { Static, Type } from '@sinclair/typebox';

const StringEnum = <T extends string[]>(values: [...T]) =>
  Type.Unsafe<T[number]>({
    type: 'string',
    enum: values
  });

export const EncoderStatus = StringEnum([
  'idle',
  'starting',
  'running',
  'stopped',
  'error'
]);
export type EncoderStatus = Static<typeof EncoderStatus>;
export const EncoderStatusResponse = Type.Object({
  status: EncoderStatus,
  playlist: Type.Optional(
    Type.String({ description: 'Origin playlist location' })
  )
});
export type EncoderStatusResponse = Static<typeof EncoderStatusResponse>;

export const EncoderStartRequest = Type.Object({
  timeout: Type.Optional(Type.Number({ description: 'Timeout in seconds' }))
});
export type EncoderStartRequest = Static<typeof EncoderStartRequest>;

export const EncoderStartResponse = Type.Object({
  rtmpPort: Type.Number({ description: 'RTMP port' }),
  streamKey: Type.String({ description: 'Stream key' }),
  outputUrl: Type.Optional(Type.String({ description: 'Output URL' })),
  playlist: Type.String({ description: 'Origin playlist location' }),
  status: EncoderStatus
});
export type EncoderStartResponse = Static<typeof EncoderStartResponse>;
