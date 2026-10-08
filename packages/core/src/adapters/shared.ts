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

/**
 * 计划完成后（真实或推演），产出最终 keyStates。
 *
 * 关键语义：keyStates.hash 永远代表"本工具最后一次写入（或确认无漂移）的内容 hash"。
 * - upsert：记录写入后的 hash；
 * - remove：删除失败/被跳过且存在上次快照 → 保留上次快照（冲突态持续可见）；
 * - none 且当前值与上次快照不一致（用户手改被跳过）→ 保留上次快照，
 *   绝不把用户的手改 hash 记为快照，否则冲突会被静默吞掉。
 */
export function finalizeKeyStates(
  plan: PlannedChange[],
  currentAfter: Map<string, unknown>,
  previous: KeyState[],
): KeyState[] {
  const states: KeyState[] = [];
  for (const change of plan) {
    const value = currentAfter.get(change.key);
    const prev = previous.find((p) => p.key === change.key);
    const currentHash = value === undefined ? null : stableHash(value);
    if (change.action === 'upsert') {
      if (currentHash !== null) states.push({ key: change.key, hash: currentHash });
      continue;
    }
    if (change.action === 'remove') {
      if (currentHash !== null && prev) states.push({ key: change.key, hash: prev.hash });
      continue;
    }
    // none
    if (currentHash === null) continue;
    if (prev && prev.hash !== currentHash) {
      states.push({ key: change.key, hash: prev.hash });
    } else {
      states.push({ key: change.key, hash: currentHash });
    }
  }
  return states;
}
