import { execFile } from 'node:child_process';

export interface RuntimeTool {
  name: string;
  /** 这个运行时承担的角色说明 */
  role: string;
  found: boolean;
  version?: string;
}

const SPECS: Array<{ name: string; role: string }> = [
  { name: 'node', role: 'stdio server 与反向桥的运行时' },
  { name: 'npx', role: 'npx 型 server 启动' },
  { name: 'uvx', role: 'python 型 server 启动' },
  { name: 'docker', role: '容器型 server 启动' },
  { name: 'git', role: '通用版本控制' },
];

/** S5 环境检测：探测本机 server 运行时是否可用（缺 npx/uvx 时对应类型的 server 无法启动）。 */
export async function detectEnvironment(): Promise<RuntimeTool[]> {
  return Promise.all(SPECS.map((spec) => detectTool(spec)));
}

async function detectTool(spec: { name: string; role: string }): Promise<RuntimeTool> {
  // Windows 上 npx 等是 .cmd shim，execFile 不带 shell 找不到——候选名 + shell 兜底
  const candidates =
    process.platform === 'win32'
      ? [`${spec.name}.cmd`, `${spec.name}.exe`, spec.name]
      : [spec.name];
  for (const candidate of candidates) {
    const found = await tryVersion(candidate);
    if (found !== null) return { ...spec, found: true, ...(found ? { version: found } : {}) };
  }
  return { ...spec, found: false };
}

function tryVersion(command: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      command,
      ['--version'],
      {
        timeout: 6000,
        windowsHide: true,
        shell: process.platform === 'win32',
      },
      (err, stdout) => {
        if (err) {
          resolve(null);
          return;
        }
        const firstLine = String(stdout).split('\n')[0]?.trim();
        resolve(firstLine ? firstLine.slice(0, 60) : '');
      },
    );
  });
}
