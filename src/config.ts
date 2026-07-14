import { SubtitleTrack } from './encoder';

export function boolFromEnv(value: string | undefined): boolean {
  return value ? value.toLowerCase() === 'true' || value === '1' : false;
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
