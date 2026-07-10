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
  generateFilterComplex,
  generateInput,
  generateOutput,
  redactSecrets
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
    rm: jest.fn(actual.rm)
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
