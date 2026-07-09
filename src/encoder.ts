import { ChildProcess, spawn } from 'child_process';
import {
  EncoderStartRequest,
  EncoderStartResponse,
  EncoderStatus
} from './model';
import { Log } from './utils/log';
import path from 'path';
import { access, constants, mkdir, rm } from 'fs/promises';
import { existsSync } from 'fs';
import { HLSPullPush, MediaPackageOutput } from '@eyevinn/hls-pull-push';
import { PullPushLogger } from './utils/pull_push_logger';

// Default upper bound (seconds) on how long an SRT caller keeps re-dialing an
// input source that is not up yet. Overridable per start request via the
// EncoderStartRequest timeout field, or globally via the INPUT_DIAL_TIMEOUT env
// var (wired in server.ts). Does not apply to the RTMP listener input.
export const DEFAULT_INPUT_DIAL_TIMEOUT_SEC = 300;

// Redact URL query strings (which may carry a passphrase) from any value that
// is logged or placed into an error message.
export function redactSecrets(value: string): string {
  return value.replace(
    /([a-z][a-z0-9+.-]*:\/\/[^\s?]*)\?[^\s]*/gi,
    '$1?<redacted>'
  );
}

export type BitrateLadderStep = {
  mediaType: 'video' | 'audio';
  bitrate: string;
  video?: {
    width: number;
    height: number;
  };
  audio?: {
    channels: number;
    sampleRate: number;
  };
};

