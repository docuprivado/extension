/*
 * listar_documentos: filtros por nombre (sin tildes ni mayúsculas), tipo, fecha y
 * subcarpetas; ocultos y enlaces hacia fuera ignorados; orden por fecha.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { prepararCarpetas } from "../server/core/rutas.js";
import { listarDocumentos, leerFecha, definir } from "../server/tools/listar.js";

const WIN = process.platform === "win32";
const base = fs.mkdtempSync(path.join(os.tmpdir(), "docuprivado-listar-"));
after(() => fs.rmSync(base, { recursive: true, force: true }));

const docs = path.join(base, "Documentos");
const crear = (rel, fecha) => {
  const r = path.join(docs, rel);
  fs.mkdirSync(path.dirname(r), { recursive: true });
  fs.writeFileSync(r, "x");
  if (fecha) fs.utimesSync(r, new Date(fecha), new Date(fecha));
  return r;
};
crear("Nómina_Septiembre_2026.pdf", "2026-09-26T10:00:00");
crear("nomina-agosto-2026.PDF", "2026-08-28T10:00:00");
crear("contrato alquiler.docx", "2026-07-01T10:00:00");
crear("foto piso.HEIC", "2026-09-01T10:00:00");
crear("notas.txt", "2026-09-20T10:00:00");
crear("programa.exe", "2026-09-20T10:00:00");
crear(".oculto.pdf", "2026-09-20T10:00:00");
crear("~$contrato alquiler.docx", "2026-09-20T10:00:00");
crear("Alquiler/nómina julio.pdf", "2026-07-30T10:00:00");
crear("Alquiler/Viejo/nomina 2019.pdf", "2019-01-30T10:00:00");
crear("node_modules/nomina.pdf", "2026-09-20T10:00:00");
fs.mkdirSync(path.join(base, "fuera"));
fs.writeFileSync(path.join(base, "fuera", "nomina-fuera.pdf"), "x");
let hayUnion = true;
try {
  fs.symlinkSync(path.join(base, "fuera"), path.join(docs, "atajo"), WIN ? "junction" : "dir");
} catch {
  hayUnion = false;
}

const ctx = { version: "prueba", ...prepararCarpetas([docs]) };
const nombres = (r) => r.lista.map((d) => d.nombre);

test("sin filtros: solo la carpeta (sin subcarpetas), solo documentos, del más reciente al más antiguo", () => {
  const r = listarDocumentos(ctx, {});
  assert.deepEqual(nombres(r), ["Nómina_Septiembre_2026.pdf", "notas.txt", "foto piso.HEIC", "nomina-agosto-2026.PDF", "contrato alquiler.docx"]);
  assert.equal(r.recursivo, false);
});

test("buscar sin tildes ni mayúsculas, y mira las subcarpetas (salvo carpetas del sistema)", () => {
  const r = listarDocumentos(ctx, { buscar: "NOMINA" });
  assert.deepEqual(nombres(r), ["Nómina_Septiembre_2026.pdf", "nomina-agosto-2026.PDF", "nómina julio.pdf", "nomina 2019.pdf"]);
  assert.equal(r.recursivo, true);
});

test("buscar varias palabras: todas tienen que estar", () => {
  assert.deepEqual(nombres(listarDocumentos(ctx, { buscar: "nómina septiembre" })), ["Nómina_Septiembre_2026.pdf"]);
});

test("buscar sin subcarpetas si se pide", () => {
  assert.deepEqual(nombres(listarDocumentos(ctx, { buscar: "nomina", recursivo: false })), ["Nómina_Septiembre_2026.pdf", "nomina-agosto-2026.PDF"]);
});

test("filtrar por tipos", () => {
  assert.deepEqual(nombres(listarDocumentos(ctx, { tipos: ["imagen", "word"] })), ["foto piso.HEIC", "contrato alquiler.docx"]);
});

test("modificados desde una fecha (dos formatos) y fecha mal escrita", () => {
  assert.deepEqual(nombres(listarDocumentos(ctx, { modificados_desde: "2026-09-01" })), ["Nómina_Septiembre_2026.pdf", "notas.txt", "foto piso.HEIC"]);
  assert.deepEqual(nombres(listarDocumentos(ctx, { modificados_desde: "20/09/2026" })), ["Nómina_Septiembre_2026.pdf", "notas.txt"]);
  assert.throws(() => listarDocumentos(ctx, { modificados_desde: "31/02/2026" }), (e) => e.codigo === "fecha");
  assert.equal(leerFecha("ayer"), null);
});

test("una carpeta concreta, por nombre", () => {
  assert.deepEqual(nombres(listarDocumentos(ctx, { carpeta: "Alquiler" })), ["nómina julio.pdf"]);
  assert.deepEqual(nombres(listarDocumentos(ctx, { carpeta: "Alquiler", recursivo: true })), ["nómina julio.pdf", "nomina 2019.pdf"]);
});

test("una carpeta de fuera: se rechaza", () => {
  assert.throws(() => listarDocumentos(ctx, { carpeta: path.join(base, "fuera") }), (e) => e.codigo === "fuera");
});

test("una unión hacia fuera dentro de la carpeta: no se recorre", { skip: !hayUnion && "no se pudo crear la unión" }, () => {
  assert.ok(!nombres(listarDocumentos(ctx, { buscar: "fuera" })).length);
});

test("la respuesta: texto en español con cifras y rutas, y datos estructurados", async () => {
  const h = definir(ctx);
  const r = await h.fn({ buscar: "nomina", tipos: ["pdf"] });
  assert.match(r.content[0].text, /^He encontrado 4 documentos con «nomina» en el nombre, de tipo PDF en .* \(incluidas las subcarpetas\):/);
  assert.equal(r.structuredContent.total, 4);
  assert.equal(r.structuredContent.documentos[0].tipo, "PDF");
  assert.match(r.structuredContent.documentos[0].modificadoLegible, /^\d{2}\/\d{2}\/\d{4}$/);
  const vacio = await h.fn({ buscar: "inexistente", recursivo: false });
  assert.match(vacio.content[0].text, /^No he encontrado documentos .*\nNo he mirado en las subcarpetas/);
});
