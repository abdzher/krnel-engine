# Suite de demo de concurrencia — JupyterHub / MRKOV

Demostración **en vivo, con navegadores reales**: N "usuarios" simultáneos que
hacen **login → levantan su servidor → ejecutan una celda (`2 + 2`) y verifican
el resultado en el DOM**. Pensada para mostrarse ante público (video +
screenshots), no sólo para pasar en verde.

> **Esto no es una prueba de carga.** Playwright levanta un navegador entero por
> usuario; sirve para demostrar el flujo de un puñado de usuarios con fidelidad,
> no para simular cientos. Para estimar el techo real de la cuota, usa la sonda
> k6 de [`capacity-probe/`](capacity-probe/) **antes** de la demo.

No está enganchada a `playbooks/site.yml` ni a ningún pipeline. Es una
herramienta manual.

## Qué asume

| Requisito | Detalle |
| --- | --- |
| Node.js ≥ 18 | No viene instalado en la máquina de control. `nvm install 20` o paquete del sistema. |
| Clúster MRKOV en línea | El Hub debe responder en `HUB_URL`. |
| Cuentas demo dedicadas | `demo-01..demo-NN` — **nunca** identidades reales de estudiantes. Deben estar en `files/allowlist.txt` y el Hub re-aplicado (`--tags update`). |
| NativeAuthenticator `open_signup: true` | Así está el `hub-values.yaml.j2` de este repo: alta inmediata sin aprobación de admin. |
| Perfil por defecto = "Efímero (Invitado)" | `local[*]`, sin Spark. `2 + 2` corre en el kernel local. Para demostrar Spark: `DEMO_PROFILE="Comunidad"` (requiere que un admin asigne el grupo a cada `demo-NN` y `SPAWN_TIMEOUT_MS` ≥ 600000). |
| Fase 3 (subida de cuotas) aplicada | La `ResourceQuota` del namespace `jupyter` limita cuántos spawns concurrentes hay. `DEMO_USER_COUNT` sale de env, no está hardcodeado. |

## Instalación

```bash
cd tests/demo-concurrencia
npm ci
cp .env.example .env
# editar .env: HUB_URL, DEMO_PASSWORD, DEMO_USER_COUNT
```

Después, para el navegador, dos caminos:

### Opción A — Docker (recomendado en Arch / distros no soportadas)

`--with-deps` de Playwright solo sabe invocar `apt`/`apt-get`; en la máquina
de control (Arch) falla directo, y la descarga nativa (`npx playwright install
chromium`, sin `--with-deps`) resultó frágil ahí (instalación incompleta,
quedó un `__dirlock` colgado). La imagen oficial de Playwright trae Chromium +
todas las dependencias de sistema ya resueltas y versionadas junto al
`@playwright/test` que usa este repo — evita el problema de raíz:

```bash
npm run docker:pull            # una vez; imagen ~3.5 GB, versión pineada abajo
npm run docker:verify:smoke
npm run docker:verify:concurrencia
```

La versión de la imagen (`mcr.microsoft.com/playwright:v1.62.1-noble`,
cableada en los scripts `docker:*` de `package.json`) **debe coincidir** con
`@playwright/test` de `devDependencies` — si subes uno, sube el otro. Corre
con `--ipc=host` (recomendado por Playwright para evitar crashes de Chromium
por memoria compartida) y monta este directorio en `/work`, así `.env` se lee
igual que en modo nativo y `reports/`/`playwright-report/` quedan en el host.
**`--user "$(id -u):$(id -g)"` + `-e HOME=/tmp` son obligatorios**: Docker
corre como `root` por defecto, y cualquier archivo que el contenedor escriba
en el bind mount (`reports/`, `playwright-report/`, `test-results/`) queda
root-owned en el host — rompe la próxima corrida nativa con `EACCES`. Si ves
ese error, es porque algo corrió `docker run` sin esas dos flags; arréglalo
con `sudo chown -R "$(whoami)" reports playwright-report test-results`. No
incluye `npm run demo` (headed, para la presentación en vivo) — ese requiere
un display real, tiene sentido correrlo nativo en la máquina que de verdad se
usa para la demo, no en Docker en la máquina de control.

