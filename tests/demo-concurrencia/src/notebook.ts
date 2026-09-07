// =============================================================================
// KRNEL — tests/demo-concurrencia/src/notebook.ts
// Crear un notebook nuevo y ejecutar código en su primera celda, leyendo el
// output REAL del DOM. Esto es lo que demuestra que el kernel corre de verdad
// — no que la UI simplemente renderizó.
//
// Entradas públicas:
//   - runDeterministicCell: `2 + 2`, valor esperado fijo (smoke/concurrencia).
//   - runCellCode: código arbitrario, ESPERA el output — para specs que
//     necesitan correr comandos de sistema (`!id`, `!ls -la`, etc.), como
//     persistence.spec.ts (Fase 10.1).
//   - openFreshNotebook / submitCell / kernelsApiBase / listKernelIds:
//     primitivas de más bajo nivel, para specs que necesitan ejecutar código
//     que deliberadamente NUNCA va a devolver un output normal (ej. una
//     celda que agota la RAM a propósito y mata el kernel/pod antes de que
//     llegue a imprimir nada — `resource-governance.spec.ts`, Fase 10.5).
// Todas comparten la misma apertura de notebook + espera de kernel, con todo
// el historial de bugs ya resuelto documentado en `openFreshNotebook` y
// `submitCell` — no duplicarlo si se agrega un cuarto caso.
// =============================================================================
import { expect, type Locator, type Page } from '@playwright/test';

const CELL_CODE = '2 + 2';
const EXPECTED = '4';

/**
 * Abre un notebook Python 3 desde el Launcher, espera kernel idle, ejecuta
 * `2 + 2` y verifica que el output sea exactamente `4`.
 * Devuelve el texto del output para registrarlo en las métricas.
 */
export async function runDeterministicCell(page: Page, timeoutMs: number): Promise<string> {
  const firstCell = await openFreshNotebook(page, timeoutMs);
  await submitCell(page, firstCell, CELL_CODE);
  const text = await readOutput(firstCell, timeoutMs);

  const expected = new RegExp(`\\b${EXPECTED}\\b`);
  await expect(firstCell.locator('.jp-OutputArea-output').first()).toHaveText(expected, {
    timeout: timeoutMs,
  });
  if (!expected.test(text)) {
    throw new Error(`El output de \`${CELL_CODE}\` fue "${text}", esperaba "${EXPECTED}".`);
  }
  return text;
}

/**
 * Igual que `runDeterministicCell` pero con código arbitrario y sin asumir un
 * resultado esperado — para verificaciones que necesitan correr comandos de
 * sistema (`!id`, `!ls -la ~`, etc.), no solo el `2 + 2` determinista.
 * Devuelve el texto crudo del área de salida de la primera celda.
 */
export async function runCellCode(page: Page, code: string, timeoutMs: number): Promise<string> {
  const firstCell = await openFreshNotebook(page, timeoutMs);
  await submitCell(page, firstCell, code);
  return readOutput(firstCell, timeoutMs);
}

/**
 * Cierra el aviso de "official Jupyter news" si aparece. El diálogo llega
 * tras un fetch async (jupyterlabapputilsextensionannouncements), así que
 * `isVisible()` sin esperar no sirve — Playwright lo ignora deliberadamente,
 * devuelve al toque (ver docs de `locator.isVisible`). Hay que esperar de
 * verdad, con un timeout corto porque la mayoría de las corridas no lo ven.
 * Nunca lanza.
 */
async function dismissAnnouncements(page: Page): Promise<void> {
  const dismiss = page.getByRole('button', { name: /^No$/i }).first();
  const appeared = await dismiss
    .waitFor({ state: 'visible', timeout: 3_000 })
    .then(() => true)
    .catch(() => false);
  if (appeared) {
    await dismiss.click().catch(() => {});
  }
}

