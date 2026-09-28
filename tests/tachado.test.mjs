/*
 * Tachado de PDF con texto (docs/PROMPT_EXTENSION.md §8.1):
 * - el PDF resultante no tiene texto (PDFium y pdf.js), ni metadatos del original, ni
 *   los valores tachados en sus bytes, y tiene las mismas páginas y tamaños;
 * - COBERTURA: cada letra de cada dato encontrado queda dentro de una barra negra (con
 *   la caja exacta de la letra que da PDFium): no asoma ningún borde;
 * - páginas giradas y con recorte, estilo «etiqueta» y calidad alta;
 * - PDF con contraseña y dañado: error claro, sin copia; escaneado: se lee con el lector
 *   (el tachado de escaneados se prueba en tests/escaneados.test.mjs).
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import "../server/core/salida-segura.js";
import { _paraPruebas, abrir, comprobarSinTexto, detectar, leerTextos, tachar } from "../server/core/documento-pdf.js";
import { opcionesDeteccion } from "../server/core/deteccion.js";
import { cerrarLector } from "../server/core/lector.js";
import { pdfLib, pdfjs } from "../server/core/motores.js";

const RAIZ = fileURLToPath(new URL("..", import.meta.url));
const WEB = path.resolve(process.env.DOCUPRIVADO_WEB || path.join(RAIZ, "..", "WEB A"));
const F = path.join(WEB, "tests", "fixtures");
const hayWeb = fs.existsSync(F);
// La carpeta temporal, por su nombre real, como trabaja la extensión: en macOS está detrás de
// un enlace (/var → /private/var) y en Windows puede venir con nombres cortos (RUNNER~1).
const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "docuprivado-tachado-")));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
after(() => cerrarLector());

// Tacha un PDF y comprueba todo; devuelve el resultado para más comprobaciones.
async function tacharYComprobar(ruta, opciones = {}) {
  const d = await abrir(ruta, path.basename(ruta));
  try {
    const paginas = await leerTextos(d);
    detectar(paginas, opcionesDeteccion(opciones.det || {}));
    const r = await tachar(d, paginas, { estilo: opciones.estilo || "negro", calidad: opciones.calidad || "normal", conRects: true });
    const valores = paginas.flatMap((p) => p.marcas.map((m) => m.valor));
    const problemas = await comprobarSinTexto(r.bytes, d.paginas, valores);
    assert.deepEqual(problemas, [], "comprobación final");
    const sinCubrir = await cobertura(d, paginas, r.paginas);
    assert.deepEqual(sinCubrir, [], "letras de datos que asoman fuera de las barras");
    return { d: { paginas: d.paginas }, paginas, r, valores };
  } finally {
    await d.cerrar();
  }
}

// Cada letra de cada dato (caja exacta de PDFium, en píxeles) tiene que estar dentro de
// alguna barra de su página: esquinas y centro, con medio píxel de tolerancia.
async function cobertura(d, paginas, resumen) {
  const { emparejar, aPixel, ESCALA } = _paraPruebas;
  const { P, M } = d;
  const fallos = [];
  const tmpPtr = M.wasmExports.malloc(40);
  const trozosPorPagina = new Map();
  for (const p of paginas) for (const m of p.marcas) {
    if (!trozosPorPagina.has(p.num)) trozosPorPagina.set(p.num, []);
    trozosPorPagina.get(p.num).push({ inicio: m.inicio, fin: m.fin, valor: m.valor });
    if (m.sigue) {
      if (!trozosPorPagina.has(m.sigue.pagina)) trozosPorPagina.set(m.sigue.pagina, []);
      trozosPorPagina.get(m.sigue.pagina).push({ inicio: m.sigue.inicio, fin: m.sigue.fin, valor: m.valor });
    }
  }
  for (const [num, trozos] of trozosPorPagina) {
    const pagina = paginas[num - 1];
    const rects = resumen.find((x) => x.num === num).rects;
    const pg = P.FPDF_LoadPage(d.doc, num - 1);
    const W = Math.round(P.FPDF_GetPageWidthF(pg) * ESCALA), H = Math.round(P.FPDF_GetPageHeightF(pg) * ESCALA);
    const tp = P.FPDFText_LoadPage(pg);
    const n = P.FPDFText_CountChars(tp);
    const chars = [];
    for (let i = 0; i < n; i++) {
      P.FPDFText_GetCharBox(tp, i, tmpPtr, tmpPtr + 8, tmpPtr + 16, tmpPtr + 24);
      const v = new Float64Array(M.HEAPU8.buffer, tmpPtr, 4);    // left, right, bottom, top
      chars.push({ c: String.fromCodePoint(P.FPDFText_GetUnicode(tp, i) || 32), l: v[0], r: v[1], b: v[2], t: v[3] });
    }
    P.FPDFText_ClosePage(tp);
    const mapa = emparejar(pagina.texto, chars);
    const dentro = (x, y) => rects.some((q) => x >= q.x - 0.5 && x <= q.x + q.w + 0.5 && y >= q.y - 0.5 && y <= q.y + q.h + 0.5);
    for (const t of trozos) {
      for (let i = t.inicio; i < t.fin; i++) {
        if (!/\S/.test(pagina.texto[i])) continue;
        const k = mapa.get(i);
        if (k === undefined) continue;
        const c = chars[k];
        if (!(c.r > c.l) || !(c.t > c.b)) continue;
        const a = aPixel(d, pg, W, H, c.l, c.t, tmpPtr + 32);
        const b = aPixel(d, pg, W, H, c.r, c.b, tmpPtr + 32);
        const x0 = Math.min(a[0], b[0]), x1 = Math.max(a[0], b[0]), y0 = Math.min(a[1], b[1]), y1 = Math.max(a[1], b[1]);
        const puntos = [[x0, y0], [x1, y0], [x0, y1], [x1, y1], [(x0 + x1) / 2, (y0 + y1) / 2]];
        if (!puntos.every(([x, y]) => dentro(x, y))) fallos.push("pág. " + num + " «" + pagina.texto[i] + "» de un dato " + t.valor.length + " letras");
      }
    }
    P.FPDF_ClosePage(pg);
  }
  M.wasmExports.free(tmpPtr);
  return fallos;
}

const TEXTO = ["nomina-ficticia.pdf", "contrato-ficticio.pdf", "contrato-cortes.pdf", "contrato-letra-pequena.pdf", "contrato-cabeceras-v1.pdf",
  "debajo/1-nomina-bloque.pdf", "debajo/2-carta.pdf", "debajo/3-tabla.pdf", "debajo/4-objeto-texto.pdf", "debajo/5-trozos.pdf", "debajo/6-apretado.pdf", "debajo/7-firma.pdf"];

for (const archivo of TEXTO) {
  test("tachado completo y sin letras a la vista: " + archivo, { skip: !hayWeb && "sin documentos de prueba de la web" }, async () => {
    const { r } = await tacharYComprobar(path.join(F, archivo));
    assert.ok(r.paginas.reduce((s, p) => s + p.datos, 0) > 0);
  });
}

test("el resultado: mismas páginas y tamaños, solo título y productor", { skip: !hayWeb }, async () => {
  const { r } = await tacharYComprobar(path.join(F, "contrato-ficticio.pdf"));
  const lib = await pdfjs();
  const tareaA = lib.getDocument({ data: new Uint8Array(fs.readFileSync(path.join(F, "contrato-ficticio.pdf"))), verbosity: 0 });
  const tareaB = lib.getDocument({ data: new Uint8Array(r.bytes), verbosity: 0 });
  const original = await tareaA.promise;
  const copia = await tareaB.promise;
  assert.equal(copia.numPages, original.numPages);
  for (let i = 1; i <= copia.numPages; i++) {
    const a = (await original.getPage(i)).getViewport({ scale: 1 });
    const b = (await copia.getPage(i)).getViewport({ scale: 1 });
    assert.ok(Math.abs(a.width - b.width) < 0.5 && Math.abs(a.height - b.height) < 0.5, "tamaño de la página " + i);
  }
  const meta = await copia.getMetadata();
  assert.equal(meta.info.Title, "Documento tachado");
  assert.equal(meta.info.Producer, "docuprivado.es");
  for (const k of ["Author", "Creator", "Subject", "Keywords", "CreationDate", "ModDate"]) assert.equal(meta.info[k], undefined, k);
  assert.equal(meta.metadata, null, "sin metadatos XMP");
  await tareaA.destroy(); await tareaB.destroy();
});

test("estilo «etiqueta» y calidad alta (PNG): también sin texto y sin letras a la vista", { skip: !hayWeb }, async () => {
  const { r } = await tacharYComprobar(path.join(F, "contrato-cortes.pdf"), { estilo: "etiqueta", calidad: "alta" });
  assert.ok(Buffer.from(r.bytes).includes(Buffer.from("/FlateDecode")), "imágenes PNG (sin pérdida)");
});

test("perfil nómina: deja a la vista la empresa y los importes, como la web", { skip: !hayWeb }, async () => {
  const d = await abrir(path.join(F, "nomina-ficticia.pdf"), "nomina");
  try {
    const paginas = await leerTextos(d);
    detectar(paginas, opcionesDeteccion({ preset: "nomina" }));
    const tipos = new Set(paginas.flatMap((p) => p.marcas.map((m) => m.tipo)));
    for (const t of ["importe", "empresa", "cif"]) assert.ok(!tipos.has(t), t);
    for (const t of ["dni", "nombre", "iban"]) assert.ok(tipos.has(t), t);
  } finally {
    await d.cerrar();
  }
});

test("no_tachar y personalizados", { skip: !hayWeb }, async () => {
  const d = await abrir(path.join(F, "nomina-ficticia.pdf"), "nomina");
  try {
    const paginas = await leerTextos(d);
    const { visibles } = detectar(paginas, opcionesDeteccion({ no_tachar: ["Empresa Ficticia de Pruebas"], personalizados: ["Técnico administrativo"] }));
    const marcas = paginas.flatMap((p) => p.marcas);
    assert.ok(visibles >= 1);
    assert.ok(!marcas.some((m) => /EMPRESA FICTICIA/i.test(m.valor)), "la empresa queda a la vista");
    assert.ok(marcas.some((m) => m.tipo === "personalizado" && /Técnico administrativo/i.test(m.valor)), "la palabra pedida se tacha");
  } finally {
    await d.cerrar();
  }
});

// PDF creado aquí con pdf-lib: página girada 90° y otra con recorte (CropBox desplazado).
test("páginas giradas y con recorte: las barras caen en su sitio", async () => {
  const { PDFDocument, StandardFonts, degrees } = pdfLib();
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const p1 = doc.addPage([595, 842]);
  p1.drawText("Arrendatario: Juan Pérez García, con DNI 12345678Z.", { x: 60, y: 700, size: 12, font });
  p1.drawText("Cuenta: ES91 2100 0418 4502 0005 1332.", { x: 60, y: 670, size: 12, font });
  p1.setRotation(degrees(90));
  const p2 = doc.addPage([595, 842]);
  p2.drawText("Firmado: María López Sánchez, NIE X1234567L.", { x: 120, y: 600, size: 11, font });
  p2.setCropBox(50, 100, 500, 700);          // x, y, ancho, alto: se ve 500 × 700
  const ruta = path.join(tmp, "girado.pdf");
  fs.writeFileSync(ruta, await doc.save());
  const { paginas, r } = await tacharYComprobar(ruta);
  const tipos = paginas.flatMap((p) => p.marcas.map((m) => m.tipo)).sort();
  for (const t of ["dni", "iban", "nie", "nombre"]) assert.ok(tipos.includes(t), t);
  // La página girada sale apaisada, como se ve.
  const copia = await PDFDocument.load(r.bytes);
  const { width, height } = copia.getPage(0).getSize();
  assert.ok(width > height, "página girada, apaisada");
  const s2 = copia.getPage(1).getSize();
  assert.ok(Math.abs(s2.width - 500) < 1 && Math.abs(s2.height - 700) < 1, "página con recorte, del tamaño visible");
});

test("PDF con contraseña, dañado y escaneado", { skip: !hayWeb }, async () => {
  await assert.rejects(abrir(path.join(F, "protegido.pdf"), "protegido.pdf"), (e) => e.codigo === "contrasena" && /contraseña/.test(e.message) && /no me la escribas/.test(e.message));
  await assert.rejects(abrir(path.join(F, "danado.pdf"), "danado.pdf"), (e) => e.codigo === "danado");
  const d = await abrir(path.join(F, "contrato-escaneado.pdf"), "escaneado");
  try {
    const paginas = await leerTextos(d);
    assert.deepEqual(paginas.map((p) => p.escaneada), [true, true, true]);
    assert.deepEqual(paginas.map((p) => p.ocr), [true, true, true], "las escaneadas se leen con el lector");
    assert.ok(paginas.every((p) => p.texto.length > 500), "y tienen texto");
  } finally {
    await d.cerrar();
  }
});
