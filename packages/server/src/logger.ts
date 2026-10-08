import { promises as fs } from 'node:fs';
import path from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** 极简文件+控制台日志：daemon.log 追加写，密钥脱敏交给调用方（绝不打印 env/headers）。 */
export class Logger {
  private minLevel: number = LEVEL_ORDER.info;

  constructor(
    private readonly logFile: string | null,
    level: LogLevel = 'info',
  ) {
    this.minLevel = LEVEL_ORDER[level] ?? LEVEL_ORDER.info;
  }

  setLevel(level: LogLevel): void {
    this.minLevel = LEVEL_ORDER[level] ?? LEVEL_ORDER.info;
  }

  debug(msg: string, extra?: Record<string, unknown>): void {
    void this.write('debug', msg, extra);
  }

  info(msg: string, extra?: Record<string, unknown>): void {
    void this.write('info', msg, extra);
  }

  warn(msg: string, extra?: Record<string, unknown>): void {
    void this.write('warn', msg, extra);
  }

  error(msg: string, extra?: Record<string, unknown>): void {
    void this.write('error', msg, extra);
  }

  private async write(level: string, msg: string, extra?: Record<string, unknown>): Promise<void> {
    if ((LEVEL_ORDER[level as LogLevel] ?? 0) < this.minLevel) return;
    const line = `${new Date().toISOString()} [${level.toUpperCase()}] ${msg}${formatExtra(extra)}`;
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
    if (this.logFile) {
      try {
        await fs.mkdir(path.dirname(this.logFile), { recursive: true });
        await fs.appendFile(this.logFile, `${line}\n`, 'utf8');
      } catch {
        // 日志写失败不影响主流程
      }
    }
  }
}

function formatExtra(extra?: Record<string, unknown>): string {
  if (!extra || Object.keys(extra).length === 0) return '';
  return ` ${JSON.stringify(extra)}`;
}
