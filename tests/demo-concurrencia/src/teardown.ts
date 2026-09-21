// =============================================================================
// KRNEL — tests/demo-concurrencia/src/teardown.ts
// Detener el servidor de un usuario simulado. Sigue siendo una utilidad MANUAL
// (no se invoca desde flow.ts/concurrencia.spec.ts, ver CLAUDE.md — el operador
// detiene los servidores a mano tras cada corrida). persistence.spec.ts (Fase
// 10.1) sí la necesita como parte del propio flujo que prueba.
//
// Primario  : DELETE /hub/api/users/:u/server con las cookies de sesión del
//             `page` (mismo origen, sin ADMIN_TOKEN) — CONFIRMADO con polling
//             real contra la API, no basta con que el Hub acepte el pedido.
// Secundario: barrido DELETE .../server con ADMIN_TOKEN, si se definió — cubre
//             el caso en que ya no hay `page`/sesión de navegador disponible.
//             Igual que el primario, un 202 acá es "aceptado", no "confirmado".
// =============================================================================
import type { Page } from '@playwright/test';
import { loadConfig } from './env';

/**
 * Detiene el server del usuario actual y CONFIRMA contra la API que el pod
 * realmente terminó. Nunca lanza.
 *
 * Se abandonó clickear el botón "Stop My Server" de /hub/home tras confirmar
 * en vivo, con un trace de una corrida real de `persistence.spec.ts`
 * (2026-09-06), una condición de carrera real: `page.goto('/hub/home',
 * {waitUntil: 'domcontentloaded'})` resuelve en cuanto el HTML se parseó, pero
 * `home.js`/`jquery.min.js` (que enganchan el handler de click del botón vía
 * jQuery) se piden sin bloquear el parseo y pueden seguir cargando en ese
 * instante. El click de Playwright "funcionaba" sin error — el `<a id="stop">`
 * ya estaba visible/habilitado/estable — pero como el handler de jQuery
 * todavía no estaba enganchado, el click no disparaba nada: ni diálogo de
 * confirmación, ni el `DELETE .../server`. El log de red de esa corrida lo
 * confirma línea por línea: el primer intento pasó los 90s enteros de
 * `waitForServerStopped` sin que apareciera NINGÚN `DELETE`; un segundo
 * intento (mismo código, desde el `finally` del test) funcionó al toque —
 * para entonces los scripts ya habían terminado de cargar por casualidad de
 * timing. Esto explica también, en retrospectiva, por qué el teardown
 * automático de flow.ts nunca confirmó un stop exitoso en ninguna corrida en
 * vivo (ver CLAUDE.md) antes de sacarse de ahí.
 *
 * Dos intentos de fix previos, ambos confirmados en vivo con trace:
 *   1. `page.request.delete()` con el header `X-XSRFToken` calculado a mano
 *      desde `page.context().cookies()` (sin URL) — devolvió 403 dos veces
 *      seguidas. Causa: hay más de una cookie `_xsrf` viva a la vez (una con
 *      `Path=/hub/`, otra con `Path=/user/<u>/...` del OAuth interno del
 *      spawn) y `cookies()` sin filtrar por URL las devuelve todas — `.find()`
 *      podía agarrar la del path equivocado.
 *   2. Mismo enfoque pero pasándole la URL exacta a `cookies(url)` para que
 *      Playwright filtre por path — MEJORÓ (pasó de 403 siempre a 403 en el
 *      primer intento y 204 en el segundo, 115ms después, mismo código) pero
 *      siguió siendo inconsistente: dos cookies `_xsrf` distintas pueden
 *      seguir matcheando la MISMA URL si sus paths se superponen, y
 *      Playwright no necesariamente las ordena como lo haría el navegador.
 *
 * El fix real: dejar que el propio navegador arme el pedido, exactamente
 * como lo hace `jhapi.js` (el JS real del Hub) — leer `document.cookie` y
 * hacer `fetch()` nativo, todo dentro de `page.evaluate()`. Esto no tiene la
 * ambigüedad de Playwright: `document.cookie`, evaluado en una página bajo
 * `/hub/...`, ya viene resuelto por el navegador con el algoritmo real de
 * matching de cookies (path más específico primero) — el mismo resultado
 * que vería cualquier script corriendo ahí de verdad. Por eso primero se
 * navega a `/hub/home` si la página no está ya bajo `/hub/` (si viene de
 * `/user/<u>/lab`, esa cookie con `Path=/hub/` ni siquiera es visible ahí).
 *
 * **Bug encontrado después, confirmado en vivo con trace (2026-09-06,
 * `kernels.spec.ts`):** como el stop se hace con un `fetch()` dentro de
 * `page.evaluate()`, cambia el estado en el SERVER pero nunca refresca el
 * DOM de la página — si `/hub/home` ya estaba cargada desde ANTES del stop
 * (server corriendo, botón "Stop My Server" visible), sigue mostrando ESE
 * botón después, aunque el server ya haya terminado. Un `ensureServerRunning`
 * llamado justo después buscaba "Start My Server", no encontraba nada
 * (seguía viendo "Stop"), no clickeaba nada, y quedaba esperando 5 minutos
 * completos una URL que nunca iba a cambiar — sin ningún POST a `/server` en
 * todo el trace de red, confirmando que nunca se disparó ningún spawn. Por
 * eso, tras un stop confirmado, se recarga `/hub/home` una vez más antes de
 * devolver el control — así el caller siempre ve el DOM real post-stop, sin
 * tener que acordarse de recargar por su cuenta (persistence.spec.ts ya lo
 * hacía manualmente por las dudas; `kernels.spec.ts` no, y ahí se vio el bug).
 */
export async function stopServer(page: Page, username: string): Promise<boolean> {
  const { hubUrl } = loadConfig();
  try {
    if (!/^\/hub\//.test(new URL(page.url()).pathname)) {
      await page.goto(`${hubUrl}/hub/home`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    }

    const url = `${hubUrl}/hub/api/users/${encodeURIComponent(username)}/server`;
    const status = await page.evaluate(async (deleteUrl) => {
      const match = document.cookie.match(/(?:^|;\s*)_xsrf=([^;]+)/);
      const xsrf = match ? decodeURIComponent(match[1]) : '';
      const res = await fetch(deleteUrl, {
        method: 'DELETE',
        credentials: 'same-origin',
        headers: xsrf ? { 'X-XSRFToken': xsrf } : {},
      });
      return res.status;
    }, url);

    // 204 = detenido ya, 202 = deteniéndose (hay que confirmar por polling),
    // 400 = ya no había server corriendo -> el estado deseado ya se cumple.
    let stopped: boolean;
    if (status === 400) {
      stopped = true;
    } else if (status !== 204 && status !== 202) {
      return false;
    } else if (status === 204) {
      stopped = true;
    } else {
      stopped = await waitForServerStopped(page, hubUrl, username, 90_000);
    }

    if (stopped) {
      await page
        .goto(`${hubUrl}/hub/home`, { waitUntil: 'domcontentloaded', timeout: 30_000 })
        .catch(() => {});
    }
    return stopped;
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
