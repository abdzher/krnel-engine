// =============================================================================
// KRNEL — tests/demo-concurrencia/src/login.ts
// Login contra NativeAuthenticator con un navegador real.
//
// - No asumimos los `name=` exactos del formulario: probamos varios selectores
//   y, si ninguno matchea, volcamos el HTML del form al log para depurar.
// - La protección XSRF de Tornado (cookie + input oculto) la resuelve sola el
//   navegador; no la tocamos.
// =============================================================================
import { expect, type Page } from '@playwright/test';
import type { DemoUser } from './env';

const USERNAME_SELECTORS = [
  'input[name="username"]',
  '#username_input',
  'input#username',
  'input[autocomplete="username"]',
  'input[placeholder*="usuario" i]',
  'input[placeholder*="user" i]',
];

const PASSWORD_SELECTORS = [
  'input[name="password"]',
  '#password_input',
  'input#password',
  'input[type="password"]',
];

const SUBMIT_SELECTORS = [
  'input[type="submit"]',
  'button[type="submit"]',
  '#login_submit',
  'button:has-text("Sign in")',
  'button:has-text("Iniciar")',
];

async function firstVisible(page: Page, selectors: string[]) {
  for (const sel of selectors) {
    const loc = page.locator(sel).first();
    if (await loc.count() && await loc.isVisible().catch(() => false)) return loc;
  }
  return null;
}

/** Navega a /hub/login y deja la página lista para enviar credenciales. */
export async function gotoLogin(page: Page, timeoutMs: number): Promise<void> {
  await page.goto('/hub/login', { waitUntil: 'domcontentloaded', timeout: timeoutMs });
  // Si ya hay sesión válida el Hub redirige fuera de /hub/login: lo toleramos.
}

/**
 * Rellena y envía el formulario de login. Espera a salir de /hub/login por
 * cambio de URL (estado real), no por tiempo.
 */
export async function submitLogin(
  page: Page,
  user: DemoUser,
  timeoutMs: number,
): Promise<void> {
  if (!/\/hub\/login/.test(page.url())) return; // ya autenticado

  const userField = await firstVisible(page, USERNAME_SELECTORS);
  const passField = await firstVisible(page, PASSWORD_SELECTORS);

  if (!userField || !passField) {
    const html = await page.locator('form').first().innerHTML().catch(() => '(sin <form>)');
    throw new Error(
      `No pude ubicar los campos de login para ${user.username}. ` +
        `Revisa los selectores en src/login.ts. HTML del form:\n${html}`,
    );
  }

  await userField.fill(user.username);
  await passField.fill(user.password);

  const submit = await firstVisible(page, SUBMIT_SELECTORS);
  await Promise.all([
    page.waitForURL((url) => !/\/hub\/login/.test(url.pathname), { timeout: timeoutMs }),
    submit ? submit.click() : passField.press('Enter'),
  ]);

  // NativeAuthenticator re-renderiza /hub/login con un .error si las credenciales
  // fallan; el waitForURL de arriba ya lo habría descartado, pero por claridad:
  await expect(
    page.locator('.error, #login_error'),
    `Login falló para ${user.username} (credenciales o autorización).`,
  ).toHaveCount(0);
}

/**
 * Intenta loguear SIN asumir éxito — para pruebas de aislamiento (Fase 10.4)
 * que esperan un RECHAZO (ej. usuario fuera de `files/allowlist.txt`). A
 * diferencia de `submitLogin` (que asume que el login va a funcionar y
 * lanza si el `waitForURL` se agota, dando un mensaje de timeout confuso
 * para este caso), acá un timeout corto alcanza: un rechazo de
 * NativeAuthenticator es casi instantáneo (re-renderiza /hub/login), no hay
 * ningún spawn de por medio que justifique esperar `LOGIN_TIMEOUT_MS`
 * completo. Devuelve si la navegación salió de /hub/login — si el login
 * fue rechazado, `leftLoginPage` debe ser `false`.
 */
export async function attemptLoginExpectingRejection(
  page: Page,
  username: string,
  password: string,
  timeoutMs = 10_000,
): Promise<{ leftLoginPage: boolean }> {
  await page.goto('/hub/login', { waitUntil: 'domcontentloaded' });

  const userField = await firstVisible(page, USERNAME_SELECTORS);
  const passField = await firstVisible(page, PASSWORD_SELECTORS);
  if (!userField || !passField) {
    const html = await page.locator('form').first().innerHTML().catch(() => '(sin <form>)');
    throw new Error(`No pude ubicar los campos de login. HTML del form:\n${html}`);
  }

  await userField.fill(username);
  await passField.fill(password);

  const submit = await firstVisible(page, SUBMIT_SELECTORS);
  await (submit ? submit.click() : passField.press('Enter'));

  const leftLoginPage = await page
    .waitForURL((url) => !/\/hub\/login/.test(url.pathname), { timeout: timeoutMs })
    .then(() => true)
    .catch(() => false);
  return { leftLoginPage };
}
