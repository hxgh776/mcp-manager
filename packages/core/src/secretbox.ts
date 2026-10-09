import { spawn } from 'node:child_process';

/**
 * S4 凭证加密：ServerDef.env / headers 的静态加密。
 *
 * - Windows：DPAPI（CurrentUser 作用域，经 PowerShell ProtectedData，无原生依赖），
 *   密文形如 `dpapi:v1:<base64>`；
 * - macOS/Linux：M3 暂为明文回退（原样返回），UI 明示；M4 计划接 Keychain/libsecret。
 *
 * 使用边界：静态加密保护 config.json 落盘；直连分发写入 agent 配置的 env 仍需明文
 * （agent 进程要真实读取），网关模式才是凭证不落地。
 */

export const DPAPI_PREFIX = 'dpapi:v1:';

export function encryptionBackend(): 'dpapi' | 'plaintext' {
  return process.platform === 'win32' ? 'dpapi' : 'plaintext';
}

export function isEncrypted(value: string): boolean {
  return value.startsWith(DPAPI_PREFIX);
}

export async function encryptSecret(plain: string): Promise<string> {
  if (plain === '' || isEncrypted(plain)) return plain;
  if (encryptionBackend() !== 'dpapi') return plain;
  const b64 = Buffer.from(plain, 'utf8').toString('base64');
  const out = await runPowerShell(
    'Add-Type -AssemblyName System.Security; ' +
      '$b64=[Console]::In.ReadToEnd().Trim(); ' +
      '$bytes=[Convert]::FromBase64String($b64); ' +
      '$enc=[Security.Cryptography.ProtectedData]::Protect($bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser); ' +
      '[Console]::Out.Write([Convert]::ToBase64String($enc))',
    b64,
  );
  return DPAPI_PREFIX + out;
}

export async function decryptSecret(value: string): Promise<string> {
  if (!isEncrypted(value)) return value;
  // 输出 base64 再由 Node 解码，避免 PowerShell 控制台编码（GBK 等）损坏非 ASCII 字符
  const b64 = await runPowerShell(
    'Add-Type -AssemblyName System.Security; ' +
      '$b64=[Console]::In.ReadToEnd().Trim(); ' +
      '$bytes=[Convert]::FromBase64String($b64); ' +
      '$dec=[Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser); ' +
      '[Console]::Out.Write([Convert]::ToBase64String($dec))',
    value.slice(DPAPI_PREFIX.length),
  );
  return Buffer.from(b64, 'base64').toString('utf8');
}

export async function encryptRecord(
  record: Record<string, string> | undefined,
): Promise<Record<string, string> | undefined> {
  if (record === undefined) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(record)) {
    out[k] = await encryptSecret(v);
  }
  return out;
}

export async function decryptRecord(
  record: Record<string, string> | undefined,
): Promise<Record<string, string> | undefined> {
  if (record === undefined) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(record)) {
    out[k] = await decryptSecret(v);
  }
  return out;
}

function runPowerShell(script: string, stdin: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`DPAPI 操作失败: ${stderr.trim().slice(0, 200)}`));
    });
    child.stdin.write(stdin);
    child.stdin.end();
  });
}
