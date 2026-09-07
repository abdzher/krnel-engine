// =============================================================================
// KRNEL — tests/demo-concurrencia/tests/resource-governance.spec.ts
// FASE 10.5 del plan de hardening: "blast radius" de los límites de recursos.
// Dos de los tres casos del plan (el tercero, cuota de spawns al límite,
// depende del techo real que confirma la Fase 10.3 y queda como runbook en
// el README, reusando concurrencia.spec.ts con DEMO_USER_COUNT = techo + 1):
//
//   1. OOM controlado: una celda agota la RAM del perfil a propósito.
//      Confirmado por investigación (ver plan): Kubernetes mata el POD
//      COMPLETO, no solo el proceso del kernel — el criterio de éxito es
//      justamente notar esa caída total (el server entero deja de responder)
//      y que el archivo escrito ANTES del OOM sobreviva al reinicio del
//      contenedor (mismo patrón que persistence.spec.ts, Fase 10.1).
//   2. Disco lleno: escribir archivos hasta agotar el storage_capacity del
//      perfil. Criterio de éxito: un error LIMPIO de "sin espacio" del lado
//      del kernel (no corrupción, no crash-loop), y que borrar los archivos
//      restaura la operación normal.
//
// Ambos requieren un perfil con RAM/storage acotados y conocidos de antemano
// (Comunidad: 12G RAM / 2Gi disco) — igual que persistence.spec.ts, se saltan
// solos si DEMO_PROFILE no apunta a uno.
//
//   npx playwright test --project=verify resource-governance.spec.ts
// =============================================================================
import { test, expect, type Locator, type Page } from '@playwright/test';
import { loadConfig } from '../src/env';
import { gotoLogin, submitLogin } from '../src/login';
import { ensureServerRunning } from '../src/spawn';
import { openFreshNotebook, submitCell, readOutput, kernelsApiBase } from '../src/notebook';

