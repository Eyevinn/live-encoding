import fastifyStatic from '@fastify/static';
import api from './api';
import { Encoder } from './encoder';
import { parseFramerate, parseLadder, parseSubtitles } from './config';
import routeEncoder from './routes/encoder';
import routeOrigin from './routes/origin';
import { Log } from './utils/log';
import path from 'path';

const server = api({ title: 'Eyevinn Live Encoding' });

const mediaDir = process.env.ORIGIN_DIR || '/tmp/media';

const PORT = process.env.PORT ? Number(process.env.PORT) : 8000;

const hlsOnly = process.env.HLS_ONLY
  ? process.env.HLS_ONLY.toLowerCase() === 'true' ||
    process.env.HLS_ONLY === '1'
  : true;

const subtitles = parseSubtitles();
const ladder = parseLadder();
const framerate = parseFramerate();

if (!hlsOnly && subtitles.length > 0) {
  Log().warn(
    'SUBTITLE_URL is set but HLS_ONLY is false, subtitles are only carried in ' +
      'the HLS output and will be discarded'
  );
}

const encoderOpts = {
  hlsOnly,
  outputUrl: process.env.OUTPUT_URL
    ? new URL(process.env.OUTPUT_URL)
    : undefined,
  originPort: PORT,
  inputUrl: process.env.INPUT_URL || undefined,
  inputDialTimeoutSec: process.env.INPUT_DIAL_TIMEOUT
    ? Number(process.env.INPUT_DIAL_TIMEOUT)
    : undefined,
  ladder,
  framerate,
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
