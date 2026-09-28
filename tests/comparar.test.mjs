/*
 * Comparar dos versiones de un documento (comparar_documentos, hito 6), con los contratos
 * ficticios de la web (tests/fixtures):
 * - encuentra los cambios de cambios-esperados.json en Word, en PDF y mezclados, sin
 *   contar como cambio las cláusulas solo renumeradas (docs/PROMPT_EXTENSION.md §8.1);
 * - lee y compara igual que el comparador de la web (tests/paridad/web-comparador.json,
 *   scripts/paridad_web.py): los mismos párrafos y los mismos cambios;
 * - del Word lee solo lo que se ve en el cuerpo, como la web;
 * - el informe es una página HTML sola, sin scripts ni nada de fuera;
 * - al chat van los cambios importantes con los datos personales tapados (decisión de
 *   el titular, 28/09/2026), y nada de lo que pone el documento va al registro;
 * - un escaneo largo sigue en segundo plano («continúa»).
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import "../server/core/salida-segura.js";
import { arrancar } from "./cliente-mcp.mjs";
import { AVISO, compararArchivos, informeHtml, leerParrafos, taparDatos, textoDeWord } from "../server/core/comparacion.js";
import { wordConCambios } from "../server/core/word-cambios.js";
import { decodificarXml } from "../server/core/word.js";
import { datosDe, leerZip } from "../server/core/zip.js";
import { cerrarLector } from "../server/core/lector.js";
import { comparadorMotor } from "../server/core/motores.js";
import { crearCorreoCliente } from "../scripts/crear-word-prueba.mjs";

const RAIZ = fileURLToPath(new URL("..", import.meta.url));
const WEB = path.resolve(process.env.DOCUPRIVADO_WEB || path.join(RAIZ, "..", "WEB A"));
const F = path.join(WEB, "tests", "fixtures");
const hayWeb = fs.existsSync(path.join(F, "contrato-v1.docx"));
const sinWeb = !hayWeb && "no encuentro los documentos de prueba de la web";
const huella = (f) => createHash("sha256").update(fs.readFileSync(f)).digest("hex");
const PARIDAD = fs.existsSync(new URL("paridad/web-comparador.json", import.meta.url)) ? JSON.parse(fs.readFileSync(new URL("paridad/web-comparador.json", import.meta.url), "utf8")) : null;
const ESPERADOS = hayWeb ? JSON.parse(fs.readFileSync(path.join(F, "cambios-esperados.json"), "utf8")) : null;
const f = (n) => ({ ruta: path.join(F, n), nombre: n });

after(() => cerrarLector());

// ---------------------------------------------------------------- los cambios de siempre
function comprobarEsperados(r) {
  assert.equal(r.resumen.total, ESPERADOS.total_cambios);
  const titulo = (s) => s.replace(/\s*\(nueva\)$/, "").split(".")[0].trim().toUpperCase();
  for (const e of ESPERADOS.cambios) {
    const tipo = e.tipo === "añadido" ? "anadido" : e.tipo;
    const c = r.cambios.find((x) => x.tipo === tipo && x.donde.toUpperCase().startsWith(titulo(e.clausula)));
    assert.ok(c, "falta el cambio " + e.tipo + " en " + e.clausula);
    if (e.antes) {
      const imp = c.importantes.find((i) => i.antes === e.antes && i.despues === e.despues);
      assert.ok(imp, e.clausula + ": falta «" + e.antes + "» → «" + e.despues + "»");
      assert.equal(imp.etiqueta, e.importante[0]);
    }
    const etiquetas = c.importantes.map((i) => i.etiqueta);
    if (e.importante.includes("clausula-nueva")) assert.ok(etiquetas.includes("clausula"), e.clausula + ": cláusula nueva");
    if (e.importante.includes("palabra-sensible")) assert.ok(etiquetas.includes("sensible"), e.clausula + ": palabra delicada");
  }
  // Las renumeradas no son cambios.
  for (const x of ESPERADOS.renumeradas_sin_cambios) {
    assert.ok(!r.cambios.some((c) => c.donde.toUpperCase().startsWith(x.despues.split(".")[0].toUpperCase())), "«" + x.despues + "» solo se ha renumerado");
  }
}

for (const [a, b] of [["contrato-v1.docx", "contrato-v2.docx"], ["contrato-v1.pdf", "contrato-v2.pdf"], ["contrato-v1.docx", "contrato-v2.pdf"], ["contrato-v1.pdf", "contrato-v2.docx"]]) {
  test("los cambios de cambios-esperados.json: " + a + " → " + b, { skip: sinWeb }, async () => {
    const { r } = await compararArchivos(f(a), f(b));
    comprobarEsperados(r);
  });
}

// ---------------------------------------------------------------- igual que la web
const PARES = PARIDAD ? Object.entries(PARIDAD.pares) : [];
for (const [par, web] of PARES) {
  test("lo mismo que el comparador de la web: " + par, { skip: sinWeb }, async () => {
    const [a, b] = par.split(" → ");
    for (const n of [a, b]) assert.equal(huella(path.join(F, n)), PARIDAD.huellas[n], "«" + n + "» ha cambiado en la web: vuelve a ejecutar python scripts/paridad_web.py");
    assert.ok(web.resumen, "la web no pudo comparar " + par + ": " + JSON.stringify(web));
    const { r } = await compararArchivos(f(a), f(b));
    assert.deepEqual(r.a, web.a, "párrafos de «" + a + "»");
    assert.deepEqual(r.b, web.b, "párrafos de «" + b + "»");
    assert.deepEqual(r.resumen, web.resumen);
    assert.deepEqual(r.cambios.map((c) => ({ tipo: c.tipo, donde: c.donde, importantes: c.importantes })), web.cambios);
  });
}

// El escaneo del contrato contra su versión con texto: casi los mismos párrafos (36 en el de
// texto) y solo los cambios que vienen de leer la imagen (letras mal leídas). En un navegador
// normal, la web lee 35 párrafos y da 9 cambios (28/09/2026).
test("un escaneo se lee párrafo a párrafo, casi igual que su versión con texto", { skip: sinWeb }, async () => {
  const { r, escaneados } = await compararArchivos(f("contrato-ficticio.pdf"), f("contrato-escaneado.pdf"));
  assert.deepEqual(escaneados, ["contrato-escaneado.pdf"]);
  assert.equal(r.a.length, 36);
  assert.ok(Math.abs(r.b.length - r.a.length) <= 2, "párrafos del escaneo: " + r.b.length);
  // Mejora 1 del hito 6: las letras mal leídas van aparte (en el escaneo de prueba, 8 de 10:
  // quedan de verdad el título del anexo, que el escaneo pega al párrafo de antes).
  assert.ok(r.resumen.total <= 3 && r.resumen.lectura >= 6, JSON.stringify(r.resumen));
  assert.ok(r.cambios.filter((c) => c.lectura).every((c) => !c.importantes.length));
});

// ---------------------------------------------------------------- Word: solo lo que se ve
test("del Word solo cuenta lo que se ve en el cuerpo: ni el encabezado, ni el comentario, ni lo borrado, ni los códigos de campo", () => {
  const M = comparadorMotor();
  const texto = textoDeWord(crearCorreoCliente(), "correo.docx");
  const parrafos = texto.split(/\n{2,}/).map((p) => M.unirLineas(p.split("\n"))).filter(Boolean);
  assert.ok(parrafos.includes("Te escribo en nombre de mi cliente, D. Juan Pérez García (DNI 12345678Z), con domicilio en Calle del Ejemplo 12, 3.º B, 28013 Madrid."));
  assert.ok(parrafos.includes("Escríbele") && parrafos.includes("Carmen Ruiz Ortega"));
  for (const oculto of ["699 123 456", "Cliente: Juan Pérez García", "Confirmar el DNI", "HYPERLINK", "mailto"]) assert.ok(!texto.includes(oculto), "no se ve y está: " + oculto);
});

test("datos personales tapados; importes, fechas y plazos a la vista", () => {
  const t = taparDatos("La arrendataria, Lucía Ejemplo Ficticia, con DNI 12345678Z, teléfono 612 345 678 y cuenta ES91 2100 0418 4502 0005 1332, pagará 950 euros antes del 5 de octubre de 2026, en 15 días.");
  for (const dato of ["Lucía", "Ficticia", "12345678Z", "612 345 678", "ES91 2100 0418 4502 0005 1332"]) assert.ok(!t.includes(dato), "sigue a la vista: " + dato);
  assert.match(t, /\*\*\*4567\*\*/);
  for (const visible of ["950 euros", "5 de octubre de 2026", "15 días"]) assert.ok(t.includes(visible), "tapado de más: " + visible);
  assert.equal(taparDatos("TERCERA. Renta"), "TERCERA. Renta");
  // Hito de actualización 17: un dato suelto se tapa según lo que es en su párrafo (una fecha
  // de nacimiento sola no dice que lo es).
  const nomina = "Fecha de nacimiento: 03/01/1978\nCategoría: Técnico administrativo\nTeléfono: 622 104 381 · Email: lucia.martin@example.com · Antigüedad: 01/02/2019";
  assert.equal(taparDatos("03/01/1978", nomina), "**/**/1978");
  assert.equal(taparDatos("01/02/2019", nomina), "01/02/2019");
});

