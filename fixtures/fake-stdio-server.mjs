#!/usr/bin/env node
// 测试夹具：一个最小的 stdio MCP server。
// 提供工具：echo / add / env / fail。供网关集成测试与 Web UI E2E 使用。
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const server = new Server(
  { name: 'fake-stdio-server', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'echo',
      description: 'Echo the message back',
      inputSchema: {
        type: 'object',
        properties: { message: { type: 'string' } },
        required: ['message'],
      },
    },
    {
      name: 'add',
      description: 'Add two numbers',
      inputSchema: {
        type: 'object',
        properties: { a: { type: 'number' }, b: { type: 'number' } },
        required: ['a', 'b'],
      },
    },
    {
      name: 'env',
      description: 'Return the MAGIC_VALUE env var (credential pass-through check)',
      inputSchema: { type: 'object', properties: {} },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  switch (name) {
    case 'echo':
      return { content: [{ type: 'text', text: `echo: ${args?.message}` }] };
    case 'add':
      return { content: [{ type: 'text', text: String((args?.a ?? 0) + (args?.b ?? 0)) }] };
    case 'env':
      return { content: [{ type: 'text', text: process.env.MAGIC_VALUE ?? '' }] };
    case 'fail':
      return { content: [{ type: 'text', text: 'boom' }], isError: true };
    default:
      throw new Error(`unknown tool: ${name}`);
  }
});

await server.connect(new StdioServerTransport());
