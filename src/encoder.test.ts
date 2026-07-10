import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import {
  BitrateLadderStep,
  DEFAULT_INPUT_DIAL_TIMEOUT_SEC,
  Encoder,
  SubtitleTrack,
  finalizeSubtitleMasterFile,
  generateFilterComplex,
  generateInput,
  generateOutput,
  masterIsComplete,
  redactSecrets,
  rewriteMasterPlaylist
} from './encoder';

jest.mock('child_process', () => ({
  ...jest.requireActual('child_process'),
  spawn: jest.fn()
}));

// Wrap the few fs calls the encoder makes as jest.fn that default to the real
// implementation, so they can be overridden per test (core module properties
// are otherwise non-configurable and cannot be spied on directly).
jest.mock('fs', () => {
  const actual = jest.requireActual('fs');
  return { ...actual, existsSync: jest.fn(actual.existsSync) };
});
jest.mock('fs/promises', () => {
  const actual = jest.requireActual('fs/promises');
  return {
    ...actual,
    access: jest.fn(actual.access),
    mkdir: jest.fn(actual.mkdir),
    rm: jest.fn(actual.rm),
    readFile: jest.fn(actual.readFile),
    writeFile: jest.fn(actual.writeFile),
    rename: jest.fn(actual.rename)
  };
});

const mockedSpawn = spawn as unknown as jest.Mock;
const realFsPromises = jest.requireActual('fs/promises') as typeof fsPromises;
const realFs = jest.requireActual('fs') as typeof fs;

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

  test('rejects an srt URL without a host', () => {
    expect(() => build('srt://')).toThrow(/must include a host and port/);
  });

  test('rejects an srt URL without a port', () => {
    expect(() => build('srt://example.com')).toThrow(
      /must include a host and port/
    );
  });

  test('does not leak a passphrase in validation errors', () => {
    let message = '';
    try {
      build('srt://?passphrase=topsecret');
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/must include a host and port/);
    expect(message).not.toContain('topsecret');
  });
});

describe('redactSecrets', () => {
  test('strips URL query strings that may carry secrets', () => {
    expect(
      redactSecrets('srt://host:9000?passphrase=secret&latency=200000')
    ).toBe('srt://host:9000?<redacted>');
  });

  test('leaves URLs without a query string unchanged', () => {
    expect(redactSecrets('rtmp://0.0.0.0:1935/live/stream')).toBe(
      'rtmp://0.0.0.0:1935/live/stream'
    );
  });
});

const spawnedProcs: EventEmitter[] = [];

const makeProc = (autoExit = false) => {
  const proc = new EventEmitter() as EventEmitter & {
    stderr: EventEmitter;
    spawnargs: string[];
    kill: jest.Mock;
  };
  proc.stderr = new EventEmitter();
  proc.spawnargs = ['ffmpeg'];
  // Killing the process emits a synchronous exit so the encoder observes it.
  proc.kill = jest.fn(() => proc.emit('exit', null));
  // autoExit simulates a process that dies immediately (a failed dial).
  if (autoExit) {
    queueMicrotask(() => proc.emit('exit', 1));
  }
  spawnedProcs.push(proc);
  return proc;
};

const buildEncoder = (
  mediaDir: string,
  opts: { inputUrl?: string; inputDialTimeoutSec?: number }
) =>
  new Encoder('ffmpeg', 'packager', 1935, 'stream', mediaDir, {
    hlsOnly: true,
    ...opts
  });

