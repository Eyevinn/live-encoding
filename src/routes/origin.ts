import { FastifyPluginCallback } from 'fastify';
import fastifyStatic from '@fastify/static';
import path from 'path';
import { DEFAULT_SEGMENT_DURATION } from '../encoder';

export interface RouteOriginOpts {
  mediaPath: string;
  // HLS segment duration in seconds (SEGMENT_DURATION). The Cache-Control
  // TTLs below follow it. Falls back to DEFAULT_SEGMENT_DURATION.
  segmentDuration?: number;
}

// Number of segments ffmpeg keeps in a media playlist (-hls_list_size in
// generateOutput). Bounds the segment TTL, see originCacheControl.
export const HLS_LIST_SIZE = 6;

const SEGMENT_EXTENSIONS = ['.ts', '.m4s', '.mp4', '.vtt'];

// Cache-Control for a file served under /origin, chosen so a CDN in front of
// the service gives segment offload without serving a stale live edge.
//
// - Playlists (.m3u8) change every segment, so they get a TTL of half a
//   segment duration (at least 1 s): a cached playlist is never more than
//   half a segment behind the live edge.
// - Segments (.ts, .m4s, .vtt) and the fMP4 init segment (.mp4) do not change
//   once written, but their names are reused: cleanup() removes the hls dir on
//   every (re)start, numbering restarts at 00 and the init filename is fixed.
//   An immutable or long TTL would then serve the previous session's media
//   after a restart, so the TTL is bounded by the playlist window
//   (HLS_LIST_SIZE x segment duration), the time a segment is referenced.
// - Anything else under /origin is revalidated on every request.
export function originCacheControl(
  filePath: string,
  segmentDuration: number = DEFAULT_SEGMENT_DURATION
): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.m3u8') {
    return `public, max-age=${Math.max(1, Math.floor(segmentDuration / 2))}`;
  }
  if (SEGMENT_EXTENSIONS.includes(ext)) {
    return `public, max-age=${HLS_LIST_SIZE * segmentDuration}`;
  }
  return 'no-cache';
}

const origin: FastifyPluginCallback<RouteOriginOpts> = (
  fastify,
  opts,
  next
) => {
  const segmentDuration = opts.segmentDuration ?? DEFAULT_SEGMENT_DURATION;
  fastify.register(fastifyStatic, {
    root: opts.mediaPath,
    prefix: '/origin',
    // Replace @fastify/static's default 'public, max-age=0' with a header
    // chosen per file type.
    cacheControl: false,
    setHeaders: (res, filePath) => {
      res.setHeader(
        'Cache-Control',
        originCacheControl(filePath, segmentDuration)
      );
    }
  });

  next();
};

export default origin;
