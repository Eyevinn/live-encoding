import { Log } from './log';
import { PullPushLogger } from './pull_push_logger';

const UPSTREAM_MSG =
  "(abc123) Upload Failed! WebDAV Client [1/1] did not PUT 'index.m3u8' " +
  'to MediaPackage Channel with username: AKIAEXAMPLEUSER';

describe('PullPushLogger', () => {
  let infoSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;
  let prevLevel: 'debug' | 'info';

  const output = () =>
    [...infoSpy.mock.calls, ...errorSpy.mock.calls]
      .map((args) => args.map((a: unknown) => String(a)).join(' '))
      .join('\n');

  beforeEach(() => {
    prevLevel = Log().level;
    Log().level = 'debug';
    infoSpy = jest.spyOn(console, 'info').mockImplementation(() => undefined);
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    infoSpy.mockRestore();
    errorSpy.mockRestore();
    Log().level = prevLevel;
  });

  test.each(['error', 'verbose', 'info', 'warn'] as const)(
    'redacts the upstream MediaPackage username message via %s()',
    (method) => {
      new PullPushLogger()[method](UPSTREAM_MSG);
      const out = output();
      expect(out).not.toContain('AKIAEXAMPLEUSER');
      expect(out).toContain('Upload Failed!');
      expect(out).toContain('username: <redacted>');
    }
  );

  test('passes exactly one string argument to the logger', () => {
    new PullPushLogger().verbose({ a: 1 });
    new PullPushLogger().error(new Error('boom'));
    const calls: unknown[][] = [...infoSpy.mock.calls, ...errorSpy.mock.calls];
    expect(calls.length).toBe(2);
    for (const args of calls) {
      expect(args.length).toBe(1);
      expect(typeof args[0]).toBe('string');
    }
  });

  test('redacts URL userinfo and query in an Error', () => {
    new PullPushLogger().error(
      new Error('PUT https://user:pass@host/p?token=abc failed')
    );
    const out = output();
    expect(out).toContain('PUT https://<redacted>@host/p?<redacted>');
    expect(out).not.toContain('user:pass');
    expect(out).not.toContain(':pass@');
    expect(out).not.toContain('token=abc');
  });

  test('does not leak auth config of an axios-like error object', () => {
    const err = {
      message: 'Request failed with status code 401',
      config: {
        auth: { username: 'u1', password: 'p1' },
        headers: {
          Authorization: 'Digest username="u1", realm="r", response="deadbeef"'
        }
      }
    };
    new PullPushLogger().error(err);
    const out = output();
    expect(out).toContain('Request failed with status code 401');
    expect(out).not.toMatch(/\bu1\b/);
    expect(out).not.toMatch(/\bp1\b/);
    expect(out).not.toContain('deadbeef');
  });

  test('does not leak enumerable props of a real Error', () => {
    const err = Object.assign(new Error('Request failed'), {
      config: { auth: { username: 'u1', password: 'p1' } }
    });
    new PullPushLogger().error(err);
    const out = output();
    expect(out).toContain('Error: Request failed');
    expect(out).not.toMatch(/\bu1\b/);
    expect(out).not.toMatch(/\bp1\b/);
  });

  test('handles non-string values without throwing', () => {
    const circular: Record<string, unknown> = { name: 'loop' };
    circular.self = circular;
    const logger = new PullPushLogger();
    expect(() => {
      logger.error(42);
      logger.error(undefined);
      logger.error(null);
      logger.error(circular);
    }).not.toThrow();
    const out = output();
    expect(out).toContain('42');
    expect(out).toContain('undefined');
    expect(out).toContain('null');
  });

  test('scrubs exact secret values in raw and percent-encoded form', () => {
    new PullPushLogger(['s3cr3tUser', 'p@ss/w0rd']).error(
      'weird format: s3cr3tUser failed, tried p%40ss%2Fw0rd'
    );
    const out = output();
    expect(out).not.toContain('s3cr3tUser');
    expect(out).not.toContain('p%40ss%2Fw0rd');
    expect(out).not.toContain('p@ss/w0rd');
    expect(out).toContain('weird format: <redacted> failed, tried <redacted>');
  });

  test('scrubs secrets given in percent-encoded (URL) form', () => {
    const url = new URL('https://s3cr3tUser:p%40ss%2Fw0rd@example.com/in');
    new PullPushLogger([url.username, url.password]).info(
      'tried p@ss/w0rd and p%40ss%2Fw0rd'
    );
    const out = output();
    expect(out).not.toContain('p@ss/w0rd');
    expect(out).not.toContain('p%40ss%2Fw0rd');
  });

  test('ignores secrets shorter than 3 characters', () => {
    new PullPushLogger(['a']).info('a banana and a cat');
    expect(output()).toContain('a banana and a cat');
  });
});
