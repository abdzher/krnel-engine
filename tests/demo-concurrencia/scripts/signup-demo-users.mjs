// =============================================================================
// KRNEL — tests/demo-concurrencia/scripts/signup-demo-users.mjs
// Da de alta las cuentas demo-01..demo-NN en JupyterHub vía el formulario de
// NativeAuthenticator (/hub/signup), usando Chromium directamente (no el runner
// de Playwright). Idempotente: ignora "username already taken".
//
// Con `open_signup: true` (así está el hub-values de este repo) el alta es
// inmediata, PERO el usuario igual debe estar en files/allowlist.txt para poder
// entrar. Corré primero scripts/append-allowlist.sh y re-aplicá el Hub:
//   ansible-playbook playbooks/05-jupyterhub.yml --tags update ...
//
// Uso:
//   node scripts/signup-demo-users.mjs          # lee .env
//   DEMO_USER_COUNT=5 node scripts/signup-demo-users.mjs
// =============================================================================
import 'dotenv/config';
import { chromium } from '@playwright/test';

const HUB_URL = (process.env.HUB_URL || '').replace(/\/+$/, '');
const PASSWORD = process.env.DEMO_PASSWORD || '';
const COUNT = Number.parseInt(process.env.DEMO_USER_COUNT || '3', 10);
const TEMPLATE = (process.env.DEMO_USERNAME_TEMPLATE || 'demo-{n}').trim();

if (!HUB_URL || !PASSWORD) {
  console.error('Faltan HUB_URL y/o DEMO_PASSWORD. Copiá .env.example a .env y completá.');
  process.exit(1);
}
if (PASSWORD.length < 8) {
  console.error('DEMO_PASSWORD debe tener al menos 8 caracteres.');
  process.exit(1);
}

const usernameFor = (i) => TEMPLATE.replace('{n}', String(i).padStart(2, '0'));

const USER_SEL = ['input[name="username"]', '#username_input', 'input#username'];
const SUBMIT_SEL = ['input[type="submit"]', 'button[type="submit"]', 'button:has-text("Sign up")'];

async function firstVisible(page, selectors) {
  for (const sel of selectors) {
    const loc = page.locator(sel).first();
    if ((await loc.count()) && (await loc.isVisible().catch(() => false))) return loc;
  }
  return null;
}

async function signup(page, username) {
  await page.goto(`${HUB_URL}/hub/signup`, { waitUntil: 'domcontentloaded' });

  const userField = await firstVisible(page, USER_SEL);
  const pwFields = page.locator('input[type="password"]');
  const pwCount = await pwFields.count();

  if (!userField || pwCount === 0) {
    const html = await page.locator('form').first().innerHTML().catch(() => '(sin form)');
    throw new Error(`No pude ubicar los campos del signup. HTML:\n${html}`);
  }

  await userField.fill(username);

  // El form de NativeAuthenticator suele tener 2 campos password (clave +
  // confirmación). Si sólo hay 1, lo llenamos igual.
  await pwFields.nth(0).fill(PASSWORD);
  if (pwCount > 1) await pwFields.nth(1).fill(PASSWORD);

  const submit = await firstVisible(page, SUBMIT_SEL);
  await (submit ? submit.click() : pwFields.last().press('Enter'));
  await page.waitForLoadState('domcontentloaded');

  const body = (await page.locator('body').innerText().catch(() => '')).toLowerCase();
  if (body.includes('already') || body.includes('ya existe') || body.includes('taken')) {
    return 'ya-existía';
  }
  if (body.includes('error') && !body.includes('signup')) {
    return `posible-error: ${body.slice(0, 160).replace(/\s+/g, ' ')}`;
  }
  return 'creado';
}

const browser = await chromium.launch();
const context = await browser.newContext({ ignoreHTTPSErrors: true });
const page = await context.newPage();

console.log(`Alta de ${COUNT} cuentas demo en ${HUB_URL} …\n`);
let ok = 0;
for (let i = 1; i <= COUNT; i += 1) {
  const username = usernameFor(i);
  try {
    const status = await signup(page, username);
    console.log(`  ${username.padEnd(12)} → ${status}`);
    ok += 1;
  } catch (err) {
    console.error(`  ${username.padEnd(12)} → FALLÓ: ${err.message.split('\n')[0]}`);
  }
}
await browser.close();

console.log(`\nListo (${ok}/${COUNT}). Recordá: cada cuenta debe estar en files/allowlist.txt`);
console.log('y el Hub re-aplicado con --tags update para que el login funcione.');
process.exit(ok === COUNT ? 0 : 1);
