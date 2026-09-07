// =============================================================================
// KRNEL — tests/demo-concurrencia/tests/kernels.spec.ts
// FASE 10.6 del plan de hardening: funcional — kernels disponibles y
// persistencia de paquetes de usuario.
//
//   1. La imagen `quay.io/jupyter/all-spark-notebook` trae, según upstream,
//      kernels de Python/R/Scala — nunca se había confirmado EN VIVO en este
//      clúster que los que estén presentes arranquen sin error. No se asume
//      cuáles trae: se leen de `/api/kernelspecs` (ground truth del server) y
//      se prueba cada uno que aparezca ahí. Python 3 es el único que se exige
//      duro (lo usa el resto de la suite); R/Scala se prueban SI existen,
//      pero que falten no es en sí una regresión — puede ser una decisión de
//      qué imagen usar, fuera del alcance de esta prueba.
//   2. `pip install --user <paquete>` cae en `/home/jovyan/.local` (montado,
//      persistente), no en la capa efímera del contenedor — relevante porque
//      no hay `fsGroup`/`securityContext` custom (hub-values.yaml.j2) que
//      pudiera interferir con esa escritura. Se confirma instalando en una
//      sesión, reiniciando el server DE VERDAD (mismo `stopServer` que Fase
//      10.1) y usando el paquete en la sesión siguiente SIN reinstalarlo.
//
//   npx playwright test --project=verify kernels.spec.ts
// =============================================================================
import { test, expect } from '@playwright/test';
import { loadConfig } from '../src/env';
import { gotoLogin, submitLogin } from '../src/login';
import { ensureServerRunning } from '../src/spawn';
import { openFreshNotebook, submitCell, readOutput, listKernelSpecs, kernelsApiBase } from '../src/notebook';
import { stopServer } from '../src/teardown';

test('los kernels que la imagen realmente trae (Python obligatorio, R/Scala si existen) arrancan y ejecutan código', async ({
  browser,
}) => {
  const config = loadConfig();
  const user = config.users[0];
  test.setTimeout(config.loginTimeoutMs + config.spawnTimeoutMs + config.execTimeoutMs * 4 + 2 * 60_000);

  const context = await browser.newContext({ ignoreHTTPSErrors: true, baseURL: config.hubUrl });
  const page = await context.newPage();

  try {
    await gotoLogin(page, config.loginTimeoutMs);
    await submitLogin(page, user, config.loginTimeoutMs);
    await ensureServerRunning(page, { profile: config.profile, timeoutMs: config.spawnTimeoutMs });

    const specs = await listKernelSpecs(page);
    expect(specs.length, 'no pude listar ningún kernelspec vía /api/kernelspecs').toBeGreaterThan(0);

    const byLanguage = (lang: RegExp) =>
      specs.find((s) => lang.test(s.language) || lang.test(s.displayName));

    const candidates = [
      { label: 'Python', required: true, spec: byLanguage(/python/i) },
      { label: 'R', required: false, spec: byLanguage(/^r$/i) },
      { label: 'Scala', required: false, spec: byLanguage(/scala/i) },
    ];

    // eslint-disable-next-line no-console
    console.log(
      `Kernelspecs disponibles: ${specs.map((s) => s.displayName).join(', ')}\n` +
        candidates
          .map((c) => `  ${c.label}: ${c.spec ? `presente (${c.spec.displayName})` : 'AUSENTE'}`)
          .join('\n'),
    );

    for (const { label, required, spec } of candidates) {
      if (!spec) {
        if (required) {
          throw new Error(`El kernel ${label} es obligatorio (lo usa el resto de la suite) y no aparece en /api/kernelspecs.`);
        }
        continue; // R/Scala ausentes: no es una regresión en sí, solo se informa (log de arriba).
      }
      const cell = await openFreshNotebook(page, config.execTimeoutMs, spec.displayName);
      await submitCell(page, cell, '2 + 2');
      const output = await readOutput(cell, config.execTimeoutMs);
      expect(output, `el kernel ${label} (${spec.displayName}) no devolvió "4" para \`2 + 2\`: "${output}"`).toMatch(
        /\b4\b/,
      );

      // Resetear el workspace antes del próximo kernel del loop: abrir una
      // SEGUNDA notebook en la misma sesión viva sin recargar dejó el panel
      // `lm-mod-hidden` en una corrida real (2026-09-06, ver el contrato en
      // `openFreshNotebook`). `?reset` es el mismo mecanismo ya probado en
      // spawn.ts tras cada login/spawn.
      const base = kernelsApiBase(page);
      if (base) {
        await page.goto(`${base}/lab?reset`, {
          waitUntil: 'domcontentloaded',
          timeout: config.execTimeoutMs,
        });
      }
    }
  } finally {
    await context.close().catch(() => {});
  }
});

