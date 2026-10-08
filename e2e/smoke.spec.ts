// E2E 冒烟：token 门 → 概览 → 添加 server → 分发预览 → 网关页。
// daemon 由 helpers 启动（沙箱 HOME + 沙箱 agent 配置根）。
import { afterAll, beforeAll, expect, test } from '@playwright/test';
import { startTestDaemon, type TestDaemon } from './helpers';

let daemon: TestDaemon;

beforeAll(async () => {
  daemon = await startTestDaemon();
});

afterAll(async () => {
  await daemon?.stop();
});

async function auth(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/');
  if ((await page.getByTestId('token-input').count()) > 0) {
    await page.getByTestId('token-input').fill(daemon.token);
    await page.getByTestId('token-submit').click();
  }
}

test('E-01 token 门进入后可见概览与本机 agent 卡片', async ({ page }) => {
  await auth(page);
  await expect(page.getByTestId('home-dir')).toBeVisible();
  await expect(page.getByTestId('agent-card-claude-code')).toBeVisible();
});

test('E-04 添加 server（stdio）出现在注册表', async ({ page }) => {
  await auth(page);
  await page.getByTestId('tab-servers').click();
  await page.getByTestId('btn-add-server').click();
  await page.getByTestId('form-name').fill('smoke-fs');
  await page.getByTestId('form-command').fill(process.execPath);
  await page.getByTestId('form-args').fill('E2E_PLACEHOLDER');
  await page.getByTestId('form-save').click();
  await expect(page.getByTestId('server-row-smoke-fs')).toBeVisible();
});

test('E-03 分发预览（dry-run）出报告', async ({ page }) => {
  await auth(page);
  await page.getByTestId('tab-sync').click();
  await page.getByTestId('btn-dry-run').click();
  await expect(page.getByText('预览完成')).toBeVisible();
});

test('E-06 网关页展示运行状态与端点', async ({ page }) => {
  await auth(page);
  await page.getByTestId('tab-gateway').click();
  await expect(page.getByTestId('endpoint-url')).toBeVisible();
});
