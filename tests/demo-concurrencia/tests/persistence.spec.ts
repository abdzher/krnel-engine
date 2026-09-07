// =============================================================================
// KRNEL — tests/demo-concurrencia/tests/persistence.spec.ts
// FASE 10.1 del plan de hardening: un archivo creado en /home/jovyan debe
// sobrevivir a un stop/start REAL del servidor, con el mismo dueño/permisos.
//
// Por qué importa: `hub-values.yaml.j2` no declara ningún
// `securityContext`/`fsGroup`/`uid` explícito para los pods de usuario — el
// comportamiento depende 100% de los defaults de la imagen all-spark-notebook
// + Longhorn, y nunca se había confirmado en vivo que el volumen reattachee
// con los mismos permisos tras un restart (sobre todo si el pod se reprograma
// en un nodo distinto).
//
// Requiere un perfil CON almacenamiento persistente propio — el perfil por
// defecto "Efímero (Invitado)" es `local[*]` sin volumen de usuario, así que
// esta prueba no dice nada corriendo ahí. Configurar en .env:
//   DEMO_PROFILE=Comunidad   (o el display_name del perfil persistente real)
// Si DEMO_PROFILE queda vacío, el test se salta explícitamente en vez de dar
// un falso verde con el perfil equivocado.
//
// Reusa `stopServer` (teardown.ts) — que llama directo a la REST API del Hub
// (no clickea el botón de la UI, ver el comentario de esa función para la
// condición de carrera real que eso tenía) y CONFIRMA por polling contra
// `GET /hub/api/users/:u` que el pod terminó de verdad.
//
//   npx playwright test --project=verify persistence.spec.ts
// =============================================================================
import { test, expect } from '@playwright/test';
import { loadConfig } from '../src/env';
import { gotoLogin, submitLogin } from '../src/login';
import { ensureServerRunning } from '../src/spawn';
import { runCellCode } from '../src/notebook';
import { stopServer } from '../src/teardown';