/**
 * Abre un notebook nuevo y espera a que su kernel esté REALMENTE listo
 * (`idle`, vía REST API — ver `waitForKernelIdle`). Devuelve el locator de la
 * primera celda, lista para tipear. Exportada para specs que necesitan
 * componer su propia secuencia de tipear/ejecutar/leer en vez de usar
 * `runCellCode` (ver `submitCell`/`readOutput` más abajo).
 *
 * `kernelTitle` elige QUÉ card del Launcher clickear — por defecto "Python 3"
 * (el único kernel que el resto de la suite necesita), pero
 * `tests/kernels.spec.ts` (Fase 10.6) la usa con el `display_name` real de
 * otros kernelspecs (R, Scala) obtenido de `listKernelSpecs`, para no
 * hardcodear un título adivinado que podría no existir en esta imagen.
 *
 * **Contrato importante, confirmado en vivo (2026-09-06) en dos specs
 * distintos con la misma causa raíz:** nunca llames a esta función una
 * SEGUNDA vez sobre una sesión ya viva (misma `page`, mismo `?reset`) sin
 * antes recargar con `page.goto(`${kernelsApiBase(page)}/lab?reset`, ...)`.
 * Abrir una segunda notebook desde el Launcher mientras otra ya está abierta
 * en la misma sesión deja su panel con la clase `lm-mod-hidden` de Lumino —
 * Playwright nunca lo ve "visible" y `openFreshNotebook` cuelga hasta el
 * timeout (visto en `resource-governance.spec.ts` y en `kernels.spec.ts`,
 * mismo síntoma exacto en ambos). Si un test necesita correr más de un
 * snippet de código en la misma notebook/kernel, reusá la MISMA celda con
 * varios `submitCell` seguidos en vez de abrir otra notebook. Si de verdad
 * necesita un kernel distinto (otro lenguaje), reseteá el workspace primero.
 */
export async function openFreshNotebook(
  page: Page,
  timeoutMs: number,
  kernelTitle = 'Python 3',
): Promise<Locator> {
  // --- abrir notebook nuevo ------------------------------------------------
  await dismissAnnouncements(page);

  // `ensureServerRunning` (spawn.ts) ya navega con `?reset`, así que un
  // workspace vacío debería mostrar un Launcher por defecto. Forzar uno
  // nuevo INCONDICIONALMENTE (como hacíamos antes) crea un SEGUNDO Launcher
  // encima — confirmado en vivo con captura: dos pestañas "Launcher", y el
  // selector de abajo (`.first()` sin filtrar visibilidad) resolvía a la
  // card del primero, que quedaba oculto (`lm-mod-hidden`) detrás del
  // segundo. Por eso: solo abrimos uno nuevo si ninguno quedó visible tras
  // el reset (esperando de verdad, no con `isVisible()` instantáneo).
  const launcherAlreadyVisible = await page
    .locator('.jp-Launcher')
    .first()
    .waitFor({ state: 'visible', timeout: 5_000 })
    .then(() => true)
    .catch(() => false);

  if (!launcherAlreadyVisible) {
    const newLauncherBtn = page
      .getByTitle(/new launcher/i)
      .or(page.getByRole('button', { name: /new launcher/i }));
    if (await newLauncherBtn.count()) {
      await newLauncherBtn.first().click();
    } else {
      await page.keyboard.press('Control+Shift+L').catch(() => {});
    }
  }

  // `:visible` como red de seguridad adicional: si por lo que sea llegara a
  // haber más de un Launcher (visible u oculto) compitiendo, nunca hay que
  // resolver a una card oculta solo por venir primero en el DOM.
  const kernelCard = page
    .locator(
      `.jp-LauncherCard[title*="${kernelTitle}" i]:visible, .jp-LauncherCard:visible:has-text("${kernelTitle}")`,
    )
    .first();
  await kernelCard.waitFor({ state: 'visible', timeout: timeoutMs });

  // Sin teardown automático (a pedido, ver flow.ts), un servidor reusado
  // puede traer kernels VIEJOS de corridas anteriores, ya en idle. Hay que
  // saber cuáles existían ANTES de crear este notebook para no confundir un
  // kernel huérfano ajeno con el propio — ver el comentario de
  // `waitForKernelIdle` más abajo, confirmado en vivo con trace.
  const baselineKernelIds = await listKernelIds(page);

  await kernelCard.click();

  // Panel del notebook montado.
  const panel = page.locator('.jp-NotebookPanel').first();
  await panel.waitFor({ state: 'visible', timeout: timeoutMs });

  // --- esperar kernel listo (idle), por estado ---------------------------
  await waitForKernelIdle(page, timeoutMs, baselineKernelIds);

  return panel.locator('.jp-Cell').first();
}

/**
 * Tipea `code` en `firstCell` y lo ejecuta (Shift+Enter) — NO espera ningún
 * output. Separada de `readOutput` para specs que ejecutan código que
 * deliberadamente puede no devolver nada nunca (ej. una celda que agota la
 * RAM del pod a propósito y lo mata antes de imprimir — `resource-
 * governance.spec.ts`, Fase 10.5): esas specs necesitan seguir con SU PROPIA
 * espera (ej. polling de `/api/kernels`), no colgarse acá hasta el timeout.
 */
