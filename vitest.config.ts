import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      // 让测试直接跑各包的 TS 源码，无需先 build
      '@mcp-manager/core': path.resolve(__dirname, 'packages/core/src/index.ts'),
      '@mcp-manager/server': path.resolve(__dirname, 'packages/server/src/index.ts'),
    },
  },
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    testTimeout: 20000,
    hookTimeout: 20000,
    pool: 'forks',
  },
  esbuild: { target: 'es2022' },
});
