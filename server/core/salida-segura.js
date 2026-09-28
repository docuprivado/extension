/*
 * Se importa lo primero de todo (server/index.js). En un servidor MCP local la salida
 * estándar es solo para el protocolo: cualquier console.log de una librería rompería la
 * comunicación con Claude (CLAUDE.md §4.7). Todo lo que se escriba con console va a la
 * salida de errores, que Claude Desktop guarda en su registro.
 */
// Avisos de pdf.js que son normales aquí (no dibuja: lo hace PDFium) y solo ensuciarían el
// registro, además de llevar la ruta de instalación.
const AVISOS_NORMALES = /Cannot load "@napi-rs\/canvas"|Cannot polyfill `(DOMMatrix|Path2D|ImageData)`|^Require stack:|^- [A-Z]:\\|^- \//;
const aErrores = (...partes) => {
  const texto = partes.map(String).join(" ");
  if (AVISOS_NORMALES.test(texto.replace(/^Warning: /, ""))) return;
  console.error(...partes);
};
console.log = aErrores;
console.info = aErrores;
console.debug = aErrores;
console.trace = aErrores;
console.warn = aErrores;   // ya iba a la salida de errores; así también se filtran los avisos normales
