import { ILogger } from '@eyevinn/hls-pull-push';
import { Log } from './log';

export class PullPushLogger implements ILogger {
  info(msg: any) {
    Log().info(msg);
  }

  verbose(msg: any) {
    Log().debug(msg);
  }

  error(msg: any) {
    Log().error(msg);
  }

  warn(msg: any) {
    Log().warn(msg);
  }
}
