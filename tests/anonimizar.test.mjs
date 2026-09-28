/*
 * Anonimizar y restaurar (docs/PROMPT_EXTENSION.md §8.1):
 * - mismo resultado que el anonimizador de la web con su texto de prueba (etiquetas, tipos,
 *   valores y texto anónimo), capturado en tests/paridad/web-anonimizador.json;
 * - ida y vuelta: anonimizar y restaurar devuelve el texto original. Como en la web, una
 *   mención corta («Sr. Pérez») lleva la etiqueta de la persona y vuelve completa
 *   («Sr. Juan Pérez García»); sin menciones cortas, la vuelta es idéntica;
 * - Word (correo-cliente.docx, ficticio, scripts/crear-word-prueba.mjs): nombre repartido
 *   entre fragmentos con formato, tabulador, encabezado, comentario, cambio registrado,
 *   enlace «mailto:», código de campo, propiedades y miniatura. Ningún dato queda en ningún
 *   rincón del archivo, el formato se conserva y la vuelta restaura el texto;
 * - etiquetas cambiadas por la IA, tabla que no es una tabla, CSV de Excel en Windows-1252,
 *   PDF y Word antiguo.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import "../server/core/salida-segura.js";
import { reglasAnonimizador } from "../server/core/motores.js";
import { anonimizarArchivo, anonimizarVarios, leerTablaDeArchivo, restaurarArchivo } from "../server/core/proceso-anonimizar.js";
import { prepararCarpetas } from "../server/core/rutas.js";
import { leerTexto } from "../server/core/texto-archivo.js";
import { abrirWord, decodificarXml, textoVisible } from "../server/core/word.js";
import { datosDe, leerZip } from "../server/core/zip.js";
import { PARRAFOS_VISIBLES, RESPUESTA_IA, crearCorreoCliente } from "../scripts/crear-word-prueba.mjs";

const RAIZ = fileURLToPath(new URL("..", import.meta.url));
const WEB = path.resolve(process.env.DOCUPRIVADO_WEB || path.join(RAIZ, "..", "WEB A"));
const F = path.join(WEB, "tests", "fixtures");
const hayWeb = fs.existsSync(path.join(F, "texto-anonimizar.txt"));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "docuprivado-anonimizar-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const ctx = prepararCarpetas([tmp]);
const R = reglasAnonimizador();
const DET = { tipos: [...new Set(R.tiposConAcompanantes(R.CASILLAS))], personalizados: [], noTachar: [] };

function archivo(nombre, datos) {
  const ruta = path.join(tmp, nombre);
  fs.writeFileSync(ruta, datos);
  const st = fs.statSync(ruta);
  return { ruta, nombre, bytes: st.size, modificado: st.mtimeMs };
}
const deRuta = (ruta) => { const st = fs.statSync(ruta); return { ruta, nombre: path.basename(ruta), bytes: st.size, modificado: st.mtimeMs }; };

// Los datos ficticios del correo de prueba: ninguno puede quedar en la copia anónima.
const VALORES = ["Juan Pérez García", "12345678Z", "612 345 678", "699 123 456", "juan.perez@example.com", "X1234567L", "ES91 2100 0418 4502 0005 1332",
  "Calle del Ejemplo 12", "María López Sánchez", "Carmen Ruiz Ortega"];

test("mismo resultado que el anonimizador de la web (texto de prueba)", { skip: !hayWeb }, async () => {
  const web = JSON.parse(fs.readFileSync(new URL("paridad/web-anonimizador.json", import.meta.url), "utf8"));
  assert.deepEqual([...web.tipos].sort(), [...R.CASILLAS].sort(), "las casillas marcadas de la web");
  for (const [nombre, suyo] of Object.entries(web.archivos)) {
    const datos = fs.readFileSync(path.join(F, nombre));
    assert.equal(createHash("sha256").update(datos).digest("hex"), suyo.sha256, "El texto de prueba ha cambiado en la web: vuelve a ejecutar python scripts/paridad_web.py");
    const r = await anonimizarArchivo(ctx, archivo(nombre, datos), DET, { mostrarTexto: true });
    assert.equal(r.texto, suyo.texto, "el texto anónimo, igual que en la web");
    const tabla = JSON.parse(fs.readFileSync(r.tabla, "utf8"));
    assert.deepEqual(tabla.sustituciones.map((s) => [s.etiqueta, s.tipo, s.valor]), suyo.grupos.map((g) => [g.etiqueta, g.tipo, g.valor]));
    assert.deepEqual(r.grupos.map((g) => g.veces), suyo.grupos.map((g) => g.veces));
    assert.equal(tabla.formato, "tabla-de-equivalencias");
    assert.equal(tabla.version, 1);
  }
});

test("ida y vuelta con un texto: vuelve idéntico (las menciones cortas, completas)", { skip: !hayWeb }, async () => {
  const original = fs.readFileSync(path.join(F, "texto-anonimizar.txt"), "utf8");
  const r = await anonimizarArchivo(ctx, archivo("correo.txt", original), DET);
  const v = await restaurarArchivo(ctx, deRuta(r.copia), leerTablaDeArchivo(r.tabla));
  assert.equal(v.desconocidas.length, 0);
  const restaurado = fs.readFileSync(v.copia, "utf8");
  // Como en la web: «Sr. Pérez» y «Sra. López» llevaban la etiqueta de la persona.
  const esperado = original.replace("El Sr. Pérez", "El Sr. Juan Pérez García").replace("la Sra. López", "la Sra. María López Sánchez");
  assert.equal(restaurado, esperado);
  // Sin menciones cortas, idéntico letra a letra.
  const sin = "Contrato entre Juan Pérez García (DNI 12345678Z) y María López Sánchez (NIE X1234567L).\r\nCuenta: ES91 2100 0418 4502 0005 1332. Tel. 612 345 678.\r\n";
  const r2 = await anonimizarArchivo(ctx, archivo("sin-menciones.txt", sin), DET);
  const v2 = await restaurarArchivo(ctx, deRuta(r2.copia), leerTablaDeArchivo(r2.tabla));
  assert.equal(fs.readFileSync(v2.copia, "utf8"), sin, "con los saltos de línea de Windows incluidos");
});

test("Word: ningún dato queda en el archivo, el formato se conserva y fuera autor, empresa y miniatura", async () => {
  const r = await anonimizarArchivo(ctx, archivo("correo-cliente.docx", crearCorreoCliente()), DET, { mostrarTexto: true });
  assert.equal(r.tipo, "word");
  const salida = fs.readFileSync(r.copia);
  const entradas = leerZip(salida);
  const nombres = entradas.map((e) => e.nombre);
  assert.ok(!nombres.includes("docProps/thumbnail.jpeg"), "sin la miniatura de la primera página");
  // Ni en el texto (repartido entre fragmentos o no) ni en ningún otro sitio del archivo.
  const word = abrirWord(salida, "copia");
  const todo = entradas.filter((e) => /\.(xml|rels)$/.test(e.nombre)).map((e) => decodificarXml(datosDe(e).toString("utf8"))).join("\n");
  for (const v of VALORES) {
    assert.ok(!word.texto.includes(v), "en el texto queda «" + v.slice(0, 4) + "…»");
    assert.ok(!todo.includes(v), "en el archivo queda «" + v.slice(0, 4) + "…»");
  }
  const xml = (n) => datosDe(entradas.find((e) => e.nombre === n)).toString("utf8");
  // El formato: la etiqueta hereda la negrita del primer fragmento del nombre.
  assert.match(xml("word/document.xml"), /<w:rPr><w:b\/><\/w:rPr><w:t xml:space="preserve">\[PERSONA_1\]<\/w:t>/);
  assert.match(word.texto, /DNI:\t\[DNI_1\]/, "el tabulador sigue en su sitio");
  assert.match(word.texto, /HYPERLINK "mailto:\[EMAIL_1\]"/, "el código de campo, con la etiqueta");
  assert.match(xml("word/_rels/document.xml.rels"), /Target="mailto:\[EMAIL_1\]"/, "y el enlace");
  assert.match(xml("word/header1.xml"), /Cliente: \[PERSONA_1\]/, "el encabezado");
  assert.match(xml("word/comments.xml"), /w:author="Autor" w:initials="A"/, "el autor del comentario");
  assert.match(xml("word/document.xml"), /<w:del w:id="1" w:author="Autor"/, "el autor del cambio registrado");
  assert.match(xml("docProps/core.xml"), /<dc:creator><\/dc:creator>.*<cp:lastModifiedBy><\/cp:lastModifiedBy>/s);
  assert.match(xml("docProps/core.xml"), /<dc:title>Contrato de \[PERSONA_1\]<\/dc:title>/);
  assert.match(xml("docProps/app.xml"), /<Company><\/Company>/);
  assert.doesNotMatch(xml("_rels/.rels"), /thumbnail/);
  assert.deepEqual([...r.quitado].sort(), ["el autor", "la empresa", "la miniatura de la primera página", "los autores de comentarios y cambios"]);
  // Lo que se ve, en el chat si se pide: sin datos.
  for (const v of VALORES) assert.ok(!r.texto.includes(v));
  assert.match(r.texto, /^Asunto: Documentación para el contrato de alquiler/);
});

test("Word: la vuelta restaura el texto (el cuerpo, el encabezado y el comentario)", async () => {
  const org = archivo("correo-vuelta.docx", crearCorreoCliente());
  const r = await anonimizarArchivo(ctx, org, DET);
  const v = await restaurarArchivo(ctx, deRuta(r.copia), leerTablaDeArchivo(r.tabla));
  assert.deepEqual(v.desconocidas, []);
  const antes = abrirWord(fs.readFileSync(org.ruta), "o").texto;
  const despues = abrirWord(fs.readFileSync(v.copia), "v").texto;
  assert.equal(despues, antes.replace("El Sr. Pérez", "El Sr. Juan Pérez García"));
  // El cuerpo que se ve, párrafo a párrafo (sin el texto borrado del cambio registrado).
  const cuerpo = textoVisible(datosDe(leerZip(fs.readFileSync(v.copia)).find((e) => e.nombre === "word/document.xml")).toString("utf8")).split("\n");
  for (const p of PARRAFOS_VISIBLES.filter((x) => !x.includes("Sr. Pérez"))) assert.ok(cuerpo.includes(p), "falta el párrafo «" + p.slice(0, 20) + "…»");
});

test("la «respuesta de la IA» de la carpeta de prueba se restaura entera con la tabla del Word", async () => {
  const r = await anonimizarArchivo(ctx, archivo("correo-ia.docx", crearCorreoCliente()), DET);
  const v = await restaurarArchivo(ctx, archivo("respuesta-ia.txt", RESPUESTA_IA), leerTablaDeArchivo(r.tabla));
  assert.deepEqual(v.desconocidas, []);
  assert.equal(v.restauradas, 10);
  const texto = fs.readFileSync(v.copia, "utf8");
  assert.match(texto, /Arrendador: Juan Pérez García \(DNI 12345678Z\), con domicilio en Calle del Ejemplo 12, 3\.º B, 28013 Madrid\./);
  assert.match(texto, /Inquilina: María López Sánchez, con NIE X1234567L\./);
  assert.match(texto, /^Hola, Carmen Ruiz Ortega:/);
});

test("segunda pasada (web): un dato ya encontrado que reaparece sin reconocerse también se cambia", async () => {
  const texto = "D. Juan Pérez García, con DNI 12345678Z, firma.\nPagos pendientes de juan pérez garcía.\nReferencia: 12345678Z-2026\nArchivo: dni_12345678Z.pdf\n" +
    "La camisa rosa; Dña. Rosa Martín firma.\nAño 2026.\n";
  const r = await anonimizarArchivo(ctx, archivo("repetidos.txt", texto), DET, { mostrarTexto: true });
  assert.equal(r.texto, "D. [PERSONA_1], con DNI [DNI_1], firma.\nPagos pendientes de [PERSONA_1].\nReferencia: [DNI_1]-2026\nArchivo: dni_[DNI_1].pdf\n" +
    "La camisa rosa; Dña. [PERSONA_2] firma.\nAño 2026.\n", "«rosa» el color y «2026» se quedan");
  assert.deepEqual(r.avisos, [], "ya no queda nada que avisar");
  const v = await restaurarArchivo(ctx, deRuta(r.copia), leerTablaDeArchivo(r.tabla));
  assert.equal(fs.readFileSync(v.copia, "utf8"), texto.replace("juan pérez garcía", "Juan Pérez García"), "la vuelta: la forma de la tabla");
});

test("detector de la web: «Expediente de…», «DNI de…» o «Comparecen…» no forman parte del nombre", async () => {
  const texto = "Expediente de Juan Pérez García\nAdjunto la copia del DNI de Juan Pérez García.\nComparecen Juan Pérez García y otros.\n";
  const r = await anonimizarArchivo(ctx, archivo("expediente.txt", texto), DET, { mostrarTexto: true });
  assert.equal(r.texto, "Expediente de [PERSONA_1]\nAdjunto la copia del DNI de [PERSONA_1].\nComparecen [PERSONA_1] y otros.\n");
  const tabla = JSON.parse(fs.readFileSync(r.tabla, "utf8"));
  assert.deepEqual(tabla.sustituciones.map((s) => s.valor), ["Juan Pérez García"], "la tabla guarda el nombre, sin «Expediente de»");
});

test("varios documentos con una sola tabla: la misma persona, la misma etiqueta en todos", async () => {
  const dir = path.join(tmp, "Expediente García");
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "correo-cliente.docx"), crearCorreoCliente());
  fs.writeFileSync(path.join(dir, "notas.txt"), "Llamé a juan pérez garcía (DNI 12345678Z) por lo del NIE X1234567L de María López Sánchez.\n");
  fs.writeFileSync(path.join(dir, "sin-datos.md"), "# Pendientes\n\n- Revisar el contrato.\n");
  const archivos = ["correo-cliente.docx", "notas.txt", "sin-datos.md"].map((n) => deRuta(path.join(dir, n)));
  const r = await anonimizarVarios(ctx, archivos, DET, { mostrarTexto: true, nombreTabla: "Expediente García" });
  assert.equal(path.basename(r.tabla), "Expediente García-tabla.json");
  const [word, notas, sin] = r.documentos;
  assert.equal(sin.copia, null, "sin datos, sin copia");
  assert.match(notas.texto, /^Llamé a \[PERSONA_1\] \(DNI \[DNI_1\]\) por lo del NIE \[NIE_1\] de \[PERSONA_2\]\./, "las mismas etiquetas que en el Word");
  assert.match(word.texto, /D\. \[PERSONA_1\] \(DNI \[DNI_1\]\)/);
  const tabla = JSON.parse(fs.readFileSync(r.tabla, "utf8"));
  assert.deepEqual(tabla.documentos, ["correo-cliente-anonimo.docx", "notas-anonimo.txt"]);
  assert.equal(tabla.sustituciones.filter((s) => s.valor === "Juan Pérez García").length, 1, "una sola entrada por persona");
  // Cada copia se restaura con la tabla común.
  const t = leerTablaDeArchivo(r.tabla);
  const v1 = await restaurarArchivo(ctx, deRuta(notas.copia), t);
  assert.equal(fs.readFileSync(v1.copia, "utf8"), "Llamé a Juan Pérez García (DNI 12345678Z) por lo del NIE X1234567L de María López Sánchez.\n");
  const v2 = await restaurarArchivo(ctx, deRuta(word.copia), t);
  assert.deepEqual(v2.desconocidas, []);
});

test("restaurar: etiquetas cambiadas por la IA, desconocidas y sin confundir PERSONA_1 con PERSONA_10", () => {
  const tabla = { PERSONA_1: "Juan Pérez García", PERSONA_10: "Ana Ruiz", DNI_1: "12345678Z" };
  const r = R.restaurar("[persona_1], PERSONA 10 y [ DNI_1 ]. Además [PERSONA_2] y persona 3.", tabla);
  assert.equal(r.texto, "Juan Pérez García, Ana Ruiz y 12345678Z. Además [PERSONA_2] y persona 3.");
  assert.equal(r.restauradas, 3);
  assert.deepEqual(r.desconocidas, ["PERSONA_2"], "«persona 3» es texto normal: no se avisa");
});

test("tabla que no es una tabla: error claro", () => {
  fs.writeFileSync(path.join(tmp, "otra.json"), JSON.stringify({ hola: 1 }));
  assert.throws(() => leerTablaDeArchivo(path.join(tmp, "otra.json")), (e) => e.codigo === "tabla" && /no es una tabla de equivalencias/.test(e.message));
  fs.writeFileSync(path.join(tmp, "rota.json"), "{no es json");
  assert.throws(() => leerTablaDeArchivo(path.join(tmp, "rota.json")), (e) => e.codigo === "tabla");
});

test("CSV de Excel en Windows-1252: la copia se lee bien (UTF-8 con marca) y la vuelta devuelve el mismo texto", async () => {
  const texto = "nombre;dni;domicilio\r\nJosé Pérez García;12345678Z;Calle del Ejemplo 12, 28013 Madrid\r\n";
  const r = await anonimizarArchivo(ctx, archivo("clientes.csv", encode1252(texto)), DET);
  const bytes = fs.readFileSync(r.copia);
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], "UTF-8 con la marca del principio");
  assert.match(leerTexto(bytes).texto, /\[PERSONA_1\];\[DNI_1\];/);
  assert.ok(r.avisos.some((a) => /UTF-8/.test(a)));
  const v = await restaurarArchivo(ctx, deRuta(r.copia), leerTablaDeArchivo(r.tabla));
  assert.equal(leerTexto(fs.readFileSync(v.copia)).texto, texto);
});
function encode1252(s) {
  return Buffer.from([...s].map((c) => ({ "é": 0xe9, "á": 0xe1, "í": 0xed, "ó": 0xf3, "ú": 0xfa, "ñ": 0xf1 }[c] || c.charCodeAt(0))));
}

test("sin datos: no se crea copia; PDF y Word antiguo: mensaje con qué hacer", async () => {
  const r = await anonimizarArchivo(ctx, archivo("nada.txt", "Hola, esto es un texto sin datos personales.\n"), DET);
  assert.equal(r.copia, null);
  assert.equal(fs.readdirSync(tmp).filter((f) => f.startsWith("nada")).length, 1);
  await assert.rejects(anonimizarArchivo(ctx, archivo("viejo.docx", Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0])), DET), (e) => e.codigo === "wordAntiguo");
  await assert.rejects(anonimizarArchivo(ctx, archivo("roto.docx", "no soy un zip"), DET), (e) => e.codigo === "danado");
});
