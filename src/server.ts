import fastifyStatic from '@fastify/static';
import api from './api';
import { Encoder, SubtitleTrack } from './encoder';
import routeEncoder from './routes/encoder';
import routeOrigin from './routes/origin';
import { Log } from './utils/log';
import path from 'path';

const server = api({ title: 'Eyevinn Live Encoding' });

const mediaDir = process.env.ORIGIN_DIR || '/tmp/media';

const PORT = process.env.PORT ? Number(process.env.PORT) : 8000;

function boolFromEnv(value: string | undefined): boolean {
  return value ? value.toLowerCase() === 'true' || value === '1' : false;
}

// Parse the optional sidecar WebVTT subtitle configuration. Unset leaves the
// output video+audio only, exactly as before. The config is shaped as an array
// so additional tracks can be added later; a single track is read from the
// environment today.
function parseSubtitles(): SubtitleTrack[] {
  const url = process.env.SUBTITLE_URL;
  if (!url) {
    return [];
  }
  const parsed = new URL(url);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Unsupported subtitle URL protocol ${parsed.protocol}`);
  }
  const language = process.env.SUBTITLE_LANGUAGE || 'und';
  return [
    {
      url,
      language,
      name: process.env.SUBTITLE_NAME || language,
      default: boolFromEnv(process.env.SUBTITLE_DEFAULT)
    }
  ];
}

const encoderOpts = {
  hlsOnly: process.env.HLS_ONLY
    ? process.env.HLS_ONLY.toLowerCase() === 'true' ||
      process.env.HLS_ONLY === '1'
    : true,
  outputUrl: process.env.OUTPUT_URL
    ? new URL(process.env.OUTPUT_URL)
    : undefined,
  originPort: PORT,
  subtitles: parseSubtitles()
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
