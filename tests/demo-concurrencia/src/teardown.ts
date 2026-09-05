// =============================================================================
// KRNEL — tests/demo-concurrencia/src/teardown.ts
// Detener el servidor de cada usuario simulado. OBLIGATORIO aunque el test
// falle: dejar servidores huérfanos consume la cuota de PVCs/CPU del namespace
// jupyter, que ya sabemos ajustada.
//
// Primario  : botón "Stop My Server" en /hub/home (navegador real, sin token),
//             confirmado con polling real contra la API — no basta con que la
//             UI cambie de botón, eso solo dice que el Hub aceptó el pedido.
// Secundario: barrido DELETE /hub/api/users/:u/server con ADMIN_TOKEN, si se
//             definió — cubre el caso en que la UI ya no responde. Igual que
//             el botón, un 202 acá es "aceptado", no "confirmado detenido".
// =============================================================================
import type { Dialog, Page } from '@playwright/test';
import { loadConfig } from './env';

/**
 * Detiene el server del usuario actual vía la UI del Hub y CONFIRMA contra la
 * API que el pod realmente terminó. Nunca lanza.
 *
 * Confirmado en vivo (2026-09-04): la UI de /hub/home cambia a "Start My
 * Server" en cuanto el Hub ACEPTA el pedido de stop (202 Accepted), no
 * cuando el pod termina de verdad — un `kubectl get pods -n jupyter` mostró
 * `jupyter-demo-01` `Running` más de 30 minutos después de una corrida que
 * había reportado `teardownOk: true`. Por eso esta función ya no confía en
 * el estado del botón: hace polling real contra `GET /hub/api/users/:u`
 * (mismo origen, usa las cookies de sesión del propio `page` vía
 * `page.request` — no necesita ADMIN_TOKEN) hasta que `servers` quede vacío.
 */
export async function stopServerViaUI(page: Page, username: string): Promise<boolean> {
  const { hubUrl } = loadConfig();
  try {
    await page.goto(`${hubUrl}/hub/home`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    const stopBtn = page
      .locator('#stop, a#stop, button#stop')
      .or(page.getByRole('button', { name: /Stop My Server/i }));
    if (!(await stopBtn.count())) return false; // no había nada que detener

    // El template de /hub/home puede pedir confirmación con un `confirm()`
    // nativo antes de disparar el DELETE. Sin manejarlo, Playwright cancela
    // cualquier diálogo no atendido por default — el click "funciona" (sin
    // error) pero la confirmación queda rechazada por debajo y el stop nunca
    // sale. Lo aceptamos automáticamente mientras dure el click.
    const onDialog = (d: Dialog) => void d.accept();
    page.on('dialog', onDialog);
    try {
      await stopBtn.first().click();
    } finally {
      page.off('dialog', onDialog);
    }

    return await waitForServerStopped(page, hubUrl, username, 90_000);
  } catch {
    return false;
  }
}

/** Poll de `GET /hub/api/users/:u` hasta que `servers` quede vacío. Nunca lanza. */
async function waitForServerStopped(
  page: Page,
  hubUrl: string,
  username: string,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await page.request.get(`${hubUrl}/hub/api/users/${encodeURIComponent(username)}`);
      if (res.ok()) {
        const body = (await res.json()) as { servers?: Record<string, unknown> };
        if (!body.servers || Object.keys(body.servers).length === 0) return true;
      }
    } catch {
      /* reintenta hasta el deadline */
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  return false;
}

/**
 * Barrido opcional vía REST API. Requiere ADMIN_TOKEN con scope `servers`.
 * Devuelve el nº de servidores que pidió detener. Nunca lanza.
 */
export async function sweepServersViaApi(usernames: string[]): Promise<number> {
  const { hubUrl, adminToken } = loadConfig();
  if (!adminToken) return 0;

  let stopped = 0;
  for (const username of usernames) {
    try {
      const res = await fetch(
        `${hubUrl}/hub/api/users/${encodeURIComponent(username)}/server`,
        {
          method: 'DELETE',
          headers: { Authorization: `token ${adminToken}` },
        },
      );
      // 204 = detenido, 202 = deteniéndose, 400 = ya no había server.
      if (res.status === 204 || res.status === 202) stopped += 1;
    } catch {
      /* best-effort */
    }
  }
  return stopped;
}
