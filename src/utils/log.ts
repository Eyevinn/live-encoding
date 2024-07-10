import chalk, { ForegroundColor } from 'chalk';
import util from 'util';

let logger_: Logger | undefined;

type LevelCode = 'info' | 'error' | 'warn' | 'debug' | 'fatal';
type LevelItem = {
  text: string;
  method: LevelCode;
  color: typeof ForegroundColor;
};
const LEVELS: { [k in LevelCode]: LevelItem } = {
  info: { text: 'info', method: 'info', color: 'white' },
  error: { text: 'error', method: 'error', color: 'red' },
  warn: { text: 'warn', method: 'info', color: 'yellow' },
  debug: { text: 'debug', method: 'info', color: 'blue' },
  fatal: { text: 'fatal', method: 'error', color: 'redBright' }
};

function log(method: LevelCode) {
  switch (method) {
    case 'info':
      return console.info;
    case 'error':
      return console.error;
    default:
      throw new Error(`Invalid log method ${method}`);
  }
}

function logfmt(levelCode: LevelCode, ...args: any[]) {
  const level = LEVELS[levelCode];
  if (levelCode == 'debug') {
    log(level.method)(...args);
  } else {
    const msg = util.format(...args);
    log(level.method)(chalk[level.color](msg));
  }
}

export class Logger {
  private debugMode = false;

  constructor() {
    return this;
  }

  info(...args: any[]) {
    logfmt('info', ...args);
    return this;
  }

  warn(...args: any[]) {
    logfmt('warn', ...args);
    return this;
  }

  error(...args: any[]) {
    logfmt('error', ...args);
    return this;
  }

  debug(...args: any[]) {
    if (this.debugMode) logfmt('debug', ...args);
    return this;
  }

  fatal(...args: any[]) {
    logfmt('fatal', ...args);
    return this;
  }

  get level(): 'debug' | 'info' {
    return this.debugMode ? 'debug' : 'info';
  }

  set level(value: 'debug' | 'info') {
    if (value == 'debug') {
      this.debugMode = true;
    } else if (value == 'info') {
      this.debugMode = false;
    } else {
      this.warn('level', value, 'not supported');
    }
  }
}

export function Log(): Logger {
  if (logger_) {
    return logger_;
  }

  logger_ = new Logger();
  logger_.level = 'info';

  if (process.env.DEBUG) {
    logger_.level = 'debug';
  }

  return logger_;
}
