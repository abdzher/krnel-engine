// =============================================================================
// KRNEL — tests/demo-concurrencia/src/flow.ts
// Flujo completo de UN usuario simulado, con su propio BrowserContext aislado
// (nunca se reutiliza contexto entre "usuarios" — eso filtraría sesión).
// Usado por smoke.spec.ts (1 usuario) y concurrencia.spec.ts (N en paralelo).
// =============================================================================
import type { Browser, BrowserContextOptions } from '@playwright/test';
import type { DemoConfig, DemoUser } from './env';
import { gotoLogin, submitLogin } from './login';
import { ensureServerRunning } from './spawn';
import { runDeterministicCell } from './notebook';
import type { FlowStage, RunMetrics } from './metrics';

/**
 * Barrera simple: todos los usuarios esperan un `arrive()` hasta que todos
 * llegaron, y salen juntos. Reusable como concepto pero de un solo uso por
 * instancia (una vez que se dispara, `pending` queda negativo y cualquier
 * `arrive()` posterior resuelve al toque sin sincronizar) — por eso
 * `runUserFlow` recibe una instancia distinta por punto de sincronización
 * (login, spawn), no la misma reutilizada dos veces.
 */
export class Barrier {
  private pending: number;
  private waiters: Array<() => void> = [];
  constructor(count: number, private readonly timeoutMs = 120_000) {
    this.pending = count;
  }
  async arrive(): Promise<void> {
    this.pending -= 1;
    if (this.pending <= 0) {
      this.waiters.forEach((w) => w());
      this.waiters = [];
      return;
    }
    // Si alguien nunca llega, no bloqueamos indefinidamente: seguimos igual.
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, this.timeoutMs);
      this.waiters.push(() => {
        clearTimeout(t);
        resolve();
      });
    });
  }
}

export interface FlowOptions {
  recordVideo: boolean;
  /** Sincroniza el envío de credenciales — todos loguean en el mismo instante. */
  loginBarrier?: Barrier;
  /**
   * Sincroniza el arranque del servidor — todos piden spawn en el mismo
   * instante. Es el punto real de interés de "concurrencia": sin esto, cada
   * usuario spawnea apenas termina SU login, que no está garantizado que
   * ocurra al mismo tiempo para todos (solo el envío del form lo está).
   */
  spawnBarrier?: Barrier;
}

/**
 * Ejecuta login -> spawn -> ejecutar celda -> teardown para un usuario.
 * Registra métricas en `metrics` y SIEMPRE intenta el teardown (finally).
 */
export async function runUserFlow(
  browser: Browser,
  user: DemoUser,
  config: DemoConfig,
  metrics: RunMetrics,
  opts: FlowOptions,
): Promise<void> {
  metrics.init(user.username);

  const ctxOpts: BrowserContextOptions = {
    ignoreHTTPSErrors: true,
    baseURL: config.hubUrl,
    viewport: { width: 1440, height: 900 },
  };
  if (opts.recordVideo) ctxOpts.recordVideo = { dir: 'test-results/videos', size: { width: 1440, height: 900 } };

  const context = await browser.newContext(ctxOpts);
  const page = await context.newPage();

  // Etapa en curso: si algo revienta en el catch, ya sabemos dónde fue sin
  // tener que parsear el mensaje de error.
  let stage: FlowStage = 'login';

  try {
    // -- LOGIN ----------------------------------------------------------
    // La barrera SIEMPRE se cumple (finally), aunque la carga de /hub/login
    // falle, para no dejar colgados al resto de los usuarios.
    try {
      await gotoLogin(page, config.loginTimeoutMs);
    } finally {
      if (opts.loginBarrier) await opts.loginBarrier.arrive(); // todos listos -> login simultáneo
    }

    let t0 = Date.now();
    await submitLogin(page, user, config.loginTimeoutMs);
    metrics.set(user.username, { loginMs: Date.now() - t0 });

    // Segunda barrera: sin esto, cada usuario spawnea apenas termina SU
    // propio login (que puede variar unos cientos de ms entre usuarios), no
    // en el mismo instante que el resto — que es justamente lo que este test
    // dice medir ("login + spawn AL MISMO TIEMPO").
    if (opts.spawnBarrier) await opts.spawnBarrier.arrive();

    // -- SPAWN --------------------------------------------------------
    stage = 'spawn';
    t0 = Date.now();
    await ensureServerRunning(page, { profile: config.profile, timeoutMs: config.spawnTimeoutMs });
    metrics.set(user.username, { spawnMs: Date.now() - t0 });

    // -- EJECUTAR CELDA --------------------------------------------
    stage = 'exec';
    t0 = Date.now();
    const output = await runDeterministicCell(page, config.execTimeoutMs);
    metrics.set(user.username, { execMs: Date.now() - t0, cellOutput: output, ok: true });
  } catch (err) {
    metrics.set(user.username, { error: (err as Error).message.split('\n')[0], ok: false, stage });
    throw err;
  } finally {
    // -- SIN teardown automático ------------------------------------
    // Se sacó a pedido: el polling de confirmación (`waitForServerStopped`,
    // hasta 90s) nunca llegó a confirmar un stop exitoso en ninguna corrida
    // en vivo y ese tiempo se perdía en cada usuario, pase o falle el test.
    // El operador detiene los servidores/pods a mano (`teardown.ts` sigue
    // disponible como utilidad manual si hace falta). Solo se cierra el
    // BrowserContext local, no el server remoto.
    await context.close().catch(() => {});
  }
}