test.describe('Fase 10.5 — gobierno de recursos', () => {
  test('OOM controlado: el pod completo cae y se recupera solo, sin perder datos previos', async ({
    browser,
  }) => {
    const config = loadConfig();
    const user = config.users[0];

    test.skip(
      !config.profile,
      'Define DEMO_PROFILE=<perfil con límite de RAM conocido, ej. "Comunidad" (12G)> en .env.',
    );

    // Login + spawn inicial + espera de que el kernel caiga (hasta 3 min) +
    // espera de que el pod vuelva (hasta `spawnTimeoutMs`, ver más abajo —
    // Kubernetes recrea el POD ENTERO tras un OOM, no solo el contenedor) +
    // margen.
    test.setTimeout(
      config.loginTimeoutMs + config.spawnTimeoutMs * 2 + config.execTimeoutMs + 3 * 60_000 + 2 * 60_000,
    );

    const context = await browser.newContext({
      ignoreHTTPSErrors: true,
      baseURL: config.hubUrl,
      viewport: { width: 1440, height: 900 },
    });
    const page = await context.newPage();

    const marker = `oom-marker-${Date.now()}`;
    const markerFile = `~/${marker}.txt`;

    try {
      await gotoLogin(page, config.loginTimeoutMs);
      await submitLogin(page, user, config.loginTimeoutMs);
      await ensureServerRunning(page, { profile: config.profile, timeoutMs: config.spawnTimeoutMs });

      // Una sola notebook/celda para el marcador Y la bomba — abrir una
      // SEGUNDA notebook en la misma sesión viva (sin pasar por un reload
      // real) dejó su panel `lm-mod-hidden` en una corrida real
      // (2026-09-06, ver el contrato en `openFreshNotebook`). No hace falta
      // una notebook nueva para esto: es el mismo kernel Python de principio
      // a fin, `submitCell` reusa la celda sin problema.
      const cell = await openFreshNotebook(page, config.execTimeoutMs);
      const base = kernelsApiBase(page);
      expect(base, 'no pude derivar la base de la API de kernels de la URL actual').toBeTruthy();

      // -- dato ANTES del OOM: debe sobrevivir al reinicio del pod ----------
      await submitCell(page, cell, `!echo ${marker} > ${markerFile} && cat ${markerFile}`);
      const before = await readOutput(cell, config.execTimeoutMs);
      expect(before, 'no se pudo escribir el marcador antes del OOM').toContain(marker);

      // -- celda que agota la RAM a propósito -------------------------------
      // Crece sin límite (bloques de 200MB) hasta que el kernel/pod muera —
      // más confiable que pedir un único bloque enorme, que Python podría
      // rechazar con un MemoryError manejable ANTES de tocar el límite real
      // del cgroup (el crecimiento incremental sí fuerza el commit de página
      // por página, que es lo que dispara el OOM killer del kernel Linux).
      const bombKernelIds = await captureRunningKernelIds(page, base!);

      await submitCell(
        page,
        cell,
        [
          'import itertools',
          'blocks = []',
          'for _ in itertools.count():',
          '    blocks.append(bytearray(200 * 1024 * 1024))',
        ].join('\n'),
      );

      // No esperamos ningún output (probablemente nunca llega) — lo que
      // importa es que el kernel/pod deje de responder de verdad.
      const wentDown = await waitForKernelGone(page, base!, bombKernelIds, 3 * 60_000);
      expect(
        wentDown,
        'el kernel que corrió la bomba de memoria seguía reportándose activo 3 min después — ' +
          'o el límite de RAM del perfil no se está aplicando, o el OOM no llegó a dispararse.',
      ).toBe(true);

      // -- esperar a que el server vuelva a responder (pod reiniciado) ------
      // Reusa `config.spawnTimeoutMs` (ya configurable por env) en vez de un
      // número fijo: confirmado en vivo con `kubectl describe pod` (2026-09-06)
      // que tras un OOM, Kubernetes recrea el pod ENTERO (no un simple
      // restart de contenedor) — un pod nuevo, con sus 4 PVCs reatachados
      // desde cero — así que el tiempo esperable es el mismo orden que un
      // spawn normal, no un valor aparte. Una corrida real tardó más de 5
      // minutos en estabilizar (probablemente por la carga acumulada de
      // varias corridas de OOM seguidas en el mismo clúster de 4 nodos ese
      // día) pero el pod resultante quedó sano (`RESTARTS: 0`, sin eventos
      // de error) — no es un timeout arbitrario más grande, es el mismo
      // presupuesto que ya usa cualquier spawn real de esta suite.
      const backUp = await waitForApiReachable(page, base!, config.spawnTimeoutMs);
      expect(
        backUp,
        `el server no volvió a responder ${config.spawnTimeoutMs}ms después del OOM — revisa ` +
          '`kubectl get pod`/`describe pod` por si quedó en CrashLoopBackOff por algo más que el OOM esperado.',
      ).toBe(true);

      // -- confirmar que el dato de antes del OOM sigue ahí -----------------
      // Reusa `base` (ya derivado de la URL real por `kernelsApiBase`) en vez
      // de volver a parsear `page.url()` a mano.
      await page.goto(`${base}/lab?reset`, {
        waitUntil: 'domcontentloaded',
        timeout: config.spawnTimeoutMs,
      });
      const afterCell = await openFreshNotebook(page, config.execTimeoutMs);
      await submitCell(page, afterCell, `!cat ${markerFile}`);
      const after = await readOutput(afterCell, config.execTimeoutMs);
      expect(after, 'el marcador escrito antes del OOM no sobrevivió al reinicio del pod').toContain(marker);
    } finally {
      await context.close().catch(() => {});
    }
  });

  test('disco lleno: error limpio del kernel, no corrupción, y se recupera al liberar espacio', async ({
    browser,
  }) => {
    const config = loadConfig();
    const user = config.users[0];

    test.skip(
      !config.profile,
      'Define DEMO_PROFILE=<perfil con storage_capacity conocido, ej. "Comunidad" (2Gi)> en .env.',
    );

    test.setTimeout(config.loginTimeoutMs + config.spawnTimeoutMs + config.execTimeoutMs * 3 + 3 * 60_000);

    const context = await browser.newContext({
      ignoreHTTPSErrors: true,
      baseURL: config.hubUrl,
      viewport: { width: 1440, height: 900 },
    });
    const page = await context.newPage();
    // SIN timestamp a propósito — ver el comentario de la limpieza más abajo:
    // el nombre debe ser estable entre corridas para que la limpieza barra
    // TAMBIÉN los restos de una corrida anterior que haya fallado a mitad de
    // camino, no solo los archivos que esta corrida puntual creó.
    const fillPrefix = 'disco-lleno-test';

    try {
      await gotoLogin(page, config.loginTimeoutMs);
      await submitLogin(page, user, config.loginTimeoutMs);
      await ensureServerRunning(page, { profile: config.profile, timeoutMs: config.spawnTimeoutMs });

      // -- escribir hasta llenar el disco -----------------------------------
      const cell = await openFreshNotebook(page, config.execTimeoutMs);
      await submitCell(page, cell, fillDiskCode(fillPrefix));
      // Llenar 2-5Gi en bloques de 50MB puede tardar bastante en I/O; usar un
      // timeout generoso propio en vez del de una celda normal.
      const fillOutput = await readOutput(cell, Math.max(config.execTimeoutMs, 5 * 60_000));
      expect(fillOutput, 'la celda de llenado no terminó con el marcador STOPPED_AT esperado').toContain(
        'STOPPED_AT=',
      );
      // errno 28 = ENOSPC ("No space left on device") — el criterio real: un
      // error LIMPIO de sistema de archivos, no una excepción rara ni un
      // cuelgue. Buscamos el texto en inglés Y el número de errno, porque el
      // mensaje exacto de Python puede variar entre libc/locale.
      expect(
        /no space left on device|errno 28|enospc/i.test(fillOutput),
        `esperaba un error de "sin espacio" reconocible, la celda dijo:\n${fillOutput}`,
      ).toBe(true);

      // -- limpiar, en la MISMA celda/kernel (no una notebook nueva) --------
      // Causa raíz real, confirmada en vivo con capturas (2026-09-06, tras
      // DOS intentos de fix equivocados — ver la bitácora de la Fase 10.5 en
      // el plan para el detalle completo): el intento anterior usaba un
      // nombre de archivo único por corrida (con timestamp), así que el
      // `rm -f` de esta corrida NUNCA tocaba los restos de corridas
      // ANTERIORES que también habían fallado en limpiar — cada corrida
      // fallida dejaba más basura, y el disco de `demo-01` terminó
      // genuinamente lleno para SIEMPRE, no solo durante la corrida. Eso
      // rompía todo lo que necesitara escribir CUALQUIER cosa después
      // (hasta abrir una notebook nueva, que necesita crear su propio
      // archivo `.ipynb`), incluido — confirmado con una alerta real de
      // Grafana — que el propio pod de `demo-01` terminó en
      // `CrashLoopBackOff`. Por eso ahora: (a) el prefijo es CONSTANTE entre
      // corridas, así el `rm -f` de cualquier corrida limpia los restos de
      // TODAS las anteriores, no solo los propios; (b) la limpieza reusa la
      // MISMA notebook ya abierta en vez de abrir una nueva — abrir una
      // notebook nueva exige crear un archivo `.ipynb`, que necesita espacio
      // en disco que en ese momento todavía no existe.
      // Confirmado en vivo (2026-09-06) con `df -h` manual DESPUÉS de una
      // corrida que falló esta misma aserción: el disco terminó casi vacío
      // igual — el `rm` sí funciona. Lo que falla es solo la CAPTURA: un
      // warning asíncrono de IPython ("history saving thread", resto del
      // ENOSPC de la celda anterior) puede aparecer SOLO en el output de la
      // celda siguiente, tapando el "LIMPIADO" real. Como es asíncrono y
      // transitorio, reintentar la MISMA celda (reejecutar `rm -f` sobre un
      // glob ya vacío es inofensivo) le da tiempo a asentarse.
      const cleanOutput = await submitAndReadWithRetry(
        page,
        cell,
        `!rm -f ~/${fillPrefix}_*.bin && echo LIMPIADO`,
        config.execTimeoutMs,
      );
      expect(cleanOutput, `no se pudo confirmar la limpieza tras varios intentos:\n${cleanOutput}`).toContain(
        'LIMPIADO',
      );

      // El kernel sigue sano tras el ENOSPC — misma celda, misma notebook.
      await submitCell(page, cell, '2 + 2');
      const restored = await readOutput(cell, config.execTimeoutMs);
      expect(restored).toMatch(/\b4\b/);
    } finally {
      await context.close().catch(() => {});
    }
  });
});

