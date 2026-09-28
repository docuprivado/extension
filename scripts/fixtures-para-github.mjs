/*
 * Mejora 3 del hito 7 (aprobada por el titular el 28/09/2026): probar la extensión en macOS sin
 * tener un Mac, con GitHub (.github/workflows/pruebas.yml). Allí no está la carpeta de la
 * web, así que las pruebas necesitan una copia de sus documentos de prueba.
 *
 * Este script hace esa copia en tests/web/tests/fixtures (con la misma estructura que la
 * web, para usarla con DOCUPRIVADO_WEB=tests/web). Solo lleva documentos FICTICIOS:
 * - nunca las fotos de personas reales ni las de la NASA (retratos, fotos/nasa): el titular
 *   decidió el 21/09/2026 que son solo para pruebas en este ordenador (WEB A/tests/fixtures/
 *   FUENTES.md);
 * - tampoco las fotos de vehículos y matrículas, que la extensión no usa;
 * - ni los archivos de más de 20 MB (las pruebas que los usan se saltan).
 *
 * **Solo se ejecuta al publicar el código en GitHub, con permiso del titular (hito 8)**:
 * subir la copia también es publicar sus documentos de prueba. Hasta entonces, tests/web/
 * no se guarda (.gitignore).
 *
 *   node scripts/fixtures-para-github.mjs [carpeta de destino]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RAIZ = fileURLToPath(new URL("..", import.meta.url));
const WEB = path.resolve(process.env.DOCUPRIVADO_WEB_ORIGEN || path.join(RAIZ, "..", "WEB A"));
const ORIGEN = path.join(WEB, "tests", "fixtures");
const DESTINO = path.resolve(process.argv[2] || path.join(RAIZ, "tests", "web"), "tests", "fixtures");
const MAX_BYTES = 20 * 1024 * 1024;

// Lo que no va nunca (rutas dentro de tests/fixtures, con «/»).
// FUENTES.md tampoco: son las notas internas de la web sobre de dónde sale cada documento.
const FUERA = [/^fotos\/nasa\//, /^fotos\/vehiculos\//, /^fotos\/matriculas\//, /(^|\/)retrato-prueba-[^/]*$/, /^FUENTES\.md$/];

if (!fs.existsSync(ORIGEN)) {
  console.error("No encuentro los documentos de prueba de la web en " + ORIGEN);
  process.exit(1);
}
fs.rmSync(DESTINO, { recursive: true, force: true });
let copiados = 0;
let bytes = 0;
const fuera = [];
(function recorrer(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    const rel = path.relative(ORIGEN, abs).split(path.sep).join("/");
    if (e.isDirectory()) {
      recorrer(abs);
      continue;
    }
    const st = fs.statSync(abs);
    if (FUERA.some((re) => re.test(rel)) || st.size > MAX_BYTES) {
      fuera.push(rel);
      continue;
    }
    fs.mkdirSync(path.join(DESTINO, path.dirname(rel)), { recursive: true });
    fs.copyFileSync(abs, path.join(DESTINO, rel));
    copiados++;
    bytes += st.size;
  }
})(ORIGEN);
fs.writeFileSync(path.join(DESTINO, "..", "..", "LEEME.txt"),
  "Copia de los documentos de prueba FICTICIOS de la web (WEB A/tests/fixtures) para las pruebas de GitHub.\n" +
  "La hace scripts/fixtures-para-github.mjs. Sin fotos de personas reales. No editar a mano.\n");
console.error(copiados + " documentos de prueba copiados (" + (bytes / 1e6).toFixed(1) + " MB) en " + DESTINO + "; " + fuera.length + " se quedan fuera.");