test('persistencia: un archivo en el home sobrevive a un stop/start real, con mismo dueño/permisos', async ({
  browser,
}) => {
  const config = loadConfig();
  const user = config.users[0];

  test.skip(
    !config.profile,
    'Define DEMO_PROFILE=<perfil con almacenamiento persistente, ej. "Comunidad"> en .env — ' +
      'el perfil por defecto ("Efímero (Invitado)") no monta un volumen propio, así que esta ' +
      'prueba no verificaría nada real corriendo ahí.',
  );

  // Dos ciclos completos de login+spawn+exec, más el stop confirmado por
  // polling en medio (hasta 90s, ver teardown.ts) y margen para el pull de
  // imagen si el pod se reprograma en otro nodo.
  test.setTimeout(
    2 * (config.loginTimeoutMs + config.spawnTimeoutMs + config.execTimeoutMs) + 5 * 60_000,
  );

  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    baseURL: config.hubUrl,
    viewport: { width: 1440, height: 900 },
  });
  const page = await context.newPage();

  // Nombre único por corrida: evita falsos positivos si una corrida previa
  // (sin teardown automático, ver flow.ts) dejó su propio marcador atrás.
  const marker = `persistence-marker-${Date.now()}`;
  const markerFile = `~/${marker}.txt`;

  try {
    // -- sesión 1: escribir el marcador y capturar dueño/permisos ----------
    await gotoLogin(page, config.loginTimeoutMs);
    await submitLogin(page, user, config.loginTimeoutMs);
    await ensureServerRunning(page, { profile: config.profile, timeoutMs: config.spawnTimeoutMs });

    const before = await runCellCode(
      page,
      `!echo ${marker} > ${markerFile} && id && ls -la ${markerFile}`,
      config.execTimeoutMs,
    );
    expect(before, 'no se pudo escribir/leer el marcador en la primera sesión').toContain(marker);
    const statBefore = extractLsFields(before, marker);
    expect(statBefore, `no encontré "${marker}.txt" en el \`ls -la\` de la primera sesión:\n${before}`).not.toBeNull();

    // -- stop real, confirmado por polling (no solo que la API lo acepte) -
    const stopped = await stopServer(page, user.username);
    expect(stopped, `el server de ${user.username} no confirmó stop real (ver teardown.ts)`).toBe(true);

    // -- sesión 2: releer el marcador tras el restart real -----------------
    // `ensureServerRunning` maneja tanto /hub/home (Start) como /hub/spawn
    // (form de perfil) según donde esté la página; tras `stopServer` seguimos
    // en la misma página del paso anterior, ni logueado nuevo ni navegado.
    await page.goto(`${config.hubUrl}/hub/home`, { waitUntil: 'domcontentloaded', timeout: config.loginTimeoutMs });
    await ensureServerRunning(page, { profile: config.profile, timeoutMs: config.spawnTimeoutMs });

    const after = await runCellCode(
      page,
      `!id && ls -la ${markerFile} && cat ${markerFile}`,
      config.execTimeoutMs,
    );
    expect(after, 'el marcador no sobrevivió al restart del server (dato perdido)').toContain(marker);
    const statAfter = extractLsFields(after, marker);
    expect(statAfter, `no encontré "${marker}.txt" en el \`ls -la\` de la segunda sesión:\n${after}`).not.toBeNull();

    // Dueño y grupo son lo que realmente importa para la persistencia: si
    // cambiaran, el volumen reattacheó con otro UID/GID (dato inaccesible o
    // corrupción real). El MODO de permisos, en cambio, puede variar por el
    // umask del arranque del contenedor sin que eso sea una regresión —
    // confirmado en vivo (2026-09-06): 644 -> 664 entre dos spawns del MISMO
    // usuario/perfil, dueño y grupo idénticos, sin ningún `NB_UMASK`/chmod
    // propio en ningún `.j2` de este repo (es comportamiento de la imagen
    // base, no de esta config). Cada usuario tiene su propia PVC — no hay
    // aislamiento entre estudiantes basado en permisos de archivo en este
    // diseño — así que un bit de más para el GRUPO PROPIO del usuario no
    // expone nada a nadie más; lo que sí sería una señal real es que el
    // archivo quede escribible por "otros".
    expect(statAfter!.owner, 'el owner del archivo cambió entre sesiones (UID inestable tras el restart)').toBe(
      statBefore!.owner,
    );
    expect(statAfter!.group, 'el group del archivo cambió entre sesiones (GID inestable tras el restart)').toBe(
      statBefore!.group,
    );
    if (statAfter!.perms !== statBefore!.perms) {
      // eslint-disable-next-line no-console
      console.warn(
        `⚠ el modo de permisos de ${marker}.txt cambió entre sesiones: ` +
          `${statBefore!.perms} -> ${statAfter!.perms} (dueño/grupo iguales — no falla el test, ver comentario arriba).`,
      );
    }
    expect(
      isWorldWritable(statAfter!.perms),
      `${marker}.txt quedó escribible por "otros" tras el restart (${statAfter!.perms}) — a diferencia de un ` +
        'cambio de bit de grupo, esto sí expondría el archivo fuera del propio usuario.',
    ).toBe(false);
  } finally {
    // Limpieza best-effort: no debe hacer fallar el test si ya no hay nada
    // que detener (p. ej. si el `expect` de arriba ya cortó la ejecución).
    await stopServer(page, user.username).catch(() => {});
    await context.close().catch(() => {});
  }
});

interface LsFields {
  perms: string;
  owner: string;
  group: string;
}

/**
 * De la línea de `ls -la` que nombra el marcador, extrae permisos + owner +
 * group por separado (ignora el conteo de links y la fecha/hora, que pueden
 * variar sin que eso sea una regresión real). Ej.: `-rw-r--r-- 1 jovyan
 * users ... persistence-marker-123.txt` -> `{perms: "-rw-r--r--", owner:
 * "jovyan", group: "users"}`.
 */
function extractLsFields(output: string, marker: string): LsFields | null {
  const line = output.split('\n').find((l) => l.includes(`${marker}.txt`));
  if (!line) return null;
  const cols = line.trim().split(/\s+/);
  if (cols.length < 4) return null;
  const [perms, , owner, group] = cols;
  return { perms, owner, group };
}

/** Bit de escritura para "otros" (posición 8 de `-rwxrwxrwx`, 0-indexed). */
function isWorldWritable(perms: string): boolean {
  return perms.length >= 9 && perms[8] === 'w';
}