export async function submitCell(page: Page, firstCell: Locator, code: string): Promise<void> {
  // `.jp-InputArea-editor` es solo el wrapper del editor; clickearlo NO
  // garantiza foco en el nodo realmente editable de CodeMirror 6
  // (`.cm-content`, contenteditable). Confirmado en vivo con un trace: el
  // click "funcionaba" sin error, pero el texto nunca llegaba al editor y la
  // celda se ejecutaba vacía (`jp-mod-noOutputs`), así que el output nunca
  // aparecía y el test colgaba hasta el timeout.
  //
  // El primer intento de arreglar esto usó `.locator('.cm-content,
  // .jp-InputArea-editor').first()` — pero un selector CSS con coma resuelve
  // en ORDEN DEL DOM, no por prioridad de alternativa, y `.jp-InputArea-editor`
  // es ANCESTRO de `.cm-content` (lo contiene), así que siempre aparece antes
  // en el árbol. `.first()` seguía devolviendo el wrapper de siempre —
  // confirmado en un segundo trace en vivo: mismo click "exitoso", mismo
  // `jp-mod-noOutputs` persistente, mismo cuelgue. Por eso acá se pide
  // `.cm-content` explícitamente y solo se cae al wrapper si de verdad no
  // existe (versión de JupyterLab distinta, etc.), nunca por orden del DOM.
  const cmContent = firstCell.locator('.cm-content');
  const editorTarget = (await cmContent.count())
    ? cmContent.first()
    : firstCell.locator('.jp-InputArea-editor').first();
  await editorTarget.click();

  // Si la celda ya tiene contenido de una ejecución anterior (se reusa la
  // misma celda para más de un snippet en la misma notebook — ver el
  // contrato de `openFreshNotebook` sobre no abrir una segunda notebook en
  // vivo), hay que limpiarla antes de insertar el código nuevo. No-op
  // inofensivo en una celda recién creada y vacía.
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Delete');

  // `insertText`, no `type`: confirmado en vivo (2026-09-06, disco lleno de
  // Fase 10.5) que `type()` simula tecla por tecla, y CodeMirror 6 autoindenta
  // solo al ver un `:` seguido de Enter — esa autoindentación se SUMA a los
  // espacios ya presentes en código multilínea con control de flujo
  // (`while`/`with`/`try`), produciendo `IndentationError: unindent does not
  // match any outer indentation level`. Nunca había aparecido antes porque
  // ningún otro spec tipeaba código con `:` (todo era `2 + 2` o comandos
  // `!shell` de una sola línea). `insertText` inserta el texto tal cual vía
  // un evento `input`, sin pasar por los handlers de `keydown` que disparan
  // el autoindentado — fix estándar para este problema con editores basados
  // en CodeMirror/Monaco.
  await page.keyboard.insertText(code);
  await page.keyboard.press('Shift+Enter');
}

/**
 * Espera el output real de `firstCell` y devuelve su texto — de TODOS los
 * bloques de salida, no solo el primero. Confirmado en vivo (2026-09-06,
 * `pip install --user` de Fase 10.6): cuando un comando escribe a stdout Y
 * stderr (ej. pip imprime una advertencia por stderr aunque todo salga bien),
 * JupyterLab renderiza cada stream como un `.jp-OutputArea-output` SEPARADO
 * — quedarse con `.first()` podía devolver solo la advertencia y nunca el
 * resultado real. Concatenar todos es un no-op para el caso común de un solo
 * bloque de stdout (la mayoría de la suite).
 *
 * Segundo bug confirmado en vivo (2026-09-06, disco lleno de Fase 10.5): los
 * bloques no siempre aparecen todos a la vez — un warning async (ej. "history
 * saving thread" de IPython, que se dispara aparte de la ejecución en sí)
 * puede renderizar ANTES que el resultado real del comando. Leer apenas el
 * primer bloque es "visible" puede cortar la carrera antes de que el segundo
 * exista todavía. Por eso se espera a que la CANTIDAD de bloques se
 * estabilice (dos lecturas seguidas iguales) antes de leerlos — acotado a
 * pocos segundos, no al timeout completo, porque es solo para absorber esa
 * carrera puntual, no una espera real de ejecución.
 */
export async function readOutput(firstCell: Locator, timeoutMs: number): Promise<string> {
  const outputs = firstCell.locator('.jp-OutputArea-output');
  await outputs.first().waitFor({ state: 'visible', timeout: timeoutMs });

  let previousCount = -1;
  let currentCount = await outputs.count();
  const stabilizeDeadline = Date.now() + Math.min(timeoutMs, 5_000);
  while (currentCount !== previousCount && Date.now() < stabilizeDeadline) {
    previousCount = currentCount;
    await new Promise((resolve) => setTimeout(resolve, 400));
    currentCount = await outputs.count();
  }

  const parts: string[] = [];
  for (let i = 0; i < currentCount; i += 1) {
    parts.push((await outputs.nth(i).innerText()).trim());
  }
  return parts.join('\n').trim();
}

