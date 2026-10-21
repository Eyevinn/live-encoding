import fastifyStatic from '@fastify/static';
import api from './api';
import { Encoder } from './encoder';
import {
  boolFromEnv,
  parseBufsizeFactor,
  parseFramerate,
  parseHlsOnly,
  parseLadder,
  parseMaxrateFactor,
  parseOutputUrl,
  parseRateControl,
  parseSegmentDuration,
  parseSegmentType,
  parseSubtitles
} from './config';
import routeEncoder from './routes/encoder';
import routeOrigin from './routes/origin';
import { Log } from './utils/log';
import path from 'path';

const server = api({ title: 'Eyevinn Live Encoding' });

const mediaDir = process.env.ORIGIN_DIR || '/tmp/media';

const PORT = process.env.PORT ? Number(process.env.PORT) : 8000;

const hlsOnly = parseHlsOnly();

const subtitles = parseSubtitles();
const ladder = parseLadder();
const framerate = parseFramerate();
const rateControl = {
  mode: parseRateControl(),
  maxrateFactor: parseMaxrateFactor(),
  bufsizeFactor: parseBufsizeFactor()
};
const segmentDuration = parseSegmentDuration();
const segmentType = parseSegmentType();
const programDateTime = boolFromEnv(process.env.PROGRAM_DATE_TIME);

Log().info(`HLS_ONLY resolved to ${hlsOnly}`);

// HLS is the only output the encoder implements, so it is always produced:
// HLS_ONLY=false adds no other output today. Warn so the setting is not
// mistaken for one that changes what is written.
if (!hlsOnly) {
  Log().warn(
    'HLS_ONLY is false but no non-HLS output is implemented, HLS output is ' +
      'still produced'
  );
}

// The CDN-push path (OUTPUT_URL -> hls-pull-push) uploads and rewrites media
// segment URIs only: it has no handling for the fMP4 initialisation segment, so
// the pushed playlists keep an #EXT-X-MAP pointing at this encoder's local
// origin and the init file is never delivered. Under fmp4 the pushed stream is
// therefore undecodable. Warn loudly rather than fail, since an operator may be
// delivering the init segment by another route, but never leave it silent.
if (segmentType === 'fmp4' && process.env.OUTPUT_URL) {
  Log().warn(
    'SEGMENT_TYPE=fmp4 is set together with OUTPUT_URL: the CDN push does ' +
      'not carry the fMP4 initialisation segment, so the pushed stream will ' +
      'reference an EXT-X-MAP that the destination cannot fetch. Use the ' +
      'local origin for fMP4, or deliver the init segment separately'
  );
}

// With FRAMERATE set the GOP is 2 x framerate, a 2 s keyframe cadence, and
// ffmpeg's hls muxer only cuts segments at keyframes, so a duration that is
// not a multiple of 2 is extended to the next keyframe (e.g. 5 becomes 6).
// This is valid HLS, so it is a warning rather than a startup failure.
if (segmentDuration !== undefined && framerate && segmentDuration % 2 !== 0) {
  Log().warn(
    `SEGMENT_DURATION ${segmentDuration} is not a multiple of the 2 s ` +
      'keyframe cadence derived from FRAMERATE, actual segments will be ' +
      'extended to the next keyframe'
  );
}

const encoderOpts = {
  hlsOnly,
  outputUrl: process.env.OUTPUT_URL
    ? parseOutputUrl(process.env.OUTPUT_URL)
    : undefined,
  originPort: PORT,
  inputUrl: process.env.INPUT_URL || undefined,
  inputDialTimeoutSec: process.env.INPUT_DIAL_TIMEOUT
    ? Number(process.env.INPUT_DIAL_TIMEOUT)
    : undefined,
  ladder,
  framerate,
  rateControl,
  segmentDuration,
  segmentType,
  programDateTime,
  subtitles
};
const encoder = new Encoder(
  process.env.FFMPEG_EXECUTABLE || 'ffmpeg',
  process.env.SHAKA_PACKAGER_EXECUTABLE || 'packager',
  process.env.RTMP_PORT ? parseInt(process.env.RTMP_PORT, 10) : 1935,
  process.env.STREAM_KEY || 'stream',
  mediaDir,
  encoderOpts
);

server.register(routeEncoder, { prefix: '/api', encoder });
server.register(routeOrigin, {
  mediaPath: mediaDir
});
server.register(fastifyStatic, {
  root: path.join(__dirname, '../out'),
  prefix: '/'
});
server.listen({ port: PORT, host: '0.0.0.0' }, (err, address) => {
  if (err) {
    throw err;
  }
  Log().info(`Server listening on ${address}`);
});

export default server;
