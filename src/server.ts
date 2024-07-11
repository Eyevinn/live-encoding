import api from './api';
import { Encoder } from './encoder';
import routeEncoder from './routes/encoder';
import routeOrigin from './routes/origin';
import { Log } from './utils/log';

const server = api({ title: 'Eyevinn Live Encoding' });

const mediaDir = process.env.ORIGIN_DIR || '/tmp/media';

const PORT = process.env.PORT ? Number(process.env.PORT) : 8000;

const encoderOpts = {
  hlsOnly: process.env.HLS_ONLY
    ? process.env.HLS_ONLY.toLowerCase() === 'true' ||
      process.env.HLS_ONLY === '1'
    : true,
  outputUrl: process.env.OUTPUT_URL
    ? new URL(process.env.OUTPUT_URL)
    : undefined,
  originPort: PORT
};
const encoder = new Encoder(
  process.env.FFMPEG_EXECUTABLE || 'ffmpeg',
  process.env.SHAKA_PACKAGER_EXECUTABLE || 'packager',
  process.env.RTMP_PORT ? parseInt(process.env.RTMP_PORT, 10) : 1935,
  process.env.STREAM_KEY || 'stream',
  mediaDir,
  encoderOpts
);

server.register(routeEncoder, { encoder });
server.register(routeOrigin, {
  mediaPath: mediaDir
});
server.listen({ port: PORT, host: '0.0.0.0' }, (err, address) => {
  if (err) {
    throw err;
  }
  Log().info(`Server listening on ${address}`);
});

export default server;
