// =============================================================================
// KRNEL — tests/demo-concurrencia/src/spawn.ts
// Levantar el servidor del usuario y esperar a que JupyterLab esté LISTO,
// siempre por estado observable (URL + selectores del shell de Lab), nunca por
// `sleep`. Los spawns varían mucho con la carga del clúster y con el pull de la
// imagen all-spark-notebook (prePuller.hook está deshabilitado en este repo).
// =============================================================================
import type { Page } from '@playwright/test';

/**
 * Tras el login el Hub puede llevarnos a:
 *   - /hub/spawn            -> formulario de perfiles (si hay >1 visible)
 *   - /hub/spawn-pending/*  -> barra de progreso
 *   - /user/<name>/lab      -> ya listo
 *   - /hub/home             -> hay que pulsar "Start My Server"
 */
export async function ensureServerRunning(
  page: Page,
  opts: { profile: string | null; timeoutMs: number },
): Promise<void> {
  // Si estamos en /hub/home, arrancar.
  if (/\/hub\/home/.test(page.url())) {
    const start = page.getByRole('button', { name: /Start My Server|My Server/i })
      .or(page.locator('a#start'));
    if (await start.count()) await start.first().click();
  }

  // Formulario de selección de perfil.
  if (/\/hub\/spawn(\b|\/|$)/.test(page.url())) {
    await selectProfile(page, opts.profile, opts.timeoutMs);
  }

  // Esperar a que la URL sea la del server del usuario — o fallar rápido y
  // claro si el Hub ya rechazó el spawn (ej. cuota agotada), en vez de
  // agotar el timeout completo sin decir por qué (Fase 10.5: "confirmar que
  // el estudiante ve un error claro, no un cuelgue silencioso").
  await waitForSpawnErrorOrReady(page, opts.timeoutMs);

  // El workspace de JupyterLab persiste entre sesiones del mismo usuario:
  // cada corrida deja notebooks abiertos (`Untitled.ipynb`, etc.) y la
  // próxima sesión los restaura como pestaña activa. Confirmado en vivo con
  // un trace: el Launcher que abríamos con "New Launcher" SÍ se creaba, pero
  // quedaba con la clase `lm-mod-hidden` de Lumino — detrás de esa pestaña
  // vieja restaurada, invisible aunque estuviera en el DOM. `?reset` fuerza
  // un workspace limpio (sin pestañas previas) en vez de intentar adivinar
  // cuál pestaña está activa.
  const cleanUrl = `${page.url().split('?')[0]}?reset`;
  await page.goto(cleanUrl, { waitUntil: 'domcontentloaded', timeout: opts.timeoutMs });

  // Y a que el shell de JupyterLab realmente monte.
  await page.locator('#jupyterlab-splash, .jp-LabShell, .jp-Launcher')
    .first()
    .waitFor({ state: 'visible', timeout: opts.timeoutMs });

  // El splash se va cuando Lab termina de cargar.
  await page.locator('.jp-LabShell').first()
    .waitFor({ state: 'visible', timeout: opts.timeoutMs });
}

/**
 * Espera a que la URL sea la del server del usuario (`/user/<u>/...`).
 * Si mientras tanto el Hub rechaza el spawn y re-renderiza `/hub/spawn` (no
 * `/hub/spawn-pending`, que es el estado normal de "en progreso") con un
 * mensaje de error visible, lanza de inmediato con ESE mensaje en vez de
 * esperar el timeout completo — un rechazo síncrono (ej. `ResourceQuota`
 * agotada) no necesita 5 minutos para confirmarse. Si no hay mensaje visible
 * pero tampoco se llega a `/user/...`, cae al timeout normal (red de
 * seguridad: no asume que TODO rechazo va a tener un banner con ese selector).
 */
async function waitForSpawnErrorOrReady(page: Page, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (/\/user\/[^/]+\//.test(page.url())) return; // llegó, listo

    const isBackAtSpawnForm =
      /\/hub\/spawn(\b|\/)/.test(page.url()) && !/\/hub\/spawn-pending/.test(page.url());
    if (isBackAtSpawnForm) {
      const errText = await page
        .locator('.alert-danger, .alert-error, #error, .error')
        .first()
        .innerText()
        .catch(() => null);
      if (errText && errText.trim()) {
        throw new Error(`El Hub rechazó el spawn: ${errText.trim()}`);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(
    `Spawn no llegó a /user/<usuario>/ en ${timeoutMs}ms (timeout, sin mensaje de error visible en /hub/spawn).`,
  );
}

async function selectProfile(page: Page, profile: string | null, timeoutMs: number): Promise<void> {
  // Radios de perfil del template Z2JH.
  const radios = page.locator('input[type="radio"][name="profile"]');
  const count = await radios.count();

  if (count > 0 && profile) {
    // Buscar el radio cuyo label contiene el display_name pedido.
    const labelled = page.locator('label', { hasText: profile }).locator('input[type="radio"]');
    if (await labelled.count()) {
      await labelled.first().check();
    } else {
      await radios.first().check(); // fallback: primer perfil (invitado)
    }
  } else if (count > 0) {
    await radios.first().check();
  }

  const submit = page.getByRole('button', { name: /Start|Iniciar/i })
    .or(page.locator('input[type="submit"]'));
  // El Hub no deja /hub/spawn hasta que el servidor está listo (pasa por
  // /hub/spawn-pending mientras tanto) — esta espera ES la espera real del
  // spawn, no un simple redirect de formulario. Debe usar el mismo timeout
  // configurable (SPAWN_TIMEOUT_MS) que el resto del flujo, nunca un valor
  // fijo: con un fixed 60s esto fallaba en spawns reales que tardan más
  // (confirmado en vivo: navegaba hasta /user/<u>/lab dentro de esos 60s y
  // aun así el test se reportaba fallido).
  await Promise.all([
    page.waitForURL((url) => !/\/hub\/spawn(\b|\/|$)/.test(url.pathname), { timeout: timeoutMs }),
    submit.first().click(),
  ]);
}
