import { promises as fs } from 'node:fs';
import path from 'node:path';

/**
 * 写入 agent 配置文件前的滚动备份：backupsRoot/<agentType>/<时间戳>-<原名>。
 * 文件不存在时返回 null（无需备份）；超过 keep 份时删除最旧的。
 */
export async function backupFile(
  file: string,
  agentType: string,
  backupsRoot: string,
  keep = 10,
): Promise<string | null> {
  let content: string;
  try {
    content = await fs.readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  const dir = path.join(backupsRoot, agentType);
  await fs.mkdir(dir, { recursive: true });
  const ts = new Date()
    .toISOString()
    .replaceAll(/[:.]/g, '-')
    .replace('T', '_')
    .slice(0, 23);
  const dest = path.join(dir, `${ts}-${path.basename(file)}`);
  await fs.writeFile(dest, content, 'utf8');
  await pruneOld(dir, keep);
  return dest;
}

async function pruneOld(dir: string, keep: number): Promise<void> {
  const entries = await fs.readdir(dir);
  if (entries.length <= keep) return;
  const sorted = entries.sort(); // 固定宽度时间戳前缀，字典序即时间序
  for (const name of sorted.slice(0, entries.length - keep)) {
    await fs.rm(path.join(dir, name), { force: true });
  }
}
