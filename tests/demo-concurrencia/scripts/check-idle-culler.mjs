// =============================================================================
// KRNEL — tests/demo-concurrencia/scripts/check-idle-culler.mjs
// FASE 10.2 del plan de hardening: confirma en vivo que el `cull` nativo del
// chart Z2JH (hub-values.yaml.j2: `cull.timeout: 1800` / `cull.every: 600`)
// detiene de verdad un servidor inactivo, y que el PVC del usuario NO
// desaparece en el proceso — `cull.users: false` es sobre no borrar el
// USUARIO de la base del Hub (NativeAuthenticator guarda credenciales ahí),
// no dice nada por sí solo sobre el PVC; nunca se había confirmado en vivo.
//
// Standalone, fuera de Playwright: no tiene sentido dejar un navegador
// abierto ~40 min solo esperando. Pega directo a la REST API del Hub con
// ADMIN_TOKEN — mismo patrón que capacity-probe/spawn-load.js, con el
// endpoint singular /server (no /servers) ya corregido en Fase 9.
//
// Uso:
//   node scripts/check-idle-culler.mjs
//   CULL_TEST_USER=demo-02 node scripts/check-idle-culler.mjs
//
// Requiere en .env: HUB_URL, ADMIN_TOKEN (scope `servers` + `read:servers`,
// ver capacity-probe/README.md para generarlo). Tarda ~35-45 min — pensado
// para correr una vez, no en cada verificación rápida.
// =============================================================================
import 'dotenv/config';

const HUB_URL = (process.env.HUB_URL || '').replace(/\/+$/, '');
const TOKEN = process.env.ADMIN_TOKEN || '';
const USER =
  process.env.CULL_TEST_USER ||
  (process.env.DEMO_USERNAME_TEMPLATE || 'demo-{n}').replace('{n}', '01');

// Mismos valores que `cull:` en hub-values.yaml.j2 — si cambian ahí, pasalos
// por env acá en vez de asumir que siguen siendo estos.
const CULL_TIMEOUT_S = Number.parseInt(process.env.CULL_TIMEOUT_S || '1800', 10);
const CULL_EVERY_S = Number.parseInt(process.env.CULL_EVERY_S || '600', 10);
const MARGIN_S = 300; // margen extra antes de reportar "no culleó"

if (!HUB_URL || !TOKEN) {
  console.error(
    'Faltan HUB_URL y/o ADMIN_TOKEN en .env (ver capacity-probe/README.md para generar el token).',
  );
  process.exit(1);
}

function headers() {
  return { Authorization: `token ${TOKEN}`, 'Content-Type': 'application/json' };
}

async function getUserModel() {
  const res = await fetch(`${HUB_URL}/hub/api/users/${encodeURIComponent(USER)}`, {
    headers: headers(),
  });
  if (!res.ok) throw new Error(`GET /hub/api/users/${USER} -> ${res.status}`);
  return res.json();
}

function fmtMin(s) {
  return `${Math.round(s / 60)} min`;
}

async function main() {
  console.log(`▶ Fase 10.2 — idle-culler real, usuario de prueba: ${USER} (${HUB_URL})\n`);

  // -- 1. Levantar el server (si no estaba ya arriba) ----------------------
  const post = await fetch(`${HUB_URL}/hub/api/users/${encodeURIComponent(USER)}/server`, {
    method: 'POST',
    headers: headers(),
  });
  if (![201, 202, 400].includes(post.status)) {
    throw new Error(`POST /hub/api/users/${USER}/server -> ${post.status} (esperaba 201/202/400)`);
  }
  console.log(
    post.status === 400
      ? '  el server ya estaba arriba (lo reusamos)'
      : '  server pedido, esperando a que quede ready…',
  );

  // -- 2. Esperar a que quede ready -----------------------------------------
  const spawnDeadline = Date.now() + 10 * 60_000; // 10 min de margen para el spawn en sí
  let ready = post.status === 400;
  while (!ready && Date.now() < spawnDeadline) {
    const model = await getUserModel();
    const srv = model.servers?.[''];
    if (srv?.ready) ready = true;
    else await new Promise((r) => setTimeout(r, 5_000));
  }
  if (!ready) throw new Error('El server no llegó a "ready" dentro de 10 min — no tiene sentido seguir.');

  const readyAt = Date.now();
  console.log(`  ✓ server ready a las ${new Date(readyAt).toISOString()}`);
  console.log(`\n  PVC esperado (pvcNameTemplate de hub-values.yaml.j2): claim-${USER}`);
  console.log('  Confirmá el baseline vos mismo antes de esperar (opcional pero recomendado):');
  console.log(
    `    kubectl get pod -n jupyter -l component=singleuser-server,hub.jupyter.org/username=${USER}`,
  );
  console.log(`    kubectl get pvc -n jupyter claim-${USER}\n`);

  // -- 3. NO tocar la sesión: esperar timeout + every + margen -------------
  const waitS = CULL_TIMEOUT_S + CULL_EVERY_S + MARGIN_S;
  console.log(
    `  Esperando ${fmtMin(waitS)} sin tocar la sesión (timeout=${fmtMin(CULL_TIMEOUT_S)} + ` +
      `every=${fmtMin(CULL_EVERY_S)} + margen=${fmtMin(MARGIN_S)})…\n`,
  );

  const cullDeadline = readyAt + waitS * 1000;
  let culledAt = null;
  while (Date.now() < cullDeadline) {
    const model = await getUserModel();
    const stillUp = model.servers && Object.keys(model.servers).length > 0;
    const elapsedMin = Math.round((Date.now() - readyAt) / 60_000);
    console.log(`  [+${elapsedMin} min] servers activos: ${stillUp ? Object.keys(model.servers).length : 0}`);
    if (!stillUp) {
      culledAt = Date.now();
      break;
    }
    await new Promise((r) => setTimeout(r, 60_000));
  }

  console.log();
  if (culledAt) {
    const cullMin = Math.round((culledAt - readyAt) / 60_000);
    console.log(`✅ El server se culleó solo a los ${cullMin} min de inactividad (esperado: 30-40 min).`);
  } else {
    console.log(
      `❌ El server SIGUE activo después de ${fmtMin(waitS)} — el \`cull:\` de hub-values.yaml.j2 ` +
        'no está actuando como se espera. Reportalo, no ajustes esa config vos mismo.',
    );
  }

  console.log('\nConfirmá ahora que el PVC del usuario sigue ahí (no se borró en el proceso):');
  console.log(`  kubectl get pvc -n jupyter claim-${USER}`);
  process.exit(culledAt ? 0 : 1);
}

main().catch((err) => {
  console.error(`\n✘ ${err.message}`);
  process.exit(1);
});
