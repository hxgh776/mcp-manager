import { stableHash, stableStringify } from '../fsutil.js';
import type { KeyState } from '../types.js';
import type { ConflictInfo, ConflictResolution, FragmentWrite } from './types.js';

export const JSON_EQUAL = (a: unknown, b: unknown): boolean =>
  stableStringify(a) === stableStringify(b);

export interface PlannedChange {
  key: string;
  action: 'upsert' | 'remove' | 'none';
  /** upsert 时要写入的 agent 原生值 */
  desired?: unknown;
}

/**
 * 共享的写入计划：依据上次同步 hash 判定冲突，缺省"冲突即跳过"。
 *
 * 冲突判定（C8）：
 * - 上次由本工具写入（previous 有记录）且文件中该片段 hash 已漂移、又不等于本次目标值 → 用户手改过 → 冲突；
 * - 无 previous 记录但键已存在（删除方向）→ 键非本工具所写 → 一律视为冲突，绝不静默删除。
 */
export function planChanges(params: {
  currentValues: Map<string, unknown>;
  writes: FragmentWrite[];
  previous: KeyState[];
  resolutions: Record<string, ConflictResolution>;
  denormalize: (entry: NonNullable<FragmentWrite['entry']>) => unknown;
}): { plan: PlannedChange[]; conflicts: ConflictInfo[] } {
  const { currentValues, writes, previous, resolutions, denormalize } = params;
  const plan: PlannedChange[] = [];
  const conflicts: ConflictInfo[] = [];

  for (const write of writes) {
    const current = currentValues.get(write.key);
    const currentHash = current === undefined ? null : stableHash(current);
    const prev = previous.find((p) => p.key === write.key);

    const recordConflict = (expectedHash: string): void => {
      const resolution = resolutions[write.key] ?? 'skip';
      conflicts.push({
        key: write.key,
        expectedHash,
        currentHash: currentHash ?? 'absent',
        resolution,
      });
    };

    if (write.entry === null) {
      if (current === undefined) {
        plan.push({ key: write.key, action: 'none' });
        continue;
      }
      if (!prev) {
        recordConflict('absent');
        if ((resolutions[write.key] ?? 'skip') === 'override') {
          plan.push({ key: write.key, action: 'remove' });
        } else {
          plan.push({ key: write.key, action: 'none' });
        }
        continue;
      }
      if (prev.hash !== currentHash) {
        recordConflict(prev.hash);
        if (resolutions[write.key] === 'override') plan.push({ key: write.key, action: 'remove' });
        else plan.push({ key: write.key, action: 'none' });
        continue;
      }
      plan.push({ key: write.key, action: 'remove' });
      continue;
    }

    const desired = denormalize(write.entry);
    if (current !== undefined && JSON_EQUAL(desired, current)) {
      plan.push({ key: write.key, action: 'none', desired });
      continue;
    }
    if (prev && prev.hash !== currentHash) {
      recordConflict(prev.hash);
      if (resolutions[write.key] === 'override') {
        plan.push({ key: write.key, action: 'upsert', desired });
      } else {
        plan.push({ key: write.key, action: 'none', desired });
      }
      continue;
    }
    plan.push({ key: write.key, action: 'upsert', desired });
  }

  return { plan, conflicts };
}

/** 计划完成后（真实或推演），产出最终 keyStates */
export function finalizeKeyStates(
  plan: PlannedChange[],
  currentAfter: Map<string, unknown>,
): KeyState[] {
  const states: KeyState[] = [];
  for (const change of plan) {
    const value = currentAfter.get(change.key);
    if (value !== undefined) {
      states.push({ key: change.key, hash: stableHash(value) });
    }
  }
  return states;
}
