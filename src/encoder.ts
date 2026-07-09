import { ChildProcess, spawn } from 'child_process';
import {
  EncoderStartRequest,
  EncoderStartResponse,
  EncoderStatus
} from './model';
import { Log } from './utils/log';
import path from 'path';
import { access, constants, mkdir, readFile, rm, writeFile } from 'fs/promises';
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

export type SubtitleTrack = {
  // Sidecar WebVTT source URL, fetched alongside the A/V input.
  url: string;
  // BCP-47 language tag, e.g. 'en' or 'sv'.
  language: string;
  // Human readable rendition name, e.g. 'English'.
  name: string;
  // Whether this rendition is the default subtitle for the group.
  default: boolean;
};

export type EncoderOpts = {
  hlsOnly: boolean;
  outputUrl?: URL;
  originPort?: number;
  subtitles?: SubtitleTrack[];
};

// HLS subtitle rendition group id used in the master playlist.
const SUBTITLE_GROUP_ID = 'subs';

type Process = {
  exitCode: number;
  process?: ChildProcess;
};

export class Encoder {
  private status: EncoderStatus = 'idle';
  private wantsToStop = false;
  private pullPushStarted = false;
  private subtitleMasterFinalized = false;
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
    const subtitles = this.opts.subtitles ?? [];
    const filterComplexArgs = generateFilterComplex(DEFAULT_LADDER);
    const inputArgs = generateInput(this.rtmpPort, this.streamKey, subtitles);
    const outputArgs = generateOutput(
      this.opts.hlsOnly,
      DEFAULT_LADDER,
      this.mediaDir,
      subtitles
    );
    const ffmpegArgs = inputArgs.concat(filterComplexArgs).concat(outputArgs);

    this.status = 'starting';
    this.subtitleMasterFinalized = false;
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
            await this.finalizeSubtitleMaster();
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

  // ffmpeg attaches the subtitle group to a single variant only (see
  // generateOutput). Once ffmpeg has written the master playlist, broaden the
  // SUBTITLES reference to every variant and apply the configured labels so the
  // rendition is selectable across the whole ABR ladder. The master playlist is
  // written once by ffmpeg, so this runs a single time per encode.
  private async finalizeSubtitleMaster(): Promise<void> {
    const subtitles = this.opts.subtitles ?? [];
    if (subtitles.length === 0 || this.subtitleMasterFinalized) {
      return;
    }
    const master = path.join(this.mediaDir, '/hls/index.m3u8');
    try {
      const content = await readFile(master, 'utf-8');
      if (!content.includes('#EXT-X-MEDIA:TYPE=SUBTITLES')) {
        // ffmpeg has not written the subtitle rendition into the master yet.
        return;
      }
      const rewritten = rewriteMasterPlaylist(
        content,
        subtitles,
        SUBTITLE_GROUP_ID
      );
      if (rewritten !== content) {
        await writeFile(master, rewritten);
      }
      this.subtitleMasterFinalized = true;
      Log().info('Wired subtitle group into HLS master playlist');
    } catch (err) {
      Log().debug(err);
    }
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

export function generateInput(
  rtmpPort: number,
  streamKey: string,
  subtitles: SubtitleTrack[] = []
): string[] {
  const args = [
    '-y',
    '-loglevel',
    'error',
    '-listen',
    '1',
    '-i',
    `rtmp://0.0.0.0:${rtmpPort}/live/${streamKey}`
  ];
  // Each sidecar WebVTT source is an extra input after the primary A/V input.
  for (const subtitle of subtitles) {
    args.push('-i', subtitle.url);
  }
  return args;
}
export function generateOutput(
  hlsOnly: boolean,
  ladder: BitrateLadderStep[],
  mediaDir: string,
  subtitles: SubtitleTrack[] = []
): string[] {
  if (hlsOnly) {
    let varStreamMap = '';
    const videos = ladder.filter((step) => step.mediaType === 'video');
    for (let i = 0; i < videos.length; i++) {
      varStreamMap += `v:${i},a:${i}`;
      // Attach the subtitle streams to the last video variant only. ffmpeg's
      // hls muxer crashes if a subtitle group is referenced from more than one
      // variant, so the reference is broadened to every variant afterwards in
      // rewriteMasterPlaylist.
      if (subtitles.length > 0 && i === videos.length - 1) {
        for (let s = 0; s < subtitles.length; s++) {
          varStreamMap += `,s:${s}`;
        }
        varStreamMap += `,sgroup:${SUBTITLE_GROUP_ID}`;
      }
      if (i < videos.length - 1) {
        varStreamMap += ' ';
      }
    }
    const subtitleArgs: string[] = [];
    for (let s = 0; s < subtitles.length; s++) {
      // Subtitle sidecar inputs follow the primary input, so subtitle s is
      // ffmpeg input index s + 1.
      subtitleArgs.push('-map', `${s + 1}:0`);
    }
    if (subtitles.length > 0) {
      subtitleArgs.push('-c:s', 'webvtt');
    }
    return subtitleArgs.concat([
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
    ]);
  }
  return [];
}

// ffmpeg (6.1.x hls muxer) only advertises the subtitle group on the single
// variant that physically carries the subtitle stream, and segfaults if any
// other variant references the group directly. This rewrites the master
// playlist ffmpeg produced so that every variant references the subtitle group
// and each rendition carries the configured language, name and default flag.
export function rewriteMasterPlaylist(
  master: string,
  subtitles: SubtitleTrack[],
  groupId: string
): string {
  if (subtitles.length === 0) {
    return master;
  }
  let mediaIndex = 0;
  return master
    .split('\n')
    .map((line) => {
      if (line.startsWith('#EXT-X-MEDIA:') && line.includes('TYPE=SUBTITLES')) {
        const uri = /URI="([^"]*)"/.exec(line)?.[1] ?? '';
        const group = /GROUP-ID="([^"]*)"/.exec(line)?.[1] ?? groupId;
        const track = subtitles[Math.min(mediaIndex, subtitles.length - 1)];
        mediaIndex++;
        return [
          '#EXT-X-MEDIA:TYPE=SUBTITLES',
          `GROUP-ID="${group}"`,
          `NAME="${track.name}"`,
          `LANGUAGE="${track.language}"`,
          'AUTOSELECT=YES',
          `DEFAULT=${track.default ? 'YES' : 'NO'}`,
          `URI="${uri}"`
        ].join(',');
      }
      if (
        line.startsWith('#EXT-X-STREAM-INF:') &&
        !line.includes('SUBTITLES=')
      ) {
        return `${line},SUBTITLES="${groupId}"`;
      }
      return line;
    })
    .join('\n');
}
