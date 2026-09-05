// =============================================================================
// KRNEL — tests/demo-concurrencia/src/notebook.ts
// Crear un notebook nuevo, ejecutar UNA celda con resultado determinista
// (`2 + 2`) y leer el output REAL del DOM. Esto es lo que demuestra que el
// kernel corre de verdad — no que la UI simplemente renderizó.
// =============================================================================
import { expect, type Page } from '@playwright/test';

const CELL_CODE = '2 + 2';
const EXPECTED = '4';

/**
 * Abre un notebook Python 3 desde el Launcher, espera kernel idle, ejecuta
 * `2 + 2` y verifica que el output sea exactamente `4`.
 * Devuelve el texto del output para registrarlo en las métricas.
 */
export async function runDeterministicCell(page: Page, timeoutMs: number): Promise<string> {
  // --- abrir notebook nuevo ------------------------------------------------
  // JupyterLab dispara un aviso ("official Jupyter news") en el primer load
  // de cada sesión (plugin apputils-extension:announcements — confirmado en
  // vivo con un trace: el endpoint jupyterlabapputilsextensionannouncements
  // se pide siempre). Puede robar foco y bloquear atajos globales como
  // Ctrl+Shift+L. Lo cerramos si aparece, antes de tocar nada más.
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
  const pythonCard = page
    .locator(
      '.jp-LauncherCard[title*="Python 3" i]:visible, .jp-LauncherCard:visible:has-text("Python 3")',
    )
    .first();
  await pythonCard.waitFor({ state: 'visible', timeout: timeoutMs });

  // Sin teardown automático (a pedido, ver flow.ts), un servidor reusado
  // puede traer kernels VIEJOS de corridas anteriores, ya en idle. Hay que
  // saber cuáles existían ANTES de crear este notebook para no confundir un
  // kernel huérfano ajeno con el propio — ver el comentario de
  // `waitForKernelIdle` más abajo, confirmado en vivo con trace.
  const baselineKernelIds = await listKernelIds(page);

  await pythonCard.click();

  // Panel del notebook montado.
  const panel = page.locator('.jp-NotebookPanel').first();
  await panel.waitFor({ state: 'visible', timeout: timeoutMs });

  // --- esperar kernel listo (idle), por estado ---------------------------
  await waitForKernelIdle(page, timeoutMs, baselineKernelIds);

  // --- escribir y ejecutar la celda -------------------------------------
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
  const firstCell = panel.locator('.jp-Cell').first();
  const cmContent = firstCell.locator('.cm-content');
  const editorTarget = (await cmContent.count()) ? cmContent.first() : firstCell.locator('.jp-InputArea-editor').first();
  await editorTarget.click();
  await page.keyboard.type(CELL_CODE);
  await page.keyboard.press('Shift+Enter');

  // --- leer el output real ---------------------------------------------
  const output = firstCell.locator('.jp-OutputArea-output').first();
  await output.waitFor({ state: 'visible', timeout: timeoutMs });

  await expect(output).toHaveText(new RegExp(`\\b${EXPECTED}\\b`), { timeout: timeoutMs });
  const text = (await output.innerText()).trim();

  if (!new RegExp(`\\b${EXPECTED}\\b`).test(text)) {
    throw new Error(`El output de \`${CELL_CODE}\` fue "${text}", esperaba "${EXPECTED}".`);
  }
  return text;
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

function kernelsApiBase(page: Page): string | undefined {
  return /^(https?:\/\/[^/]+\/user\/[^/]+)\//.exec(page.url())?.[1];
}

/** IDs de los kernels que YA existen en el server del usuario. `null` si la API falló. */
async function listKernelIds(page: Page): Promise<Set<string> | null> {
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
