# Suite de demo de concurrencia — JupyterHub / MRKOV

Demostración **en vivo, con navegadores reales**: N "usuarios" simultáneos que
hacen **login → levantan su servidor → ejecutan una celda (`2 + 2`) y verifican
el resultado en el DOM**. Pensada para mostrarse ante público (video +
screenshots), no sólo para pasar en verde.

> **Esto no es una prueba de carga.** Playwright levanta un navegador entero por
> usuario; sirve para demostrar el flujo de un puñado de usuarios con fidelidad,
> no para simular cientos. Para estimar el techo real de la cuota, usa la sonda
> k6 de `tmp/capacity-probe/` (fuera de este árbol y de git — depende de k6,
> no de Node/Playwright, ver su propio README ahí) **antes** de la demo.

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

# Persistencia: un archivo sobrevive a un stop/start real (requiere
# DEMO_PROFILE con almacenamiento propio, ver tabla de variables abajo)
npm run verify:persistence

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
| `DEMO_PROFILE` | `` (primero) | `display_name` del perfil a elegir si aparece el form. `verify:persistence` EXIGE un perfil con almacenamiento propio (no el de invitado) — se salta solo si esto queda vacío. |
| `LOGIN_TIMEOUT_MS` | `30000` | Tope de login. |
| `SPAWN_TIMEOUT_MS` | `300000` | Tope de spawn hasta Lab listo. Subir para perfiles Spark. |
| `EXEC_TIMEOUT_MS` | `60000` | Tope de ejecución de la celda. |
| `DEMO_SLOWMO_MS` | `150` | `slowMo` sólo en el proyecto `demo` (hace el video legible). |
| `ADMIN_TOKEN` | `` | Opcional, reservado para `teardown.ts` (`sweepServersViaApi`). No se invoca automáticamente desde ninguna corrida — el teardown es manual, ver "Sin teardown automático" abajo. |
| `REPORT_SMTP_HOST` / `_PORT` / `_SECURE` / `_USER` / `_PASSWORD` | `` | Opcionales. Si las 5 (+ `FROM`/`TO`) están completas, cada corrida manda el resumen por correo. |
| `REPORT_EMAIL_FROM` / `REPORT_EMAIL_TO` | `` | Remitente y lista de administradores (separada por comas) del aviso por correo. |

## Prueba de carga real (Fase 10.3 — spawn storm)

> **Genera carga real en el clúster — correr fuera de horario de clase.**

Cierra una brecha real: `tmp/capacity-probe/spawn-load.js` (arreglado en la
Fase 9, vive fuera de este árbol — ver "Por qué está en tmp/" en su propio
README) nunca se había corrido contra la cuota real, y además pega directo a
la REST API con `ADMIN_TOKEN` — nunca pasa por el login real de
NativeAuthenticator, así que no mide el costo de N logins simultáneos, solo N
spawns. Dos pasos:

1. **k6 primero (barato, sin navegador)** — encontrar el techo real de
   `spawn_success == 1.0`. Ver `tmp/capacity-probe/README.md`: con la cuota
   real (`limits.memory: 52Gi`, perfil de invitado `mem_limit: 4G`) el techo
   teórico es `~13` (RAM, no CPU ni PVCs, es el recurso más ajustado — mismo
   hallazgo que en la Fase 3 del hardening). Arrancá la rampa un poco por
   encima de ese número para confirmarlo en vivo, no asumirlo.

   ```bash
   cd ../../tmp/capacity-probe && k6 run -e HUB_URL=... -e ADMIN_TOKEN=... -e MAX_USERS=15 spawn-load.js
   ```

   Sin k6 instalado (ej. Arch, sin paquete oficial): usá Docker — ver
   "Correr con Docker" en `tmp/capacity-probe/README.md`. Si la corrida da
   **0% de éxito parejo desde el primer usuario** (no una caída gradual),
   probablemente no es la cuota — ver "Interpretar una corrida con 100% de
   fallos" en ese mismo README antes de reportarlo como problema de cuota.

