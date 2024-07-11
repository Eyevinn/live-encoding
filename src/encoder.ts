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
  }

  public async start(
    startRequest: EncoderStartRequest
  ): Promise<EncoderStartResponse> {
    const filterComplexArgs = generateFilterComplex(DEFAULT_LADDER);
    const inputArgs = generateInput(this.rtmpPort, this.streamKey);
    const outputArgs = generateOutput(
      this.opts.hlsOnly,
      DEFAULT_LADDER,
      this.mediaDir
    );
    const ffmpegArgs = inputArgs.concat(filterComplexArgs).concat(outputArgs);

    this.status = 'starting';
    const startAttemptTs = Date.now();
    const monitor = setInterval(async () => {
      if (this.ffmpeg) {
        if (!this.ffmpeg.process) {
          if (!this.wantsToStop) {
            Log().info(
              'ffmpeg process unintentionally exited with code ' +
                this.ffmpeg.exitCode
            );
            this.status = 'error';
          } else {
            Log().info(
              'ffmpeg process intentionally exited with code ' +
                this.ffmpeg.exitCode
            );
            this.status = 'stopped';
          }
          clearInterval(monitor);
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
          if (startRequest.timeout) {
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
      Log().info(this.ffmpeg?.process?.spawnargs);
      Log().info(`  wantsToStop: ${this.wantsToStop}`);
      if (this.ffmpeg) {
        this.ffmpeg.process = undefined;
        this.ffmpeg.exitCode = code || this.wantsToStop ? 0 : 1;
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
      await rm(path.join(this.mediaDir, '/hls'), { recursive: true });
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

export function generateInput(rtmpPort: number, streamKey: string): string[] {
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
