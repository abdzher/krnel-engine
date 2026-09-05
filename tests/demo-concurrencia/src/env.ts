// =============================================================================
// KRNEL — tests/demo-concurrencia/src/env.ts
// Parseo y validación de la configuración por variables de entorno.
// Todo lo parametrizable de la demo vive aquí: nada de valores hardcodeados en
// los tests (el número de usuarios simultáneos sobre todo — el techo real de la
// cuota todavía no está confirmado en el clúster).
// =============================================================================
import 'dotenv/config';

/** Un usuario simulado de la demo. */
export interface DemoUser {
  /** Índice 1-based. */
  index: number;
  /** Username tal cual se usa en login y en files/allowlist.txt. */
  username: string;
  /** Contraseña compartida (viene de DEMO_PASSWORD). */
  password: string;
}

/** Config SMTP para el aviso por correo del resumen de cada corrida. Opt-in. */
export interface ReportEmailConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  password: string;
  from: string;
  to: string[];
}

export interface DemoConfig {
  hubUrl: string;
  users: DemoUser[];
  userCount: number;
  profile: string | null;
  loginTimeoutMs: number;
  spawnTimeoutMs: number;
  execTimeoutMs: number;
  slowMoMs: number;
  adminToken: string | null;
  reportEmail: ReportEmailConfig | null;
}

function required(name: string): string {
  const v = process.env[name];
  if (!v || !v.trim()) {
    throw new Error(
      `Falta la variable de entorno ${name}. Copia .env.example a .env y complétala.`,
    );
  }
  return v.trim();
}

function optionalInt(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v.trim() === '') return fallback;
  const n = Number.parseInt(v, 10);
  if (Number.isNaN(n) || n <= 0) {
    throw new Error(`La variable ${name} debe ser un entero positivo (recibí "${v}").`);
  }
  return n;
}

/** Expande DEMO_USERNAME_TEMPLATE para el índice dado (relleno de ceros a 2). */
export function usernameFor(index: number): string {
  const template = process.env.DEMO_USERNAME_TEMPLATE?.trim() || 'demo-{n}';
  return template.replace('{n}', String(index).padStart(2, '0'));
}

/** null si falta cualquier variable requerida — el aviso por correo es opt-in. */
function loadReportEmailConfig(): ReportEmailConfig | null {
  const host = process.env.REPORT_SMTP_HOST?.trim();
  const user = process.env.REPORT_SMTP_USER?.trim();
  const password = process.env.REPORT_SMTP_PASSWORD?.trim();
  const from = process.env.REPORT_EMAIL_FROM?.trim();
  const to = (process.env.REPORT_EMAIL_TO ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  if (!host || !user || !password || !from || to.length === 0) return null;

  return {
    host,
    port: optionalInt('REPORT_SMTP_PORT', 587),
    secure: /^true$/i.test(process.env.REPORT_SMTP_SECURE?.trim() ?? 'false'),
    user,
    password,
    from,
    to,
  };
}

let cached: DemoConfig | null = null;

export function loadConfig(): DemoConfig {
  if (cached) return cached;

  const hubUrl = required('HUB_URL').replace(/\/+$/, '');
  const password = required('DEMO_PASSWORD');
  if (password.length < 8) {
    throw new Error('DEMO_PASSWORD debe tener al menos 8 caracteres (NativeAuthenticator).');
  }

  const userCount = optionalInt('DEMO_USER_COUNT', 3);
  const users: DemoUser[] = Array.from({ length: userCount }, (_, i) => {
    const index = i + 1;
    return { index, username: usernameFor(index), password };
  });

  cached = {
    hubUrl,
    users,
    userCount,
    profile: process.env.DEMO_PROFILE?.trim() || null,
    loginTimeoutMs: optionalInt('LOGIN_TIMEOUT_MS', 30_000),
    spawnTimeoutMs: optionalInt('SPAWN_TIMEOUT_MS', 300_000),
    execTimeoutMs: optionalInt('EXEC_TIMEOUT_MS', 60_000),
    slowMoMs: optionalInt('DEMO_SLOWMO_MS', 150),
    adminToken: process.env.ADMIN_TOKEN?.trim() || null,
    reportEmail: loadReportEmailConfig(),
  };
  return cached;
}
