import {
  MAX_LOG_ARG_LENGTH,
  expandSecrets,
  redactCredentialTokens,
  redactSecrets,
  sanitizeLogArg,
  scrubExactValues
} from './redact';
import { redactSecrets as redactSecretsFromEncoder } from '../encoder';

describe('redactSecrets', () => {
  test('is re-exported from encoder.ts', () => {
    expect(redactSecretsFromEncoder).toBe(redactSecrets);
  });

  test('redacts URL userinfo and query string', () => {
    expect(redactSecrets('srt://h:9000?passphrase=x')).toBe(
      'srt://h:9000?<redacted>'
    );
    expect(redactSecrets('https://u:p@h/x')).toBe('https://<redacted>@h/x');
  });

  test('leaves URLs without userinfo or query untouched', () => {
    const s = 'see rtmp://0.0.0.0:1935/live/stream and a://b/c then x';
    expect(redactSecrets(s)).toBe(s);
    expect(redactSecrets('go 1http://u:p@h/x?q=1')).toBe(
      'go 1http://<redacted>@h/x?<redacted>'
    );
  });

  test.each([
    ['a://', 'a://'.repeat(20000)],
    ['letters', 'a'.repeat(80000)],
    ['scheme-like', 'a:'.repeat(40000)],
    ['userinfo-like', 'a://b'.repeat(16000) + '@']
  ])('runs in linear time on adversarial input (%s)', (_name, input) => {
    const start = Date.now();
    redactSecrets(input);
    sanitizeLogArg({ input });
    expect(Date.now() - start).toBeLessThan(500);
  });
});

describe('redactCredentialTokens', () => {
  test('redacts JSON credential fields', () => {
    expect(
      redactCredentialTokens('{"username":"bob","password":"hunter2"}, next=1')
    ).toBe('{"username":<redacted>,"password":<redacted>}, next=1');
  });

  test('redacts quoted and plain values, keeping surrounding text', () => {
    expect(redactCredentialTokens('x username="bob smith", next=1')).toBe(
      'x username=<redacted>, next=1'
    );
    expect(redactCredentialTokens('password=hunter2, next=1')).toBe(
      'password=<redacted>, next=1'
    );
    expect(redactCredentialTokens("user: 'bob' pass=x&y=1")).toBe(
      'user: <redacted> pass=<redacted>&y=1'
    );
  });

  test('redacts Authorization header values', () => {
    expect(
      redactCredentialTokens(
        'Authorization: Digest username="u1", realm="r", response="deadbeef"'
      )
    ).toBe('Authorization: <redacted>');
    expect(redactCredentialTokens('Authorization: Bearer abc.def')).toBe(
      'Authorization: <redacted>'
    );
    expect(
      redactCredentialTokens('{"Authorization":"Basic dTE6cDE=","x":1}')
    ).toBe('{"Authorization":"<redacted>","x":1}');
  });

  test('redacts digest auth parameters', () => {
    const out = redactCredentialTokens(
      'realm="r", nonce="n1", cnonce="c1", opaque="o1", response="deadbeef"'
    );
    expect(out).toBe(
      'realm="r", nonce="<redacted>", cnonce="<redacted>", ' +
        'opaque="<redacted>", response="<redacted>"'
    );
  });

  test('does not end a quoted value at an escaped quote', () => {
    expect(
      redactCredentialTokens('{"password":"ab\\"cdLEAKEDTAIL","x":1}')
    ).toBe('{"password":<redacted>,"x":1}');
    expect(redactCredentialTokens("user: 'it\\'sLEAK' next")).toBe(
      'user: <redacted> next'
    );
    expect(redactCredentialTokens('{"password":"ab\\\\","x":1}')).toBe(
      '{"password":<redacted>,"x":1}'
    );
  });

  test('leaves look-alike words untouched', () => {
    for (const s of ['superuser=1', 'bypass', 'compass: north', 'users: 3']) {
      expect(redactCredentialTokens(s)).toBe(s);
    }
  });
});

describe('scrubExactValues / expandSecrets', () => {
  test('replaces literal occurrences, including regex metacharacters', () => {
    expect(scrubExactValues('a+b.c? and a+b.c?', ['a+b.c?'])).toBe(
      '<redacted> and <redacted>'
    );
  });

  test('expands encoded/decoded forms and drops short secrets', () => {
    const s = expandSecrets(['p@ss/w0rd', 'a', '']);
    expect(s).toContain('p@ss/w0rd');
    expect(s).toContain('p%40ss%2Fw0rd');
    expect(s).not.toContain('a');
  });

  test('tolerates invalid percent-encoding', () => {
    expect(expandSecrets(['abc%zz'])).toContain('abc%zz');
  });
});

describe('sanitizeLogArg', () => {
  test('returns plain strings unchanged', () => {
    expect(sanitizeLogArg('hello world')).toBe('hello world');
  });

  test('serialises non-string values', () => {
    expect(sanitizeLogArg(42)).toBe('42');
    expect(sanitizeLogArg(null)).toBe('null');
    expect(sanitizeLogArg(undefined)).toBe('undefined');
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(sanitizeLogArg(circular)).toBe('[object Object]');
  });

  test('caps the length of serialised objects', () => {
    const out = sanitizeLogArg({ big: 'x'.repeat(MAX_LOG_ARG_LENGTH * 2) });
    expect(out.length).toBeLessThan(MAX_LOG_ARG_LENGTH + 32);
    expect(out).toMatch(/\[truncated]$/);
  });

  test('redacts a password containing a quote in a serialised object', () => {
    const out = sanitizeLogArg({
      message: 'Request failed',
      config: { auth: { username: 'svc', password: 'ab"cdLEAKEDTAIL' } }
    });
    expect(out).not.toContain('LEAKEDTAIL');
    expect(out).not.toContain('svc');
    expect(out).toContain('Request failed');
  });

  test('uses only name, message and stack of an Error', () => {
    const err = Object.assign(new Error('boom'), { secretProp: 'zzsecret' });
    const out = sanitizeLogArg(err);
    expect(out.startsWith('Error: boom')).toBe(true);
    expect(out).not.toContain('zzsecret');
  });
});