/**
 * Igual que `submitCell` + `readOutput`, pero reintenta la MISMA celda si el
 * output capturado es SOLO el warning asíncrono conocido de IPython
 * ("history saving thread" / "database or disk is full", residuo de un
 * ENOSPC real en una celda anterior) sin ningún otro contenido — confirmado
 * en vivo que ese warning puede tapar el resultado real de la celda
 * siguiente. Reejecutar un comando idempotente (`rm -f` sobre un glob que
 * ya puede estar vacío) es inofensivo.
 */
async function submitAndReadWithRetry(
  page: Page,
  cell: Locator,
  code: string,
  timeoutMs: number,
  maxAttempts = 3,
): Promise<string> {
  let output = '';
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    await submitCell(page, cell, code);
    output = await readOutput(cell, timeoutMs);
    const onlyNoisyWarning = /history saving thread/i.test(output) && !/LIMPIADO/.test(output);
    if (!onlyNoisyWarning) return output;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  return output;
}

/** IDs de kernels con `execution_state !== 'dead'` en este momento. */
async function captureRunningKernelIds(page: Page, base: string): Promise<Set<string>> {
  try {
    const res = await page.request.get(`${base}/api/kernels`);
    if (!res.ok()) return new Set();
    const kernels = (await res.json()) as Array<{ id?: string }>;
    return new Set(kernels.map((k) => k.id).filter((id): id is string => !!id));
  } catch {
    return new Set();
  }
}

