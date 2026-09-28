/*
 * Empaqueta la extensión en dist/docuprivado-<versión>.mcpb, solo si todo está en orden:
 *   1. la copia de la web está al día (sync-desde-web.mjs --comprobar);
 *   2. versión igual en manifest.json y package.json;
 *   3. pasan todas las pruebas (node --test), la prueba sin red y la del MCP Inspector;
 *   4. se prepara dist/paquete/ con solo lo que necesita la extensión (sin pruebas, sin
 *      herramientas de desarrollo, sin mapas ni tipos, sin módulos nativos);
 *   5. mcpb validate + mcpb pack;
 *   6. se desempaqueta el .mcpb en una carpeta temporal y se arranca desde ahí, como hace
 *      Claude Desktop, con la red bloqueada: la prueba sin red y el ensayo de las 12 frases
 *      de prueba y de las pruebas negativas (scripts/ensayo-frases.mjs);
 *   7. se imprime y se guarda el tamaño y la huella SHA-256 (docs/PROGRESO.md las anota).
 *
 *   node scripts/empaquetar.mjs [--sin-pruebas]   (--sin-pruebas solo para ensayar el empaquetado)
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RAIZ = fileURLToPath(new URL("..", import.meta.url));
const DIST = path.join(RAIZ, "dist");
const PAQUETE = path.join(DIST, "paquete");
const MCPB = path.join(RAIZ, "node_modules", "@anthropic-ai", "mcpb", "dist", "cli", "cli.js");
const sinPruebas = process.argv.includes("--sin-pruebas");

const paso = (t) => console.error("\n== " + t);
const ejecutar = (args, opciones = {}) => execFileSync(process.execPath, args, { cwd: RAIZ, stdio: "inherit", ...opciones });

// Qué viaja en el paquete: manifiesto, icono, README (con la política de privacidad y los
// créditos), registro de cambios, servidor (menos las pruebas copiadas de la
// web) y las dependencias de producción.
const INCLUIR = ["manifest.json", "icon.png", "README.md", "CHANGELOG.md", "LICENSE", "NOTICE", "server"];   // LICENSE y NOTICE: Apache-2.0 (hito 8)
const EXCLUIR_SERVIDOR = [path.join("server", "shared", "pruebas")];
const EXCLUIR_ARCHIVOS = /(\.map|\.d\.ts|\.d\.mts|\.d\.cts|\.tsbuildinfo|\.md)$/i;
const CONSERVAR = /^(licen[cs]e|copying|notice)/i;
const PROHIBIDO = [/[\\/]@napi-rs[\\/]/, /\.node$/i, /[\\/]node-fetch[\\/]/];   // nativos o de red
// Paquetes de los que solo viaja lo que se usa (docs/LIBRERIAS.md). Si falta un archivo
// de la lista, el empaquetado para: una versión nueva puede haberlo movido.
const RECORTES = {
  "pdfjs-dist": ["package.json", "LICENSE", "legacy/build/pdf.min.mjs", "legacy/build/pdf.worker.min.mjs"],
  "@embedpdf/pdfium": ["package.json", "LICENSE", "LICENSE.pdfium", "dist/index.js", "dist/pdfium.wasm"],
  "pdf-lib": ["package.json", "LICENSE.md", "dist/pdf-lib.min.js"],
  // Van dentro de dist/pdf-lib.min.js: de ellos solo viajan sus licencias.
  "@pdf-lib/standard-fonts": ["package.json", "LICENSE.md"],
  "@pdf-lib/upng": ["package.json", "LICENSE"],
  "pako": ["package.json", "LICENSE"],
  "tslib": ["package.json", "LICENSE.txt", "CopyrightNotice.txt"],
  "jpeg-js": ["package.json", "LICENSE", "index.js", "lib/encoder.js", "lib/decoder.js"],
  "pngjs": ["package.json", "LICENSE", "lib"],
  // Lector de escaneados (hito 3): el código de Node, las dos variantes del núcleo que
  // usan Claude Desktop y Node (con SIMD) y el español «4.0.0_best_int», el de la web.
  // Ojo: en Node, tesseract.js 7 carga siempre el núcleo completo («tesseract-core-simd»,
  // no «…-simd-lstm»): src/worker-script/index.js le pasa a getCore un sí/no donde espera
  // el modo de lectura. Es el que se ha probado; el «-lstm» no se carga nunca.
  "tesseract.js": ["package.json", "LICENSE.md", "src"],
  "tesseract.js-core": ["package.json", "LICENSE", "index.js", "tesseract-core-relaxedsimd.js", "tesseract-core-relaxedsimd.wasm",
    "tesseract-core-simd.js", "tesseract-core-simd.wasm"],
  "@tesseract.js-data/spa": ["package.json", "4.0.0_best_int/spa.traineddata.gz"],
  "bmp-js": ["package.json", "LICENSE", "index.js", "lib"],
  "zlibjs": ["package.json", "LICENSE"],        // solo lo usa la versión de navegador
  // Fotos HEIC (hito 3): LGPL, archivo aparte y sin modificar, con su licencia (CLAUDE.md §4.8).
  "libheif-js": ["package.json", "LICENSE", "libheif-wasm/libheif.js", "libheif-wasm/libheif.wasm", "libheif-wasm/LICENSE"],
};
// Dependencias que no viajan: node-fetch (y lo suyo) solo haría falta en un Node sin
// «fetch», y la extensión no descarga nada; opencollective-postinstall es un aviso al instalar.
const NO_VIAJAN = new Set(["node-fetch", "whatwg-url", "tr46", "webidl-conversions", "opencollective-postinstall"]);

function copiar(origen, destino, filtro) {
  const st = fs.statSync(origen);
  if (st.isDirectory()) {
    for (const e of fs.readdirSync(origen)) copiar(path.join(origen, e), path.join(destino, e), filtro);
  } else if (filtro(origen)) {
    fs.mkdirSync(path.dirname(destino), { recursive: true });
    fs.copyFileSync(origen, destino);
  }
}

function listarArchivos(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const r = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listarArchivos(r)); else out.push(r);
  }
  return out;
}

const manifiesto = JSON.parse(fs.readFileSync(path.join(RAIZ, "manifest.json"), "utf8"));
const pkg = JSON.parse(fs.readFileSync(path.join(RAIZ, "package.json"), "utf8"));
const version = manifiesto.version;

paso("1. Copia de la web al día");
ejecutar(["scripts/sync-desde-web.mjs", "--comprobar"]);

paso("2. Versión");
if (pkg.version !== version) throw new Error("La versión de package.json (" + pkg.version + ") no coincide con la de manifest.json (" + version + ")");
console.error("versión " + version);

if (!sinPruebas) {
  paso("3. Pruebas y prueba sin red");
  ejecutar(["--test", "tests/**/*.test.mjs"]);
  ejecutar(["scripts/comprobar-sin-red.mjs"]);
  ejecutar(["scripts/probar-inspector.mjs"]);
}

