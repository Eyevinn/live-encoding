import { ILogger } from '@eyevinn/hls-pull-push';
import { Log } from './log';
import { expandSecrets, sanitizeLogArg } from './redact';

// Forwards @eyevinn/hls-pull-push log messages to our logger. The upstream
// library logs ingest credentials (e.g. the MediaPackage username on a failed
// upload), so every message is reduced to one sanitised string first.
export class PullPushLogger implements ILogger {
  private secrets: string[];

  // secrets: known credential values (e.g. OUTPUT_URL username/password) that
  // are scrubbed from every message by exact value, in raw, percent-encoded
  // and percent-decoded form.
  constructor(secrets: string[] = []) {
    this.secrets = expandSecrets(secrets);
  }

  private sanitize(msg: unknown): string {
    return sanitizeLogArg(msg, this.secrets);
  }

  info(msg: unknown) {
    Log().info(this.sanitize(msg));
  }

  verbose(msg: unknown) {
    Log().debug(this.sanitize(msg));
  }

  error(msg: unknown) {
    Log().error(this.sanitize(msg));
  }

  warn(msg: unknown) {
    Log().warn(this.sanitize(msg));
  }
}