/**
 * Espera a que TODOS los kernels que estaban en `knownIds` desaparezcan de
 * `/api/kernels` — o a que la API deje de responder del todo (el pod entero
 * cayó, que es justo lo que la investigación de la Fase 10 confirmó que hace
 * Kubernetes ante un OOM: mata el pod completo, no solo el kernel). Cualquiera
 * de las dos cuenta como "el kernel de la bomba se fue".
 */
async function waitForKernelGone(
  page: Page,
  base: string,
  knownIds: Set<string>,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await page.request.get(`${base}/api/kernels`, { timeout: 5_000 });
      if (!res.ok()) return true; // server ya no responde bien -> se cayó
      const kernels = (await res.json()) as Array<{ id?: string }>;
      const stillThere = kernels.some((k) => k.id && knownIds.has(k.id));
      if (!stillThere) return true;
    } catch {
      return true; // conexión rechazada/timeout -> el pod se cayó
    }
    await new Promise((r) => setTimeout(r, 3_000));
  }
  return false;
}

/** Espera a que `/api/kernels` vuelva a responder 200 (pod reiniciado). */
async function waitForApiReachable(page: Page, base: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await page.request.get(`${base}/api/kernels`, { timeout: 5_000 });
      if (res.ok()) return true;
    } catch {
      /* todavía cayéndose/reiniciando, reintenta */
    }
    await new Promise((r) => setTimeout(r, 5_000));
  }
  return false;
}

/**
 * Código que escribe bloques de 50MB en `~/<prefix>_N.bin` hasta que el
 * filesystem rechace la escritura, capturando el error de Python en vez de
 * dejar que reviente el kernel — a diferencia de la bomba de RAM, un disco
 * lleno NO debería matar nada, así que acá SÍ tiene sentido esperar un
 * output normal.
 */
function fillDiskCode(prefix: string): string {
  return [
    'import os',
    'i = 0',
    'try:',
    '    while True:',
    `        with open(f"/home/jovyan/${prefix}_{i}.bin", "wb") as f:`,
    '            f.write(os.urandom(50 * 1024 * 1024))',
    '        i += 1',
    'except OSError as e:',
    '    print(f"STOPPED_AT={i} ERROR={e}")',
  ].join('\n');
}
