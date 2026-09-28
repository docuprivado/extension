/*
 * Arranque del hilo del lector de escaneados (lo usa server/core/lector.js como
 * «workerPath» de tesseract.js). Antes de cargar el lector desvía a la salida de errores
 * todo lo que el hilo pudiera escribir por la salida estándar: en un servidor MCP la
 * salida estándar es solo para el protocolo (CLAUDE.md §4.7), y la de un hilo va a parar
 * a la del proceso. Los avisos normales del lector («Estimating resolution…») se callan.
 */
"use strict";

const NORMALES = /^(Estimating resolution as|Detected \d+ diacritics|Warning: Invalid resolution|Empty page!!)/;
const errores = console.error.bind(console);
const aErrores = (...partes) => {
  if (NORMALES.test(partes.map(String).join(" ").trim())) return;
  errores(...partes);
};
console.log = aErrores;
console.info = aErrores;
console.debug = aErrores;
console.warn = aErrores;
console.error = aErrores;
process.stdout.write = (trozo, ...resto) => process.stderr.write(trozo, ...resto);

// Si el entorno no tiene «fetch», el lector cargaría «node-fetch», que no viaja en el
// paquete: se pone uno que siempre falla (la extensión nunca descarga nada).
if (typeof globalThis.fetch !== "function") globalThis.fetch = () => Promise.reject(new Error("docuprivado no se conecta a internet"));

require("tesseract.js/src/worker-script/node/index.js");