describe('encoder SRT caller dial lifecycle', () => {
  // Filesystem calls are stubbed so the monitor loop resolves purely through
  // microtasks, making the fake-timer transitions deterministic. hlsIndex is
  // reported absent so the encoder never spuriously reaches 'running'.
  beforeEach(() => {
    jest.useFakeTimers();
    spawnedProcs.length = 0;
    mockedSpawn.mockReset();
    mockedSpawn.mockImplementation(() => makeProc());
    // Resolve all fs calls through microtasks so the fake-timer transitions
    // are deterministic; the HLS index is reported absent so the encoder never
    // spuriously reaches 'running'.
    (fs.existsSync as jest.Mock).mockReturnValue(true);
    (fsPromises.mkdir as jest.Mock).mockResolvedValue(undefined);
    (fsPromises.rm as jest.Mock).mockResolvedValue(undefined);
    (fsPromises.access as jest.Mock).mockRejectedValue(new Error('ENOENT'));
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    // Restore real fs behaviour for the remaining describes in this file.
    (fs.existsSync as jest.Mock).mockImplementation(realFs.existsSync);
    (fsPromises.mkdir as jest.Mock).mockImplementation(realFsPromises.mkdir);
    (fsPromises.rm as jest.Mock).mockImplementation(realFsPromises.rm);
    (fsPromises.access as jest.Mock).mockImplementation(realFsPromises.access);
  });

  test('re-dials exactly once after a pre-running exit', async () => {
    const encoder = buildEncoder('/media', { inputUrl: 'srt://source:9000' });
    await encoder.start({});
    expect(mockedSpawn).toHaveBeenCalledTimes(1);

    // Simulate a dial failure before the encoder ever reached running.
    spawnedProcs[0].emit('exit', 1);
    await jest.advanceTimersByTimeAsync(5000);

    expect(mockedSpawn).toHaveBeenCalledTimes(2);
    expect(await encoder.getStatus()).toBe('starting');
  });

  test('lands in error, not stopped, when the dial deadline passes', async () => {
    const encoder = buildEncoder('/media', {
      inputUrl: 'srt://source:9000',
      inputDialTimeoutSec: 3
    });
    await encoder.start({});
    spawnedProcs[0].emit('exit', 1);
    await jest.advanceTimersByTimeAsync(5000);

    expect(await encoder.getStatus()).toBe('error');
    // No further dial attempt once the deadline is exceeded.
    expect(mockedSpawn).toHaveBeenCalledTimes(1);
  });

  test('applies the default dial deadline when no timeout is supplied', async () => {
    expect(DEFAULT_INPUT_DIAL_TIMEOUT_SEC).toBe(300);
    // Every dial attempt fails immediately, so the encoder keeps re-dialing.
    mockedSpawn.mockImplementation(() => makeProc(true));
    const encoder = buildEncoder('/media', { inputUrl: 'srt://source:9000' });
    await encoder.start({});

    // Well before the default deadline the encoder is still re-dialing.
    await jest.advanceTimersByTimeAsync(5000);
    expect(await encoder.getStatus()).toBe('starting');

    // Past the default deadline a never-connecting source lands in error.
    await jest.advanceTimersByTimeAsync(
      (DEFAULT_INPUT_DIAL_TIMEOUT_SEC + 10) * 1000
    );
    expect(await encoder.getStatus()).toBe('error');
  });

  test('RTMP listener still stops (not errors) on start timeout', async () => {
    const encoder = buildEncoder('/media', {});
    await encoder.start({ timeout: 3 });

    // Process stays alive but never produces an HLS index. The extra time
    // covers the internal wait-for-kill poll inside stop().
    await jest.advanceTimersByTimeAsync(8000);
    expect(await encoder.getStatus()).toBe('stopped');
  });

  test('redacts secrets in ffmpeg stderr output', async () => {
    const errorSpy = jest
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const encoder = buildEncoder('/media', { inputUrl: 'srt://source:9000' });
    await encoder.start({});

    const proc = spawnedProcs[0] as EventEmitter & { stderr: EventEmitter };
    proc.stderr.emit(
      'data',
      'Connection to srt://source:9000?passphrase=SUPERSECRETPASS123 failed: I/O error'
    );

    const logged = errorSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).not.toContain('SUPERSECRETPASS123');
    expect(logged).toContain('<redacted>');
    errorSpy.mockRestore();
  });
});