const DEFAULT_LADDER: BitrateLadderStep[] = [
  {
    mediaType: 'video',
    bitrate: '4M',
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

export type EncoderOpts = {
  hlsOnly: boolean;
  outputUrl?: URL;
  originPort?: number;
  // Optional input URL. When set, ffmpeg dials this source in caller mode
  // instead of listening for an RTMP publisher. Only srt:// is supported.
  inputUrl?: string;
  // Optional override (seconds) for the caller-mode dial deadline. Falls back
  // to DEFAULT_INPUT_DIAL_TIMEOUT_SEC. Ignored for the RTMP listener input.
  inputDialTimeoutSec?: number;
};

type Process = {
  exitCode: number;
  process?: ChildProcess;
};

export class Encoder {
  private status: EncoderStatus = 'idle';
  private wantsToStop = false;
  private pullPushStarted = false;
  private ffmpeg?: Process;
  private pullPush?: HLSPullPush;
  private fetcherId?: string;

  constructor(
    private ffmpegExecutable: string,
    private shakaPackagerExecutable: string,
    private rtmpPort: number,
    private streamKey: string,
    private mediaDir: string,
    private opts: EncoderOpts
  ) {
    if (this.opts.outputUrl) {
      if (
        this.opts.outputUrl.protocol == 'https:' ||
        this.opts.outputUrl.protocol == 'http:'
      ) {
        this.pullPush = new HLSPullPush(new PullPushLogger());
      } else {
        throw new Error(`Unsupported protocol ${this.opts.outputUrl.protocol}`);
      }
    }
    if (this.opts.inputUrl) {
      const redacted = redactSecrets(this.opts.inputUrl);
      let parsed: URL;
      try {
        parsed = new URL(this.opts.inputUrl);
      } catch {
        throw new Error(`Invalid input URL '${redacted}': not a valid URL`);
      }
      if (parsed.protocol !== 'srt:') {
        throw new Error(
          `Unsupported input URL protocol '${parsed.protocol}', only srt:// is supported`
        );
      }
      if (!parsed.hostname || !parsed.port) {
        throw new Error(
          `Invalid input URL '${redacted}': srt:// URL must include a host and port`
        );
      }
    }
  }

  public async start(
    startRequest: EncoderStartRequest
  ): Promise<EncoderStartResponse> {
    const filterComplexArgs = generateFilterComplex(DEFAULT_LADDER);
    const inputArgs = generateInput(
      this.rtmpPort,
      this.streamKey,
      this.opts.inputUrl
    );
    const outputArgs = generateOutput(
      this.opts.hlsOnly,
      DEFAULT_LADDER,
      this.mediaDir
    );
    const ffmpegArgs = inputArgs.concat(filterComplexArgs).concat(outputArgs);

    this.status = 'starting';
    const startAttemptTs = Date.now();
    // Caller-mode input bounds the dial with a deadline: the per-request
    // timeout if supplied, otherwise a configured/default deadline. The RTMP
    // listener keeps its original behaviour (unbounded unless a timeout is set).
    const dialDeadlineSec =
      startRequest.timeout ??
      this.opts.inputDialTimeoutSec ??
      DEFAULT_INPUT_DIAL_TIMEOUT_SEC;
    const dialDeadlineReached = () =>
      Date.now() - startAttemptTs > dialDeadlineSec * 1000;
    // Remove any stale HLS output from a previous run so a leftover index.m3u8
    // cannot flip status to 'running' before this attempt actually connects.
    await this.cleanup();
    const monitor = setInterval(async () => {
      if (this.ffmpeg) {
        if (!this.ffmpeg.process) {
          if (this.wantsToStop) {
            Log().info(
              'ffmpeg process intentionally exited with code ' +
                this.ffmpeg.exitCode
            );
            this.status = 'stopped';
            clearInterval(monitor);
          } else if (this.opts.inputUrl && this.status === 'starting') {
            // Caller-mode input (e.g. SRT): the source may not be listening
            // yet. A dial failure before we ever reached 'running' is not
            // terminal, so retry the connection and stay in 'starting', up to
            // the dial deadline. A connect that never succeeds is an input
            // failure, so on deadline we land in 'error' (not 'stopped').
            if (dialDeadlineReached()) {
              Log().info(
                'Dial deadline reached without connecting to input source'
              );
              await this.stop();
              this.status = 'error';
              clearInterval(monitor);
            } else {
              Log().info(
                'ffmpeg exited before input was ready with code ' +
                  this.ffmpeg.exitCode +
                  ', retrying input connection'
              );
              // Clear any partial HLS output before re-dialing.
              await this.cleanup();
              await this.startFFmpeg(ffmpegArgs);
            }
          } else {
            Log().info(
              'ffmpeg process unintentionally exited with code ' +
                this.ffmpeg.exitCode
            );
            await this.stopPullPush();
            this.status = 'error';
            clearInterval(monitor);
          }
        } else {
          if (await this.hlsIndexIsAvailable()) {
            if (this.status != 'running') {
              Log().debug(
                'We have HLS index file available, change status to running'
              );
              this.status = 'running';
              if (this.opts.outputUrl && !this.pullPushStarted) {
                await this.startPullPush();
              }
            }
          }
          if (this.opts.inputUrl) {
            // Caller-mode input: a connection that produces no output within
            // the dial deadline is an input failure, so land in 'error'.
            if (this.status === 'starting' && dialDeadlineReached()) {
              Log().info(
                'Dial deadline reached without connecting to input source'
              );
              await this.stop();
              this.status = 'error';
              clearInterval(monitor);
            }
          } else if (startRequest.timeout) {
            if (
              this.status != 'running' &&
              Date.now() - startAttemptTs > startRequest.timeout * 1000
            ) {
              Log().info('Timeout reached');
              await this.stop();
              this.status = 'stopped';
              clearInterval(monitor);
            }
          }
        }
      }
    }, 5000);
    await this.startFFmpeg(ffmpegArgs);

    return {
      rtmpPort: this.rtmpPort,
      streamKey: this.streamKey,
      outputUrl: this.opts.outputUrl?.toString(),
      playlist: '/origin/hls/index.m3u8',
      status: this.status
    };
  }

  public async stop() {
    this.wantsToStop = true;
    await this.stopPullPush();
    await this.stopFFmpeg();
  }

  public async getStatus(): Promise<EncoderStatus> {
    return this.status;
  }

  public getOriginPlaylist(): string | undefined {
    return this.status === 'running' ? '/origin/hls/index.m3u8' : undefined;
  }

  private async hlsIndexIsAvailable(): Promise<boolean> {
    const file = path.join(this.mediaDir, '/hls/index.m3u8');
    try {
      await access(file, constants.F_OK);
      return true;
    } catch (err) {
      Log().debug(err);
      return false;
    }
  }

  private async startFFmpeg(ffmpegArgs: string[]) {
    if (!existsSync(path.join(this.mediaDir, '/hls'))) {
      await mkdir(path.join(this.mediaDir, '/hls'), { recursive: true });
    }
    this.wantsToStop = false;
    this.ffmpeg = {
      exitCode: 0,
      process: spawn(this.ffmpegExecutable, ffmpegArgs)
    };
    this.ffmpeg.process?.stderr?.on('data', (data) => {
      Log().error(`${data}`);
    });
    this.ffmpeg.process?.on('exit', (code) => {
      Log().info('ffmpeg exited with code ' + code);
      Log().info(this.ffmpeg?.process?.spawnargs?.map(redactSecrets));
      Log().info(`  wantsToStop: ${this.wantsToStop}`);
      if (this.ffmpeg) {
        this.ffmpeg.process = undefined;
        this.ffmpeg.exitCode = code || (this.wantsToStop ? 0 : 1);
      }
    });
  }

  private async stopFFmpeg() {
    const waitForKilled = new Promise<void>((resolve) => {
      const t = setInterval(() => {
        if (!this.ffmpeg?.process) {
          clearInterval(t);
          resolve();
        }
      }, 1000);
    });
    if (this.ffmpeg?.process) {
      this.wantsToStop = true;
      this.ffmpeg.process.kill('SIGKILL');
      await waitForKilled;
      await this.cleanup();
    }
  }

  private async startPullPush() {
    if (
      !this.pullPushStarted &&
      this.opts.outputUrl &&
      this.pullPush &&
      !this.wantsToStop
    ) {
      const username = this.opts.outputUrl.username;
      const password = this.opts.outputUrl.password;
      const destUrl = new URL(
        this.opts.outputUrl.pathname + this.opts.outputUrl.searchParams,
        this.opts.outputUrl.origin
      );
      Log().debug(`${username} ${password} ${destUrl.toString()}`);
      const plugin = new MediaPackageOutput();
      this.pullPush.registerPlugin('mediapackage', plugin);
      const outputDest = plugin.createOutputDestination(
        {
          ingestUrls: [
            {
              url: destUrl.toString(),
              username,
              password
            }
          ]
        },
        this.pullPush.getLogger()
      );
      if (outputDest) {
        const source = new URL(
          `http://127.0.0.1:${this.opts.originPort}/origin/hls/index.m3u8`
        );
        this.fetcherId = this.pullPush.startFetcher({
          name: 'default',
          url: source.toString(),
          destPlugin: outputDest,
          destPluginName: 'mediapackage'
        });
        outputDest.attachSessionId(this.fetcherId);
        this.pullPushStarted = true;
        Log().info(
          `Started pull push of ${source.href} to ${destUrl.toString()}`
        );
      }
    }
  }

  private async stopPullPush() {
    if (this.pullPush && this.fetcherId) {
      await this.pullPush.stopFetcher(this.fetcherId);
      this.fetcherId = undefined;
      this.pullPushStarted = false;
      Log().info('Stopped pull push');
    }
  }

  private async cleanup() {
    try {
      Log().debug('Cleaning up HLS files');
      await rm(path.join(this.mediaDir, '/hls'), {
        recursive: true,
        force: true
      });
    } catch (err) {
      Log().debug(err);
    }
  }
}

export function generateFilterComplex(ladder: BitrateLadderStep[]): string[] {
  const videos = ladder.filter(
    (step) => step.mediaType === 'video' && step.video
  );
  let filterComplexString = `[0:v]split=${videos.length}`;
  for (let i = 0; i < videos.length; i++) {
    filterComplexString += `[v${i + 1}]`;
  }
  filterComplexString += ';';
  for (let i = 0; i < videos.length; i++) {
    filterComplexString += `[v${i + 1}]scale=w=${videos[i].video?.width}:h=${
      videos[i].video?.height
    }[v${i + 1}out]`;
    if (i < videos.length - 1) {
      filterComplexString += ';';
    }
  }
  const videoMaps = [];
  const audioMaps = [];
  const audio = ladder.find((step) => step.mediaType === 'audio' && step.audio);
  for (let i = 0; i < videos.length; i++) {
    const videoMap = [
      '-map',
      `[v${i + 1}out]`,
      `-c:v:${i}`,
      'libx264',
      '-x264-params',
      'nal-hrd=cbr:force-cfr=1',
      `-b:v:${i}`,
      videos[i].bitrate,
      `-maxrate:v:${i}`,
      videos[i].bitrate,
      `-minrate:v:${i}`,
      videos[i].bitrate,
      `-bufsize:v:${i}`,
      videos[i].bitrate,
      '-preset',
      'ultrafast',
      '-g',
      '48',
      '-sc_threshold',
      '0',
      '-keyint_min',
      '48'
    ];
    videoMaps.push(videoMap);
    if (audio) {
      const audioMap = [
        '-map',
        `a:0`,
        `-c:a:${i}`,
        'aac',
        `-b:a:${i}`,
        audio.bitrate,
        '-ar',
        audio.audio?.sampleRate.toString() || '',
        '-ac',
        audio.audio?.channels.toString() || ''
      ];
      audioMaps.push(audioMap);
    }
  }

  return ['-filter_complex', filterComplexString]
    .concat(videoMaps.flat())
    .concat(audioMaps.flat());
}

export function generateInput(
  rtmpPort: number,
  streamKey: string,
  inputUrl?: string
): string[] {
  if (inputUrl) {
    // Caller-mode input: ffmpeg dials the given source (e.g. an srt:// URL in
    // caller mode) and pulls the feed. Any protocol knobs (latency, passphrase,
    // streamid, connect timeout, ...) travel as query parameters on the URL and
    // are parsed by ffmpeg itself, so no option strings are hardcoded here.
    return ['-y', '-loglevel', 'error', '-i', inputUrl];
  }
  return [
    '-y',
    '-loglevel',
    'error',
    '-listen',
    '1',
    '-i',
    `rtmp://0.0.0.0:${rtmpPort}/live/${streamKey}`
  ];
}
export function generateOutput(
  hlsOnly: boolean,
  ladder: BitrateLadderStep[],
  mediaDir: string
): string[] {
  if (hlsOnly) {
    let varStreamMap = '';
    const videos = ladder.filter((step) => step.mediaType === 'video');
    for (let i = 0; i < videos.length; i++) {
      varStreamMap += `v:${i},a:${i}`;
      if (i < videos.length - 1) {
        varStreamMap += ' ';
      }
    }
    return [
      '-f',
      'hls',
      '-hls_time',
      '10',
      '-hls_flags',
      'independent_segments+delete_segments',
      '-hls_segment_type',
      'mpegts',
      '-hls_segment_filename',
      `${mediaDir}/hls/media_%v_%02d.ts`,
      '-hls_list_size',
      '6',
      '-master_pl_name',
      'index.m3u8',
      '-var_stream_map',
      varStreamMap,
      `${mediaDir}/hls/media_%v.m3u8`
    ];
  }
  return [];
}
