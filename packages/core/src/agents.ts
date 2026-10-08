import os from 'node:os';
import path from 'node:path';
import {
  CodexTomlAdapter,
} from './adapters/codex-toml.js';
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

function home(...segments: string[]): string {
  return path.join(os.homedir(), ...segments);
}

const claudeCode = new JsonAgentAdapter({
  type: 'claude-code',
  displayName: 'Claude Code',
  transports: ['stdio', 'http'],
  paths: [home('.claude.json')],
  containerKey: 'mcpServers',
  normalize: normalizeClaudeStyle,
  denormalize: denormalizeClaudeStyle,
});

const codex = new CodexTomlAdapter([home('.codex', 'config.toml')]);

const cursor = new JsonAgentAdapter({
  type: 'cursor',
  displayName: 'Cursor',
  transports: ['stdio', 'http'],
  paths: [home('.cursor', 'mcp.json')],
  containerKey: 'mcpServers',
  normalize: normalizeUrlOrCommand,
  denormalize: denormalizeUrlOrCommand,
});

const trae = new JsonAgentAdapter({
  type: 'trae',
  displayName: 'Trae',
  transports: ['stdio', 'http'],
  paths: [home('.trae', 'mcp.json'), home('.trae-cn', 'mcp.json')],
  containerKey: 'mcpServers',
  normalize: normalizeUrlOrCommand,
  denormalize: denormalizeUrlOrCommand,
});

const opencode = new JsonAgentAdapter({
  type: 'opencode',
  displayName: 'OpenCode',
  transports: ['stdio', 'http'],
  paths: [home('.config', 'opencode', 'opencode.json')],
  containerKey: 'mcp',
  normalize: normalizeOpencode,
  denormalize: denormalizeOpencode,
});

export const AGENTS: Record<AgentType, AgentDefinition> = {
  'claude-code': { type: 'claude-code', displayName: 'Claude Code', adapter: claudeCode },
  codex: { type: 'codex', displayName: 'Codex CLI', adapter: codex },
  cursor: { type: 'cursor', displayName: 'Cursor', adapter: cursor },
  trae: { type: 'trae', displayName: 'Trae', adapter: trae },
  opencode: { type: 'opencode', displayName: 'OpenCode', adapter: opencode },
};

export const AGENT_LIST: AgentDefinition[] = Object.values(AGENTS);
