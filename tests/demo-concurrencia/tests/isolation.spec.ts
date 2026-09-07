// =============================================================================
// KRNEL — tests/demo-concurrencia/tests/isolation.spec.ts
// FASE 10.4 del plan de hardening: regresión de aislamiento a nivel de
// aplicación (allowlist + admin_access), la mitad de 10.4 que se hace mejor
// desde acá que desde un playbook — ya tenemos login.ts. La otra mitad
// (NetworkPolicy entre pods, RBAC de spark-editor) vive en
// `playbooks/utils/test-tenant-isolation.yml`.
//
//   1. Signup + login con un usuario que NO está en files/allowlist.txt debe
//      rechazarse — `open_signup: true` permite CREAR la cuenta en la base
//      de NativeAuthenticator, pero el LOGIN lo filtra `allowed_users`
//      (poblado desde el allowlist al renderizar el template). Lo que se
//      prueba acá es esa segunda barrera, no la primera.
//   2. Logueado como una cuenta demo, navegar directo a `/user/<otra-cuenta>/`
//      debe rechazarse — confirma que el aislamiento es real (cookie/token
//      del Hub), no solo que la UI no ofrece un botón para hacerlo.
//      `admin_access: false` (hub-values.yaml.j2, hallazgo S4 ya cerrado)
//      es justamente lo que hace que ni siquiera una cuenta demo con
//      privilegios de más pudiera colarse acá — pero nunca se había
//      confirmado con un intento real.
//
//   npx playwright test --project=verify isolation.spec.ts
// =============================================================================
import { test, expect } from '@playwright/test';
import { loadConfig } from '../src/env';
import { gotoLogin, submitLogin, attemptLoginExpectingRejection } from '../src/login';

const USERNAME_SELECTORS = ['input[name="username"]', '#username_input', 'input#username'];
const SUBMIT_SELECTORS = ['input[type="submit"]', 'button[type="submit"]', 'button:has-text("Sign up")'];

test.describe('Fase 10.4 — aislamiento a nivel de aplicación', () => {
  test('un usuario fuera del allowlist no puede loguear aunque el signup esté abierto', async ({
    browser,
  }) => {
    const config = loadConfig();
    // Nombre fijo (no aleatorio por corrida): así no se acumulan cuentas
    // fantasma nuevas en cada corrida — igual que las cuentas `demo-NN`, un
    // reintento de signup para el mismo username es idempotente en la
    // práctica (NativeAuthenticator responde "ya existe" y sigue).
    const strangerUser = 'isolation-test-notallowed';

    const context = await browser.newContext({ ignoreHTTPSErrors: true, baseURL: config.hubUrl });
    const page = await context.newPage();

    try {
      // -- signup (puede "funcionar" — eso no es lo que se prueba) --------
      await page.goto('/hub/signup', { waitUntil: 'domcontentloaded', timeout: config.loginTimeoutMs });
      const userField = page.locator(USERNAME_SELECTORS.join(', ')).first();
      if (await userField.count()) {
        await userField.fill(strangerUser);
        const pwFields = page.locator('input[type="password"]');
        const pwCount = await pwFields.count();
        if (pwCount > 0) await pwFields.nth(0).fill(config.users[0].password);
        if (pwCount > 1) await pwFields.nth(1).fill(config.users[0].password);
        const submit = page.locator(SUBMIT_SELECTORS.join(', ')).first();
        await (await submit.count() ? submit.click() : pwFields.last().press('Enter'));
        await page.waitForLoadState('domcontentloaded').catch(() => {});
      }

      // -- lo que realmente se prueba: el LOGIN debe quedar afuera --------
      const { leftLoginPage } = await attemptLoginExpectingRejection(
        page,
        strangerUser,
        config.users[0].password,
        Math.min(config.loginTimeoutMs, 15_000),
      );

      expect(
        leftLoginPage,
        `"${strangerUser}" no está en files/allowlist.txt y aun así el login lo dejó pasar — ` +
          'revisa que allowed_users siga poblándose desde el allowlist en hub-values.yaml.j2.',
      ).toBe(false);
    } finally {
      await context.close().catch(() => {});
    }
  });

  test('una cuenta demo no puede entrar al server de otra navegando directo a su URL', async ({
    browser,
  }) => {
    const config = loadConfig();
    test.skip(
      config.users.length < 2,
      'Necesita al menos 2 cuentas demo — subí DEMO_USER_COUNT a 2 o más para esta prueba.',
    );
    const [userA, userB] = config.users;

    const context = await browser.newContext({ ignoreHTTPSErrors: true, baseURL: config.hubUrl });
    const page = await context.newPage();

    try {
      await gotoLogin(page, config.loginTimeoutMs);
      await submitLogin(page, userA, config.loginTimeoutMs);

      const response = await page.goto(`${config.hubUrl}/user/${userB.username}/`, {
        waitUntil: 'domcontentloaded',
        timeout: config.loginTimeoutMs,
      });

      // No debe llegar al shell real de JupyterLab de otro usuario — el
      // criterio es este, no un código HTTP puntual: distintas versiones
      // del Hub pueden rechazar con 403, con un redirect, o con una página
      // de error propia, pero ninguna variante debería mostrar el Lab de
      // userB.
      const gotLabShell = await page
        .locator('.jp-LabShell, #jupyterlab-splash')
        .first()
        .isVisible()
        .catch(() => false);
      expect(
        gotLabShell,
        `${userA.username} llegó al shell de JupyterLab de ${userB.username} — aislamiento roto ` +
          '(revisa admin_access en hub-values.yaml.j2, hallazgo S4).',
      ).toBe(false);

      if (response) {
        expect(
          response.status(),
          `esperaba un status de rechazo (403 típico de JupyterHub para "logged in as X, not authorized"), ` +
            `recibí ${response.status()}`,
        ).not.toBe(200);
      }
    } finally {
      await context.close().catch(() => {});
    }
  });
});