test("el informe: una página sola, sin scripts ni nada de fuera, con el aviso y los cambios palabra a palabra", { skip: sinWeb }, async () => {
  const { r } = await compararArchivos(f("contrato-v1.docx"), f("contrato-v2.docx"));
  const html = informeHtml(r, { original: "contrato-v1.docx", nuevo: "contrato-v2.docx", fecha: "28/09/2026", escaneado: false });
  assert.doesNotMatch(html, /<script|<link|<img|<iframe|src=|https?:\/\//i);
  assert.match(html, /Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"/);
  assert.match(html, /<del>850<\/del><ins>950<\/ins>/);
  assert.ok(html.includes(AVISO));
  assert.match(html, /4 cambios \(2 modificados, 1 añadido, 1 eliminado\); 3 importantes\./);
  const escapado = informeHtml({ ...r, a: ["<b>hola</b>"], b: ["<b>adiós</b>"], cambios: [{ tipo: "modificado", a: 0, b: 0, donde: "<i>x</i>", importantes: [], palabras: [[-1, "<b>hola</b>"], [1, "<b>adiós</b>"]] }] },
    { original: "a", nuevo: "b", fecha: "", escaneado: false });
  assert.ok(!escapado.includes("<b>hola") && escapado.includes("&lt;b&gt;hola"), "el texto de los documentos va escapado");
});

// ---------------------------------------------------------------- mejora 3: Word con control de cambios
// Lo que se ve en Word al aceptar (o rechazar) todos los cambios, párrafo a párrafo.
function vistaWord(buf, aceptar) {
  const xml = datosDe(leerZip(buf).find((e) => e.nombre === "word/document.xml")).toString("utf8");
  const parrafos = [];
  for (const p of xml.match(/<w:p>[\s\S]*?<\/w:p>/g) || []) {
    if ((aceptar && /<w:pPr><w:rPr><w:del /.test(p)) || (!aceptar && /<w:pPr><w:rPr><w:ins /.test(p))) continue;   // párrafo que desaparece
    let t = "";
    const re = /<w:(ins|del) [^>]*?>([\s\S]*?)<\/w:\1>|<w:t xml:space="preserve">([^<]*)<\/w:t>/g;
    let m;
    const cuerpo = p.replace(/<w:pPr>[\s\S]*?<\/w:pPr>/, "");
    while ((m = re.exec(cuerpo))) {
      if (m[1] === "ins" && aceptar) t += (m[2].match(/<w:t xml:space="preserve">([^<]*)<\/w:t>/g) || []).map((x) => x.replace(/<[^>]+>/g, "")).join("");
      else if (m[1] === "del" && !aceptar) t += (m[2].match(/<w:delText xml:space="preserve">([^<]*)<\/w:delText>/g) || []).map((x) => x.replace(/<[^>]+>/g, "")).join("");
      else if (!m[1]) t += m[3];
    }
    parrafos.push(decodificarXml(t));
  }
  return parrafos;
}

// Todas las etiquetas del XML abren y cierran en orden.
function bienFormado(xml) {
  const pila = [];
  for (const m of xml.matchAll(/<(\/?)([\w:]+)[^>]*?(\/?)>/g)) {
    if (m[3]) continue;
    if (!m[1]) pila.push(m[2]);
    else if (pila.pop() !== m[2]) return false;
  }
  return pila.length === 0;
}

test("el Word con control de cambios: al aceptarlo todo queda la versión nueva, y al rechazarlo, la anterior", { skip: sinWeb }, async () => {
  for (const [a, b] of [["contrato-v1.docx", "contrato-v2.docx"], ["contrato-cabeceras-v1.pdf", "contrato-cabeceras-v2.pdf"]]) {
    const { r } = await compararArchivos(f(a), f(b));
    const doc = wordConCambios(r, { original: a, nuevo: b, fecha: new Date(2026, 8, 28, 12) });
    const entradas = leerZip(doc);
    for (const e of entradas.filter((x) => x.nombre.endsWith(".xml") || x.nombre.endsWith(".rels"))) assert.ok(bienFormado(datosDe(e).toString("utf8")), a + ": " + e.nombre + " mal formado");
    assert.deepEqual(vistaWord(doc, true), r.b, a + ": aceptando todo");
    assert.deepEqual(vistaWord(doc, false), r.a, a + ": rechazando todo");
    // Lo lee también el lector de Word de la extensión (lo que se ve: la versión nueva).
    const M = comparadorMotor();
    assert.deepEqual(textoDeWord(doc, "x.docx").split(/\n{2,}/).map((p) => M.unirLineas(p.split("\n"))).filter(Boolean), r.b);
    const xml = datosDe(entradas.find((e) => e.nombre === "word/document.xml")).toString("utf8");
    assert.match(xml, /<w:del w:id="\d+" w:author="docuprivado"/);
    assert.match(xml, /<w:ins w:id="\d+" w:author="docuprivado"/);
    assert.match(datosDe(entradas.find((e) => e.nombre === "word/settings.xml")).toString("utf8"), /<w:trackRevisions\/>/);
    assert.match(datosDe(entradas.find((e) => e.nombre === "docProps/core.xml")).toString("utf8"), /<dc:creator>docuprivado<\/dc:creator>/);
  }
});

test("mejora 2: una cláusula movida de sitio (y cambiada) es un solo cambio, y el Word lo refleja", () => {
  const A = ["PRIMERA. Objeto. La vivienda de la calle del Ejemplo.", "SEGUNDA. Duración. Un año desde la firma del contrato.",
    "TERCERA. Renta. 850 euros al mes pagaderos por transferencia.", "CUARTA. Fianza. Una mensualidad de renta en metálico."];
  const B = [A[0], "SEGUNDA. Renta. 850 euros al mes pagaderos por transferencia.", "TERCERA. Fianza. Una mensualidad de renta en metálico.",
    "CUARTA. Duración. Dos años desde la firma del contrato."];
  const r = comparadorMotor().comparar(A, B);
  assert.equal(r.resumen.total, 1);
  assert.equal(r.resumen.movidos, 1);
  assert.deepEqual([r.cambios[0].tipo, r.cambios[0].donde, r.cambios[0].desde], ["movido", "CUARTA. Duración", "SEGUNDA. Duración"]);
  assert.deepEqual(r.cambios[0].importantes, [{ etiqueta: "plazo", antes: "Un año", despues: "Dos años" }]);
  const doc = wordConCambios(r, { original: "a", nuevo: "b" });
  assert.deepEqual(vistaWord(doc, true), B);
  assert.deepEqual(vistaWord(doc, false), A);
});

test("errores claros al leer: sin texto, formato que no es y PDF con contraseña", { skip: sinWeb }, async () => {
  await assert.rejects(leerParrafos(f("protegido.pdf")), (e) => e.codigo === "contrasena" && /comparar-documentos/.test(e.message));
  await assert.rejects(leerParrafos(f("danado.pdf")), (e) => e.codigo === "danado");
  await assert.rejects(leerParrafos(f("captura-ficticia.png")), (e) => e.codigo === "formato");
});

// ---------------------------------------------------------------- la herramienta
// La carpeta temporal, por su nombre real, como trabaja la extensión: en macOS está detrás de
// un enlace (/var → /private/var) y en Windows puede venir con nombres cortos (RUNNER~1).
const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "docuprivado-comparar-")));
const docs = path.join(base, "Contratos Ñ");
const fuera = path.join(base, "fuera");
fs.mkdirSync(docs, { recursive: true });
fs.mkdirSync(fuera);
if (hayWeb) {
  for (const n of ["contrato-v1.docx", "contrato-v2.docx", "contrato-v2.pdf", "contrato-ficticio.pdf", "contrato-escaneado.pdf", "protegido.pdf", "captura-ficticia.png"]) {
    fs.copyFileSync(path.join(F, n), path.join(docs, n));
  }
  fs.copyFileSync(path.join(F, "contrato-v1.docx"), path.join(fuera, "contrato-fuera.docx"));
}
// Dos versiones de texto ficticias con una cláusula nueva que nombra a una persona con su DNI.
fs.writeFileSync(path.join(docs, "aval-v1.txt"), "PRIMERA. Objeto.\n\nEl arrendador alquila la vivienda.\n\nSEGUNDA. Renta.\n\nLa renta es de 850 euros al mes.\n");
fs.writeFileSync(path.join(docs, "aval-v2.txt"), "PRIMERA. Objeto.\n\nEl arrendador alquila la vivienda.\n\nSEGUNDA. Renta.\n\nLa renta es de 900 euros al mes.\n\n" +
  "TERCERA. Avalista Juan Pérez García. Con DNI 12345678Z, responde de la renta hasta 3.000 euros.\n");
