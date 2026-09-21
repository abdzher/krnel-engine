// =============================================================================
// KRNEL — tests/demo-concurrencia/playwright.config.ts
// Dos proyectos con la MISMA suite:
//   - verify : headless, sin video, para el chequeo previo (CI local / smoke).
//   - demo   : headed, con video + trace + slowMo, para la demostración en vivo.
//
// El runner corre con workers=1: la concurrencia real (N "usuarios" a la vez)
// la orquesta el propio test con N BrowserContext + Promise.all, NO el runner.
// =============================================================================
import { defineConfig, devices } from '@playwright/test';
import { loadConfig } from './src/env';

// Se carga perezosamente: los comandos `--list` / `show-report` no necesitan env.
let hubUrl = process.env.HUB_URL?.replace(/\/+$/, '') || 'https://jupyter.invalid';
let slowMoMs = 150;
try {
  const cfg = loadConfig();
  hubUrl = cfg.hubUrl;
  slowMoMs = cfg.slowMoMs;
} catch {
  // Config incompleta: se validará al ejecutar un test real.
}

export default defineConfig({
  testDir: './tests',
  outputDir: './test-results',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  // Tope duro por test; el test de concurrencia además ajusta su propio timeout
  // en función de SPAWN_TIMEOUT_MS.
  timeout: 20 * 60 * 1000,
  expect: { timeout: 15_000 },

  use: {
    baseURL: hubUrl,
    // Cert-Manager sin Issuer es un hallazgo conocido: el certificado del Hub
    // puede no validar. No queremos que la demo se caiga por eso.
    ignoreHTTPSErrors: true,
    screenshot: 'only-on-failure',
    actionTimeout: 30_000,
    navigationTimeout: 60_000,
  },

  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: 'playwright-report' }],
    ['json', { outputFile: 'reports/last-run.json' }],
  ],

  projects: [
    {
      name: 'verify',
      use: {
        ...devices['Desktop Chrome'],
        headless: true,
        video: 'off',
        trace: 'retain-on-failure',
      },
    },
    {
      name: 'demo',
      use: {
        ...devices['Desktop Chrome'],
        headless: false,
        viewport: { width: 1440, height: 900 },
        video: 'on',
        trace: 'on',
        launchOptions: { slowMo: slowMoMs },
      },
    },
  ],
});
