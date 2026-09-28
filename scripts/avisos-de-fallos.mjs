/*
 * Para las pruebas de GitHub (.github/workflows/pruebas.yml): cuando fallan, escribe el
 * motivo de cada prueba que falla como un aviso de la ejecución. El registro completo solo
 * se ve con la sesión iniciada en GitHub; los avisos, cualquiera, también sin sesión.
 * Lee la salida de «node --test» guardada en un archivo. Como mucho, 10 avisos (el límite
 * de GitHub por paso), cada uno con las primeras líneas del error, sin la pila.
 *
 *   node scripts/avisos-de-fallos.mjs pruebas.log
 */
import fs from "node:fs";

const texto = fs.readFileSync(process.argv[2] || "pruebas.log", "utf8").replace(/\r/g, "");
const desde = texto.indexOf("✖ failing tests:");
if (desde < 0) {
  console.log("::error title=Pruebas::Han fallado, pero no encuentro la lista de pruebas que fallan en la salida.");
  process.exit(0);
}
const bloques = texto.slice(desde).split(/\n(?=test at )/).slice(1);
// Lo que va en un aviso: sin las líneas de la pila y con los caracteres que GitHub necesita escapados.
const escapar = (s) => s.replace(/%/g, "%25").replace(/\n/g, "%0A");
for (const b of bloques.slice(0, 10)) {
  const lineas = b.split("\n").filter((l) => !/^\s+at /.test(l) && l.trim());
  const donde = (lineas[0] || "").replace(/^test at /, "");
  const nombre = (lineas[1] || "").replace(/^✖ /, "").replace(/ \([\d.]+ms\)$/, "");
  console.log("::error title=" + escapar(nombre.slice(0, 120)).replace(/[,:]/g, " ") + "::" + escapar([donde, ...lineas.slice(2, 22)].join("\n")));
}
if (bloques.length > 10) console.log("::error title=Pruebas::Y " + (bloques.length - 10) + " pruebas más fallan.");