const originales = hayWeb ? fs.readdirSync(docs).map((n) => [n, huella(path.join(docs, n))]) : [];

let s;
let fin;
before(async () => {
  s = arrancar({ carpetas: [docs] });
  await s.iniciar();
});
after(async () => {
  if (s && !fin) fin = await s.cerrar();
  fs.rmSync(base, { recursive: true, force: true });
});
const texto = (r) => r.result.content.map((c) => c.text).join("\n");

test("comparar dos Word: recuento, cambios importantes con su antes → después, informe guardado y el aviso", { skip: sinWeb }, async () => {
  const r = await s.llamar("comparar_documentos", { original: "contrato-v1.docx", nuevo: "contrato-v2.docx" });
  assert.equal(r.result.isError, undefined, texto(r));
  const d = s.largas(r.result.structuredContent);
  assert.deepEqual(d.resumen, { total: 4, anadidos: 1, eliminados: 1, modificados: 2, movidos: 0, importantes: 3, lectura: 0 });
  assert.equal(path.basename(d.informe), "comparacion-contrato-v1-contrato-v2.html");
  assert.equal(path.dirname(d.informe), path.join(docs, "docuprivado"));
  assert.ok(fs.existsSync(d.informe));
  const t = texto(r);
  assert.match(t, /4 cambios \(2 modificados, 1 añadido, 1 eliminado\); 3 importantes\./);
  assert.match(t, /- TERCERA\. Renta \(modificado\): importe, 850 euros → 950 euros\./);
  assert.match(t, /- SEXTA\. Desistimiento \(modificado\): fecha o plazo, 30 días → 15 días\./);
  assert.match(t, /- SÉPTIMA\. Penalización \(añadido\): cláusula nueva «SÉPTIMA\. Penalización»; palabra delicada: penalización\./);
  assert.match(t, /Otros cambios: QUINTA\. Gastos \(párrafo 3\) \(eliminado\)\./);
  // Mejora 3: el Word con control de cambios, junto al informe y con su mismo nombre.
  assert.equal(path.basename(d.word), "comparacion-contrato-v1-contrato-v2.docx");
  assert.match(t, /Word con control de cambios/);
  assert.match(t, /Se abre con Word o con LibreOffice \(gratis\); si no tienes ninguno de los dos, el informe del navegador enseña los mismos cambios\./);
  assert.ok(t.includes(AVISO));
  assert.doesNotMatch(t, /datos personales van tapados/, "no se ha tapado nada: no se dice");
  // La segunda vez no pisa el informe anterior.
  const r2 = await s.llamar("comparar_documentos", { original: "contrato-v1.docx", nuevo: "contrato-v2.pdf" });
  assert.equal(s.largas(r2.result.structuredContent).resumen.total, 4);
  assert.equal(path.basename(s.largas(r2.result.structuredContent).informe), "comparacion-contrato-v1-contrato-v2 (2).html");
  assert.equal(path.basename(s.largas(r2.result.structuredContent).word), "comparacion-contrato-v1-contrato-v2 (2).docx", "el Word lleva el mismo número que su informe");
  const sinWord = await s.llamar("comparar_documentos", { original: "contrato-v1.docx", nuevo: "contrato-v2.docx", control_de_cambios: false });
  assert.equal(s.largas(sinWord.result.structuredContent).word, null);
});

