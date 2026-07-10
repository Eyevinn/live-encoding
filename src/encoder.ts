import { ChildProcess, spawn } from 'child_process';
import {
  EncoderStartRequest,
  EncoderStartResponse,
  EncoderStatus
} from './model';
import { Log } from './utils/log';
import path from 'path';
import {
  access,
  constants,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile
} from 'fs/promises';
import { existsSync } from 'fs';
import { HLSPullPush, MediaPackageOutput } from '@eyevinn/hls-pull-push';
import { PullPushLogger } from './utils/pull_push_logger';

// Default upper bound (seconds) on how long an SRT caller keeps re-dialing an
// input source that is not up yet. Overridable per start request via the
// EncoderStartRequest timeout field, or globally via the INPUT_DIAL_TIMEOUT env
// var (wired in server.ts). Does not apply to the RTMP listener input.
export const DEFAULT_INPUT_DIAL_TIMEOUT_SEC = 300;

// HLS subtitle rendition group id used in the master playlist.
const SUBTITLE_GROUP_ID = 'subs';

// IO timeout for fetching a sidecar subtitle source, in microseconds (ffmpeg
// -rw_timeout). Without it a stalled subtitle server would pin the encoder in
// 'starting' forever with no output once the input source connects.
const SUBTITLE_RW_TIMEOUT_US = 15_000_000;

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
  // Optional input URL. When set, ffmpeg dials this source in caller mode
  // instead of listening for an RTMP publisher. Only srt:// is supported.
  inputUrl?: string;
  // Optional override (seconds) for the caller-mode dial deadline. Falls back
  // to DEFAULT_INPUT_DIAL_TIMEOUT_SEC. Ignored for the RTMP listener input.
  inputDialTimeoutSec?: number;
  // Optional sidecar WebVTT subtitle tracks passed through into the HLS output.
  subtitles?: SubtitleTrack[];
};

type Process = {
  exitCode: number;
  process?: ChildProcess;
};

