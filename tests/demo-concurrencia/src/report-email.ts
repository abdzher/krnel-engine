// =============================================================================
// KRNEL — tests/demo-concurrencia/src/report-email.ts
// Aviso por correo del resumen de una corrida (smoke o concurrencia) a los
// administradores. Opt-in (REPORT_SMTP_* en .env) y best-effort: si falla el
// envío o no está configurado, nunca rompe la corrida — mismo criterio que
// sweepServersViaApi (src/teardown.ts).
// =============================================================================
import { createTransport } from 'nodemailer';
import type { DemoConfig } from './env';
import type { RunMetrics } from './metrics';

/** Arma asunto + cuerpo a partir del resumen ya calculado y lo envía por SMTP. */
export async function sendRunReportEmail(
  config: DemoConfig,
  metrics: RunMetrics,
  reportMarkdown: string,
): Promise<void> {
  const cfg = config.reportEmail;
  if (!cfg) return; // no configurado: silencioso, es opt-in

  const summary = metrics.summary();
  const status = summary.failed === 0 ? 'OK' : `${summary.failed} fallo(s)`;
  const subject =
    `[MRKOV demo-concurrencia] ${summary.passed}/${summary.users} OK` +
    // Sin teardown automático (ver flow.ts): recordar en el asunto cuántos
    // servidores quedaron levantados y hay que detener a mano.
    (summary.spawned ? ` · ${summary.spawned} servidor(es) levantado(s) — detener a mano` : '') +
    ` — ${status} — ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`;

  try {
    const transport = createTransport({
      host: cfg.host,
      port: cfg.port,
      secure: cfg.secure,
      auth: { user: cfg.user, pass: cfg.password },
    });
    await transport.sendMail({
      from: cfg.from,
      to: cfg.to,
      subject,
      text: reportMarkdown,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      `[report-email] No se pudo enviar el aviso por correo (${(err as Error).message}). ` +
        'La corrida y los reportes en reports/ no se ven afectados.',
    );
  }
}
