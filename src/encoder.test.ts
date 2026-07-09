import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import {
  BitrateLadderStep,
  SubtitleTrack,
  finalizeSubtitleMasterFile,
  generateFilterComplex,
  generateInput,
  generateOutput,
  masterIsComplete,
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

// A two-variant master exactly as ffmpeg 6.1 writes it: the subtitle group is
// advertised only on the variant that carries the subtitle stream (media_1).
const ffmpegMaster = [
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

// The same master after finalizing: every variant references the group and the
// rendition carries the configured labels.
const finalizedMaster = [
  '#EXTM3U',
  '#EXT-X-VERSION:6',
  '#EXT-X-STREAM-INF:BANDWIDTH=4540800,RESOLUTION=1280x720,CODECS="avc1.f4001f,mp4a.40.2",SUBTITLES="subs"',
  'media_0.m3u8',
  '',
  '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English",LANGUAGE="en",AUTOSELECT=YES,DEFAULT=YES,URI="media_1_vtt.m3u8"',
  '#EXT-X-STREAM-INF:BANDWIDTH=3440800,RESOLUTION=640x360,CODECS="avc1.f4001e,mp4a.40.2",SUBTITLES="subs"',
  'media_1.m3u8',
  ''
].join('\n');

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

  test('generateInput appends a bounded sidecar input per subtitle track', () => {
    expect(generateInput(1935, 'stream', subtitleTracks)).toEqual([
      '-y',
      '-loglevel',
      'error',
      '-listen',
      '1',
      '-i',
      'rtmp://0.0.0.0:1935/live/stream',
      '-rw_timeout',
      '15000000',
      '-i',
      'https://example.com/subs/en.vtt'
    ]);
  });

  test('generateOutput emits subtitle map and group against a golden array', () => {
    expect(generateOutput(true, testLadder, '/data', subtitleTracks)).toEqual([
      '-map',
      '1:0',
      '-c:s',
      'webvtt',
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
      'v:0,a:0 v:1,a:1,s:0,sgroup:subs',
      '/data/hls/media_%v.m3u8'
    ]);
  });

  test('generateOutput is byte-identical to the no-arg form without subtitles', () => {
    expect(generateOutput(true, testLadder, '/data', [])).toEqual([
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

  test('rewriteMasterPlaylist matches the golden finalized master', () => {
    expect(rewriteMasterPlaylist(ffmpegMaster, subtitleTracks, 'subs')).toEqual(
      finalizedMaster
    );
  });

  test('rewriteMasterPlaylist is idempotent', () => {
    const once = rewriteMasterPlaylist(ffmpegMaster, subtitleTracks, 'subs');
    const twice = rewriteMasterPlaylist(once, subtitleTracks, 'subs');
    expect(twice).toEqual(once);
  });

  test('rewriteMasterPlaylist handles a single-variant master', () => {
    const master = [
      '#EXTM3U',
      '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="subtitle_0",DEFAULT=YES,URI="media_0_vtt.m3u8"',
      '#EXT-X-STREAM-INF:BANDWIDTH=4540800,RESOLUTION=1280x720,SUBTITLES="subs"',
      'media_0.m3u8'
    ].join('\n');
    const rewritten = rewriteMasterPlaylist(master, subtitleTracks, 'subs');
    const streamInf = rewritten
      .split('\n')
      .filter((line) => line.startsWith('#EXT-X-STREAM-INF:'));
    expect(streamInf.length).toEqual(1);
    expect(streamInf[0]).toContain('SUBTITLES="subs"');
    expect(rewritten).toContain('NAME="English"');
  });

  test('rewriteMasterPlaylist clamps mediaIndex for extra MEDIA lines', () => {
    const master = [
      '#EXTM3U',
      '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="a",URI="a.m3u8"',
      '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="b",URI="b.m3u8"',
      '#EXT-X-STREAM-INF:BANDWIDTH=1,SUBTITLES="subs"',
      'media_0.m3u8'
    ].join('\n');
    const media = rewriteMasterPlaylist(master, subtitleTracks, 'subs')
      .split('\n')
      .filter((line) => line.startsWith('#EXT-X-MEDIA:'));
    // The single configured track is clamped to both MEDIA lines, URIs kept.
    expect(media[0]).toContain('NAME="English"');
    expect(media[0]).toContain('URI="a.m3u8"');
    expect(media[1]).toContain('NAME="English"');
    expect(media[1]).toContain('URI="b.m3u8"');
  });

  test('rewriteMasterPlaylist leaves a MEDIA line without URI alone', () => {
    const master = [
      '#EXTM3U',
      '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="x"',
      '#EXT-X-STREAM-INF:BANDWIDTH=1',
      'media_0.m3u8'
    ].join('\n');
    const rewritten = rewriteMasterPlaylist(master, subtitleTracks, 'subs');
    expect(rewritten).toContain(
      '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="x"'
    );
    expect(rewritten).not.toContain('URI=""');
  });

  test('rewriteMasterPlaylist leaves the playlist untouched without subtitles', () => {
    const master = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nmedia_0.m3u8\n';
    expect(rewriteMasterPlaylist(master, [], 'subs')).toEqual(master);
  });

  test('masterIsComplete requires the subtitle rendition and every variant', () => {
    expect(masterIsComplete(ffmpegMaster, 2)).toBe(true);
    // Missing the EXT-X-MEDIA subtitle rendition.
    const noMedia = ffmpegMaster
      .split('\n')
      .filter((line) => !line.startsWith('#EXT-X-MEDIA:'))
      .join('\n');
    expect(masterIsComplete(noMedia, 2)).toBe(false);
    // Only one variant written so far.
    expect(masterIsComplete(ffmpegMaster, 3)).toBe(false);
  });
});

describe('finalizeSubtitleMasterFile', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'le-subs-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test('finalizes a complete master on disk, atomically and idempotently', async () => {
    const master = path.join(dir, 'index.m3u8');
    await writeFile(master, ffmpegMaster);

    const first = await finalizeSubtitleMasterFile(master, subtitleTracks, 2);
    expect(first).toBe(true);
    expect(await readFile(master, 'utf-8')).toEqual(finalizedMaster);
    // No temp file left behind by the rename.
    let tmpExists = true;
    try {
      await readFile(`${master}.tmp`, 'utf-8');
    } catch {
      tmpExists = false;
    }
    expect(tmpExists).toBe(false);

    // Running again is idempotent: the file content does not change.
    const second = await finalizeSubtitleMasterFile(master, subtitleTracks, 2);
    expect(second).toBe(true);
    expect(await readFile(master, 'utf-8')).toEqual(finalizedMaster);
  });

  test('refuses to rewrite an incomplete master and leaves it untouched', async () => {
    const master = path.join(dir, 'index.m3u8');
    const incomplete = ffmpegMaster
      .split('\n')
      .filter((line) => !line.startsWith('#EXT-X-MEDIA:'))
      .join('\n');
    await writeFile(master, incomplete);

    const done = await finalizeSubtitleMasterFile(master, subtitleTracks, 2);
    expect(done).toBe(false);
    expect(await readFile(master, 'utf-8')).toEqual(incomplete);
  });
});
