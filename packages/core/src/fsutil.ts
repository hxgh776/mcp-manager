import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

/** 原子写：临时文件 + 同卷 rename；成功后目录内不残留临时文件。
 * Windows 上 rename 覆盖已有文件可能因目标被短暂占用（杀软/索引器）抛 EPERM/EBUSY，
 * 采用指数退避重试——这是发布到用户机器的必要健壮性。 */
export async function atomicWriteFile(filePath: string, data: string): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  try {
    await fs.writeFile(tmp, data, 'utf8');
    let lastError: unknown;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await fs.rename(tmp, filePath);
        return;
      } catch (err) {
        lastError = err;
        const code = (err as NodeJS.ErrnoException).code;
        const transient =
          code === 'EPERM' || code === 'EBUSY' || code === 'EACCES';
        if (!transient || attempt === 4) break;
        await new Promise((resolve) => setTimeout(resolve, 10 * 2 ** attempt));
      }
    }
    throw lastError;
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

export async function readTextIfExists(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * 确定性序列化：对象键递归排序、数组保序、undefined 字段剔除。
 * 用于"管辖片段"的内容 hash——同内容不同键序必须得到相同 hash。
 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value)) ?? 'null';
}

function sortValue(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(sortValue);
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    const v = (value as Record<string, unknown>)[key];
    if (v !== undefined) out[key] = sortValue(v);
  }
  return out;
}

export function stableHash(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}