test("lo que va al chat lleva los datos personales tapados; el informe, en tu carpeta, completo", { skip: sinWeb }, async () => {
  const r = await s.llamar("comparar_documentos", { original: "aval-v1.txt", nuevo: "aval-v2.txt" });
  const d = s.largas(r.result.structuredContent);
  const t = texto(r);
  const todo = JSON.stringify(r.result);
  for (const dato of ["12345678Z", "Pérez García"]) assert.ok(!todo.includes(dato), "la respuesta lleva «" + dato + "»");
  assert.match(t, /\(los datos personales van tapados\)/);
  assert.match(t, /importe, 850 euros → 900 euros/);
  assert.match(t, /3\.000 euros/);
  assert.ok(d.importantes.some((c) => c.tipo === "anadido"));
  const html = fs.readFileSync(d.informe, "utf8");
  assert.ok(html.includes("12345678Z") && html.includes("Juan Pérez García"), "el informe es para ti: va completo");
});

test("un escaneo contra el PDF con texto: se lee con el lector y se avisa", { skip: sinWeb }, async () => {
  const r = await s.llamar("comparar_documentos", { original: "contrato-ficticio.pdf", nuevo: "contrato-escaneado.pdf" });
  assert.equal(r.result.isError, undefined, texto(r));
  const d = s.largas(r.result.structuredContent);
  assert.deepEqual(d.escaneados.map((x) => path.basename(x)), ["contrato-escaneado.pdf"]);
  assert.match(texto(r), /«contrato-escaneado\.pdf» era un escaneo: su texto se ha leído automáticamente/);
  assert.ok(d.resumen.lectura >= 6 && d.lectura.length === d.resumen.lectura);
  assert.match(texto(r), /Posibles errores de lectura del escaneo \(letras o signos mal leídos/);
  assert.match(fs.readFileSync(d.informe, "utf8"), /posible error de lectura/);
});

test("una cláusula movida de sitio: el chat dice de dónde viene", { skip: sinWeb }, async () => {
  fs.writeFileSync(path.join(docs, "movida-v1.txt"), "PRIMERA. Objeto. La vivienda de la calle del Ejemplo.\n\nSEGUNDA. Duración. Un año desde la firma del contrato.\n\n" +
    "TERCERA. Renta. 850 euros al mes pagaderos por transferencia.\n\nCUARTA. Fianza. Una mensualidad de renta en metálico.\n");
  fs.writeFileSync(path.join(docs, "movida-v2.txt"), "PRIMERA. Objeto. La vivienda de la calle del Ejemplo.\n\nSEGUNDA. Renta. 850 euros al mes pagaderos por transferencia.\n\n" +
    "TERCERA. Fianza. Una mensualidad de renta en metálico.\n\nCUARTA. Duración. Dos años desde la firma del contrato.\n");
  const r = await s.llamar("comparar_documentos", { original: "movida-v1.txt", nuevo: "movida-v2.txt" });
  assert.match(texto(r), /1 cambio \(1 movido de sitio\); 1 importante\./);
  assert.match(texto(r), /- CUARTA\. Duración \(movido de sitio \(antes en SEGUNDA\. Duración\)\): fecha o plazo, Un año → Dos años\./);
  assert.equal(s.largas(r.result.structuredContent).importantes[0].desde, "SEGUNDA. Duración");
});

test("errores claros: el mismo archivo dos veces, una foto, un PDF con contraseña y fuera de las carpetas", { skip: sinWeb }, async () => {
  const casos = [
    [{ original: "contrato-v1.docx", nuevo: "contrato-v1.docx" }, /mismo archivo dos veces/],
    [{ original: "captura-ficticia.png", nuevo: "contrato-v1.docx" }, /no es un Word \(\.docx\), un PDF ni un archivo de texto/],
    [{ original: "protegido.pdf", nuevo: "contrato-v2.pdf" }, /tiene contraseña.*no me la escribas en el chat/],
    [{ original: path.join(fuera, "contrato-fuera.docx"), nuevo: "contrato-v2.docx" }, /fuera de las carpetas que autorizaste/],
    [{ original: "contrato-v1.docx", nuevo: "contrato-v2.docx", carpeta_salida: fuera }, /fuera de las carpetas/],
  ];
  for (const [args, re] of casos) {
    const r = await s.llamar("comparar_documentos", args);
    assert.equal(r.result.isError, true, JSON.stringify(args));
    assert.match(texto(r), re);
  }
  assert.deepEqual(fs.readdirSync(fuera), ["contrato-fuera.docx"], "nada escrito fuera");
});

test("los originales no cambian y el registro no lleva nombres ni lo que pone en los documentos", { skip: sinWeb }, async () => {
  for (const [n, h] of originales) assert.equal(huella(path.join(docs, n)), h, n + " ha cambiado");
  fin = await s.cerrar();
  assert.equal(fin.lineasMalas.length, 0);
  assert.match(fin.stderr, /ningún intento de conexión/);
  assert.match(fin.stderr, /comparar_documentos: bien/);
  assert.doesNotMatch(fin.stderr, /Contratos Ñ|contrato-v1|aval-v|Pérez|12345678Z|950 euros|Penalización/i);
});

test("un escaneo que no cabe en el tiempo de una llamada sigue en segundo plano y se entrega con «continúa»", { skip: sinWeb }, async () => {
  const lento = arrancar({ carpetas: [docs], presupuestoMs: 50 });
  await lento.iniciar();
  try {
    const args = { original: "contrato-ficticio.pdf", nuevo: "contrato-escaneado.pdf" };
    const r1 = await lento.llamar("comparar_documentos", args);
    assert.equal(s.largas(r1.result.structuredContent).pendiente, true);
    assert.match(texto(r1), /Dime «continúa»/);
    let r;
    for (let i = 0; i < 60; i++) {
      await new Promise((ok) => setTimeout(ok, 500));
      r = await lento.llamar("comparar_documentos", args);
      if (!s.largas(r.result.structuredContent).pendiente) break;
    }
    assert.equal(s.largas(r.result.structuredContent).pendiente, false);
    assert.ok(s.largas(r.result.structuredContent).informe && fs.existsSync(s.largas(r.result.structuredContent).informe));
  } finally {
    await lento.cerrar();
  }
});
