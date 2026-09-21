// =============================================================================
// KRNEL — tests/demo-concurrencia/tests/concurrencia.spec.ts
// EL TEST CENTRAL de la demo: N "usuarios" (BrowserContext aislados) que hacen
// login + spawn AL MISMO TIEMPO (barrera + Promise.all), cada uno ejecuta
// `2 + 2` y verifica el output real en el DOM. SIN teardown automático (a
// pedido: el polling de confirmación nunca llegó a confirmar un stop exitoso
// en vivo y desperdiciaba ~90s por usuario) — el operador detiene los
// servidores a mano al terminar, `summary.spawned` en el reporte dice cuántos.
//
//   npm run demo               # headed, con video (para la demostración)
//   npm run verify:concurrencia # headless (verificación previa)
//
// El nº de usuarios sale de DEMO_USER_COUNT (env), NO está hardcodeado: el
// techo real lo fija la ResourceQuota del namespace jupyter (Fase 3).
// =============================================================================
import { test, expect } from '@playwright/test';
import { loadConfig } from '../src/env';
import { Barrier, runUserFlow } from '../src/flow';
import { RunMetrics } from '../src/metrics';
import { sendRunReportEmail } from '../src/report-email';

test('N usuarios simultáneos: login -> spawn -> ejecutar 2 + 2', async ({ browser }, testInfo) => {
  const config = loadConfig();
  const metrics = new RunMetrics();
  const recordVideo = testInfo.project.name === 'demo';

  // Timeout del test = margen para el peor caso concurrente (todos pagan el
  // pull de imagen a la vez) + login + exec + las DOS barreras (hasta 120s de
  // espera interna cada una si alguien no llega). Sin teardown automático, no
  // hay que presupuestar los 90s de polling que se sacaron (ver flow.ts).
  test.setTimeout(config.spawnTimeoutMs + config.loginTimeoutMs + config.execTimeoutMs + 5 * 60_000);

  // eslint-disable-next-line no-console
  console.log(
    `\n▶ Demo de concurrencia: ${config.userCount} usuarios · perfil "${config.profile ?? '(primero / invitado)'}" · ${config.hubUrl}\n`,
  );

  // Dos barreras, no una: `Barrier` es de un solo uso (ver flow.ts). Sincroniza
  // login (envío de credenciales) y spawn (arranque del servidor) por separado.
  const loginBarrier = new Barrier(config.userCount);
  const spawnBarrier = new Barrier(config.userCount);

  const results = await Promise.allSettled(
    config.users.map((user) =>
      runUserFlow(browser, user, config, metrics, { recordVideo, loginBarrier, spawnBarrier }),
    ),
  );

  // Sin teardown automático (ver flow.ts): el operador detiene los N
  // servidores a mano al terminar. El reporte deja claro cuántos quedaron
  // levantados (`summary.spawned`) para que sea obvio qué hay que parar.
  const { mdPath, md } = metrics.flush();
  await testInfo.attach('metricas-corrida.md', { path: mdPath, contentType: 'text/markdown' });
  await sendRunReportEmail(config, metrics, md);

  const failed = results
    .map((r, i) => ({ r, user: config.users[i].username }))
    .filter((x) => x.r.status === 'rejected');

  if (failed.length) {
    const detail = failed
      .map((f) => `  - ${f.user}: ${(f.r as PromiseRejectedResult).reason?.message?.split('\n')[0]}`)
      .join('\n');
    throw new Error(`${failed.length}/${config.userCount} usuarios fallaron:\n${detail}`);
  }

  // Todos verdes: y cada uno ejecutó realmente la celda.
  for (const row of metrics.all()) {
    expect(row.ok, `${row.username}: ${row.error ?? ''}`).toBe(true);
    expect(row.cellOutput, `${row.username}: output inesperado`).toMatch(/\b4\b/);
  }
});
