# Sonda de capacidad (k6) — exploratoria, fuera de la suite

**Qué es:** un script k6 que arranca servidores de JupyterHub vía REST API (sin
navegador) para N usuarios crecientes y mide cuántos spawns concurrentes aguanta
la `ResourceQuota` del namespace `jupyter` antes de que empiecen a fallar.

**Qué NO es:** no es parte de la suite Playwright, no corre en CI, no se ejecuta
en cada demo. Se corre **una vez, a mano**, para tener un número antes de la
demostración en vivo.

Playwright no sirve para medir capacidad (levanta un navegador entero por
usuario); k6 escala a cientos de "usuarios" con costo mínimo. Ver
<https://www.artillery.io/docs/playwright> y
<https://www.loadview-testing.com/blog/playwright-load-testing/>.

El script arranca el servidor por defecto con `POST /hub/api/users/:u/server`
(singular) y sondea el progreso con `GET /hub/api/users/:u` (modelo de
usuario, `servers[''].ready`) — el endpoint plural `/servers` de la API de
JupyterHub es solo para servidores *con nombre*, no aplica al flujo por
defecto que usa esta sonda.

## Requisitos

1. **k6** — <https://grafana.com/docs/k6/latest/set-up/install-k6/>
   (Arch: `sudo pacman -S k6`; o binario oficial.)
2. Cuentas `probe-01..probe-NN` dadas de alta en el Hub y presentes en
   `files/allowlist.txt` (mismo procedimiento que las cuentas `demo-*`: usa
   `scripts/append-allowlist.sh` con `DEMO_USERNAME_TEMPLATE='probe-{n}'` y
   `scripts/signup-demo-users.mjs` con `DEMO_USERNAME_TEMPLATE=probe-{n}`).
3. **ADMIN_TOKEN** — token de admin del Hub con scopes `servers` y `read:servers`:
   ```
   kubectl -n jupyter exec deploy/hub -- jupyterhub token <admin_user>
   ```

## Correr

```bash
k6 run \
  -e HUB_URL=https://<jupyterhub_domain> \
  -e ADMIN_TOKEN=<token> \
  -e MAX_USERS=8 \
  -e SPAWN_TIMEOUT_S=300 \
  spawn-load.js
```

Rampa de 1 a `MAX_USERS` spawns simultáneos (uno nuevo cada 30 s), mantiene 2
min, y baja. Cada VU detiene su servidor al final (`DELETE .../server`).

## Leer el resultado

- `spawn_success` (Rate): fracción de spawns que llegaron a `ready` dentro del
  timeout. Si cae por debajo de ~0.99, ese `MAX_USERS` ya es demasiado.
- `spawn_time_ms` p(95): cuánto tarda un spawn bajo esa concurrencia. Sirve para
  fijar `SPAWN_TIMEOUT_MS` de la suite Playwright.
- Si k6 recibe errores 403/`would exceed quota` en el `POST` → llegaste al techo
  de la `ResourceQuota`. **Repórtalo** — no ajustes la cuota por tu cuenta
  (ver CLAUDE.md).

Anota el número máximo con `spawn_success == 1.0` y úsalo como `DEMO_USER_COUNT`
para la demo (idealmente con 1 de margen).