### Opción B — nativo (Ubuntu/Debian, o Arch si ya tienes las libs)

```bash
npx playwright install --with-deps chromium   # Ubuntu/Debian
# — o en Arch/otras distros —
npx playwright install chromium               # solo el binario, sin --with-deps
```

Si en Arch un test falla con `error while loading shared libraries:
libX.so...`, instala el paquete pacman correspondiente a esa librería (un
Arch de escritorio normalmente ya las tiene todas).

## Preparar las cuentas demo (una sola vez, con el clúster arriba)

```bash
# 1. Agregar demo-01..demo-05 al allowlist (no imprime el archivo)
scripts/append-allowlist.sh 5

# 2. Re-aplicar el Hub para que tome el allowlist nuevo
cd ../.. && ansible-playbook playbooks/05-jupyterhub.yml --tags update \
    --ask-vault-pass --ask-become-pass && cd tests/demo-concurrencia

# 3. Dar de alta las cuentas vía el form de signup
npm run signup
```

## Correr

```bash
# Verificación previa — 1 usuario, headless, rápido
npm run verify:smoke

# Verificación previa — N usuarios, headless
npm run verify:concurrencia

# LA DEMO — N usuarios, headed, con video + trace + slowMo
npm run demo

# Ver el reporte HTML de la última corrida
npm run report
```

### Variables de entorno (`.env`)

| Var | Default | Para qué |
| --- | --- | --- |
| `HUB_URL` | — (obligatorio) | URL raíz del Hub, sin slash final. |
| `DEMO_PASSWORD` | — (obligatorio) | Contraseña compartida de las cuentas demo (≥ 8). |
| `DEMO_USER_COUNT` | `3` | Cuántos usuarios simultáneos. **El techo real lo fija la cuota.** |
| `DEMO_USERNAME_TEMPLATE` | `demo-{n}` | `{n}` → índice con 2 dígitos. Debe casar con `files/allowlist.txt`. |
| `DEMO_PROFILE` | `` (primero) | `display_name` del perfil a elegir si aparece el form. |
| `LOGIN_TIMEOUT_MS` | `30000` | Tope de login. |
| `SPAWN_TIMEOUT_MS` | `300000` | Tope de spawn hasta Lab listo. Subir para perfiles Spark. |
| `EXEC_TIMEOUT_MS` | `60000` | Tope de ejecución de la celda. |
| `DEMO_SLOWMO_MS` | `150` | `slowMo` sólo en el proyecto `demo` (hace el video legible). |
| `ADMIN_TOKEN` | `` | Opcional, reservado para `teardown.ts` (`sweepServersViaApi`). No se invoca automáticamente desde ninguna corrida — el teardown es manual, ver "Sin teardown automático" abajo. |
| `REPORT_SMTP_HOST` / `_PORT` / `_SECURE` / `_USER` / `_PASSWORD` | `` | Opcionales. Si las 5 (+ `FROM`/`TO`) están completas, cada corrida manda el resumen por correo. |
| `REPORT_EMAIL_FROM` / `REPORT_EMAIL_TO` | `` | Remitente y lista de administradores (separada por comas) del aviso por correo. |

## Cómo está armado

```
src/
  env.ts        parseo/validación de env, construye la lista de usuarios demo
  login.ts      login NativeAuthenticator; selectores con fallback + volcado de HTML
  spawn.ts      levantar server y esperar Lab listo POR ESTADO (URL + shell + kernel), nunca sleep
  notebook.ts   abrir notebook, ejecutar `2 + 2`, leer el output real del DOM
  teardown.ts   stopServerViaUI() (botón del Hub) + sweepServersViaApi() (opcional)
  metrics.ts    tiempos + etapa de fallo + server detenido -> reports/run-<ts>.{json,md}
  report-email.ts  aviso por correo del resumen a administradores (opcional, ver abajo)
  flow.ts       flujo de 1 usuario con BrowserContext aislado + Barrier
tests/
  smoke.spec.ts         1 usuario (verificación previa)
  concurrencia.spec.ts  N usuarios: barrera + Promise.all -> login+spawn SIMULTÁNEOS
scripts/
  append-allowlist.sh    agrega demo-NN a files/allowlist.txt (sin imprimirlo)
  signup-demo-users.mjs  alta de demo-NN vía /hub/signup
capacity-probe/          sonda k6 (exploratoria, fuera de la suite)
```

