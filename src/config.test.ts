import {
  boolFromEnv,
  parseFramerate,
  parseLadder,
  parseSubtitles
} from './config';

describe('boolFromEnv', () => {
  test('truthy values', () => {
    expect(boolFromEnv('true')).toBe(true);
    expect(boolFromEnv('TRUE')).toBe(true);
    expect(boolFromEnv('1')).toBe(true);
  });

  test('falsy values', () => {
    expect(boolFromEnv('false')).toBe(false);
    expect(boolFromEnv('0')).toBe(false);
    expect(boolFromEnv('')).toBe(false);
    expect(boolFromEnv(undefined)).toBe(false);
  });
});

describe('parseSubtitles', () => {
  test('returns empty when SUBTITLE_URL is unset', () => {
    expect(parseSubtitles({})).toEqual([]);
  });

  test('parses a single track with defaults', () => {
    expect(
      parseSubtitles({ SUBTITLE_URL: 'https://example.com/en.vtt' })
    ).toEqual([
      {
        url: 'https://example.com/en.vtt',
        language: 'und',
        name: 'und',
        default: false
      }
    ]);
  });

  test('name falls back to language', () => {
    const [track] = parseSubtitles({
      SUBTITLE_URL: 'https://example.com/sv.vtt',
      SUBTITLE_LANGUAGE: 'sv'
    });
    expect(track.language).toBe('sv');
    expect(track.name).toBe('sv');
  });

  test('honours explicit name and default flag', () => {
    const [track] = parseSubtitles({
      SUBTITLE_URL: 'http://example.com/en.vtt',
      SUBTITLE_LANGUAGE: 'en',
      SUBTITLE_NAME: 'English',
      SUBTITLE_DEFAULT: 'true'
    });
    expect(track.name).toBe('English');
    expect(track.default).toBe(true);
  });

  test('rejects a non-http protocol', () => {
    expect(() =>
      parseSubtitles({ SUBTITLE_URL: 'ftp://example.com/en.vtt' })
    ).toThrow('Unsupported subtitle URL protocol');
  });

  test('rejects a malformed URL with an intentional message', () => {
    expect(() => parseSubtitles({ SUBTITLE_URL: 'not a url' })).toThrow(
      'Invalid SUBTITLE_URL'
    );
  });
});

describe('parseLadder', () => {
  test('returns undefined when LADDER is unset', () => {
    expect(parseLadder({})).toBeUndefined();
  });

  test('parses a multi-rung ladder and appends the default audio rung', () => {
    expect(
      parseLadder({ LADDER: '1920x1080:5000k,1280x720:2800k,640x360:800k' })
    ).toEqual([
      {
        mediaType: 'video',
        bitrate: '5000k',
        video: { width: 1920, height: 1080 }
      },
      {
        mediaType: 'video',
        bitrate: '2800k',
        video: { width: 1280, height: 720 }
      },
      {
        mediaType: 'video',
        bitrate: '800k',
        video: { width: 640, height: 360 }
      },
      {
        mediaType: 'audio',
        bitrate: '128k',
        audio: { channels: 2, sampleRate: 48000 }
      }
    ]);
  });

  test('tolerates surrounding whitespace and an uppercase separator', () => {
    expect(parseLadder({ LADDER: ' 1280X720:4M , 640x360:3M ' })).toEqual([
      {
        mediaType: 'video',
        bitrate: '4M',
        video: { width: 1280, height: 720 }
      },
      { mediaType: 'video', bitrate: '3M', video: { width: 640, height: 360 } },
      {
        mediaType: 'audio',
        bitrate: '128k',
        audio: { channels: 2, sampleRate: 48000 }
      }
    ]);
  });

  test('accepts a plain integer bitrate', () => {
    const ladder = parseLadder({ LADDER: '640x360:800000' });
    expect(ladder?.[0]).toEqual({
      mediaType: 'video',
      bitrate: '800000',
      video: { width: 640, height: 360 }
    });
  });

  test('fails fast on an empty value rather than falling back to the default', () => {
    expect(() => parseLadder({ LADDER: '   ' })).toThrow(
      /Invalid LADDER: set but empty/
    );
  });

  test('fails fast naming a structurally malformed entry', () => {
    expect(() => parseLadder({ LADDER: '1280x720:2800k,badentry' })).toThrow(
      /Invalid LADDER entry 'badentry'/
    );
  });

  test('fails fast on a zero dimension', () => {
    expect(() => parseLadder({ LADDER: '0x360:800k' })).toThrow(
      /width and height must be positive integers/
    );
  });

  test('fails fast naming an invalid bitrate', () => {
    expect(() => parseLadder({ LADDER: '640x360:fast' })).toThrow(
      /bitrate 'fast' must be a number/
    );
  });
});

describe('parseFramerate', () => {
  test('returns undefined when FRAMERATE is unset', () => {
    expect(parseFramerate({})).toBeUndefined();
  });

  test('parses a positive integer', () => {
    expect(parseFramerate({ FRAMERATE: '30' })).toBe(30);
    expect(parseFramerate({ FRAMERATE: ' 50 ' })).toBe(50);
  });

  test('fails fast on zero', () => {
    expect(() => parseFramerate({ FRAMERATE: '0' })).toThrow(
      /must be a positive integer/
    );
  });

  test('fails fast on a non-integer', () => {
    expect(() => parseFramerate({ FRAMERATE: '29.97' })).toThrow(
      /must be a positive integer/
    );
  });

  test('fails fast on a non-numeric value', () => {
    expect(() => parseFramerate({ FRAMERATE: 'fast' })).toThrow(
      /Invalid FRAMERATE 'fast'/
    );
  });
});
