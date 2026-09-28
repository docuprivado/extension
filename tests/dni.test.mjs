/*
 * Copia protegida del DNI (proteger_copia_dni, hito 5), con las fotos ficticias de la web
 * (tests/fixtures: la tarjeta «DOCUMENTO DE PRUEBA», el pasaporte y el banco de 24 escenas):
 * - el recorte es el de la web: mismo buscador de bordes, mismas esquinas y la misma
 *   confianza (tests/paridad/web-bordes.json, scripts/paridad_web.py);
 * - el PDF mide lo que debe: A4 con cada cara a 242,65 × 153,01 pt (85,60 × 53,98 mm), y las
 *   imágenes, 1011 × 638 px (pasaporte 1476 × 1039);
 * - la marca va fundida en los píxeles (no es texto que se pueda quitar) y se lee;
 * - sin finalidad no se hace nada: se pide; los originales no se tocan; los nombres no se pisan;
 * - cargar OpenCV no deja nada enganchado al proceso ni variables globales.
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
import {
  A4, FORMATOS, _paraPruebas, abrirCaras, buscarDosCaras, fundirMarca, imagenJpg, mediaVuelta, nombreDeMarca, prepararCara, reconocerCara, textoDeMarca,
} from "../server/core/copia-dni.js";
import { abrirFoto, metadatos } from "../server/core/imagenes.js";
import { cerrarLector, leer } from "../server/core/lector.js";
import { bordesDni, jpeg, pdfLib, pdfium, pdfjs, png } from "../server/core/motores.js";

const RAIZ = fileURLToPath(new URL("..", import.meta.url));
const WEB = path.resolve(process.env.DOCUPRIVADO_WEB || path.join(RAIZ, "..", "WEB A"));
const F = path.join(WEB, "tests", "fixtures");
const hayWeb = fs.existsSync(path.join(F, "dni-facil-anverso.jpg"));
const sinWeb = !hayWeb && "no encuentro los documentos de prueba de la web";
const WEB_BORDES = JSON.parse(fs.readFileSync(new URL("paridad/web-bordes.json", import.meta.url), "utf8"));
const huella = (f) => createHash("sha256").update(fs.readFileSync(f)).digest("hex");

after(() => cerrarLector());

// ---------------------------------------------------------------- recorte (como la web)
function distanciaMaxima(a, b) {
  return Math.max(...a.map((p, i) => Math.hypot(p.x - b[i][0], p.y - b[i][1])));
}

test("mismo recorte que la web en las fotos de las pruebas: mismas esquinas y misma confianza", { skip: sinWeb }, async () => {
  const B = await bordesDni();
  for (const ruta of ["dni-facil-anverso.jpg", "dni-facil-reverso.jpg", "pasaporte-prueba.jpg", "dni-dificil.jpg", "_tarjeta-anverso-plana.png"]) {
    const w = WEB_BORDES.archivos[ruta];
    assert.equal(huella(path.join(F, ruta)), w.sha256, "La foto de prueba ha cambiado en la web: vuelve a ejecutar python scripts/paridad_web.py");
    const foto = await abrirFoto(new Uint8Array(fs.readFileSync(path.join(F, ruta))), ruta, 2500);
    assert.deepEqual([foto.img.width, foto.img.height], [w.ancho, w.alto], ruta);
    const r = B.detectar(foto.img, w.formato);
    assert.equal(r.confianza, w.confianza, ruta);
    // Mismas esquinas: a menos del 3 % del lado corto de la foto (los JPG los abre otro
    // decodificador y algún píxel sale distinto; en la mayoría, a menos del 0,1 %).
    assert.ok(distanciaMaxima(r.esquinas, w.esquinas) < 0.03 * Math.min(w.ancho, w.alto), ruta + ": esquinas distintas de las de la web");
  }
});

// En el banco de 24 escenas y las 5 fotos, la extensión y la web tienen que opinar igual en
// casi todas. Las diferencias (3 de 29 el 28/09/2026: escenas 5, 19 y 24) vienen del
// decodificador de JPG y se reparten a favor y en contra: docs/DECISIONES.md, hito 5.
test("banco de escenas del Kit DNI: la misma confianza que la web en al menos 26 de 29 fotos", { skip: sinWeb }, async () => {
  const B = await bordesDni();
  const distintas = [];
  for (const [ruta, w] of Object.entries(WEB_BORDES.archivos)) {
    const foto = await abrirFoto(new Uint8Array(fs.readFileSync(path.join(F, ruta))), ruta, 2500);
    const r = B.detectar(foto.img, w.formato);
    if (r.confianza !== w.confianza) distintas.push(ruta + " (web " + w.confianza + ", extensión " + r.confianza + ")");
  }
  assert.ok(distintas.length <= 3, "Demasiadas diferencias con la web: " + distintas.join("; "));
});

// Error medio de las esquinas frente a las de verdad, como la página de pruebas de la web
// (WEB A/tests/bordes/ejecutar.js): bueno si es ≤ 2,5 % y la confianza no es baja.
function errorFrenteReal(esq, reales) {
  if (!esq) return Infinity;
  const lado = Math.min(Math.hypot(reales[1][0] - reales[0][0], reales[1][1] - reales[0][1]), Math.hypot(reales[3][0] - reales[0][0], reales[3][1] - reales[0][1]));
  let mejor = Infinity;
  for (let g = 0; g < 4; g++) for (const s of [1, -1]) {
    let t = 0;
    for (let i = 0; i < 4; i++) { const r = reales[((g + s * i) % 4 + 4) % 4]; t += Math.hypot(esq[i].x - r[0], esq[i].y - r[1]); }
    mejor = Math.min(mejor, t / 4);
  }
  return 100 * mejor / lado;
}

test("banco de escenas: al menos 17 de 26 recortes automáticos buenos, como la web, y ninguna confianza baja se recorta", { skip: sinWeb }, async () => {
  const casos = JSON.parse(fs.readFileSync(path.join(F, "bordes", "esquinas.json"), "utf8")).casos.map((c) => ({ ruta: "bordes/" + c.archivo, reales: c.esquinas }));
  casos.push({ ruta: "dni-facil-anverso.jpg", reales: [[262, 232], [1332, 276], [1298, 948], [228, 902]] });
  casos.push({ ruta: "dni-facil-reverso.jpg", reales: [[250, 262], [1318, 230], [1352, 910], [282, 944]] });
  const B = await bordesDni();
  let buenos = 0;
  const inventadas = [];
  for (const c of casos) {
    const foto = await abrirFoto(new Uint8Array(fs.readFileSync(path.join(F, c.ruta))), c.ruta, 2500);
    const r = B.detectar(foto.img, "id1");
    if (errorFrenteReal(r.esquinas, c.reales) <= 2.5 && r.confianza !== "baja") buenos++;
    // Con confianza baja la cara va entera, sin recortar (en la web se ajusta a mano).
    if (r.confianza === "baja") assert.equal((await prepararCara(foto.img, "id1")).recorte, "sin_bordes", c.ruta);
    // Mejora 1: en una foto con una sola tarjeta no se puede inventar una segunda.
    if (await buscarDosCaras(foto.img, "id1")) inventadas.push(c.ruta);
  }
  assert.ok(buenos >= 17, "Solo " + buenos + " recortes buenos de " + casos.length);
  assert.deepEqual(inventadas, [], "segunda tarjeta inventada");
});

// ---------------------------------------------------------------- mejora 1: dos caras en una imagen
const DOS = hayWeb ? JSON.parse(fs.readFileSync(path.join(F, "bordes", "dos-caras.json"), "utf8")).casos : [];

test("las dos caras en la misma foto u hoja escaneada: al menos 6 de 7 escenas separadas bien, en orden de lectura", { skip: sinWeb }, async () => {
  const bien = [];
  for (const c of DOS) {
    const foto = await abrirFoto(new Uint8Array(fs.readFileSync(path.join(F, "bordes", c.archivo))), c.archivo, 2500);
    const dos = await buscarDosCaras(foto.img, "id1");
    if (dos && c.tarjetas.every((t, i) => errorFrenteReal(dos[i].esquinas, t.esquinas) <= 2.5)) bien.push(c.archivo);
  }
  assert.ok(bien.length >= 6, "Solo " + bien.length + " de " + DOS.length + ": " + bien.join(", "));
  for (const n of ["01", "02", "03"]) assert.ok(bien.includes("dos-caras-" + n + ".jpg"), "la hoja escaneada " + n + " tiene que separarse");
});

test("las dos caras en la misma imagen: lo mismo que la web (mismo número de tarjetas y mismas esquinas)", { skip: sinWeb || (!WEB_BORDES.dosCaras && "falta volver a ejecutar python scripts/paridad_web.py") }, async () => {
  const B = await bordesDni();
  for (const [ruta, w] of Object.entries(WEB_BORDES.dosCaras)) {
    assert.equal(huella(path.join(F, ruta)), w.sha256, "La escena ha cambiado en la web: vuelve a ejecutar python scripts/paridad_web.py");
    const foto = await abrirFoto(new Uint8Array(fs.readFileSync(path.join(F, ruta))), ruta, 2500);
    const nuestras = B.detectarVarias(foto.img, "id1", 2);
    assert.equal(nuestras.length, w.tarjetas.length, ruta);
    nuestras.forEach((r, i) => {
      if (!r.esquinas || !w.tarjetas[i].esquinas) return;
      assert.ok(distanciaMaxima(r.esquinas, w.tarjetas[i].esquinas) < 0.03 * Math.min(foto.img.width, foto.img.height), ruta + ": tarjeta " + (i + 1) + " distinta de la web");
    });
  }
});

// ---------------------------------------------------------------- mejora 2: derecha y en su sitio
test("reconocer la cara: la delantera derecha no se toca, del revés se gira y la trasera se reconoce por sus líneas «<<<<»", { skip: sinWeb }, async () => {
  const [a] = await abrirCaras({ ruta: path.join(F, "dni-facil-anverso.jpg"), nombre: "a" }, 1);
  const [b] = await abrirCaras({ ruta: path.join(F, "dni-facil-reverso.jpg"), nombre: "b" }, 1);
  const delantera = (await prepararCara(a.img, "id1")).img;
  const trasera = (await prepararCara(b.img, "id1")).img;
  const r1 = await reconocerCara(delantera);
  assert.deepEqual([r1.delReves, r1.lineasDeAbajo, r1.leida], [false, false, true]);
  assert.equal(r1.img, delantera);
  const r2 = await reconocerCara(trasera);
  assert.deepEqual([r2.delReves, r2.lineasDeAbajo], [false, true]);
  const r3 = await reconocerCara(mediaVuelta(delantera));
  assert.equal(r3.delReves, true);
  assert.deepEqual(Buffer.from(r3.img.data), Buffer.from(delantera.data), "girada dos veces es la de antes");
  const r4 = await reconocerCara(mediaVuelta(trasera));
  assert.deepEqual([r4.delReves, r4.lineasDeAbajo], [true, true]);
});

// ---------------------------------------------------------------- mejora 3: una copia por trámite
test("nombre corto de cada finalidad para el archivo", () => {
  assert.equal(nombreDeMarca("Solo para la inmobiliaria"), "la-inmobiliaria");
  assert.equal(nombreDeMarca("Sólo para apertura de cuenta en Banco Ejemplo"), "apertura-de-cuenta-en-banco");
  assert.equal(nombreDeMarca("Copia para Hacienda"), "hacienda");
  assert.equal(nombreDeMarca("Alquiler en Logroño (piso 3.º)"), "alquiler-en-logrono-piso-3");
  assert.equal(nombreDeMarca("¡!"), "");
});

test("girar: 180° da la misma cara del revés; 90° con la foto entera la pone de lado", { skip: sinWeb }, async () => {
  const [c] = await abrirCaras({ ruta: path.join(F, "dni-facil-anverso.jpg"), nombre: "a" }, 1);
  const recta = await prepararCara(c.img, "id1");
  const vuelta = await prepararCara(c.img, "id1", { girar: 180 });
  const { data: a, width: w, height: h } = recta.img;
  let diferencia = 0;
  for (let y = 0; y < h; y += 7) {
    for (let x = 0; x < w; x += 7) {
      const o = (y * w + x) * 4;
      const o2 = ((h - 1 - y) * w + (w - 1 - x)) * 4;
      diferencia += Math.abs(a[o] - vuelta.img.data[o2]);
    }
  }
  assert.ok(diferencia / ((w / 7) * (h / 7)) < 12, "la cara girada 180° no es la misma del revés");
  const deLado = await prepararCara(c.img, "id1", { automatico: false, girar: 90 });
  assert.equal(deLado.recorte, "sin_recortar");
  assert.deepEqual([deLado.img.width, deLado.img.height], FORMATOS.id1.px);
  // La foto (1600 × 1200) girada queda de pie: blanco a los lados, foto en el centro.
  const px = (x, y) => deLado.img.data[(y * 1011 + x) * 4];
  assert.equal(px(5, 319), 255);
  assert.notEqual(px(505, 319), 255);
});

test("cuadriláteros válidos y giro de esquinas, como la web", () => {
  const { cuadrilateroValido, rotarEsquinas } = _paraPruebas;
  const q = [{ x: 100, y: 100 }, { x: 900, y: 120 }, { x: 880, y: 600 }, { x: 90, y: 580 }];
  assert.ok(cuadrilateroValido(q, 1000, 700));
  assert.ok(!cuadrilateroValido([{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 50 }, { x: 0, y: 50 }], 1000, 700), "demasiado pequeño");
  assert.ok(!cuadrilateroValido(null, 1000, 700));
  assert.deepEqual(rotarEsquinas(q, 1), [q[3], q[0], q[1], q[2]]);
  assert.deepEqual(rotarEsquinas(q, 4), q);
});

// ---------------------------------------------------------------- marca de agua
test("la marca: con la fecha de hoy, sin emojis y con el texto de la web", async () => {
  assert.equal(await textoDeMarca("  Solo para   alquiler de vivienda ", true, new Date(2026, 8, 28)), "Solo para alquiler de vivienda · 28/09/2026");
  assert.equal(await textoDeMarca("Solo para el banco", false), "Solo para el banco");
  assert.equal(await textoDeMarca("", true), "");
  assert.equal(await textoDeMarca("Sólo para la Agencia Tributaria: ñ, ü, ¿? ¡! € «»", false), "Sólo para la Agencia Tributaria: ñ, ü, ¿? ¡! € «»");
  await assert.rejects(textoDeMarca("Solo para 😀", false), (e) => e.codigo === "marcaCaracteres" && /😀/.test(e.message));
  await assert.rejects(textoDeMarca("Только", false), (e) => e.codigo === "marcaCaracteres");
});

test("la marca queda fundida en los píxeles y se lee (franja, que el lector lee en horizontal)", { skip: sinWeb }, async () => {
  const [c] = await abrirCaras({ ruta: path.join(F, "dni-facil-anverso.jpg"), nombre: "a" }, 1);
  const sinMarca = await prepararCara(c.img, "id1");
  const conMarca = await prepararCara(c.img, "id1");
  await fundirMarca(conMarca.img, { texto: "Solo para alquiler de vivienda", estilo: "franja" });
  let cambiados = 0;
  for (let i = 0; i < sinMarca.img.data.length; i += 4) if (Math.abs(sinMarca.img.data[i] - conMarca.img.data[i]) > 8) cambiados++;
  assert.ok(cambiados > 0.1 * 1011 * 638, "la franja tiene que cubrir buena parte de la tarjeta");
  const buf = png().sync.write({ width: 1011, height: 638, data: Buffer.from(conMarca.img.data) });
  const leido = await leer(buf, { text: true });
  assert.match(leido.data ? leido.data.text : leido.text, /alquiler de vivienda/i);
  // La diagonal, por toda la tarjeta: también sobre la foto y sobre los datos.
  const diagonal = await prepararCara(c.img, "id1");
  await fundirMarca(diagonal.img, { texto: "Solo para alquiler de vivienda · 28/09/2026" });
  const zonas = [[40, 100, 280, 420], [320, 90, 640, 440], [600, 450, 1000, 630]];   // foto, datos y abajo a la derecha
  for (const [x0, y0, x1, y1] of zonas) {
    let n = 0;
    for (let y = y0; y < y1; y += 2) for (let x = x0; x < x1; x += 2) { const o = (y * 1011 + x) * 4; if (Math.abs(sinMarca.img.data[o] - diagonal.img.data[o]) > 8) n++; }
    assert.ok(n > 0.05 * ((x1 - x0) / 2) * ((y1 - y0) / 2), "la marca no cruza la zona " + [x0, y0, x1, y1].join(","));
  }
});

test("cargar OpenCV no deja enganches al proceso ni variables globales", async () => {
  await bordesDni();
  // Los de OpenCV: «abort» para las promesas sin atender y el que relanza todo lo que no sea
  // su «ExitStatus». (El corredor de pruebas pone los suyos: esos no cuentan.)
  const deOpencv = (l) => /ExitStatus|^function abort\(/.test(String(l));
  assert.ok(!process.listeners("unhandledRejection").some(deOpencv));
  assert.ok(!process.listeners("uncaughtException").some(deOpencv));
  assert.equal(typeof globalThis.Module, "undefined");
  assert.equal(typeof globalThis.cv, "undefined");
});

// ---------------------------------------------------------------- la herramienta
// La carpeta temporal, por su nombre real, como trabaja la extensión: en macOS está detrás de
// un enlace (/var → /private/var) y en Windows puede venir con nombres cortos (RUNNER~1).
const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "docuprivado-dni-")));
const docs = path.join(base, "Mis Documentos Ñ");
const fuera = path.join(base, "fuera");
fs.mkdirSync(path.join(docs, "DNI"), { recursive: true });
fs.mkdirSync(fuera);
const COPIAS = [["dni-facil-anverso.jpg", "DNI/dni-frente.jpg"], ["dni-facil-reverso.jpg", "DNI/dni-detras.jpg"], ["pasaporte-prueba.jpg", "pasaporte.jpg"],
  ["bordes/escena-08.jpg", "dni-en-el-sofa.jpg"], ["contrato-v1.docx", "contrato.docx"], ["dni-facil-anverso.jpg", "fuera"],
  ["bordes/dos-caras-01.jpg", "DNI/escaneo-dos-caras.jpg"], ["bordes/dos-caras-05.jpg", "dos-caras-trasera-arriba.jpg"]];
if (hayWeb) for (const [de, a] of COPIAS) fs.copyFileSync(path.join(F, de), a === "fuera" ? path.join(fuera, "dni.jpg") : path.join(docs, a));
const huellas = hayWeb ? Object.fromEntries(COPIAS.filter(([, a]) => a !== "fuera").map(([, a]) => [a, huella(path.join(docs, a))])) : {};

let s;
let fin;
before(async () => {
  if (!hayWeb) return;
  // Un PDF con las dos caras (una por página), como el que saca un escáner.
  const { PDFDocument } = pdfLib();
  const pdf = await PDFDocument.create();
  for (const f of ["dni-facil-anverso.jpg", "dni-facil-reverso.jpg"]) {
    const img = await pdf.embedJpg(fs.readFileSync(path.join(F, f)));
    pdf.addPage([img.width * 0.36, img.height * 0.36]).drawImage(img, { x: 0, y: 0, width: img.width * 0.36, height: img.height * 0.36 });
  }
  fs.writeFileSync(path.join(docs, "DNI", "dni-escaneado.pdf"), await pdf.save());
  // La foto de la delantera hecha del revés (mejora 2).
  const recta = await abrirFoto(new Uint8Array(fs.readFileSync(path.join(F, "dni-facil-anverso.jpg"))), "a", 2500);
  fs.writeFileSync(path.join(docs, "DNI", "dni-frente-del-reves.jpg"), imagenJpg(mediaVuelta(recta.img)));
  s = arrancar({ carpetas: [docs] });
  await s.iniciar();
});
after(async () => {
  if (s && !fin) fin = await s.cerrar();
  fs.rmSync(base, { recursive: true, force: true });
});
const texto = (r) => r.result.content.map((c) => c.text).join("\n");

// Lee el PDF generado: tamaño de la hoja, medidas de cada imagen y el texto que lleva.
async function leerPdf(ruta) {
  const bytes = fs.readFileSync(ruta);
  const P = await pdfium();
  const M = P.pdfium;
  const ptr = M.wasmExports.malloc(bytes.length);
  M.HEAPU8.set(bytes, ptr);
  const doc = P.FPDF_LoadMemDocument(ptr, bytes.length, "");
  const cajas = M.wasmExports.malloc(16);
  const out = { paginas: P.FPDF_GetPageCount(doc), imagenes: [] };
  const pg = P.FPDF_LoadPage(doc, 0);
  out.hoja = [P.FPDF_GetPageWidthF(pg), P.FPDF_GetPageHeightF(pg)];
  for (let i = 0; i < P.FPDFPage_CountObjects(pg); i++) {
    const obj = P.FPDFPage_GetObject(pg, i);
    if (P.FPDFPageObj_GetType(obj) !== 3) continue;
    P.FPDFPageObj_GetBounds(obj, cajas, cajas + 4, cajas + 8, cajas + 12);
    const [l, b, r, t] = Array.from(M.HEAPF32.subarray(cajas / 4, cajas / 4 + 4));
    out.imagenes.push([Math.round((r - l) * 100) / 100, Math.round((t - b) * 100) / 100]);
  }
  P.FPDF_ClosePage(pg);
  P.FPDF_CloseDocument(doc);
  M.wasmExports.free(cajas);
  M.wasmExports.free(ptr);
  const tarea = (await pdfjs()).getDocument({ data: new Uint8Array(bytes), verbosity: 0, isEvalSupported: false, disableFontFace: true });
  const d = await tarea.promise;
  out.texto = (await (await d.getPage(1)).getTextContent()).items.map((x) => x.str).join(" ").trim();
  out.info = (await d.getMetadata()).info;
  await tarea.destroy();
  out.bytes = bytes;
  return out;
}

test("sin finalidad no se hace nada: pide para qué es la copia", { skip: sinWeb }, async () => {
  const r = await s.llamar("proteger_copia_dni", { delantera: "dni-frente.jpg", trasera: "dni-detras.jpg" });
  assert.equal(r.result.isError, true);
  assert.match(texto(r), /para qué es.*texto_marca/s);
  assert.ok(!fs.existsSync(path.join(docs, "DNI", "docuprivado")), "no se ha creado nada");
});

test("DNI por las dos caras en PDF A4: medidas reales, marca fundida, sin texto ni datos del original", { skip: sinWeb }, async () => {
  const r = await s.llamar("proteger_copia_dni", { delantera: "dni-frente.jpg", trasera: "dni-detras.jpg", texto_marca: "Solo para alquiler de vivienda" });
  assert.equal(r.result.isError, undefined, texto(r));
  const d = s.largas(r.result.structuredContent);
  assert.equal(d.archivos.length, 1);
  assert.match(path.basename(d.archivos[0]), /^dni-protegido-\d{4}-\d{2}-\d{2}\.pdf$/);
  assert.equal(path.dirname(d.archivos[0]), path.join(docs, "DNI", "docuprivado"));
  assert.match(d.marca, /^Solo para alquiler de vivienda · \d{2}\/\d{2}\/\d{4}$/);
  assert.deepEqual(d.caras.map((c) => [c.cara, c.recorte, c.confianza]), [["delantera", "automatico", "alta"], ["trasera", "automatico", "alta"]]);
  const pdf = await leerPdf(d.archivos[0]);
  assert.equal(pdf.paginas, 1);
  assert.deepEqual(pdf.hoja.map((n) => Math.round(n * 100) / 100), A4);
  assert.deepEqual(pdf.imagenes, [FORMATOS.id1.pt, FORMATOS.id1.pt]);   // 85,60 × 53,98 mm cada cara
  assert.equal(pdf.texto, "", "la marca no puede ser texto: va en los píxeles");
  assert.equal(pdf.info.Title, "Copia protegida");
  assert.equal(pdf.info.Producer, "docuprivado.es");
  assert.equal(pdf.info.Author, undefined);
  assert.ok(!pdf.bytes.toString("latin1").includes("alquiler"), "el texto de la marca no está en el PDF como texto");
  assert.match(texto(r), /Tamaño real.*85,60 × 53,98 mm/);
  assert.match(texto(r), /revísala antes de entregarla/);
  for (const [a, h] of Object.entries(huellas)) assert.equal(huella(path.join(docs, a)), h, "el original " + a + " ha cambiado");
});

test("PDF con «Copia de DNI» arriba y «Es copia» con línea para firmar", { skip: sinWeb }, async () => {
  const r = await s.llamar("proteger_copia_dni", { delantera: "dni-frente.jpg", trasera: "dni-detras.jpg", texto_marca: "Solo para el banco", anadir_fecha: false,
    linea_finalidad: true, es_copia: true });
  const pdf = await leerPdf(s.largas(r.result.structuredContent).archivos[0]);
  assert.match(path.basename(s.largas(r.result.structuredContent).archivos[0]), / \(2\)\.pdf$/, "no pisa la copia anterior");
  assert.equal(pdf.texto.replace(/\s+/g, " "), "Copia de DNI · Solo para el banco Es copia Firma");
});

test("dos imágenes con el mismo número, y una sola imagen con las dos caras", { skip: sinWeb }, async () => {
  const r1 = await s.llamar("proteger_copia_dni", { delantera: "dni-frente.jpg", trasera: "dni-detras.jpg", texto_marca: "Solo para la inmobiliaria", salida: "imagenes" });
  const r2 = await s.llamar("proteger_copia_dni", { delantera: "dni-frente.jpg", trasera: "dni-detras.jpg", texto_marca: "Solo para la inmobiliaria", salida: "imagenes" });
  const n1 = s.largas(r1.result.structuredContent).archivos.map((a) => path.basename(a));
  const n2 = s.largas(r2.result.structuredContent).archivos.map((a) => path.basename(a));
  assert.match(n1[0], /^dni-protegido-delantera-\d{4}-\d{2}-\d{2}\.jpg$/);
  assert.match(n1[1], /^dni-protegido-trasera-\d{4}-\d{2}-\d{2}\.jpg$/);
  assert.match(n2[0], / \(2\)\.jpg$/);
  assert.match(n2[1], / \(2\)\.jpg$/);
  for (const a of s.largas(r1.result.structuredContent).archivos) {
    const b = fs.readFileSync(a);
    const img = jpeg().decode(b, { useTArray: true });
    assert.deepEqual([img.width, img.height], FORMATOS.id1.px);
    assert.equal(metadatos(new Uint8Array(b)).hay, false, "sin datos ocultos");
  }
  const u = await s.llamar("proteger_copia_dni", { delantera: "dni-frente.jpg", trasera: "dni-detras.jpg", texto_marca: "Copia enviada por WhatsApp", salida: "imagen_unica", estilo: "franja", color: "azul" });
  const img = jpeg().decode(fs.readFileSync(s.largas(u.result.structuredContent).archivos[0]), { useTArray: true });
  assert.deepEqual([img.width, img.height], [1011, 638 * 2 + 24]);
  assert.match(texto(u), /en una franja/);
});

test("un PDF escaneado con las dos caras: la primera página es la delantera y la segunda la trasera", { skip: sinWeb }, async () => {
  const r = await s.llamar("proteger_copia_dni", { delantera: "dni-escaneado.pdf", texto_marca: "Solo para oposiciones", salida: "imagenes" });
  const d = s.largas(r.result.structuredContent);
  assert.deepEqual(d.caras.map((c) => [c.cara, c.pagina, c.recorte]), [["delantera", 1, "automatico"], ["trasera", 2, "automatico"]]);
  assert.equal(d.archivos.length, 2);
  assert.match(texto(r), /página 1 de «dni-escaneado\.pdf»/);
});

test("pasaporte: una sola cara de 1476 × 1039 px; la trasera no se usa y se dice", { skip: sinWeb }, async () => {
  const r = await s.llamar("proteger_copia_dni", { delantera: "pasaporte.jpg", trasera: "dni-detras.jpg", documento: "pasaporte", texto_marca: "Solo para el hotel", salida: "imagenes" });
  const d = s.largas(r.result.structuredContent);
  assert.equal(d.archivos.length, 1);
  assert.match(path.basename(d.archivos[0]), /^pasaporte-protegido-\d{4}-\d{2}-\d{2}\.jpg$/);
  const img = jpeg().decode(fs.readFileSync(d.archivos[0]), { useTArray: true });
  assert.deepEqual([img.width, img.height], FORMATOS.id3.px);
  assert.match(texto(r), /El pasaporte solo lleva la página de datos: no he usado «dni-detras\.jpg»/);
});

test("bordes que no se ven claros: la foto va entera, sin recortar, y se explica qué hacer", { skip: sinWeb }, async () => {
  const r = await s.llamar("proteger_copia_dni", { delantera: "dni-en-el-sofa.jpg", texto_marca: "Solo para el gimnasio" });
  const d = s.largas(r.result.structuredContent);
  assert.equal(d.caras[0].recorte, "sin_bordes");
  assert.match(texto(r), /no he encontrado bien los bordes.*foto entera.*docuprivado\.es\/dni\//s);
  assert.match(texto(r), /Solo me has dado una cara/);
});

test("sin marca solo si se pide expresamente, y se avisa", { skip: sinWeb }, async () => {
  const r = await s.llamar("proteger_copia_dni", { delantera: "dni-frente.jpg", sin_marca: true, recorte_automatico: false, salida: "imagenes" });
  const d = s.largas(r.result.structuredContent);
  assert.equal(d.marca, null);
  assert.equal(d.caras[0].recorte, "sin_recortar");
  assert.match(texto(r), /Sin marca de agua, como has pedido/);
});

test("errores claros: hueco sin rellenar, texto largo, Word, la misma foto dos veces y fuera de las carpetas", { skip: sinWeb }, async () => {
  const casos = [
    [{ delantera: "dni-frente.jpg", texto_marca: "Solo para [empresa]" }, /hueco sin rellenar.*\[empresa\]/],
    [{ delantera: "dni-frente.jpg", texto_marca: "x".repeat(81) }, /demasiado largo/],
    [{ delantera: "dni-frente.jpg", texto_marca: "Solo para 😀" }, /no puede llevar/],
    [{ delantera: "contrato.docx", texto_marca: "Solo para el banco" }, /no es una foto/],
    [{ delantera: "dni-frente.jpg", trasera: "dni-frente.jpg", texto_marca: "Solo para el banco" }, /mismo archivo para las dos caras/],
    [{ delantera: path.join(fuera, "dni.jpg"), texto_marca: "Solo para el banco" }, /fuera de las carpetas que autorizaste/],
    [{ delantera: "dni-frente.jpg", texto_marca: "Solo para el banco", carpeta_salida: fuera }, /fuera de las carpetas/],
  ];
  for (const [args, re] of casos) {
    const r = await s.llamar("proteger_copia_dni", args);
    assert.equal(r.result.isError, true, JSON.stringify(args).slice(0, 80));
    assert.match(texto(r), re);
  }
  assert.deepEqual(fs.readdirSync(fuera), ["dni.jpg"], "nada escrito fuera");
});

// Lee una imagen guardada con el lector: ¿lleva las líneas «<<<<» de la trasera?
async function llevaLineasDeAbajo(ruta) {
  const r = jpeg().decode(fs.readFileSync(ruta), { useTArray: true });
  return (await reconocerCara({ data: r.data, width: r.width, height: r.height })).lineasDeAbajo;
}

test("mejora 1: una hoja escaneada con las dos caras, dada como delantera, sale con las dos caras separadas", { skip: sinWeb }, async () => {
  const r = await s.llamar("proteger_copia_dni", { delantera: "escaneo-dos-caras.jpg", texto_marca: "Solo para la gestoría" });
  assert.equal(r.result.isError, undefined, texto(r));
  const d = s.largas(r.result.structuredContent);
  assert.deepEqual(d.caras.map((c) => [c.cara, c.mismaFoto, c.recorte]), [["delantera", true, "automatico"], ["trasera", true, "automatico"]]);
  assert.equal(d.carasCambiadas, false);
  assert.match(texto(r), /Las dos caras estaban en la misma foto \(«escaneo-dos-caras\.jpg»\): las he separado\./);
  assert.doesNotMatch(texto(r), /Solo me has dado una cara/);
  const pdf = await leerPdf(d.archivos[0]);
  assert.deepEqual(pdf.imagenes, [FORMATOS.id1.pt, FORMATOS.id1.pt]);
});

test("mejora 2: si la trasera viene arriba (o las fotos cambiadas), se ponen en su sitio", { skip: sinWeb }, async () => {
  // Sin marca, para poder volver a leer las copias guardadas (la marca tapa en parte las
  // líneas «<<<<»; la herramienta mira cada cara antes de ponerle la marca).
  const r = await s.llamar("proteger_copia_dni", { delantera: "dos-caras-trasera-arriba.jpg", sin_marca: true, salida: "imagenes" });
  const d = s.largas(r.result.structuredContent);
  assert.equal(d.carasCambiadas, true);
  assert.match(texto(r), /Las caras venían cambiadas.*las he puesto en su sitio/);
  const [del, tras] = d.archivos;
  assert.match(path.basename(del), /-delantera-/);
  assert.equal(await llevaLineasDeAbajo(del), false, "la delantera guardada no puede ser la de las líneas «<<<<»");
  assert.equal(await llevaLineasDeAbajo(tras), true, "la trasera guardada es la de las líneas «<<<<»");
  // Las dos fotos dadas al revés: la delantera es la que era la trasera.
  const r2 = await s.llamar("proteger_copia_dni", { delantera: "dni-detras.jpg", trasera: "dni-frente.jpg", texto_marca: "Solo para la gestoría" });
  const d2 = s.largas(r2.result.structuredContent);
  assert.equal(d2.carasCambiadas, true);
  assert.deepEqual(d2.caras.map((c) => [c.cara, c.origen]), [["delantera", "dni-frente.jpg"], ["trasera", "dni-detras.jpg"]]);
});

test("mejora 2: una foto del revés se pone derecha sola; con girar_delantera se respeta lo pedido", { skip: sinWeb }, async () => {
  const r = await s.llamar("proteger_copia_dni", { delantera: "dni-frente-del-reves.jpg", trasera: "dni-detras.jpg", texto_marca: "Solo para la gestoría", salida: "imagenes" });
  const d = s.largas(r.result.structuredContent);
  assert.deepEqual(d.caras.map((c) => [c.cara, c.puestaDerecha, c.girada]), [["delantera", true, 180], ["trasera", false, 0]]);
  assert.match(texto(r), /Parte delantera \(«dni-frente-del-reves\.jpg»\): recortada.*Estaba del revés: la he girado\./);
  // La copia sale derecha: igual que la que se hace con la foto derecha (salvo la marca, que es la misma).
  const recta = await s.llamar("proteger_copia_dni", { delantera: "dni-frente.jpg", trasera: "dni-detras.jpg", texto_marca: "Solo para la gestoría", salida: "imagenes" });
  const a = jpeg().decode(fs.readFileSync(d.archivos[0]), { useTArray: true }).data;
  const b = jpeg().decode(fs.readFileSync(s.largas(recta.result.structuredContent).archivos[0]), { useTArray: true }).data;
  let dif = 0;
  for (let i = 0; i < a.length; i += 40) dif += Math.abs(a[i] - b[i]);
  assert.ok(dif / (a.length / 40) < 12, "la copia de la foto del revés no ha salido derecha");
  const pedido = await s.llamar("proteger_copia_dni", { delantera: "dni-frente-del-reves.jpg", texto_marca: "Solo para la gestoría", girar_delantera: 0 });
  assert.equal(s.largas(pedido.result.structuredContent).caras[0].puestaDerecha, false, "con girar_delantera no se gira nada por su cuenta");
});

test("mejora 2: si solo se da la trasera, se dice que es la trasera", { skip: sinWeb }, async () => {
  const r = await s.llamar("proteger_copia_dni", { delantera: "dni-detras.jpg", texto_marca: "Solo para la gestoría" });
  assert.equal(s.largas(r.result.structuredContent).caras[0].cara, "trasera");
  assert.match(texto(r), /La cara que me has dado es la trasera/);
});

test("mejora 3: varias copias de una vez, una por trámite, cada una con su marca y su nombre", { skip: sinWeb }, async () => {
  const r = await s.llamar("proteger_copia_dni", { delantera: "dni-frente.jpg", trasera: "dni-detras.jpg",
    texto_marca: ["Solo para la inmobiliaria", "Solo para el banco", "solo para la inmobiliaria"] });
  assert.equal(r.result.isError, undefined, texto(r));
  const d = s.largas(r.result.structuredContent);
  assert.equal(d.copias.length, 2, "las repetidas no cuentan");
  assert.deepEqual(d.copias.map((c) => c.marca.replace(/ · .*/, "")), ["Solo para la inmobiliaria", "Solo para el banco"]);
  assert.match(path.basename(d.copias[0].archivos[0]), /^dni-protegido-la-inmobiliaria-\d{4}-\d{2}-\d{2}\.pdf$/);
  assert.match(path.basename(d.copias[1].archivos[0]), /^dni-protegido-el-banco-\d{4}-\d{2}-\d{2}\.pdf$/);
  assert.deepEqual(d.archivos, d.copias.flatMap((c) => c.archivos));
  assert.notDeepEqual(fs.readFileSync(d.copias[0].archivos[0]), fs.readFileSync(d.copias[1].archivos[0]), "cada una con su marca");
  for (const c of d.copias) assert.deepEqual((await leerPdf(c.archivos[0])).imagenes, [FORMATOS.id1.pt, FORMATOS.id1.pt]);
  assert.match(texto(r), /He preparado 2 copias protegidas de tu DNI en PDF, una para cada trámite/);
  const mal = await s.llamar("proteger_copia_dni", { delantera: "dni-frente.jpg", texto_marca: Array.from({ length: 11 }, (_, i) => "Trámite " + i) });
  assert.equal(mal.result.isError, true);
  const hueco = await s.llamar("proteger_copia_dni", { delantera: "dni-frente.jpg", texto_marca: ["Solo para el banco", "Solo para [empresa]"] });
  assert.match(texto(hueco), /hueco sin rellenar/);
});

test("la respuesta y el registro no llevan nada de lo que pone el documento", { skip: sinWeb }, async () => {
  const r = await s.llamar("proteger_copia_dni", { delantera: "dni-frente.jpg", trasera: "dni-detras.jpg", texto_marca: "Solo para alquiler" });
  const todo = JSON.stringify(r.result);
  for (const dato of ["12345678Z", "EJEMPLO", "LUCÍA", "FICTICIA", "PRB000001"]) assert.ok(!todo.includes(dato), "la respuesta lleva «" + dato + "»");
  fin = await s.cerrar();
  assert.equal(fin.lineasMalas.length, 0);
  assert.match(fin.stderr, /ningún intento de conexión/);
  assert.match(fin.stderr, /proteger_copia_dni: bien/);
  assert.doesNotMatch(fin.stderr, /Mis Documentos|dni-frente|dni-detras|pasaporte\.jpg|alquiler|12345678Z/i, "el registro no puede llevar nombres ni la marca");
});
