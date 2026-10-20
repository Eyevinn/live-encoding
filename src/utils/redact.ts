// Helpers that strip credentials and other secrets from values before they are
// logged or returned in an error response.

// Upper bound on the length of a serialised non-string log argument, so that
// a large object (e.g. an HTTP client error) cannot flood the log.
export const MAX_LOG_ARG_LENGTH = 4096;

// Secrets shorter than this are not scrubbed by exact value: replacing every
// occurrence of a one or two character string would mangle the whole message.
const MIN_SECRET_LENGTH = 3;

const REDACTED = '<redacted>';

// Redact secrets that may appear in a value that is logged or placed into an
// error message: basic-auth userinfo embedded in a URL (user:pass@host) and URL
// query strings (which may carry a passphrase or a signed-URL token).
export function redactSecrets(value: string): string {
  return value
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^/@\s]*@/gi, '$1<redacted>@')
    .replace(/([a-z][a-z0-9+.-]*:\/\/[^\s?]*)\?[^\s]*/gi, '$1?<redacted>');
}

// Redact credential-looking key/value tokens: `username: x`, `password=x`,
// `"user":"x"`, HTTP Authorization header values and digest-auth parameters.
export function redactCredentialTokens(value: string): string {
  return (
    value
      // Quoted Authorization value, e.g. JSON `"Authorization":"Digest ..."`.
      // Escape-aware so that a JSON-escaped \" inside does not end the match.
      .replace(
        /(\bauthorization["']?\s*[:=]\s*)"(?:\\.|[^"\\\r\n])*"/gi,
        `$1"${REDACTED}"`
      )
      .replace(
        /(\bauthorization["']?\s*[:=]\s*)'(?:\\.|[^'\\\r\n])*'/gi,
        `$1'${REDACTED}'`
      )
      // Unquoted header form: the value runs to the end of the line.
      .replace(
        /(\bauthorization\s*[:=]\s*)(?:Digest|Basic|Bearer)\b[^\r\n]*/gi,
        `$1${REDACTED}`
      )
      // Digest-auth parameters, plain or JSON-escaped quotes.
      .replace(
        /\b(response|nonce|cnonce|opaque)=(\\?)"(?:[^"\\]|\\(?!"))*\\?"/gi,
        `$1=$2"${REDACTED}$2"`
      )
      .replace(
        /\b(username|password|passwd|user|pass)\b(["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;&)}\]]+)/gi,
        `$1$2${REDACTED}`
      )
  );
}

// Replace every literal occurrence of each secret with <redacted>. Uses
// split/join rather than a regex so secrets need no escaping.
export function scrubExactValues(value: string, secrets: string[]): string {
  let out = value;
  for (const secret of secrets) {
    if (secret.length < MIN_SECRET_LENGTH) continue;
    out = out.split(secret).join(REDACTED);
  }
  return out;
}

// Expand a list of secrets with their percent-encoded and percent-decoded
// forms, drop too-short values and order longest first so that a secret that
// is a substring of another does not leave a partial match behind.
export function expandSecrets(secrets: string[]): string[] {
  const all = new Set<string>();
  for (const secret of secrets) {
    if (!secret) continue;
    all.add(secret);
    all.add(encodeURIComponent(secret));
    try {
      const decoded = decodeURIComponent(secret);
      all.add(decoded);
      all.add(encodeURIComponent(decoded));
    } catch {
      // not valid percent-encoding, keep the raw form only
    }
  }
  return [...all]
    .filter((s) => s.length >= MIN_SECRET_LENGTH)
    .sort((a, b) => b.length - a.length);
}

function stringifyLogArg(x: unknown): string {
  if (typeof x === 'string') return x;
  if (x instanceof Error) {
    // Only name, message and stack: enumerable properties of e.g. an HTTP
    // client error (config, request, response) carry auth headers.
    const head = `${x.name}: ${x.message}`;
    const stack = typeof x.stack === 'string' ? x.stack : undefined;
    if (!stack) return head;
    return stack.startsWith(head) ? stack : `${head}\n${stack}`;
  }
  let s: string | undefined;
  try {
    s = JSON.stringify(x);
  } catch {
    s = undefined;
  }
  if (s === undefined) {
    try {
      s = String(x);
    } catch {
      s = '[unserialisable value]';
    }
  }
  return s;
}

// Turn any log argument into a single string with secrets removed: exact
// known secret values, URL userinfo and query strings, and credential tokens.
// Non-string values are capped in length after redaction, so a cut can never
// split a secret and defeat the exact-value scrub.
export function sanitizeLogArg(x: unknown, secrets: string[] = []): string {
  const out = redactCredentialTokens(
    redactSecrets(scrubExactValues(stringifyLogArg(x), secrets))
  );
  if (typeof x !== 'string' && out.length > MAX_LOG_ARG_LENGTH) {
    return out.slice(0, MAX_LOG_ARG_LENGTH) + '...[truncated]';
  }
  return out;
}
