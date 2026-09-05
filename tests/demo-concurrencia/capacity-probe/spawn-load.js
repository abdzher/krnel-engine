// =============================================================================
// KRNEL — tests/demo-concurrencia/capacity-probe/spawn-load.js
// Sonda de CAPACIDAD (k6) — NO es parte de la suite Playwright ni de ningún
// pipeline. Se corre UNA vez, a mano, antes de la demo, para estimar el techo
// real de spawns concurrentes que aguanta la ResourceQuota del namespace.
//
// Golpea directamente la REST API del Hub (sin navegador, mucho más barato de
// escalar que Playwright). El servidor por defecto (sin nombre) se controla
// con el endpoint SINGULAR /server — /servers (plural) es solo para
// servidores con nombre (/servers/{server_name}), no aplica acá:
//   POST   /hub/api/users/:u/server   -> 201 listo / 202 en progreso / 400 ya corría
//   GET    /hub/api/users/:u          -> modelo de usuario; servers[''].ready (polling)
//   DELETE /hub/api/users/:u/server   -> 204 / 202
//
// Requisitos:
//   - k6 instalado            https://grafana.com/docs/k6/latest/set-up/install-k6/
//   - ADMIN_TOKEN : token de admin del Hub con scope `servers` + `read:servers`
//   - HUB_URL     : https://<jupyterhub_domain>
//   - Las cuentas probe-01..probe-NN dadas de alta y en el allowlist.
//
// Ejemplo (rampa 1 -> 8 spawns simultáneos):
//   k6 run -e HUB_URL=https://jupyter.midominio.com \
//          -e ADMIN_TOKEN=xxxxx \
//          -e MAX_USERS=8 \
//          tests/demo-concurrencia/capacity-probe/spawn-load.js
// =============================================================================
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend, Rate } from 'k6/metrics';

const HUB_URL = (__ENV.HUB_URL || '').replace(/\/+$/, '');
const TOKEN = __ENV.ADMIN_TOKEN || '';
const MAX_USERS = parseInt(__ENV.MAX_USERS || '5', 10);
const USER_TEMPLATE = __ENV.PROBE_USERNAME_TEMPLATE || 'probe-{n}';
const SPAWN_TIMEOUT_S = parseInt(__ENV.SPAWN_TIMEOUT_S || '300', 10);

const spawnTime = new Trend('spawn_time_ms', true);
const spawnOk = new Rate('spawn_success');

export const options = {
  // Rampa: sube de a 1 usuario cada 30 s hasta MAX_USERS, mantiene, y baja.
  scenarios: {
    ramp_spawns: {
      executor: 'ramping-vus',
      startVUs: 1,
      stages: [
        { duration: `${MAX_USERS * 30}s`, target: MAX_USERS },
        { duration: '2m', target: MAX_USERS },
        { duration: '30s', target: 0 },
      ],
      gracefulStop: '5m',
    },
  },
  thresholds: {
    spawn_success: ['rate>0.99'],
    'spawn_time_ms': [`p(95)<${SPAWN_TIMEOUT_S * 1000}`],
  },
};

function headers() {
  return { Authorization: `token ${TOKEN}`, 'Content-Type': 'application/json' };
}

function usernameFor(n) {
  return USER_TEMPLATE.replace('{n}', String(n).padStart(2, '0'));
}

export default function () {
  if (!HUB_URL || !TOKEN) {
    throw new Error('Faltan HUB_URL y/o ADMIN_TOKEN');
  }
  // Cada VU mapea a un usuario probe-NN estable.
  const n = ((__VU - 1) % MAX_USERS) + 1;
  const user = usernameFor(n);
  const base = `${HUB_URL}/hub/api/users/${encodeURIComponent(user)}`;

  const started = Date.now();
  const post = http.post(`${base}/server`, null, { headers: headers() });
  check(post, { 'POST server 201/202/400': (r) => [201, 202, 400].includes(r.status) });

  // 400 = ya estaba corriendo -> lo tratamos como listo.
  let ready = post.status === 201 || post.status === 400;

  const deadline = started + SPAWN_TIMEOUT_S * 1000;
  while (!ready && Date.now() < deadline) {
    const model = http.get(base, { headers: headers() });
    if (model.status === 200) {
      const servers = (model.json('servers') || {});
      const srv = servers[''] || Object.values(servers)[0];
      if (srv && srv.ready) ready = true;
    }
    if (!ready) sleep(2);
  }

  spawnTime.add(Date.now() - started);
  spawnOk.add(ready);
  check(null, { 'servidor listo dentro del timeout': () => ready });

  // Teardown: liberar la cuota.
  http.del(`${base}/server`, null, { headers: headers() });
  sleep(3);
}