2. **`concurrencia.spec.ts` con el techo encontrado (con login real incluido)**
   — el diseño de `Barrier` + `Promise.all` (ver "Cómo está armado" abajo) ya
   escala a cualquier `DEMO_USER_COUNT`, no hace falta código nuevo ni sumar
   una herramienta aparte como `hubtraf`. Necesita esa cantidad de cuentas
   `demo-NN` dadas de alta (`scripts/append-allowlist.sh N` +
   `scripts/signup-demo-users.mjs`, ver "Preparar las cuentas demo" arriba):

   ```bash
   DEMO_USER_COUNT=13 npm run docker:verify:concurrencia
   ```

   **Costo en la máquina de control, no en el clúster:** cada "usuario" es un
   `BrowserContext` con un Chromium real detrás (`workers: 1`, un solo proceso
   Node orquesta los N contextos) — a diferencia de k6, esto sí consume RAM
   real de la máquina que lo corre (varios cientos de MB por contexto es un
   punto de partida razonable para estimar si 13-15 contextos entran
   cómodos). Si la máquina de control no da abasto, correlo desde una más
   grande, no reduzcas `DEMO_USER_COUNT` por eso — subestimarías la prueba.

**Criterio de éxito:** `spawn_success ≥ 0.99` (k6) hasta el `MAX_USERS` que se
decida como techo de clase; si `concurrencia.spec.ts` falla antes de eso o el
Hub responde con error de cuota, **reportalo — no ajustes `ResourceQuota` /
`LimitRange` por tu cuenta** (ver CLAUDE.md y "Si la demo revela que la cuota
no alcanza" más abajo). Una vez confirmado un techo estable, usalo como
`DEMO_USER_COUNT` por defecto de la demo real (con 1 de margen).

## Aislamiento multi-usuario (Fase 10.4)

Regresión de seguridad: confirma en vivo que cosas ya cerradas en fases
anteriores del hardening (S3, S4) siguen cerradas, y que la NetworkPolicy de
usuario-a-usuario funciona de verdad. Dos mitades, según qué es más práctico
probar desde dónde:

- **`tests/isolation.spec.ts`** (acá, ya tiene `login.ts`): (a) un usuario que
  NO está en `files/allowlist.txt` puede a veces completar el *signup*
  (`open_signup: true`), pero el **login** debe rechazarlo — eso es lo que
  filtra `allowed_users`, poblado desde el allowlist al renderizar el
  template; (b) logueado como una cuenta demo, navegar directo a
  `/user/<otra-cuenta>/` debe rechazarse (confirma que el aislamiento es del
  Hub/proxy por cookie, no solo que la UI no ofrece un botón — relevante
  porque `admin_access: false`, hallazgo S4, nunca se había probado con un
  intento real). El segundo test necesita `DEMO_USER_COUNT >= 2` y se salta
  solo si no lo hay.

  ```bash
  npm run docker:verify:isolation
  ```

- **`playbooks/utils/test-tenant-isolation.yml`** (necesita `kubectl`, corre
  en el master): (a) un pod `netshoot` efímero, soltado en el namespace SIN
  el label `spark-role: executor` que la NetworkPolicy exige, no debe poder
  conectar por red a un pod de usuario real — necesita al menos 1 cuenta demo
  con servidor Running; (b) convierte los chequeos informativos que
  `diagnose-spark-infra.yml` ya hacía (`kubectl auth can-i` sobre
  `spark-editor`) en `assert:` duros — evita que un futuro cambio a
  `spark-rbac.yaml.j2` reabra el hallazgo S3 sin que nadie lo note. Todo de
  solo lectura + un pod de debug que se borra solo (`--rm`); no toca RBAC,
  NetworkPolicy, cuotas ni UFW.

  ```bash
  ansible-playbook -i inventories/mrkov playbooks/utils/test-tenant-isolation.yml -K
  ```

Si cualquiera de las dos mitades falla, es una regresión real —
**reportalo, no ajustes RBAC/NetworkPolicy/allowlist por tu cuenta** (mismo
criterio que rige toda la suite, ver CLAUDE.md).

## Gobierno de recursos (Fase 10.5) — blast radius

"¿Qué tan grande es el daño cuando un estudiante se pasa de los límites?" —
tres casos, dos automatizados y uno que reusa `concurrencia.spec.ts`:

- **OOM controlado (`resource-governance.spec.ts`):** una celda agota la RAM
  del perfil a propósito (`bytearray` creciendo sin límite). Confirmado por
  investigación (Fase 10): Kubernetes mata el **pod completo**, no solo el
  proceso del kernel — el test no espera un mensaje de error de Python (no
  va a llegar), espera a que `/api/kernels` deje de responder del todo, y
  después a que vuelva a responder solo (Kubernetes reinicia el contenedor).
  Reusa el patrón de marcador de `persistence.spec.ts` (Fase 10.1) para
  confirmar que un archivo escrito ANTES del OOM sigue ahí después. Requiere
  `DEMO_PROFILE` con límite de RAM conocido (ej. "Comunidad", 12G) — se
  salta solo si no hay uno. Puede tardar varios minutos (esperar la caída +
  el reinicio del pod).
- **Disco lleno (`resource-governance.spec.ts`):** escribe bloques de 50MB
  hasta que el filesystem devuelva `ENOSPC`, capturado LIMPIO del lado de
  Python (no un cuelgue, no una corrupción) — después borra los archivos y
  confirma que el kernel sigue sano corriendo `2 + 2` (la celda ya
  endurecida del resto de la suite). Vale la pena confirmarlo puntualmente
  sobre Longhorn + la clase de storage de este clúster en vez de asumir el
  comportamiento genérico de Kubernetes. Mismo requisito de `DEMO_PROFILE`
  persistente.

  ```bash
  npm run docker:verify:resource-governance
  ```

- **Cuota de spawns al límite (runbook, sin código nuevo):** cierra el ciclo
  de la Fase 10.3 — una vez confirmado el techo real de `spawn_success ==
  1.0`, un spawn UNO MÁS ALLÁ de ese techo debe fallar con un mensaje CLARO,
  no un cuelgue silencioso de varios minutos. `spawn.ts` ahora detecta un
  rechazo síncrono del Hub (vuelve a `/hub/spawn` con un banner de error) y
  falla de inmediato con ese mensaje en vez de esperar el timeout completo.
  Reusa `concurrencia.spec.ts` directamente, no hace falta un test nuevo:

  ```bash
  # <techo> = el número confirmado en la Fase 10.3
  DEMO_USER_COUNT=$((<techo> + 1)) npm run docker:verify:concurrencia
  ```

  Con ese `DEMO_USER_COUNT`, el reporte debe mostrar exactamente 1 fallo en
  etapa `spawn` con un mensaje de rechazo legible (no un timeout genérico).
  Si en cambio se cuelga sin mensaje claro, **reportalo** — puede que el Hub
  use un patrón de error distinto al que `waitForSpawnErrorOrReady` busca.

Los tres casos usan exclusivamente cuentas `demo-NN` — nunca perfiles con
datos de estudiantes reales, por diseño (generan un pod muerto real a
propósito).

## Funcional: kernels y persistencia de paquetes (Fase 10.6)

- **Kernels que la imagen realmente trae (`kernels.spec.ts`):** upstream
  documenta que `quay.io/jupyter/all-spark-notebook` trae Python/R/Scala,
  pero nunca se había confirmado EN VIVO en este clúster que los que estén
  presentes arranquen sin error. El test no asume nada: lee
  `GET /api/kernelspecs` (ground truth del propio server) y prueba cada
  kernel que aparezca ahí con un `2 + 2` — sintaxis válida en los tres
  lenguajes. Python es el único obligatorio (lo usa el resto de la suite);
  si R o Scala no están, se informa en el log pero **no** hace fallar el
  test — su ausencia puede ser una decisión de qué imagen usar, no
  necesariamente una regresión.
- **`pip install --user` persiste entre reinicios (`kernels.spec.ts`):**
  relevante porque `hub-values.yaml.j2` no declara ningún
  `securityContext`/`fsGroup` que pudiera interferir con escribir en
  `/home/jovyan/.local` (mismo punto que ya motivó `persistence.spec.ts`,
  Fase 10.1). Instala un paquete chico y puro-Python (`cowsay`, poco probable
  que ya esté en la imagen base) en una sesión, reinicia el server DE VERDAD
  (`stopServer`, mismo mecanismo que 10.1) y lo importa de nuevo SIN
  reinstalarlo. Requiere `DEMO_PROFILE` persistente — se salta solo si no
  hay uno.

  ```bash
  npm run docker:verify:kernels
  ```

## Cómo está armado

```
src/
  env.ts        parseo/validación de env, construye la lista de usuarios demo
  login.ts      login NativeAuthenticator; selectores con fallback + volcado de HTML
  spawn.ts      levantar server y esperar Lab listo POR ESTADO (URL + shell + kernel), nunca sleep
  notebook.ts   abrir notebook, ejecutar `2 + 2`, leer el output real del DOM
  teardown.ts   stopServer() (REST + confirmación real por polling) + sweepServersViaApi() (opcional)
  metrics.ts    tiempos + etapa de fallo + server detenido -> reports/run-<ts>.{json,md}
  report-email.ts  aviso por correo del resumen a administradores (opcional, ver abajo)
  flow.ts       flujo de 1 usuario con BrowserContext aislado + Barrier
tests/
  smoke.spec.ts         1 usuario (verificación previa)
  concurrencia.spec.ts  N usuarios: barrera + Promise.all -> login+spawn SIMULTÁNEOS
  persistence.spec.ts   1 usuario: archivo en el home sobrevive a un stop/start real,
                         mismo dueño/permisos (requiere DEMO_PROFILE persistente)
  isolation.spec.ts     Fase 10.4: allowlist rechaza login fuera de lista +
                         una cuenta no entra al server de otra por URL directa
  resource-governance.spec.ts  Fase 10.5: OOM controlado (el pod cae y se
                         recupera sin perder datos) + disco lleno (error
                         limpio, no corrupción)
  kernels.spec.ts        Fase 10.6: kernels que la imagen realmente trae
                         (Python obligatorio, R/Scala si existen) + paquete
                         pip --user persiste entre reinicios
scripts/
  append-allowlist.sh    agrega demo-NN a files/allowlist.txt (sin imprimirlo)
  signup-demo-users.mjs  alta de demo-NN vía /hub/signup
  check-idle-culler.mjs  Fase 10.2: confirma en vivo el cull real (~40 min, ver abajo)
```

`tmp/capacity-probe/` (fuera de este árbol, fuera de git): sonda k6,
exploratoria, depende de k6 en vez de Node/Playwright — ver su propio README.

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
cada corrida.

**Causa raíz encontrada después (2026-09-06):** al construir `persistence.spec.ts`
(ver abajo), un trace en vivo mostró por qué el click nunca confirmaba: `goto('/hub/home',
{waitUntil: 'domcontentloaded'})` resuelve en cuanto el HTML se parsea, pero
`home.js`/jQuery (que enganchan el handler de click del botón) se piden sin
bloquear el parseo y pueden seguir cargando en ese instante — el click de
Playwright "funcionaba" sin error (el botón ya estaba visible/habilitado),
pero como el handler de jQuery todavía no estaba enganchado, no disparaba
nada: ni diálogo de confirmación ni el `DELETE .../server`. Reemplazar el
click por un `DELETE` directo trajo dos rondas más de bugs de XSRF, ambas
confirmadas en vivo con trace, antes de asentarse: mandar el header
`X-XSRFToken` calculado a mano desde `page.context().cookies()` fallaba con
403, primero siempre y después de forma intermitente, porque hay más de una
cookie `_xsrf` viva a la vez (una con `Path=/hub/`, otra con
`Path=/user/<u>/...` del OAuth interno del spawn) y la API de cookies de
Playwright no las resuelve con la misma precisión que el navegador. El fix
que finalmente funcionó: dejar que el propio navegador arme el pedido —
`page.evaluate()` ejecuta un `fetch()` nativo leyendo `document.cookie`
directamente, exactamente como lo hace `jhapi.js` (el JS real del Hub), así
que no hay ninguna cookie ambigua que Playwright tenga que adivinar.
`teardown.ts` (`stopServer`, antes `stopServerViaUI`) sigue sin invocarse
desde `flow.ts`/`concurrencia.spec.ts` — esa fue una decisión de producto
aparte (no gastar ~90s por usuario en cada corrida, pase o falle), no solo el
workaround de una función rota; `persistence.spec.ts` sí la necesita como
parte del propio flujo que prueba, y `sweepServersViaApi` sigue disponible
como utilidad manual adicional (requiere `ADMIN_TOKEN`).

**Etapa del fallo:** si un usuario falla, el reporte indica en qué etapa
(`login`, `spawn` o `exec`), no sólo el mensaje de error crudo — para
distinguir rápido un problema de NativeAuthenticator, de cuota/spawn, o del
kernel.

**Prueba de persistencia (`persistence.spec.ts`):** `hub-values.yaml.j2` no
declara ningún `securityContext`/`fsGroup`/`uid` explícito para los pods de
usuario — el comportamiento del volumen depende 100% de los defaults de la
imagen `all-spark-notebook` + Longhorn, y nunca se había confirmado en vivo
que reattachee con los mismos permisos tras un restart real (más aún si el
pod se reprograma en otro nodo). Esta prueba: loguea, escribe un archivo
marcador y captura `id`/`ls -la` en `~`, detiene el servidor con `stopServer`
(REST directo + confirmación real por polling, ver "Sin teardown automático"
arriba), vuelve a levantar el servidor, y compara el contenido, dueño y
grupo del mismo archivo — eso es lo que de verdad indica un volumen sano
(mismo UID/GID tras el reattach). El MODO de permisos se reporta pero no
hace fallar el test por sí solo: confirmado en vivo (2026-09-06), el modo
puede cambiar entre dos arranques del mismo pod (`644` -> `664`, dueño/grupo
idénticos) por el umask del propio arranque del contenedor — no hay ningún
`NB_UMASK`/`chmod` en ningún `.j2` de este repo, es comportamiento de la
imagen base `all-spark-notebook`, y como cada usuario tiene su propia PVC
(no hay aislamiento entre estudiantes basado en permisos de archivo en este
diseño), un bit de más para el grupo propio del usuario no expone nada. Lo
que sí hace fallar el test es que el archivo quede escribible por "otros"
(`world-writable`) tras el restart — esa sería una señal real, a diferencia
del bit de grupo. Requiere un perfil con almacenamiento persistente propio
(`DEMO_PROFILE`) — el de invitado no tiene volumen de usuario, así que ahí
la prueba no verificaría nada real y se salta sola.

**Idle-culler real (`scripts/check-idle-culler.mjs`, Fase 10.2):** confirma en
vivo que el `cull:` nativo del chart Z2JH (`hub-values.yaml.j2` —
`timeout: 1800` / `every: 600`, o sea 30 min de inactividad ± hasta 10 min de
margen del chequeo periódico) detiene de verdad un servidor inactivo, y que
el PVC del usuario **no** desaparece en el proceso. `cull.users: false` es
sobre no borrar al USUARIO de la base del Hub (NativeAuthenticator guarda
credenciales ahí) — no dice nada por sí solo sobre el PVC, así que nunca se
había confirmado en vivo. Es un script standalone fuera de Playwright (no
tiene sentido un navegador abierto ~40 min esperando): pega directo a la REST
API con `ADMIN_TOKEN` (mismo patrón que `tmp/capacity-probe/spawn-load.js`),
levanta el server de un usuario demo, y espera sin tocar la sesión hasta que
el Hub reporte `servers: {}` o se agote el margen. Al final imprime el
`kubectl get pvc -n jupyter claim-<usuario>` exacto para que confirmes vos
mismo que el PVC sigue ahí (el script no asume que corre donde hay `kubectl`
configurado).

```bash
npm run check:idle-culler                 # usa demo-01, ~35-45 min
CULL_TEST_USER=demo-02 npm run check:idle-culler
```

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
`tmp/capacity-probe/` (fuera del ecosistema npm de esta suite, y fuera de
este árbol).

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
