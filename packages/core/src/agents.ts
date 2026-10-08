import os from 'node:os';
import path from 'node:path';
import { CodexTomlAdapter } from './adapters/codex-toml.js';
import {
  JsonAgentAdapter,
  denormalizeClaudeStyle,
  denormalizeOpencode,
  denormalizeUrlOrCommand,
  normalizeClaudeStyle,
  normalizeOpencode,
  normalizeUrlOrCommand,
} from './adapters/json-adapter.js';
import type { AgentAdapter } from './adapters/types.js';
import type { AgentType } from './types.js';

export interface AgentDefinition {
  type: AgentType;
  displayName: string;
  adapter: AgentAdapter;
}

/**
 * 构建全部 agent 定义。baseDir 缺省为用户主目录；
 * 测试传入沙箱目录即可获得与生产完全一致的适配器组合。
 */
export function makeAgents(baseDir?: string): Record<AgentType, AgentDefinition> {
  const p = (...segments: string[]): string => path.join(baseDir ?? os.homedir(), ...segments);

  const claudeCode = new JsonAgentAdapter({
    type: 'claude-code',
    displayName: 'Claude Code',
    transports: ['stdio', 'http'],
    paths: [p('.claude.json')],
    containerKey: 'mcpServers',
    normalize: normalizeClaudeStyle,
    denormalize: denormalizeClaudeStyle,
  });

  const codex = new CodexTomlAdapter([p('.codex', 'config.toml')]);

  const cursor = new JsonAgentAdapter({
    type: 'cursor',
    displayName: 'Cursor',
    transports: ['stdio', 'http'],
    paths: [p('.cursor', 'mcp.json')],
    containerKey: 'mcpServers',
    normalize: normalizeUrlOrCommand,
    denormalize: denormalizeUrlOrCommand,
  });

  const trae = new JsonAgentAdapter({
    type: 'trae',
    displayName: 'Trae',
    transports: ['stdio', 'http'],
    paths: [p('.trae', 'mcp.json'), p('.trae-cn', 'mcp.json')],
    containerKey: 'mcpServers',
    normalize: normalizeUrlOrCommand,
    denormalize: denormalizeUrlOrCommand,
  });

  const opencode = new JsonAgentAdapter({
    type: 'opencode',
    displayName: 'OpenCode',
    transports: ['stdio', 'http'],
    paths: [p('.config', 'opencode', 'opencode.json')],
    containerKey: 'mcp',
    normalize: normalizeOpencode,
    denormalize: denormalizeOpencode,
  });

  return {
    'claude-code': { type: 'claude-code', displayName: 'Claude Code', adapter: claudeCode },
    codex: { type: 'codex', displayName: 'Codex CLI', adapter: codex },
    cursor: { type: 'cursor', displayName: 'Cursor', adapter: cursor },
    trae: { type: 'trae', displayName: 'Trae', adapter: trae },
    opencode: { type: 'opencode', displayName: 'OpenCode', adapter: opencode },
  };
}

export const AGENTS: Record<AgentType, AgentDefinition> = makeAgents();
export const AGENT_LIST: AgentDefinition[] = Object.values(AGENTS);
