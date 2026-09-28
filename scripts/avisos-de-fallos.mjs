/*
 * Para las pruebas de GitHub (.github/workflows/pruebas.yml): cuando algo falla, escribe el
 * motivo como avisos de la ejecución. El registro completo solo se ve con la sesión iniciada
 * en GitHub; los avisos, cualquiera, también sin sesión.
 * - De la salida de «node --test»: un aviso por prueba que falla, con las primeras líneas
 *   del error, sin la pila.
 * - De la prueba con el Inspector y del ensayo de las frases: las líneas que empiezan por «✗».
 * Como mucho, 10 avisos (el límite de GitHub por paso).
 *
 *   node scripts/avisos-de-fallos.mjs pruebas.log inspector.log ensayo.log
 */
import fs from "node:fs";

const MAXIMO = 10;
// Lo que va en un aviso, con los caracteres que GitHub necesita escapados.
const escapar = (s) => s.replace(/%/g, "%25").replace(/\r/g, "").replace(/\n/g, "%0A");
const titulo = (s) => escapar(s.slice(0, 120)).replace(/[,:]/g, " ");
const avisos = [];

for (const archivo of process.argv.slice(2)) {
  if (!fs.existsSync(archivo)) continue;
  const texto = fs.readFileSync(archivo, "utf8").replace(/\r/g, "");
  const desde = texto.indexOf("✖ failing tests:");
  if (desde >= 0) {
    for (const b of texto.slice(desde).split(/\n(?=test at )/).slice(1)) {
      const lineas = b.split("\n").filter((l) => !/^\s+at /.test(l) && l.trim());
      const donde = (lineas[0] || "").replace(/^test at /, "");
      const nombre = (lineas[1] || "").replace(/^✖ /, "").replace(/ \([\d.]+ms\)$/, "");
      avisos.push([nombre, [donde, ...lineas.slice(2, 22)].join("\n")]);
    }
    continue;
  }
  const malas = texto.split("\n").filter((l) => /^✗/.test(l));
  if (malas.length) avisos.push([archivo + ": " + malas.length + " fallo(s)", malas.slice(0, 20).join("\n")]);
}

if (!avisos.length) console.log("::error title=Pruebas::Algo ha fallado, pero no encuentro el motivo en " + process.argv.slice(2).join(", ") + ".");
for (const [t, m] of avisos.slice(0, MAXIMO)) console.log("::error title=" + titulo(t) + "::" + escapar(m));
if (avisos.length > MAXIMO) console.log("::error title=Pruebas::Y " + (avisos.length - MAXIMO) + " fallos más.");
