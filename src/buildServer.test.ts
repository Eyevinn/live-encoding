import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { buildServer } from './buildServer';
import {
  DEFAULT_SEGMENT_DURATION,
  Encoder,
  SegmentType,
  fmp4InitFilename
} from './encoder';
import { originCacheControl } from './routes/origin';

// Files ffmpeg writes under <ORIGIN_DIR>/hls for a single-rung ladder with
// one subtitle track, per segment container (see generateOutput).
function hlsFixtures(segmentType: SegmentType): string[] {
  const common = [
    'index.m3u8',
    'media_0.m3u8',
    'media_1.m3u8',
    'media_1_00.vtt'
  ];
  return segmentType === 'fmp4'
    ? [...common, fmp4InitFilename(1), 'media_0_00.m4s', 'media_0_01.m4s']
    : [...common, 'media_0_00.ts', 'media_0_01.ts'];
}

function newEncoder(mediaDir: string, segmentType: SegmentType) {
  return new Encoder('ffmpeg', 'packager', 1935, 'stream', mediaDir, {
    hlsOnly: true,
    segmentType
  });
}

describe('Cache-Control headers', () => {
  let mediaDir: string;
  let uiRoot: string;

  beforeAll(() => {
    uiRoot = mkdtempSync(path.join(os.tmpdir(), 'le-ui-'));
    writeFileSync(path.join(uiRoot, 'index.html'), '<html></html>');
    writeFileSync(path.join(uiRoot, 'app.js'), 'console.log(1);');
  });

  afterAll(() => {
    rmSync(uiRoot, { recursive: true, force: true });
  });

  const segmentTypes: SegmentType[] = ['mpegts', 'fmp4'];
  for (const type of segmentTypes) {
    describe(`SEGMENT_TYPE=${type}`, () => {
      beforeAll(() => {
        mediaDir = mkdtempSync(path.join(os.tmpdir(), `le-origin-${type}-`));
        mkdirSync(path.join(mediaDir, 'hls'));
        for (const name of hlsFixtures(type)) {
          writeFileSync(path.join(mediaDir, 'hls', name), `fixture ${name}`);
        }
      });

      afterAll(() => {
        rmSync(mediaDir, { recursive: true, force: true });
      });

      const segmentExt = type === 'fmp4' ? 'm4s' : 'ts';

      const durationCases: [number | undefined, string, string][] = [
        [undefined, 'public, max-age=5', 'public, max-age=60'],
        [4, 'public, max-age=2', 'public, max-age=24'],
        [5, 'public, max-age=2', 'public, max-age=30'],
        [1, 'public, max-age=1', 'public, max-age=6']
      ];
      for (const [segmentDuration, playlistCc, segmentCc] of durationCases) {
        it(`serves playlists and segments with SEGMENT_DURATION=${segmentDuration}`, async () => {
          const server = buildServer({
            title: 'test',
            encoder: newEncoder(mediaDir, type),
            mediaDir,
            segmentDuration,
            uiRoot
          });
          const files = hlsFixtures(type);
          for (const name of files) {
            const res = await server.inject({
              method: 'GET',
              url: `/origin/hls/${name}`
            });
            expect(res.statusCode).toBe(200);
            expect(res.body).toBe(`fixture ${name}`);
            expect(res.headers['cache-control']).toBe(
              name.endsWith('.m3u8') ? playlistCc : segmentCc
            );
          }
          // Both a master/media playlist and a media segment are covered.
          expect(files).toContain('index.m3u8');
          expect(files).toContain(`media_0_00.${segmentExt}`);
          if (type === 'fmp4') {
            expect(files).toContain('init.mp4');
          }
          await server.close();
        });
      }

      it('keeps the CORS headers on /origin unchanged', async () => {
        const server = buildServer({
          title: 'test',
          encoder: newEncoder(mediaDir, type),
          mediaDir,
          uiRoot
        });
        const res = await server.inject({
          method: 'GET',
          url: `/origin/hls/media_0_00.${segmentExt}`,
          headers: { origin: 'https://player.example' }
        });
        expect(res.statusCode).toBe(200);
        expect(res.headers['access-control-allow-origin']).toBe('*');
        expect(res.headers['vary']).toBe('Origin');

        const preflight = await server.inject({
          method: 'OPTIONS',
          url: '/origin/hls/index.m3u8',
          headers: {
            origin: 'https://player.example',
            'access-control-request-method': 'GET'
          }
        });
        expect(preflight.statusCode).toBe(204);
        expect(preflight.headers['access-control-allow-origin']).toBe('*');
        expect(preflight.headers['access-control-allow-methods']).toBe(
          'GET,HEAD,PUT,PATCH,POST,DELETE'
        );
        expect(preflight.headers['vary']).toBe(
          'Origin, Access-Control-Request-Headers'
        );
        await server.close();
      });
    });
  }

  describe('/api and /', () => {
    let server: ReturnType<typeof buildServer>;

    beforeAll(() => {
      mediaDir = mkdtempSync(path.join(os.tmpdir(), 'le-origin-'));
      server = buildServer({
        title: 'test',
        encoder: newEncoder(mediaDir, 'mpegts'),
        mediaDir,
        uiRoot
      });
    });

    afterAll(async () => {
      await server.close();
      rmSync(mediaDir, { recursive: true, force: true });
    });

    const apiCases: [string, number][] = [
      ['/api', 200],
      ['/api/', 200],
      ['/api/encoder', 200],
      ['/api/docs', 302],
      ['/api/docs/static/index.html', 200],
      ['/api/docs/json', 200],
      ['/api/does-not-exist', 404]
    ];
    for (const [url, status] of apiCases) {
      it(`sends no-store on ${url}`, async () => {
        const res = await server.inject({ method: 'GET', url });
        expect(res.statusCode).toBe(status);
        expect(res.headers['cache-control']).toBe('no-store');
      });
    }

    it('sends no-store on a rejected /api request', async () => {
      const res = await server.inject({
        method: 'POST',
        url: '/api/encoder',
        payload: { timeout: 'not-a-number' }
      });
      // Schema validation fails before the handler runs; the encoder routes'
      // error handler maps it to 500.
      expect(res.statusCode).toBe(500);
      expect(res.headers['cache-control']).toBe('no-store');
    });

    const uiCases: [string, string][] = [
      ['/', '<html></html>'],
      ['/index.html', '<html></html>'],
      ['/app.js', 'console.log(1);']
    ];
    for (const [url, body] of uiCases) {
      it(`sends no-cache on the UI at ${url}`, async () => {
        const res = await server.inject({ method: 'GET', url });
        expect(res.statusCode).toBe(200);
        expect(res.body).toBe(body);
        expect(res.headers['cache-control']).toBe('no-cache');
      });
    }
  });
});

describe('originCacheControl', () => {
  it('bounds the playlist TTL to half a segment, at least 1 s', () => {
    expect(originCacheControl('/m/hls/index.m3u8')).toBe(
      `public, max-age=${DEFAULT_SEGMENT_DURATION / 2}`
    );
    expect(originCacheControl('/m/hls/media_0.m3u8', 6)).toBe(
      'public, max-age=3'
    );
    expect(originCacheControl('/m/hls/media_0.m3u8', 3)).toBe(
      'public, max-age=1'
    );
    expect(originCacheControl('/m/hls/media_0.m3u8', 1)).toBe(
      'public, max-age=1'
    );
  });

  it('bounds segment TTLs to the playlist window', () => {
    for (const f of ['a.ts', 'a.m4s', 'init_0.mp4', 'a.vtt', 'A.TS']) {
      expect(originCacheControl(`/m/hls/${f}`, 4)).toBe('public, max-age=24');
    }
  });

  it('revalidates any other file', () => {
    expect(originCacheControl('/m/hls/index.m3u8.tmp', 4)).toBe('no-cache');
    expect(originCacheControl('/m/notes.txt', 4)).toBe('no-cache');
  });
});
