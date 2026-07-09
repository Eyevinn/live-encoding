import {
  BitrateLadderStep,
  Encoder,
  generateFilterComplex,
  generateInput,
  generateOutput
} from './encoder';

const testLadder: BitrateLadderStep[] = [
  {
    mediaType: 'video',
    bitrate: '6M',
    video: { width: 1280, height: 720 }
  },
  {
    mediaType: 'video',
    bitrate: '3M',
    video: { width: 640, height: 360 }
  },
  {
    mediaType: 'audio',
    bitrate: '128k',
    audio: { channels: 2, sampleRate: 48000 }
  }
];

describe('encoder util', () => {
  test('can generate filter-complex args', () => {
    const filterComplex = generateFilterComplex(testLadder);
    expect(filterComplex).toEqual([
      '-filter_complex',
      '[0:v]split=2[v1][v2];[v1]scale=w=1280:h=720[v1out];[v2]scale=w=640:h=360[v2out]',

      '-map',
      '[v1out]',
      '-c:v:0',
      'libx264',
      '-x264-params',
      'nal-hrd=cbr:force-cfr=1',
      '-b:v:0',
      '6M',
      '-maxrate:v:0',
      '6M',
      '-minrate:v:0',
      '6M',
      '-bufsize:v:0',
      '6M',
      '-preset',
      'ultrafast',
      '-g',
      '48',
      '-sc_threshold',
      '0',
      '-keyint_min',
      '48',

      '-map',
      '[v2out]',
      '-c:v:1',
      'libx264',
      '-x264-params',
      'nal-hrd=cbr:force-cfr=1',
      '-b:v:1',
      '3M',
      '-maxrate:v:1',
      '3M',
      '-minrate:v:1',
      '3M',
      '-bufsize:v:1',
      '3M',
      '-preset',
      'ultrafast',
      '-g',
      '48',
      '-sc_threshold',
      '0',
      '-keyint_min',
      '48',

      '-map',
      'a:0',
      '-c:a:0',
      'aac',
      '-b:a:0',
      '128k',
      '-ar',
      '48000',
      '-ac',
      '2',

      '-map',
      'a:0',
      '-c:a:1',
      'aac',
      '-b:a:1',
      '128k',
      '-ar',
      '48000',
      '-ac',
      '2'
    ]);
  });

  test('generates RTMP listener input args by default', () => {
    const input = generateInput(1935, 'stream');
    expect(input).toEqual([
      '-y',
      '-loglevel',
      'error',
      '-listen',
      '1',
      '-i',
      'rtmp://0.0.0.0:1935/live/stream'
    ]);
  });

  test('generates caller-mode input args when an input URL is set', () => {
    const input = generateInput(
      1935,
      'stream',
      'srt://example.com:9000?latency=200&streamid=abc'
    );
    expect(input).toEqual([
      '-y',
      '-loglevel',
      'error',
      '-i',
      'srt://example.com:9000?latency=200&streamid=abc'
    ]);
    // No RTMP listener args when dialing a caller-mode source.
    expect(input).not.toContain('-listen');
  });

  test('can generate outout args', () => {
    const hlsOnly = generateOutput(true, testLadder, '/data');
    expect(hlsOnly).toEqual([
      '-f',
      'hls',
      '-hls_time',
      '10',
      '-hls_flags',
      'independent_segments+delete_segments',
      '-hls_segment_type',
      'mpegts',
      '-hls_segment_filename',
      '/data/hls/media_%v_%02d.ts',
      '-hls_list_size',
      '6',
      '-master_pl_name',
      'index.m3u8',
      '-var_stream_map',
      'v:0,a:0 v:1,a:1',
      '/data/hls/media_%v.m3u8'
    ]);
  });
});

describe('encoder input URL validation', () => {
  const build = (inputUrl?: string) =>
    new Encoder('ffmpeg', 'packager', 1935, 'stream', '/data', {
      hlsOnly: true,
      inputUrl
    });

  test('accepts an srt:// input URL', () => {
    expect(() => build('srt://example.com:9000?latency=200')).not.toThrow();
  });

  test('accepts no input URL (default RTMP listener)', () => {
    expect(() => build(undefined)).not.toThrow();
  });

  test('rejects a non-srt protocol', () => {
    expect(() => build('rtsp://example.com:554/stream')).toThrow(
      /only srt:\/\/ is supported/
    );
  });

  test('rejects a value that is not a URL', () => {
    expect(() => build('not-a-url')).toThrow(/not a valid URL/);
  });
});