/** Un kernelspec real, tal como lo reporta `/api/kernelspecs` del server. */
export interface KernelSpecInfo {
  /** Nombre interno (ej. `python3`, `ir`). */
  name: string;
  /** Lo que muestra la card del Launcher — usar esto con `openFreshNotebook`. */
  displayName: string;
  language: string;
}

/**
 * Lista los kernelspecs que la imagen REALMENTE trae instalados, vía
 * `GET /api/kernelspecs` — para `tests/kernels.spec.ts` (Fase 10.6), que no
 * debe asumir de antemano cuáles de Python/R/Scala están presentes (eso es
 * justo lo que hay que confirmar, no adivinar). `[]` si la API falla.
 */
export async function listKernelSpecs(page: Page): Promise<KernelSpecInfo[]> {
  const base = kernelsApiBase(page);
  if (!base) return [];
  try {
    const res = await page.request.get(`${base}/api/kernelspecs`);
    if (!res.ok()) return [];
    const body = (await res.json()) as {
      kernelspecs?: Record<string, { name: string; spec: { display_name: string; language: string } }>;
    };
    return Object.values(body.kernelspecs ?? {}).map((k) => ({
      name: k.name,
      displayName: k.spec.display_name,
      language: k.spec.language,
    }));
  } catch {
    return [];
  }
}

export function kernelsApiBase(page: Page): string | undefined {
  return /^(https?:\/\/[^/]+\/user\/[^/]+)\//.exec(page.url())?.[1];
}

/** IDs de los kernels que YA existen en el server del usuario. `null` si la API falló. */
export async function listKernelIds(page: Page): Promise<Set<string> | null> {
  const base = kernelsApiBase(page);
  if (!base) return null;
  try {
    const res = await page.request.get(`${base}/api/kernels`);
    if (!res.ok()) return null;
    const kernels = (await res.json()) as Array<{ id?: string }>;
    return new Set(kernels.map((k) => k.id).filter((id): id is string => !!id));
  } catch {
    return null;
  }
}

/**
 * Confirma que existe un kernel REAL, NUEVO (no uno huérfano de una corrida
 * anterior) y en idle, vía la REST API del server del usuario (mismo origen,
 * cookies de sesión del propio `page` — no necesita token).
 *
 * Se abandonó el indicador del DOM (`.jp-Notebook-ExecutionIndicator`,
 * `data-status`) tras dos intentos fallidos, ambos confirmados en vivo con
 * trace:
 *   1. `data-status="idle"` resultó ser también el valor por defecto ANTES
 *      de que exista kernel — falso positivo, tipeábamos y corríamos la
 *      celda antes de que el kernel arrancara.
 *   2. El intento de arreglarlo exigiendo `title` no vacío como señal de
 *      "ya reportó estado real" falló distinto: el log de reintentos mostró
 *      la secuencia real `idle → initializing → connecting → idle` (o sea
 *      SÍ hay una transición real detrás de data-status), pero `title`
 *      quedó vacío en las 116 lecturas de "idle" real posteriores — este
 *      build de JupyterLab simplemente nunca puebla ese atributo. Exigirlo
 *      colgaba el test 60s siempre, incluso con el kernel ya listo.
 * Pasar a `GET /user/<u>/api/kernels` arregló smoke.spec.ts, pero en
 * concurrencia.spec.ts (sin teardown automático — a pedido) apareció un
 * TERCER falso positivo, confirmado en vivo con trace: un servidor reusado
 * puede traer un kernel VIEJO de una corrida anterior, ya idle desde antes.
 * "¿hay algún kernel idle?" decía que sí usando ESE kernel huérfano, ~100ms
 * ANTES de que el `POST /api/sessions` del notebook nuevo siquiera saliera
 * — tipeábamos otra vez antes de que el kernel correcto existiera. Por eso
 * ahora se exige que el kernel idle sea uno que NO estuviera en
 * `baselineIds` (capturado antes de crear el notebook).
 */
async function waitForKernelIdle(
  page: Page,
  timeoutMs: number,
  baselineIds: Set<string> | null,
): Promise<void> {
  const base = kernelsApiBase(page);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (base) {
      try {
        const res = await page.request.get(`${base}/api/kernels`);
        if (res.ok()) {
          const kernels = (await res.json()) as Array<{ id?: string; execution_state?: string }>;
          const isNew = (k: { id?: string }) => !baselineIds || !k.id || !baselineIds.has(k.id);
          if (kernels.some((k) => isNew(k) && k.execution_state === 'idle')) return;
        }
      } catch {
        /* reintenta hasta el deadline */
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Ningún kernel NUEVO llegó a "idle" real (vía /api/kernels) en ${timeoutMs}ms.`);
}
