import {
  BitrateLadderStep,
  SubtitleTrack,
  generateFilterComplex,
  generateInput,
  generateOutput,
  rewriteMasterPlaylist
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

const subtitleTracks: SubtitleTrack[] = [
  {
    url: 'https://example.com/subs/en.vtt',
    language: 'en',
    name: 'English',
    default: true
  }
];

describe('subtitle passthrough', () => {
  test('generateInput is unchanged without subtitles', () => {
    expect(generateInput(1935, 'stream')).toEqual([
      '-y',
      '-loglevel',
      'error',
      '-listen',
      '1',
      '-i',
      'rtmp://0.0.0.0:1935/live/stream'
    ]);
  });

  test('generateInput appends a sidecar input per subtitle track', () => {
    expect(generateInput(1935, 'stream', subtitleTracks)).toEqual([
      '-y',
      '-loglevel',
      'error',
      '-listen',
      '1',
      '-i',
      'rtmp://0.0.0.0:1935/live/stream',
      '-i',
      'https://example.com/subs/en.vtt'
    ]);
  });

  test('generateOutput maps the subtitle and groups it on the last variant', () => {
    const args = generateOutput(true, testLadder, '/data', subtitleTracks);
    expect(args.slice(0, 4)).toEqual(['-map', '1:0', '-c:s', 'webvtt']);
    const varStreamMapIndex = args.indexOf('-var_stream_map');
    expect(args[varStreamMapIndex + 1]).toEqual(
      'v:0,a:0 v:1,a:1,s:0,sgroup:subs'
    );
  });

  test('generateOutput is unchanged when no subtitles are configured', () => {
    expect(generateOutput(true, testLadder, '/data', [])).toEqual(
      generateOutput(true, testLadder, '/data')
    );
  });

  test('rewriteMasterPlaylist broadens the subtitle group to every variant', () => {
    const master = [
      '#EXTM3U',
      '#EXT-X-VERSION:6',
      '#EXT-X-STREAM-INF:BANDWIDTH=4540800,RESOLUTION=1280x720,CODECS="avc1.f4001f,mp4a.40.2"',
      'media_0.m3u8',
      '',
      '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="subtitle_1",DEFAULT=YES,URI="media_1_vtt.m3u8"',
      '#EXT-X-STREAM-INF:BANDWIDTH=3440800,RESOLUTION=640x360,CODECS="avc1.f4001e,mp4a.40.2",SUBTITLES="subs"',
      'media_1.m3u8',
      ''
    ].join('\n');

    const rewritten = rewriteMasterPlaylist(master, subtitleTracks, 'subs');
    const lines = rewritten.split('\n');

    const streamInf = lines.filter((line) =>
      line.startsWith('#EXT-X-STREAM-INF:')
    );
    expect(streamInf.length).toEqual(2);
    streamInf.forEach((line) => {
      expect(line).toContain('SUBTITLES="subs"');
    });

    const media = lines.find((line) => line.startsWith('#EXT-X-MEDIA:'));
    expect(media).toEqual(
      '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English",' +
        'LANGUAGE="en",AUTOSELECT=YES,DEFAULT=YES,URI="media_1_vtt.m3u8"'
    );
  });

  test('rewriteMasterPlaylist leaves the playlist untouched without subtitles', () => {
    const master = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nmedia_0.m3u8\n';
    expect(rewriteMasterPlaylist(master, [], 'subs')).toEqual(master);
  });
});
