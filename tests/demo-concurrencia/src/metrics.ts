// =============================================================================
// KRNEL — tests/demo-concurrencia/src/metrics.ts
// Métricas por usuario de cada corrida: tiempo de login, tiempo de spawn (hasta
// Lab listo), éxito/fallo de la celda. Es la evidencia para la demo y para
// validar si la cuota de la Fase 3 alcanza para N sesiones.
// =============================================================================
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPORTS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'reports');

export type FlowStage = 'login' | 'spawn' | 'exec';

export interface UserMetric {
  username: string;
  loginMs: number | null;
  spawnMs: number | null;
  execMs: number | null;
  cellOutput: string | null;
  ok: boolean;
  error: string | null;
  /** En qué etapa ocurrió el fallo (null si ok, o si falló antes de la primera etapa). */
  stage: FlowStage | null;
}

export class RunMetrics {
  readonly startedAt = new Date();
  private rows = new Map<string, UserMetric>();

  init(username: string): void {
    this.rows.set(username, {
      username,
      loginMs: null,
      spawnMs: null,
      execMs: null,
      cellOutput: null,
      ok: false,
      error: null,
      stage: null,
    });
  }

  set(username: string, patch: Partial<UserMetric>): void {
    const row = this.rows.get(username) ?? {
      username, loginMs: null, spawnMs: null, execMs: null,
      cellOutput: null, ok: false, error: null, stage: null,
    };
    this.rows.set(username, { ...row, ...patch });
  }

  all(): UserMetric[] {
    return [...this.rows.values()].sort((a, b) => a.username.localeCompare(b.username));
  }

  /** Resumen agregado de la corrida. Público: lo reusa report-email.ts para el asunto/cuerpo. */
  summary() {
    const rows = this.all();
    const ok = rows.filter((r) => r.ok);
    const nums = (xs: (number | null)[]) => xs.filter((x): x is number => x != null);
    const avg = (xs: number[]) => (xs.length ? Math.round(xs.reduce((a, c) => a + c, 0) / xs.length) : null);
    const max = (xs: number[]) => (xs.length ? Math.max(...xs) : null);
    return {
      users: rows.length,
      passed: ok.length,
      failed: rows.length - ok.length,
      // Cuántos usuarios llegaron a levantar servidor (spawnMs != null): sin
      // teardown automático (ver flow.ts), TODOS estos quedan corriendo en el
      // clúster hasta que el operador los detenga a mano.
      spawned: rows.filter((r) => r.spawnMs != null).length,
      loginAvgMs: avg(nums(rows.map((r) => r.loginMs))),
      spawnAvgMs: avg(nums(rows.map((r) => r.spawnMs))),
      spawnMaxMs: max(nums(rows.map((r) => r.spawnMs))),
      execAvgMs: avg(nums(rows.map((r) => r.execMs))),
    };
  }

  /** Escribe reports/run-<timestamp>.{json,md} y lo imprime en consola. */
  flush(): { jsonPath: string; mdPath: string; md: string } {
    mkdirSync(REPORTS_DIR, { recursive: true });
    const stamp = this.startedAt.toISOString().replace(/[:.]/g, '-');
    const rows = this.all();
    const summary = this.summary();

    const jsonPath = join(REPORTS_DIR, `run-${stamp}.json`);
    writeFileSync(jsonPath, JSON.stringify({ startedAt: this.startedAt, summary, users: rows }, null, 2));

    const md = [
      `# Corrida de demo — ${this.startedAt.toISOString()}`,
      '',
      `- Usuarios: **${summary.users}**  ·  OK: **${summary.passed}**  ·  Fallo: **${summary.failed}**  ·  Servidores levantados (sin teardown automático — detener a mano): **${summary.spawned}**`,
      `- Login promedio: ${fmt(summary.loginAvgMs)}  ·  Spawn promedio: ${fmt(summary.spawnAvgMs)}  ·  Spawn máx: ${fmt(summary.spawnMaxMs)}  ·  Exec promedio: ${fmt(summary.execAvgMs)}`,
      '',
      '| Usuario | Login | Spawn (Lab listo) | Exec celda | Output | Resultado | Etapa fallida |',
      '| --- | ---: | ---: | ---: | :---: | :---: | :---: |',
      ...rows.map((r) =>
        `| ${r.username} | ${fmt(r.loginMs)} | ${fmt(r.spawnMs)} | ${fmt(r.execMs)} | ${r.cellOutput ?? '—'} | ${r.ok ? '✅' : `❌ ${r.error ?? ''}`} | ${r.ok ? '—' : r.stage ?? '?'} |`,
      ),
      '',
    ].join('\n');
    const mdPath = join(REPORTS_DIR, `run-${stamp}.md`);
    writeFileSync(mdPath, md);

    // eslint-disable-next-line no-console
    console.log('\n' + md);
    console.table(rows.map((r) => ({
      usuario: r.username,
      login_ms: r.loginMs,
      spawn_ms: r.spawnMs,
      exec_ms: r.execMs,
      output: r.cellOutput,
      ok: r.ok,
      etapa_fallida: r.ok ? '' : r.stage ?? '?',
    })));
    console.log(`\nReportes: ${jsonPath}\n          ${mdPath}\n`);

    return { jsonPath, mdPath, md };
  }
}

function fmt(ms: number | null): string {
  if (ms == null) return '—';
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${ms} ms`;
}