describe('encoder clears stale HLS output before starting', () => {
  let mediaDir: string;

  beforeEach(() => {
    jest.useFakeTimers();
    spawnedProcs.length = 0;
    mockedSpawn.mockReset();
    mockedSpawn.mockImplementation(() => makeProc());
    // This describe exercises the real filesystem.
    (fs.existsSync as jest.Mock).mockImplementation(realFs.existsSync);
    (fsPromises.mkdir as jest.Mock).mockImplementation(realFsPromises.mkdir);
    (fsPromises.rm as jest.Mock).mockImplementation(realFsPromises.rm);
    (fsPromises.access as jest.Mock).mockImplementation(realFsPromises.access);
    mediaDir = realFs.mkdtempSync(
      path.join(os.tmpdir(), 'live-encoding-test-')
    );
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    fs.rmSync(mediaDir, { recursive: true, force: true });
  });

  test('removes a stale index so status does not flip to running', async () => {
    fs.mkdirSync(path.join(mediaDir, 'hls'), { recursive: true });
    fs.writeFileSync(path.join(mediaDir, 'hls', 'index.m3u8'), '#EXTM3U');

    const encoder = buildEncoder(mediaDir, { inputUrl: 'srt://source:9000' });
    await encoder.start({});

    expect(fs.existsSync(path.join(mediaDir, 'hls', 'index.m3u8'))).toBe(false);
    expect(await encoder.getStatus()).toBe('starting');
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
  test('generateInput appends a bounded sidecar input in RTMP mode', () => {
    expect(generateInput(1935, 'stream', undefined, subtitleTracks)).toEqual([
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

  test('generateInput keeps SRT input first and appends the sidecar in caller mode', () => {
    expect(
      generateInput(
        1935,
        'stream',
        'srt://source:9000?streamid=abc',
        subtitleTracks
      )
    ).toEqual([
      '-y',
      '-loglevel',
      'error',
      '-i',
      'srt://source:9000?streamid=abc',
      '-rw_timeout',
      '15000000',
      '-i',
      'https://example.com/subs/en.vtt'
    ]);
  });

  test('generateOutput maps the sidecar as input 1 and groups it on the last variant', () => {
    const args = generateOutput(true, testLadder, '/data', subtitleTracks);
    // The sidecar is input index 1 in both RTMP and SRT mode (single primary
    // input), so -map 1:0 resolves to the subtitle in either case.
    expect(args.slice(0, 4)).toEqual(['-map', '1:0', '-c:s', 'webvtt']);
    const varStreamMapIndex = args.indexOf('-var_stream_map');
    expect(args[varStreamMapIndex + 1]).toEqual(
      'v:0,a:0 v:1,a:1,s:0,sgroup:subs'
    );
  });

  test('generateOutput is byte-identical to the no-arg form without subtitles', () => {
    expect(generateOutput(true, testLadder, '/data', [])).toEqual(
      generateOutput(true, testLadder, '/data')
    );
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
    const noMedia = ffmpegMaster
      .split('\n')
      .filter((line) => !line.startsWith('#EXT-X-MEDIA:'))
      .join('\n');
    expect(masterIsComplete(noMedia, 2)).toBe(false);
    expect(masterIsComplete(ffmpegMaster, 3)).toBe(false);
  });
});

describe('finalizeSubtitleMasterFile', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await realFsPromises.mkdtemp(path.join(os.tmpdir(), 'le-subs-'));
  });

  afterEach(async () => {
    await realFsPromises.rm(dir, { recursive: true, force: true });
  });

  test('finalizes a complete master on disk, atomically and idempotently', async () => {
    const master = path.join(dir, 'index.m3u8');
    await realFsPromises.writeFile(master, ffmpegMaster);

    const first = await finalizeSubtitleMasterFile(master, subtitleTracks, 2);
    expect(first).toBe(true);
    expect(await realFsPromises.readFile(master, 'utf-8')).toEqual(
      finalizedMaster
    );
    // No temp file left behind by the rename.
    let tmpExists = true;
    try {
      await realFsPromises.readFile(`${master}.tmp`, 'utf-8');
    } catch {
      tmpExists = false;
    }
    expect(tmpExists).toBe(false);

    const second = await finalizeSubtitleMasterFile(master, subtitleTracks, 2);
    expect(second).toBe(true);
    expect(await realFsPromises.readFile(master, 'utf-8')).toEqual(
      finalizedMaster
    );
  });

  test('refuses to rewrite an incomplete master and leaves it untouched', async () => {
    const master = path.join(dir, 'index.m3u8');
    const incomplete = ffmpegMaster
      .split('\n')
      .filter((line) => !line.startsWith('#EXT-X-MEDIA:'))
      .join('\n');
    await realFsPromises.writeFile(master, incomplete);

    const done = await finalizeSubtitleMasterFile(master, subtitleTracks, 2);
    expect(done).toBe(false);
    expect(await realFsPromises.readFile(master, 'utf-8')).toEqual(incomplete);
  });
});

describe('encoder subtitle finalize gates running in SRT mode', () => {
  const incompleteMaster = ffmpegMaster
    .split('\n')
    .filter((line) => !line.startsWith('#EXT-X-MEDIA:'))
    .join('\n');

  // In-memory master content the mocked fs serves to the encoder. null means
  // ffmpeg has not written an HLS index yet. Assigning it simulates ffmpeg
  // producing output. Filesystem is fully mocked so the monitor's transitions
  // are deterministic under fake timers (real fs would resolve off the timer).
  let master: string | null;
  let written: string | null;

  const buildWithSubs = () =>
    new Encoder('ffmpeg', 'packager', 1935, 'stream', '/media', {
      hlsOnly: true,
      inputUrl: 'srt://source:9000',
      subtitles: subtitleTracks
    });

  beforeEach(() => {
    jest.useFakeTimers();
    spawnedProcs.length = 0;
    mockedSpawn.mockReset();
    // Live process: it never exits, so the encoder never re-dials.
    mockedSpawn.mockImplementation(() => makeProc());
    master = null;
    written = null;
    (fs.existsSync as jest.Mock).mockReturnValue(true);
    (fsPromises.mkdir as jest.Mock).mockResolvedValue(undefined);
    (fsPromises.rm as jest.Mock).mockResolvedValue(undefined);
    (fsPromises.rename as jest.Mock).mockResolvedValue(undefined);
    (fsPromises.access as jest.Mock).mockImplementation(async () => {
      if (master === null) throw new Error('ENOENT');
    });
    (fsPromises.readFile as jest.Mock).mockImplementation(async () => {
      if (master === null) throw new Error('ENOENT');
      return master;
    });
    (fsPromises.writeFile as jest.Mock).mockImplementation(async (_p, data) => {
      written = `${data}`;
      // The rewrite writes to a temp file then renames it over the master.
      master = `${data}`;
    });
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    (fs.existsSync as jest.Mock).mockImplementation(realFs.existsSync);
    (fsPromises.mkdir as jest.Mock).mockImplementation(realFsPromises.mkdir);
    (fsPromises.rm as jest.Mock).mockImplementation(realFsPromises.rm);
    (fsPromises.access as jest.Mock).mockImplementation(realFsPromises.access);
    (fsPromises.rename as jest.Mock).mockImplementation(realFsPromises.rename);
    (fsPromises.readFile as jest.Mock).mockImplementation(
      realFsPromises.readFile
    );
    (fsPromises.writeFile as jest.Mock).mockImplementation(
      realFsPromises.writeFile
    );
  });

  test('stays starting until the master is complete, then finalizes and runs', async () => {
    const encoder = buildWithSubs();
    await encoder.start({});

    // An incomplete master (HLS index exists but has no subtitle rendition yet)
    // must keep the encoder in starting: the finalize gate refuses it.
    master = incompleteMaster;
    await jest.advanceTimersByTimeAsync(5000);
    expect(await encoder.getStatus()).toBe('starting');
    expect(written).toBeNull();

    // Once ffmpeg has written a complete master, the gate opens: the master is
    // broadened to every variant and the channel goes running.
    master = ffmpegMaster;
    await jest.advanceTimersByTimeAsync(5000);
    expect(await encoder.getStatus()).toBe('running');
    expect(written).toEqual(finalizedMaster);
  });
});
