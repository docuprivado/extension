/*
 * Formularios rellenables (mejora aprobada por el titular; hito de actualización 10 de la web):
 * lo escrito en los campos no está en el texto de la página, pero se ve. Con el formulario
 * ficticio de la web (tests/fixtures/formulario-ficticio.pdf):
 * - se tapan los campos con datos personales (también «Xiana», por el nombre del campo)
 *   y NO la localidad; se comprueba MIRANDO la copia dibujada: los campos personales
 *   quedan en negro y la localidad se sigue leyendo;
 * - la copia conserva lo escrito en los campos que no se tapan (antes salían en blanco);
 * - «no_tachar» también vale para los campos.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import "../server/core/salida-segura.js";
import { abrir, comprobarSinTexto, detectar, leerTextos, tachar } from "../server/core/documento-pdf.js";
import { opcionesDeteccion } from "../server/core/deteccion.js";
import { pdfium, pdfjs } from "../server/core/motores.js";

const RAIZ = fileURLToPath(new URL("..", import.meta.url));
const WEB = path.resolve(process.env.DOCUPRIVADO_WEB || path.join(RAIZ, "..", "WEB A"));
const FORMULARIO = path.join(WEB, "tests", "fixtures", "formulario-ficticio.pdf");
const hay = fs.existsSync(FORMULARIO);

async function tacharFormulario(params = {}) {
  const d = await abrir(FORMULARIO, "formulario-ficticio.pdf");
  try {
    const paginas = await leerTextos(d);
    const r0 = detectar(paginas, opcionesDeteccion(params));
    const r = await tachar(d, paginas, { estilo: "negro", calidad: "normal" });
    const valores = paginas.flatMap((p) => p.marcas.concat(p.marcasCampo).map((m) => m.valor));
    assert.deepEqual(await comprobarSinTexto(r.bytes, d.paginas, valores), []);
    return { paginas, bytes: r.bytes, visibles: r0.visibles };
  } finally {
    await d.cerrar();
  }
}

// Porcentaje de píxeles oscuros dentro de cada campo del formulario, en la copia dibujada.
async function negroPorCampo(bytes) {
  const lib = await pdfjs();
  const tarea = lib.getDocument({ data: new Uint8Array(fs.readFileSync(FORMULARIO)), verbosity: 0 });
  const campos = (await (await (await tarea.promise).getPage(1)).getAnnotations()).filter((a) => a.fieldType === "Tx");
  await tarea.destroy();
  const P = await pdfium();
  const M = P.pdfium;
  const ptr = M.wasmExports.malloc(bytes.length);
  M.HEAPU8.set(bytes, ptr);
  const doc = P.FPDF_LoadMemDocument(ptr, bytes.length, "");
  const pg = P.FPDF_LoadPage(doc, 0);
  const W = 1190, H = 1684;
  const bmp = P.FPDFBitmap_Create(W, H, 1);
  P.FPDFBitmap_FillRect(bmp, 0, 0, W, H, 0xffffffff);
  P.FPDF_RenderPageBitmap(bmp, pg, 0, 0, W, H, 0, 0);
  const buf = P.FPDFBitmap_GetBuffer(bmp), st = P.FPDFBitmap_GetStride(bmp);
  const tmp = M.wasmExports.malloc(8);
  const aPixel = (x, y) => { P.FPDF_PageToDevice(pg, 0, 0, W, H, 0, x, y, tmp, tmp + 4); return Array.from(new Int32Array(M.HEAPU8.buffer, tmp, 2)); };
  const salida = {};
  for (const c of campos) {
    const a = aPixel(c.rect[0], c.rect[1]), b = aPixel(c.rect[2], c.rect[3]);
    const x0 = Math.min(a[0], b[0]) + 5, x1 = Math.max(a[0], b[0]) - 5, y0 = Math.min(a[1], b[1]) + 5, y1 = Math.max(a[1], b[1]) - 5;
    let oscuros = 0, total = 0;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const o = buf + y * st + x * 4;
      total++;
      if (M.HEAPU8[o] + M.HEAPU8[o + 1] + M.HEAPU8[o + 2] < 90) oscuros++;
    }
    salida[c.fieldName] = Math.round((100 * oscuros) / total);
  }
  M.wasmExports.free(tmp);
  P.FPDFBitmap_Destroy(bmp);
  P.FPDF_ClosePage(pg);
  P.FPDF_CloseDocument(doc);
  M.wasmExports.free(ptr);
  return salida;
}

test("formulario: se detectan los campos personales, no la localidad", { skip: !hay && "sin el formulario de prueba de la web" }, async () => {
  const { paginas } = await tacharFormulario();
  const campos = paginas[0].marcasCampo.map((m) => m.campo + ":" + m.tipo).sort();
  assert.deepEqual(campos, ["cuenta_iban:iban", "dni:dni", "nombre_hijo:nombre", "nombre_solicitante:nombre"]);
  assert.ok(paginas[0].marcas.some((m) => m.tipo === "dni" && m.valor === "11111111H"), "el DNI del texto normal también");
});

test("formulario: en la copia, los campos personales en negro y la localidad a la vista", { skip: !hay }, async () => {
  const { bytes } = await tacharFormulario();
  const negro = await negroPorCampo(bytes);
  for (const c of ["nombre_solicitante", "dni", "cuenta_iban", "nombre_hijo"]) assert.ok(negro[c] >= 95, c + ": " + negro[c] + " %");
  assert.ok(negro.localidad > 0 && negro.localidad < 40, "la localidad se sigue leyendo (" + negro.localidad + " %)");
});

test("formulario: no_tachar también deja a la vista un campo", { skip: !hay }, async () => {
  const { paginas, bytes, visibles } = await tacharFormulario({ no_tachar: ["Juan Pérez García"] });
  assert.ok(!paginas[0].marcasCampo.some((m) => m.campo === "nombre_solicitante"));
  assert.ok(visibles >= 1);
  const negro = await negroPorCampo(bytes);
  assert.ok(negro.nombre_solicitante < 40, "el nombre se ve");
});
