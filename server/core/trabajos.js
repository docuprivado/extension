/*
 * Trabajos largos (docs/PROMPT_EXTENSION.md §4.4 y docs/DECISIONES.md, hito 1).
 *
 * Claude Desktop deja de esperar a una herramienta a los 60 s y no avisa a la extensión.
 * Por eso cada llamada trabaja como mucho PRESUPUESTO_MS y devuelve lo hecho y la lista
 * de pendientes. Un archivo que ya ha empezado no se corta a medias: sigue en segundo
 * plano (el servidor sigue vivo entre llamadas) y su resultado se entrega en la llamada
 * siguiente, sin repetir el trabajo ni crear copias duplicadas.
 */
// 40 s; las pruebas pueden acortarlo con DOCUPRIVADO_PRESUPUESTO_MS para ver el «continúa».
export const PRESUPUESTO_MS = Number(process.env.DOCUPRIVADO_PRESUPUESTO_MS) > 0 ? Number(process.env.DOCUPRIVADO_PRESUPUESTO_MS) : 40000;
const OLVIDAR_MS = 30 * 60 * 1000;      // resultados sin recoger: se olvidan a la media hora

const trabajos = new Map();

// Empieza un trabajo con esa clave o devuelve el que ya estaba en marcha o terminado.
export function lanzar(clave, fn) {
  limpiar();
  let t = trabajos.get(clave);
  if (!t) {
    t = { estado: "en curso", inicio: Date.now() };
    t.promesa = Promise.resolve().then(fn).then(
      (r) => { t.estado = "hecho"; t.resultado = r; t.fin = Date.now(); },
      (e) => { t.estado = "error"; t.error = e; t.fin = Date.now(); },
    );
    trabajos.set(clave, t);
  }
  return t;
}

// Espera a que termine, como mucho «ms». Devuelve el trabajo (mira t.estado).
export async function esperar(t, ms) {
  if (t.estado !== "en curso" || ms <= 0) return t;
  let temporizador;
  await Promise.race([t.promesa, new Promise((ok) => { temporizador = setTimeout(ok, ms); })]);
  clearTimeout(temporizador);
  return t;
}

// Un trabajo terminado se entrega una sola vez.
export function recoger(clave) {
  const t = trabajos.get(clave);
  if (t && t.estado !== "en curso") trabajos.delete(clave);
  return t;
}

function limpiar() {
  const ahora = Date.now();
  for (const [k, t] of trabajos) if (t.estado !== "en curso" && ahora - t.fin > OLVIDAR_MS) trabajos.delete(k);
}

/** Reloj de una llamada: cuánto queda del presupuesto. */
export function reloj(presupuesto = PRESUPUESTO_MS) {
  const inicio = Date.now();
  return { queda: () => presupuesto - (Date.now() - inicio), transcurrido: () => Date.now() - inicio };
}
