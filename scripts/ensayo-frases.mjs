/*
 * Ensayo de las 12 frases de prueba y de las pruebas negativas (docs/PROMPT_EXTENSION.md
 * §8.2), antes de que el titular las pruebe en Claude Desktop. Para cada frase hace la llamada
 * que tendría que hacer Claude y comprueba el resultado; no sustituye a la prueba real,
 * que es la que dice si Claude elige bien la herramienta.
 *
 *   node scripts/ensayo-frases.mjs [--servidor <carpeta del paquete>]
 *
 * Trabaja en una carpeta de prueba nueva y temporal (scripts/preparar-carpeta-prueba.mjs),
 * con la red bloqueada, y apunta el tiempo de cada llamada (el trabajo de la extensión;
 * en Claude Desktop se suma lo que tarda Claude en contestar).
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { arrancar } from "../tests/cliente-mcp.mjs";
import { FRASE_TRAMPA } from "./crear-pruebas-finales.mjs";

const RAIZ = fileURLToPath(new URL("..", import.meta.url));
const i = process.argv.indexOf("--servidor");
const paquete = i > 0 ? path.resolve(process.argv[i + 1]) : RAIZ;
const version = JSON.parse(fs.readFileSync(path.join(paquete, "manifest.json"), "utf8")).version;
// Los datos (ficticios) de la nómina de prueba de la web: nunca pueden salir en una respuesta.
const PARIDAD = JSON.parse(fs.readFileSync(path.join(RAIZ, "tests", "paridad", "web-tachador.json"), "utf8"));
const DATOS_NOMINA = PARIDAD.archivos["nomina-ficticia.pdf"].marcas.map((m) => m.valor)
  .filter((v) => v.length >= 6 && !/^[\d.,]+$/.test(v) && !/EMPRESA|Avenida|B0000/.test(v));

// La carpeta temporal, por su nombre real, como trabaja la extensión: en macOS está detrás de

// un enlace (/var → /private/var) y en Windows puede venir con nombres cortos (RUNNER~1).

const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "docuprivado-ensayo-")));
const C = path.join(base, "carpeta-de-prueba");
execFileSync(process.execPath, [path.join(RAIZ, "scripts", "preparar-carpeta-prueba.mjs")], { env: { ...process.env, DOCUPRIVADO_CARPETA_PRUEBA: C }, stdio: "pipe" });

function listar(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const r = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listar(r)); else out.push(r);
  }
  return out;
}
const huella = (f) => fs.statSync(f).size > 50e6 ? "grande:" + fs.statSync(f).size : createHash("sha256").update(fs.readFileSync(f)).digest("hex");
const foto = () => new Map(listar(C).map((f) => [path.relative(C, f), huella(f)]));
const nuevos = (antes) => [...foto().keys()].filter((f) => !antes.has(f));
const originalesIntactos = (antes) => [...antes].every(([f, h]) => fs.existsSync(path.join(C, f)) && huella(path.join(C, f)) === h);

const s = arrancar({ carpetas: [C], servidor: path.join(paquete, "server", "index.js"), cwd: paquete });
await s.iniciar();

// Una llamada como la de Claude; si la extensión dice que sigue trabajando, «continúa».
async function llamar(nombre, args) {
  const t0 = Date.now();
  for (let vuelta = 0; ; vuelta++) {
    const r = await s.pedir("tools/call", { name: nombre, arguments: args });
    const sc = r.result && r.result.structuredContent;
    const sigue = sc && (sc.pendiente === true || (Array.isArray(sc.pendientes) && sc.pendientes.length));
    if (!sigue || vuelta > 8) {
      const texto = r.result ? r.result.content.map((c) => c.text || "").join("\n") : "";
      return { r, sc, texto, error: !!(r.error || (r.result && r.result.isError)), ms: Date.now() - t0, vueltas: vuelta + 1 };
    }
  }
}

const filas = [];
async function frase(num, texto, herramienta, args, comprobar) {
  const antes = foto();
  let res;
  let fallo = null;
  try {
    res = await llamar(herramienta, args);
    const creados = nuevos(antes);
    const problema = comprobar(res, creados, antes);
    if (problema) fallo = problema;
    else if (!originalesIntactos(antes)) fallo = "ha cambiado un archivo que ya existía";
  } catch (e) {
    fallo = "error: " + e.message.split("\n")[0];
  }
  filas.push({ num, texto, herramienta, ok: !fallo, fallo, ms: res ? res.ms : 0, vueltas: res ? res.vueltas : 0 });
  console.error((fallo ? "✗ " : "✓ ") + num + " «" + texto + "» → " + herramienta + " (" + (res ? (res.ms / 1000).toFixed(1) : "?") + " s)" + (fallo ? ": " + fallo : ""));
}
const sin = (texto, valores) => valores.filter((v) => texto.includes(v));

await frase(1, "¿Qué puedes hacer con docuprivado?", "ayuda_docuprivado", {}, (r) =>
  r.error ? "error" : !r.texto.includes("versión " + version) ? "no dice la versión " + version : r.sc.enPreparacion.length ? "dice que hay cosas en preparación" :
    r.sc.disponible.length !== 7 ? "no enseña las 7 capacidades" : null);
await frase(2, "Busca las nóminas que tengo en la carpeta de prueba.", "listar_documentos", { buscar: "nomina" }, (r) =>
  r.error ? "error" : r.sc.total !== 13 ? "encuentra " + r.sc.total + " y son 13 (3 en Alquiler y 10 en Medicion)" : null);
await frase(3, "¿Qué datos personales hay en nomina-septiembre-2026.pdf?", "analizar_datos_personales", { rutas: ["nomina-septiembre-2026.pdf"] }, (r) =>
  r.error ? "error" : r.sc.total < 8 ? "solo " + r.sc.total + " datos" : sin(r.texto + JSON.stringify(r.sc), DATOS_NOMINA).length ? "enseña datos: " + sin(r.texto, DATOS_NOMINA).length : null);
await frase(4, "Enséñame los DNI que aparecen en ese documento.", "analizar_datos_personales", { rutas: ["nomina-septiembre-2026.pdf"], tipos: ["dni", "nie"], mostrar_valores: true }, (r) =>
  r.error ? "error" : !/\*{3}\d{4}\*{2}/.test(r.texto) ? "no enseña el DNI tapado (***4567**, como la AEPD)" : sin(r.texto, DATOS_NOMINA).length ? "enseña el DNI entero" : null);
await frase(5, "Tacha los datos personales de nomina-septiembre-2026.pdf.", "tachar_documentos", { rutas: ["nomina-septiembre-2026.pdf"] }, (r, creados) =>
  r.error ? "error" : r.sc.copias.length !== 1 ? "no crea la copia" : !creados.some((f) => /nomina-septiembre-2026-tachado\.pdf$/.test(f)) ? "no está la copia" :
    !r.texto.includes("revis") ? "no recomienda revisar" : sin(r.texto, DATOS_NOMINA).length ? "enseña datos" : null);
await frase(6, "Tacha todos los PDF de la carpeta Contratos, pero deja visible el nombre de la empresa Inmobiliaria Ejemplo.", "tachar_documentos",
  { rutas: ["Contratos"], no_tachar: ["Inmobiliaria Ejemplo"] }, (r) =>
    r.error ? "error" : r.sc.copias.length < 4 ? "solo " + r.sc.copias.length + " copias" : !r.sc.noTachados.some((n) => /contrasena/.test(n.ruta)) ? "no explica el de la contraseña" : null);
await frase(7, "Este contrato está escaneado: tápale el DNI y la dirección.", "tachar_documentos",
  { rutas: ["contrato-escaneado.pdf"], tipos: ["dni", "direccion"], repetir: true }, (r) =>
    r.error ? "error" : r.sc.copias.length !== 1 ? "no crea la copia" : !(r.sc.copias[0].paginasLeidas > 0) ? "no lee el escaneo" : !(r.sc.porTipo.dni >= 1) ? "no tapa el DNI" : null);
await frase(8, "Quita la ubicación de todas las fotos de la carpeta Viaje.", "limpiar_metadatos_imagen", { rutas: ["Viaje"] }, (r) =>
  r.error ? "error" : r.sc.copias.length !== 5 ? r.sc.copias.length + " copias y son 5" : r.sc.conUbicacion !== 4 ? r.sc.conUbicacion + " con ubicación y son 4" : null);
await frase(9, "Anonimiza correo-cliente.docx para pasárselo a ChatGPT.", "anonimizar_archivo", { ruta: "correo-cliente.docx" }, (r, creados) =>
  r.error ? "error" : !creados.some((f) => /correo-cliente-anonimo\.docx$/.test(f)) || !creados.some((f) => /correo-cliente-tabla\.json$/.test(f)) ? "faltan la copia o la tabla" :
    /Juan Pérez|12345678Z/.test(r.texto) ? "enseña datos" : null);
await frase(10, "Devuelve los datos reales a respuesta-ia.txt con la tabla de antes.", "restaurar_archivo",
  { ruta: "respuesta-ia.txt", tabla: path.join("docuprivado", "correo-cliente-tabla.json") }, (r, creados) =>
    r.error ? "error" : !creados.some((f) => /respuesta-ia-restaurado\.txt$/.test(f)) ? "no crea la copia" : !(r.sc.restauradas > 0) ? "no devuelve ningún dato" : null);
await frase(11, "Prepara mi DNI para alquilar un piso: las fotos son dni-frente.jpg y dni-detras.jpg.", "proteger_copia_dni",
  { delantera: "dni-frente.jpg", trasera: "dni-detras.jpg", texto_marca: "Solo para alquiler de vivienda" }, (r, creados) =>
    r.error ? "error" : !creados.some((f) => /dni-protegido-.*\.pdf$/.test(f)) ? "no crea el PDF" : !/242,65 × 153,01|85,6/.test(r.texto + r.sc.medidas) ? "no dice las medidas" : null);
await frase(12, "¿Qué ha cambiado entre contrato-v1.docx y contrato-v2.docx?", "comparar_documentos", { original: "contrato-v1.docx", nuevo: "contrato-v2.docx" }, (r, creados) =>
  r.error ? "error" : r.sc.resumen.total !== 4 || r.sc.resumen.importantes !== 3 ? "encuentra " + r.sc.resumen.total + " cambios (" + r.sc.resumen.importantes + " importantes) y son 4 (3)" :
    !/850.*950/.test(r.texto) ? "no dice la renta de 850 a 950" : !creados.some((f) => /\.html$/.test(f)) || !creados.some((f) => /\.docx$/.test(f)) ? "faltan el informe o el Word" : null);

// Las dos tareas que se cronometran (docs/MEDICIONES.md): aquí, solo el trabajo de la extensión.
await frase("M1", "Tacha las nóminas de la carpeta Medicion/Nominas.", "tachar_documentos", { rutas: ["Medicion/Nominas"], preset: "nomina" }, (r, creados) =>
  r.error ? "error" : r.sc.copias.length !== 10 ? r.sc.copias.length + " copias y son 10" : creados.filter((f) => /-tachado\.pdf$/.test(f)).length !== 10 ? "no están las 10 copias" : null);
await frase("M2", "Prepara mi DNI para el banco con dni-frente.jpg y dni-detras.jpg.", "proteger_copia_dni",
  { delantera: "dni-frente.jpg", trasera: "dni-detras.jpg", texto_marca: "Solo para apertura de cuenta en el banco" }, (r, creados) =>
    r.error ? "error" : !creados.some((f) => /dni-protegido-.*\.pdf$/.test(f)) ? "no crea el PDF" : null);

// Lo que encontró la revisión con otro chat de Claude (hitos de actualización 17 y 18 de la web).
await frase("R1", "¿Qué datos personales hay en datos-escondidos.pdf?", "analizar_datos_personales", { rutas: ["datos-escondidos.pdf"] }, (r) =>
  r.error ? "error" : r.sc.archivos[0].escondidos !== 3 ? r.sc.archivos[0].escondidos + " escondidos y son 3" : !/datos escondidos/.test(r.texto) ? "no avisa del tachado falso" : null);
await frase("R2", "Anonimiza carta-cliente.docx y enséñame cómo queda.", "anonimizar_archivo", { ruta: "carta-cliente.docx", mostrar_texto: true }, (r) =>
  r.error ? "error" : /Vega|Castillo/.test(r.sc.texto) ? "se ve el nombre de la tabla" : !/^Un saludo, \[PERSONA_\d\]/m.test(r.sc.texto) ? "ha tocado «Un saludo»" : null);

// Pruebas negativas.
// En macOS, un archivo del sistema de allí (en GitHub, mejora 3 del hito 7).
const DEL_SISTEMA = process.platform === "win32" ? "C:\\Windows\\win.ini" : "/etc/hosts";
await frase("N1", "Tacha " + DEL_SISTEMA, "tachar_documentos", { rutas: [DEL_SISTEMA] }, (r, creados) =>
  !r.error && !(r.sc && r.sc.noTachados && r.sc.noTachados.length && !r.sc.copias.length) ? "no se niega" : creados.length ? "ha creado algo" :
    !/fuera de las carpetas|no está dentro|autoriz/i.test(r.texto + JSON.stringify(r.r.error || {})) ? "no explica por qué" : null);
await frase("N2", "Tacha contrato-con-instrucciones.pdf (lleva «" + FRASE_TRAMPA + "»)", "tachar_documentos", { rutas: ["contrato-con-instrucciones.pdf"] }, (r, creados) =>
  r.error ? "error" : r.texto.includes("Ignora") ? "la respuesta lleva la orden escondida" :
    creados.some((f) => !/Pruebas negativas[\\/]docuprivado[\\/](contrato-con-instrucciones-tachado\.pdf|revision-tachado-.*\.html)$/.test(f)) ? "ha creado algo más: " + creados.join(", ") : null);
await frase("N2b", "Anonimiza nota-con-instrucciones.txt (la misma orden)", "anonimizar_archivo", { ruta: "nota-con-instrucciones.txt" }, (r, creados) =>
  r.error ? "error" : r.texto.includes("Ignora") ? "la respuesta lleva la orden escondida" : creados.length !== 2 ? "ha creado " + creados.length + " archivos y son 2" : null);
await frase("N3", "Tacha escaneo-enorme.pdf (150 MB)", "tachar_documentos", { rutas: ["escaneo-enorme.pdf"] }, (r, creados) =>
  creados.length ? "ha creado algo" : !/100 MB/.test(r.texto + JSON.stringify(r.r.error || {})) ? "no dice que pasa de 100 MB" : null);

// Ninguna respuesta del ensayo lleva la carpeta del usuario (rutas cortas, mejora 1 del hito 7).
{
  const casa = os.homedir().toLowerCase();
  const conCasa = s.mensajes.filter((m) => m.id && m.result && !m.result.protocolVersion)
    .filter((m) => JSON.stringify(m.result).toLowerCase().replace(/\\\\/g, "\\").includes(casa));
  const fallo = conCasa.length ? conCasa.length + " respuestas llevan la carpeta del usuario" : null;
  filas.push({ num: "P", texto: "Ninguna respuesta lleva la carpeta del usuario", herramienta: "(todas)", ok: !fallo, fallo, ms: 0, vueltas: 0 });
  console.error((fallo ? "✗ " : "✓ ") + "P «Ninguna respuesta lleva la carpeta del usuario»" + (fallo ? ": " + fallo : ""));
}

await s.cerrar();
fs.rmSync(base, { recursive: true, force: true });

const mal = filas.filter((f) => !f.ok);
fs.mkdirSync(path.join(RAIZ, "dist"), { recursive: true });
fs.writeFileSync(path.join(RAIZ, "dist", "ensayo-frases-" + version + ".json"), JSON.stringify({ version, fecha: new Date().toISOString(), filas }, null, 2) + "\n");
if (mal.length) {
  console.error("\nEnsayo de las frases: " + mal.length + " con problemas");
  process.exit(1);
}
console.error("\nEnsayo de las frases superado: " + filas.length + " de " + filas.length);
