import {
  BitrateLadderStep,
  DEFAULT_BUFSIZE_FACTOR,
  DEFAULT_LADDER,
  DEFAULT_MAXRATE_FACTOR,
  RateControlMode,
  SubtitleTrack
} from './encoder';

export function boolFromEnv(value: string | undefined): boolean {
  return value ? value.toLowerCase() === 'true' || value === '1' : false;
}

// Parse the optional ABR ladder from the LADDER env var. The format is a
// comma-separated list of video rungs, each `<width>x<height>:<bitrate>`, e.g.
//   LADDER=1920x1080:5000k,1280x720:2800k,640x360:800k
// The bitrate is passed to ffmpeg verbatim, so an integer with an optional
// k/M/G suffix is accepted. Unset returns undefined so the caller falls back to
// DEFAULT_LADDER, keeping the output byte-identical to the previous behaviour.
//
// An empty-or-whitespace value is treated as unset (returns undefined). Container
// platforms commonly deliver an unset optional config key to the container as an
// empty-string env var, so an empty LADDER carries no operator intent and must
// not crash the image at boot. A value that contains content but no valid rung
// (e.g. ',,') is a real operator mistake and still FAILS FAST.
//
// Any non-empty invalid value FAILS FAST with an error naming the offending
// entry rather than silently falling back to the default ladder: an operator who
// sets LADDER expects that exact ladder, and an encoder that quietly ignores a
// bad ladder and streams a different one is worse than a startup crash.
//
// Audio is not configurable through LADDER today; the default stereo AAC rung
// from DEFAULT_LADDER is appended so the ladder stays a complete A/V ladder.
export function parseLadder(
  env: Record<string, string | undefined> = process.env
): BitrateLadderStep[] | undefined {
  const raw = env.LADDER;
  if (raw === undefined || raw.trim() === '') {
    return undefined;
  }
  const entries = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
  if (entries.length === 0) {
    throw new Error(
      'Invalid LADDER: contains no rung, provide at least one ' +
        '<width>x<height>:<bitrate> rung (e.g. 1280x720:2800k) or unset it'
    );
  }
  const videoSteps: BitrateLadderStep[] = entries.map((entry) => {
    const match = /^(\d+)[xX](\d+):(\S+)$/.exec(entry);
    if (!match) {
      throw new Error(
        `Invalid LADDER entry '${entry}': expected ` +
          '<width>x<height>:<bitrate>, e.g. 1280x720:2800k'
      );
    }
    const width = Number(match[1]);
    const height = Number(match[2]);
    const bitrate = match[3];
    if (width <= 0 || height <= 0) {
      throw new Error(
        `Invalid LADDER entry '${entry}': width and height must be ` +
          'positive integers'
      );
    }
    if (!/^\d+(\.\d+)?[kKmMgG]?$/.test(bitrate)) {
      throw new Error(
        `Invalid LADDER entry '${entry}': bitrate '${bitrate}' must be a ` +
          'number with an optional k/M/G suffix, e.g. 2800k'
      );
    }
    return {
      mediaType: 'video',
      bitrate,
      video: { width, height }
    };
  });
  const audio = DEFAULT_LADDER.find((step) => step.mediaType === 'audio');
  return audio ? [...videoSteps, audio] : videoSteps;
}

// Parse the optional output framerate from the FRAMERATE env var. Typical
// values are 25, 30, 50 or 60. Unset (or empty-or-whitespace, which container
// platforms deliver for an unset optional key) returns undefined so the output
// follows the input framerate (previous behaviour). A non-empty
// non-positive-integer value FAILS FAST rather than being silently ignored, for
// the same reason as parseLadder.
export function parseFramerate(
  env: Record<string, string | undefined> = process.env
): number | undefined {
  const raw = env.FRAMERATE;
  if (raw === undefined || raw.trim() === '') {
    return undefined;
  }
  const trimmed = raw.trim();
  const fps = Number(trimmed);
  if (!/^\d+$/.test(trimmed) || fps <= 0) {
    throw new Error(
      `Invalid FRAMERATE '${raw}': must be a positive integer, ` +
        'e.g. 25, 30, 50 or 60'
    );
  }
  return fps;
}

// Parse the optional sidecar WebVTT subtitle configuration from the
// environment. Unset leaves the output video+audio only, exactly as before. The
// result is shaped as a track array so additional tracks can be added later; a
// single track is read from the environment today.
export function parseSubtitles(
  env: Record<string, string | undefined> = process.env
): SubtitleTrack[] {
  const url = env.SUBTITLE_URL;
  if (!url) {
    return [];
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid SUBTITLE_URL: ${url}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Unsupported subtitle URL protocol ${parsed.protocol}`);
  }
  const language = env.SUBTITLE_LANGUAGE || 'und';
  return [
    {
      url,
      language,
      name: env.SUBTITLE_NAME || language,
      default: boolFromEnv(env.SUBTITLE_DEFAULT)
    }
  ];
}

// Parse the per-rung rate-control mode from the RATE_CONTROL env var. 'cbr'
// (the default when unset, or when empty-or-whitespace, which container
// platforms deliver for an unset optional key) keeps the historical strict-CBR
// encode byte for byte; 'capped-vbr' switches to a VBV-capped variable bitrate.
// An unrecognised non-empty value FAILS FAST naming the offending value rather
// than silently defaulting, for the same reason as parseLadder and
// parseFramerate.
export function parseRateControl(
  env: Record<string, string | undefined> = process.env
): RateControlMode {
  const raw = env.RATE_CONTROL;
  if (raw === undefined || raw.trim() === '') {
    return 'cbr';
  }
  const value = raw.trim().toLowerCase();
  if (value === 'cbr' || value === 'capped-vbr') {
    return value;
  }
  throw new Error(
    `Invalid RATE_CONTROL '${raw}': must be 'cbr' or 'capped-vbr'`
  );
}

// Parse a positive-float rate-control factor from the environment, returning the
// supplied default when unset (or when empty-or-whitespace, which container
// platforms deliver for an unset optional key). A non-empty non-numeric or
// non-positive value FAILS FAST naming the variable and the offending value.
// These factors are only consulted under capped-VBR; under cbr they are ignored.
function parsePositiveFloatFactor(
  raw: string | undefined,
  name: string,
  fallback: number
): number {
  if (raw === undefined || raw.trim() === '') {
    return fallback;
  }
  const value = Number(raw.trim());
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Invalid ${name} '${raw}': must be a positive number`);
  }
  return value;
}

// -maxrate multiple of a rung's target bitrate under capped-VBR (default 1.15).
export function parseMaxrateFactor(
  env: Record<string, string | undefined> = process.env
): number {
  return parsePositiveFloatFactor(
    env.MAXRATE_FACTOR,
    'MAXRATE_FACTOR',
    DEFAULT_MAXRATE_FACTOR
  );
}

// -bufsize multiple of the computed maxrate under capped-VBR (default 2.0).
export function parseBufsizeFactor(
  env: Record<string, string | undefined> = process.env
): number {
  return parsePositiveFloatFactor(
    env.BUFSIZE_FACTOR,
    'BUFSIZE_FACTOR',
    DEFAULT_BUFSIZE_FACTOR
  );
}
