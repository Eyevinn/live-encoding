import fastifyStatic from '@fastify/static';
import path from 'path';
import api from './api';
import { Encoder } from './encoder';
import routeEncoder from './routes/encoder';
import routeOrigin from './routes/origin';

export interface BuildServerOpts {
  title: string;
  encoder: Encoder;
  // Directory served under /origin (ORIGIN_DIR).
  mediaDir: string;
  // HLS segment duration in seconds; drives the /origin Cache-Control TTLs.
  segmentDuration?: number;
  // Directory with the built control UI served under /. Defaults to out/.
  uiRoot?: string;
}

// Builds the HTTP server without listening, so it can be exercised with
// fastify inject in tests.
export function buildServer(opts: BuildServerOpts) {
  const server = api({ title: opts.title });

  server.register(routeEncoder, { prefix: '/api', encoder: opts.encoder });
  server.register(routeOrigin, {
    mediaPath: opts.mediaDir,
    segmentDuration: opts.segmentDuration
  });
  server.register(fastifyStatic, {
    root: opts.uiRoot ?? path.join(__dirname, '../out'),
    prefix: '/',
    // The control UI must be revalidated so a release is picked up at once,
    // rather than leaving the TTL to a CDN's default.
    cacheControl: false,
    setHeaders: (res) => {
      res.setHeader('Cache-Control', 'no-cache');
    }
  });
  return server;
}
