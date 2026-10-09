#!/usr/bin/env node
// G7 stdio 反向桥独立入口：
//   node bridge-main.js <url> [--token=xxx] [--header k=v]... [--name xxx]
// 由同步引擎写入不支持 http 的 agent（Codex）配置，也可手动运行。
import { runBridgeStdio, parseBridgeArgs } from './gateway/bridge.js';

const opts = parseBridgeArgs(process.argv.slice(2));
await runBridgeStdio(opts);
