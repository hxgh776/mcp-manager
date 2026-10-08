export class CoreError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'CoreError';
  }
}

/** agent 配置文件损坏（JSON/TOML 解析失败）——禁止写入，必须显式处理 */
export class MalformedConfigError extends CoreError {
  constructor(
    readonly filePath: string,
    readonly cause?: unknown,
  ) {
    super(`agent 配置文件无法解析: ${filePath}`, 'MALFORMED_CONFIG');
    this.name = 'MalformedConfigError';
  }
}

/** 写入后复读校验失败——已回滚 */
export class WriteVerificationError extends CoreError {
  constructor(
    readonly filePath: string,
  ) {
    super(`写入后校验失败，已回滚: ${filePath}`, 'WRITE_VERIFICATION_FAILED');
    this.name = 'WriteVerificationError';
  }
}

export class ConfigConflictError extends CoreError {
  constructor(message: string) {
    super(message, 'CONFIG_CONFLICT');
    this.name = 'ConfigConflictError';
  }
}