**Concurrencia real:** el runner corre con `workers: 1`. Es
`concurrencia.spec.ts` quien crea N `BrowserContext` y los libera con
`Promise.all` sobre **dos** `Barrier` (`Barrier` es de un solo uso, ver
`flow.ts`) — una antes de enviar credenciales, otra antes de pedir el spawn —
de modo que tanto los N logins como los N spawns pegan al Hub en el mismo
instante cada uno, no solo el login. No es paralelismo del runner sobre tests
distintos.

**Esperas por estado, no por tiempo:** `waitForURL`, selectores del shell de
JupyterLab, indicador de kernel en `idle`, `expect(output).toHaveText(/4/)`. No
hay `sleep` fijos (la causa nº 1 de flakiness en spawns).

**Sin teardown automático — detener a mano.** Se intentó primero un stop
automático vía el botón "Stop My Server" con confirmación real por polling
(`GET /hub/api/users/:u` hasta que `servers` quedara vacío, hasta 90s). En la
práctica, en ninguna corrida en vivo llegó a confirmar un stop exitoso —
`kubectl get pods -n jupyter` seguía mostrando el pod `Running` bastante
después — y esos 90s por usuario se perdían en cada corrida, pase o falle el
test. Se sacó por pedido explícito: ahora cada corrida solo reporta cuántos
usuarios llegaron a levantar servidor (`summary.spawned` / fila "Servidores
levantados" del reporte) y el operador los detiene a mano (UI del Hub o
`kubectl delete pod -n jupyter jupyter-<usuario>`) — orphan servers siguen
consumiendo la cuota de PVCs/CPU, así que no conviene dejarlos sin revisar tras
cada corrida. `teardown.ts` (`stopServerViaUI`, `sweepServersViaApi`) sigue en
el repo como utilidad, ya no se invoca desde `flow.ts` ni `concurrencia.spec.ts`.

**Etapa del fallo:** si un usuario falla, el reporte indica en qué etapa
(`login`, `spawn` o `exec`), no sólo el mensaje de error crudo — para
distinguir rápido un problema de NativeAuthenticator, de cuota/spawn, o del
kernel.

## Aviso por correo

Opcional (`REPORT_SMTP_*`/`REPORT_EMAIL_*` en `.env`, ver tabla arriba). Si
están completas, `smoke.spec.ts` y `concurrencia.spec.ts` mandan el resumen de
la corrida (mismo contenido que `reports/run-<ts>.md`) por correo a
`REPORT_EMAIL_TO` al terminar — pase o falle. Pensado para que los
administradores vean el resultado sin tener que abrir el reporte HTML/Markdown
en la máquina de control. Reusa el criterio multi-admin de Alertmanager
(Fase 4 del hardening) pero con su propia credencial SMTP — este suite corre
fuera de Ansible y no lee el Vault del clúster. Es best-effort: si el envío
falla (SMTP mal configurado, etc.), sólo se loguea una advertencia — nunca
rompe la corrida ni afecta `reports/`. **No** aplica a la sonda k6 de
`capacity-probe/` (fuera del ecosistema npm de esta suite).

## Salidas

- `playwright-report/` — reporte HTML (screenshots, y en el proyecto `demo`
  también video y trace por usuario).
- `test-results/videos/` — un `.webm` por usuario (proyecto `demo`).
- `reports/run-<timestamp>.md` y `.json` — tabla de métricas por usuario
  (login ms, spawn ms, exec ms, output, OK/fallo, etapa del fallo) + resumen
  (incluye cuántos servidores quedaron levantados — sin teardown automático,
  ver "Sin teardown automático" arriba).
- Correo a los administradores con el mismo resumen, si se configuró
  `REPORT_SMTP_*`/`REPORT_EMAIL_*`.

Todo lo generado está gitignoreado.

## Si la demo revela que la cuota no alcanza

Repórtalo. **No** ajustes `ResourceQuota`, `LimitRange`, RBAC ni UFW por tu
cuenta — ver `CLAUDE.md` y `tmp/contexto.md`.