test('un paquete instalado con pip --user persiste entre reinicios reales del server', async ({
  browser,
}) => {
  const config = loadConfig();
  const user = config.users[0];

  test.skip(
    !config.profile,
    'Define DEMO_PROFILE=<perfil con almacenamiento persistente, ej. "Comunidad"> en .env — ' +
      'el perfil de invitado no monta un volumen propio, así que "persistir" no significaría nada ahí.',
  );

  // Dos ciclos de login+spawn+exec, más el stop confirmado, más margen para
  // que `pip install` baje el paquete (requiere egress a PyPI).
  test.setTimeout(
    2 * (config.loginTimeoutMs + config.spawnTimeoutMs) + config.execTimeoutMs * 3 + 5 * 60_000,
  );

  const context = await browser.newContext({ ignoreHTTPSErrors: true, baseURL: config.hubUrl });
  const page = await context.newPage();

  // Paquete chico, puro Python, sin compilación nativa, muy poco probable
  // que ya esté en la imagen base (evita un falso positivo por "ya estaba").
  const pkg = 'cowsay';

  try {
    // -- sesión 1: instalar -------------------------------------------------
    await gotoLogin(page, config.loginTimeoutMs);
    await submitLogin(page, user, config.loginTimeoutMs);
    await ensureServerRunning(page, { profile: config.profile, timeoutMs: config.spawnTimeoutMs });

    const installCell = await openFreshNotebook(page, config.execTimeoutMs);
    await submitCell(
      page,
      installCell,
      `!pip install --user --quiet ${pkg} && python -c "import ${pkg}; print('INSTALLED_OK', ${pkg}.__file__)"`,
    );
    // pip install puede tardar bastante más que una celda normal (descarga +
    // resolución de deps), pero no tanto como un spawn — usa un piso propio.
    const installOut = await readOutput(installCell, Math.max(config.execTimeoutMs, 3 * 60_000));
    expect(installOut, `la instalación de ${pkg} falló:\n${installOut}`).toContain('INSTALLED_OK');
    expect(
      installOut,
      `${pkg} no se instaló en el home persistente (/home/jovyan/.local) sino en: ${installOut}`,
    ).toContain('/home/jovyan/.local');

    // -- stop real, confirmado por polling -----------------------------------
    const stopped = await stopServer(page, user.username);
    expect(stopped, `el server de ${user.username} no confirmó stop real (ver teardown.ts)`).toBe(true);

    // -- sesión 2: usar el paquete SIN reinstalarlo --------------------------
    await ensureServerRunning(page, { profile: config.profile, timeoutMs: config.spawnTimeoutMs });
    const checkCell = await openFreshNotebook(page, config.execTimeoutMs);
    await submitCell(page, checkCell, `!python -c "import ${pkg}; print('STILL_THERE', ${pkg}.__file__)"`);
    const checkOut = await readOutput(checkCell, config.execTimeoutMs);
    expect(
      checkOut,
      `${pkg} no sobrevivió al restart del server (debería, vive en /home/jovyan):\n${checkOut}`,
    ).toContain('STILL_THERE');
  } finally {
    await stopServer(page, user.username).catch(() => {});
    await context.close().catch(() => {});
  }
});
