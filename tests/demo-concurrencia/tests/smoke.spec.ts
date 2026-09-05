// =============================================================================
// KRNEL — tests/demo-concurrencia/tests/smoke.spec.ts
// Chequeo previo con UN solo usuario (demo-01). Headless, rápido.
// Sirve para validar que login + spawn + kernel funcionan ANTES de exponer la
// demo de N usuarios ante público.
//
//   npm run verify:smoke
// =============================================================================
import { test, expect } from '@playwright/test';
import { loadConfig } from '../src/env';
import { runUserFlow } from '../src/flow';
import { RunMetrics } from '../src/metrics';
import { sendRunReportEmail } from '../src/report-email';
import { sweepServersViaApi } from '../src/teardown';

test('smoke: 1 usuario hace login, levanta su servidor y ejecuta 2 + 2', async ({ browser }) => {
  const config = loadConfig();
  const user = config.users[0];
  const metrics = new RunMetrics();

  test.setTimeout(config.loginTimeoutMs + config.spawnTimeoutMs + config.execTimeoutMs + 120_000);

  try {
    await runUserFlow(browser, user, config, metrics, { recordVideo: false });
  } finally {
    await sweepServersViaApi([user.username]);
    const { md } = metrics.flush();
    await sendRunReportEmail(config, metrics, md);
  }

  const row = metrics.all()[0];
  expect(row.ok, row.error ?? 'flujo falló').toBe(true);
  expect(row.cellOutput).toMatch(/\b4\b/);
});