paso("4. Carpeta del paquete");
fs.rmSync(PAQUETE, { recursive: true, force: true });
fs.mkdirSync(PAQUETE, { recursive: true });
for (const e of INCLUIR) {
  copiar(path.join(RAIZ, e), path.join(PAQUETE, e), (f) => !EXCLUIR_SERVIDOR.some((x) => f.startsWith(path.join(RAIZ, x))));
}
fs.writeFileSync(path.join(PAQUETE, "package.json"), JSON.stringify({ name: pkg.name, version, private: true, license: pkg.license, type: "module", dependencies: pkg.dependencies }, null, 2) + "\n");
const produccion = execFileSync("npm" + (process.platform === "win32" ? ".cmd" : ""), ["ls", "--omit=dev", "--all", "--parseable"], { cwd: RAIZ, encoding: "utf8", shell: process.platform === "win32" })
  .split(/\r?\n/).filter((l) => l && path.resolve(l) !== path.resolve(RAIZ));
for (const dir of produccion) {
  const rel = path.relative(RAIZ, dir);
  const nombrePaquete = path.relative(path.join(RAIZ, "node_modules"), dir).split(path.sep).join("/");
  if (NO_VIAJAN.has(nombrePaquete.split("/node_modules/").pop())) continue;
  if (RECORTES[nombrePaquete]) {
    for (const f of RECORTES[nombrePaquete]) {
      const origen = path.join(dir, f);
      if (!fs.existsSync(origen)) throw new Error("Falta " + nombrePaquete + "/" + f + " (¿ha cambiado la versión?)");
      copiar(origen, path.join(PAQUETE, rel, f), (x) => !EXCLUIR_ARCHIVOS.test(path.basename(x)) || CONSERVAR.test(path.basename(x)));
    }
    continue;
  }
  copiar(dir, path.join(PAQUETE, rel), (f) => {
    const nombre = path.basename(f);
    if (CONSERVAR.test(nombre)) return true;
    return !EXCLUIR_ARCHIVOS.test(nombre);
  });
}
const archivos = listarArchivos(PAQUETE);
const prohibidos = archivos.filter((f) => PROHIBIDO.some((re) => re.test(f)));
if (prohibidos.length) throw new Error("El paquete lleva archivos prohibidos (nativos o de red):\n" + prohibidos.join("\n"));
const bytes = archivos.reduce((s, f) => s + fs.statSync(f).size, 0);
console.error(archivos.length + " archivos, " + (bytes / 1e6).toFixed(1) + " MB sin comprimir; dependencias: " + produccion.map((d) => path.relative(path.join(RAIZ, "node_modules"), d)).join(", "));

paso("5. Validar y empaquetar");
ejecutar([MCPB, "validate", path.join(PAQUETE, "manifest.json")]);
const salida = path.join(DIST, "docuprivado-" + version + ".mcpb");
fs.rmSync(salida, { force: true });
ejecutar([MCPB, "pack", PAQUETE, salida]);

paso("6. Arrancar desde el paquete, como Claude Desktop");
const prueba = fs.mkdtempSync(path.join(os.tmpdir(), "docuprivado-paquete-"));
try {
  ejecutar([MCPB, "unpack", salida, prueba], { stdio: "pipe" });
  const desempaquetados = listarArchivos(prueba).length;
  if (desempaquetados !== archivos.length) throw new Error("El .mcpb tiene " + desempaquetados + " archivos y la carpeta del paquete " + archivos.length);
  ejecutar(["scripts/comprobar-sin-red.mjs", "--servidor", prueba]);
  ejecutar(["scripts/ensayo-frases.mjs", "--servidor", prueba]);
} finally {
  fs.rmSync(prueba, { recursive: true, force: true });
}

paso("7. Resultado");
const datos = fs.readFileSync(salida);
const sha = createHash("sha256").update(datos).digest("hex");
const resumen = "docuprivado-" + version + ".mcpb · " + (datos.length / 1e6).toFixed(2) + " MB (" + datos.length + " bytes) · SHA-256 " + sha + " · " + new Date().toISOString().slice(0, 10);
fs.writeFileSync(path.join(DIST, "docuprivado-" + version + ".txt"), resumen + "\n");
console.error(resumen);
