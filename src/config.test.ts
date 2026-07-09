import { boolFromEnv, parseSubtitles } from './config';

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