export class Encoder {
  private status: EncoderStatus = 'idle';
  private wantsToStop = false;
  private pullPushStarted = false;
  private subtitleMasterFinalized = false;
  private subtitleFinalizeAttempts = 0;
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
    const subtitles = this.opts.subtitles ?? [];
    const filterComplexArgs = generateFilterComplex(DEFAULT_LADDER);
    const inputArgs = generateInput(
      this.rtmpPort,
      this.streamKey,
      this.opts.inputUrl,
      subtitles
    );
    const outputArgs = generateOutput(
      this.opts.hlsOnly,
      DEFAULT_LADDER,
      this.mediaDir,
      subtitles
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
            // With subtitles configured the master must be finalized before the
            // channel is declared running, otherwise a downstream one-shot
            // consumer (the pull-push fetcher) can cache the un-broadened
            // master for the whole session. A not-yet-finalized master keeps us
            // in 'starting' and is retried on the next tick.
            const subtitlesReady =
              subtitles.length === 0 ||
              (await this.finalizeSubtitleMaster(DEFAULT_LADDER));
            if (subtitlesReady && this.status != 'running') {
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

  // ffmpeg attaches the subtitle group to a single variant only (see
  // generateOutput). Once ffmpeg has written a complete master playlist,
  // broaden the SUBTITLES reference to every variant and apply the configured
  // labels so the rendition is selectable across the whole ABR ladder.
  //
  // Returns true when the master has been finalized (this process performed the
  // rewrite), false while it is not yet safe to do so. The caller uses this as
  // a readiness gate, so a not-yet-complete or unreadable master keeps the
  // encoder in 'starting' and is retried on the next monitor tick rather than
  // being declared running with an un-broadened master.
  private async finalizeSubtitleMaster(
    ladder: BitrateLadderStep[]
  ): Promise<boolean> {
    const subtitles = this.opts.subtitles ?? [];
    if (subtitles.length === 0 || this.subtitleMasterFinalized) {
      return true;
    }
    const master = path.join(this.mediaDir, '/hls/index.m3u8');
    const expectedVariants = ladder.filter(
      (step) => step.mediaType === 'video'
    ).length;
    this.subtitleFinalizeAttempts++;
    try {
      const done = await finalizeSubtitleMasterFile(
        master,
        subtitles,
        expectedVariants
      );
      if (!done) {
        // ffmpeg has not written a complete master with the subtitle rendition
        // yet. Stay in 'starting' and retry. Surfaced only after repeated
        // misses so a genuinely stuck encode is visible at operator log levels.
        if (this.subtitleFinalizeAttempts >= 3) {
          Log().warn(
            'HLS master playlist not ready for subtitle finalize after ' +
              `${this.subtitleFinalizeAttempts} attempts (missing subtitle ` +
              'rendition or expected variants), still waiting'
          );
        }
        return false;
      }
      this.subtitleMasterFinalized = true;
      Log().info('Wired subtitle group into HLS master playlist');
      return true;
    } catch (err) {
      Log().error('Failed to finalize subtitle master playlist');
      Log().error(err);
      return false;
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
    // The hls output dir has just been purged by cleanup() (initial start and
    // every re-dial), so any previously finalized master no longer exists.
    // Reset the subtitle finalize state per attempt, otherwise a re-dial after
    // a briefly-connected attempt would leave the fresh master un-broadened.
    this.subtitleMasterFinalized = false;
    this.subtitleFinalizeAttempts = 0;
    this.wantsToStop = false;
    this.ffmpeg = {
      exitCode: 0,
      process: spawn(this.ffmpegExecutable, ffmpegArgs)
    };
    this.ffmpeg.process?.stderr?.on('data', (data) => {
      // Redact URL query strings: a failed srt dial echoes the full input URL
      // (passphrase, streamid) in ffmpeg's error output, and in caller mode
      // failed dials are the common path. Note stderr data events are chunked,
      // so a URL split across chunks could theoretically evade redaction; this
      // covers the normal single-line case.
      Log().error(redactSecrets(`${data}`));
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
  inputUrl?: string,
  subtitles: SubtitleTrack[] = []
): string[] {
  // Primary A/V input: either an RTMP listener or, in caller mode, ffmpeg dials
  // the given source (e.g. an srt:// URL). Any protocol knobs (latency,
  // passphrase, streamid, connect timeout, ...) travel as query parameters on
  // the URL and are parsed by ffmpeg itself, so no option strings are hardcoded.
  const args = inputUrl
    ? ['-y', '-loglevel', 'error', '-i', inputUrl]
    : [
        '-y',
        '-loglevel',
        'error',
        '-listen',
        '1',
        '-i',
        `rtmp://0.0.0.0:${rtmpPort}/live/${streamKey}`
      ];
  // Each sidecar WebVTT source is an extra input after the primary A/V input,
  // in both listener and caller mode, so the subtitle stream is always input
  // index 1 (matched by generateOutput's -map). -rw_timeout bounds a stalled
  // or unreachable subtitle server so it cannot hang the encode indefinitely.
  for (const subtitle of subtitles) {
    args.push('-rw_timeout', `${SUBTITLE_RW_TIMEOUT_US}`, '-i', subtitle.url);
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

function isSubtitleMediaLine(line: string): boolean {
  return line.startsWith('#EXT-X-MEDIA:') && line.includes('TYPE=SUBTITLES');
}

function isStreamInfLine(line: string): boolean {
  return line.startsWith('#EXT-X-STREAM-INF:');
}

// A master is safe to finalize once ffmpeg has written the subtitle rendition
// entry AND every expected variant stream. This uses the same line predicates
// as rewriteMasterPlaylist so the readiness gate and the rewrite agree on what
// a finished master looks like, and it distinguishes a not-yet-complete master
// from one that is genuinely wrong.
export function masterIsComplete(
  master: string,
  expectedVariants: number
): boolean {
  const lines = master.split('\n');
  const hasSubtitleMedia = lines.some(isSubtitleMediaLine);
  const streamInfCount = lines.filter(isStreamInfLine).length;
  return hasSubtitleMedia && streamInfCount >= expectedVariants;
}

// Reads the master ffmpeg wrote, and if it is complete, rewrites it in place so
// every variant references the subtitle group. The write is atomic (temp file +
// rename) so readers never see a truncated master. Returns false, leaving the
// file untouched, when the master is not yet complete so the caller can retry.
export async function finalizeSubtitleMasterFile(
  masterPath: string,
  subtitles: SubtitleTrack[],
  expectedVariants: number
): Promise<boolean> {
  const content = await readFile(masterPath, 'utf-8');
  if (!masterIsComplete(content, expectedVariants)) {
    return false;
  }
  const rewritten = rewriteMasterPlaylist(
    content,
    subtitles,
    SUBTITLE_GROUP_ID
  );
  const tmp = `${masterPath}.tmp`;
  await writeFile(tmp, rewritten);
  await rename(tmp, masterPath);
  return true;
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
      if (isSubtitleMediaLine(line)) {
        const uriMatch = /URI="([^"]*)"/.exec(line);
        if (!uriMatch) {
          // No rendition URI to point at, leave the line untouched rather than
          // emitting an empty URI.
          return line;
        }
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
          `URI="${uriMatch[1]}"`
        ].join(',');
      }
      if (isStreamInfLine(line) && !line.includes('SUBTITLES=')) {
        return `${line},SUBTITLES="${groupId}"`;
      }
      return line;
    })
    .join('\n');
}
