import { expect, test } from '@playwright/test';

test('web preview completes the Strategy Lab Create → Chat → Flow → Backtest workflow', async ({ page }) => {
  await page.goto('http://127.0.0.1:4176/web-preview.html');
  await expect(page.getByRole('status')).toContainText('Web preview · simulated API · simulated data');
  await expect(page.getByRole('status')).not.toContainText('temporary');
  await expect(page.getByRole('heading', { name: 'Connect your AI provider' })).toBeVisible();

  await page.getByLabel('Profile name').fill('Preview Trader');
  await page.getByLabel('Base URL').fill('https://api.example.com/v1');
  await page.getByLabel('API key').fill('preview-only-key');
  await page.getByLabel('Model').fill('preview/model');
  await page.getByRole('button', { name: 'Connect & continue' }).click();

  await page.getByRole('button', { name: 'Create new bot' }).first().click();
  await page.getByLabel('Bot name').fill('ETH RSI Preview');
  await expect(page.getByRole('combobox', { name: 'DEX' })).toContainText('Hyperliquid');
  await expect(page.getByLabel('Market')).toHaveCount(0);
  await page.getByRole('button', { name: 'Create draft' }).click();
  await expect(page.getByRole('heading', { name: 'ETH RSI Preview' })).toBeVisible();
  await expect(page.getByText('Hyperliquid · Dynamic markets')).toBeVisible();

  await page.getByLabel('Message Catbots AI').fill('For ETH, open a long below RSI 20 and close that long above RSI 80.');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByText('Draft v1 is valid.', { exact: false })).toBeVisible();
  const flowTriggers = page.locator('[aria-label^="trigger: Interval"]');
  await expect(flowTriggers).toHaveCount(2);
  await expect(flowTriggers.first()).toBeVisible();
  await expect(page.getByText('ETH-PERP', { exact: false }).first()).toBeVisible();
  await expect(page.getByText('schemaVersion')).toHaveCount(0);

  await page.getByRole('tab', { name: 'Backtest' }).click();
  await page.getByRole('button', { name: 'Run backtest' }).click();
  await expect(page.getByText('Bundled sample data', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Use dataset date range' }).click();
  await page.getByRole('button', { name: 'Run backtest' }).click();
  await expect(page.getByText('+0.99%')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'By market' })).toBeVisible();
  const byMarket = page.getByRole('table', { name: 'Backtest results by market' });
  await expect(byMarket.getByRole('row', { name: /BTC-PERP/ })).toBeVisible();
  await expect(byMarket.getByRole('row', { name: /ETH-PERP/ })).toBeVisible();
  await page.getByRole('button', { name: /interval run.*2 markets/i }).first().click();
  const marketEvaluations = page.getByRole('group', { name: 'Market evaluations' });
  await expect(marketEvaluations.getByRole('button', { name: /BTC-PERP/ })).toBeVisible();
  await marketEvaluations.getByRole('button', { name: /ETH-PERP/ }).click();
  await expect(page.getByRole('heading', { name: 'ETH-PERP evaluation' })).toBeVisible();
  const traceEvents = page.getByRole('list', { name: 'Events for ETH-PERP' });
  await expect(traceEvents.getByText('action proposed')).toBeVisible();
  await expect(traceEvents.getByText('flow completed')).toBeVisible();

  await page.getByRole('button', { name: 'Approve v1' }).click();
  await page.getByRole('button', { name: 'Confirm approval' }).click();
  await expect(page.locator('.workbench-header').getByText('Approved', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Run Paper' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Review Live' })).toHaveCount(0);
  await expect(page.getByRole('tab', { name: 'Deploy' })).toHaveCount(0);
  await expect(page.getByRole('tab', { name: 'Performance' })).toHaveCount(0);
  await expect(page.getByRole('tab', { name: 'Logs' })).toHaveCount(0);

  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByText('Strategy Lab Beta', { exact: true })).toBeVisible();
  await expect(page.getByRole('switch', { name: /Enable Hyperliquid testnet/ })).toHaveCount(0);
});
