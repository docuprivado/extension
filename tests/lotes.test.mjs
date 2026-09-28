/*
 * Lotes y trabajos largos: qué archivos entran en una llamada (carpetas, subcarpetas,
 * resultados anteriores, límite de 200) y el presupuesto de tiempo: lo que no cabe queda
 * pendiente y lo que ya empezó se entrega en la llamada siguiente sin repetirse.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { prepararCarpetas } from "../server/core/rutas.js";
import { copiaVigente, expandir } from "../server/core/lotes.js";
import { claveDe, ejecutarLote } from "../server/core/ejecutar-lote.js";

const base = fs.mkdtempSync(path.join(os.tmpdir(), "docuprivado-lotes-"));
after(() => fs.rmSync(base, { recursive: true, force: true }));
const docs = path.join(base, "Documentos");
const crear = (rel) => { const r = path.join(docs, rel); fs.mkdirSync(path.dirname(r), { recursive: true }); fs.writeFileSync(r, "x"); };
["Alquiler/nomina-1.pdf", "Alquiler/nomina-2.pdf", "Alquiler/nomina-1-tachado.pdf", "Alquiler/nomina-1-tachado (2).pdf", "Alquiler/foto.jpg",
  "Alquiler/docuprivado/nomina-1-tachado.pdf", "Alquiler/Viejo/nomina-2019.pdf"].forEach(crear);
const ctx = prepararCarpetas([docs]);
const nombres = (r) => r.archivos.map((a) => a.nombre);

test("una carpeta: sus archivos, sin los resultados anteriores ni la subcarpeta «docuprivado»", () => {
  assert.deepEqual(nombres(expandir(ctx, ["Alquiler"])), ["foto.jpg", "nomina-1.pdf", "nomina-2.pdf"]);
});

test("con subcarpetas si se pide", () => {
  assert.deepEqual(nombres(expandir(ctx, ["Alquiler"], true)), ["foto.jpg", "nomina-1.pdf", "nomina-2.pdf", "nomina-2019.pdf"]);
});

test("archivos sueltos, repetidos una vez, y errores por archivo sin parar el lote", () => {
  const r = expandir(ctx, ["nomina-1.pdf", path.join(docs, "Alquiler", "nomina-1.pdf"), "no-existe.pdf", path.join(base, "fuera.pdf")]);
  assert.deepEqual(nombres(r), ["nomina-1.pdf"]);
  assert.equal(r.errores.length, 2);
});

test("una copia ya tachada pedida expresamente sí se acepta", () => {
  assert.deepEqual(nombres(expandir(ctx, [path.join(docs, "Alquiler", "nomina-1-tachado.pdf")])), ["nomina-1-tachado.pdf"]);
});

test("más de 200 archivos: el resto queda pendiente", () => {
  const muchos = path.join(docs, "Muchos");
  fs.mkdirSync(muchos);
  for (let i = 0; i < 205; i++) fs.writeFileSync(path.join(muchos, "d" + String(i).padStart(3, "0") + ".pdf"), "x");
  const r = expandir(ctx, ["Muchos"]);
  assert.equal(r.archivos.length, 200);
  assert.equal(r.pendientes.length, 5);
});

test("archivos de una carpeta (deCarpeta) y pedidos por su nombre", () => {
  const r = expandir(ctx, ["Alquiler", path.join(docs, "Alquiler", "Viejo", "nomina-2019.pdf")]);
  assert.deepEqual(r.archivos.map((a) => [a.nombre, a.deCarpeta]), [["foto.jpg", true], ["nomina-1.pdf", true], ["nomina-2.pdf", true], ["nomina-2019.pdf", false]]);
});

test("copia vigente: más reciente que el original, y con cuidado con los nombres repetidos", () => {
  const carpeta = path.join(docs, "Alquiler", "docuprivado");
  const a = expandir(ctx, ["Alquiler"]).archivos.find((x) => x.nombre === "nomina-1.pdf");
  const copia = path.join(carpeta, "nomina-1-tachado.pdf");
  const despues = new Date(a.modificado + 60000);
  fs.utimesSync(copia, despues, despues);
  assert.equal(copiaVigente(a, carpeta, new Set()), copia);
  const antes = new Date(a.modificado - 60000);
  fs.utimesSync(copia, antes, antes);
  assert.equal(copiaVigente(a, carpeta, new Set()), null, "copia anterior al original: se vuelve a tachar");
  fs.utimesSync(copia, despues, despues);
  const comun = path.join(docs, "Resultados");
  fs.mkdirSync(comun, { recursive: true });
  fs.writeFileSync(path.join(comun, "nomina-1-tachado.pdf"), "x");
  fs.utimesSync(path.join(comun, "nomina-1-tachado.pdf"), despues, despues);
  assert.equal(copiaVigente(a, comun, new Set(["nomina-1"])), null, "carpeta común y otro «nomina-1» en el lote: no se sabe de quién es la copia");
  assert.ok(copiaVigente(a, comun, new Set()));
});

test("copia vigente de fotos: «-tachado.jpg/png» y «-sin-datos», cada una con su sufijo", () => {
  const carpeta = path.join(docs, "Alquiler", "docuprivado");
  const a = expandir(ctx, ["Alquiler"]).archivos.find((x) => x.nombre === "foto.jpg");
  const despues = new Date(a.modificado + 60000);
  for (const n of ["foto-tachado.png", "foto-sin-datos (2).jpg"]) {
    fs.writeFileSync(path.join(carpeta, n), "x");
    fs.utimesSync(path.join(carpeta, n), despues, despues);
  }
  assert.equal(path.basename(copiaVigente(a, carpeta, new Set(), "-tachado", ["jpg", "png"])), "foto-tachado.png");
  assert.equal(path.basename(copiaVigente(a, carpeta, new Set(), "-sin-datos", ["jpg", "jpeg", "png", "webp"])), "foto-sin-datos (2).jpg");
  assert.equal(copiaVigente(a, carpeta, new Set(), "-tachado", ["pdf"]), null, "una copia de otro tipo no cuenta");
  // Las copias «-sin-datos» tampoco se vuelven a procesar al recorrer la carpeta.
  fs.writeFileSync(path.join(docs, "Alquiler", "otra-sin-datos.jpg"), "x");
  assert.ok(!nombres(expandir(ctx, ["Alquiler"])).includes("otra-sin-datos.jpg"));
});

test("sin rutas: error claro", () => {
  assert.throws(() => expandir(ctx, []), (e) => e.codigo === "sinRutas");
});

test("presupuesto de tiempo: lo que no cabe queda pendiente y lo empezado se entrega después, sin repetirse", async () => {
  const archivos = ["a", "b", "c"].map((n) => ({ ruta: path.join(docs, n + ".pdf"), nombre: n + ".pdf", tipo: "pdf", bytes: 1, modificado: 1 }));
  let ejecuciones = 0;
  const opciones = {
    aceptar: () => null,
    clave: (a) => claveDe("prueba-lote", a, {}),
    trabajo: async (a) => { ejecuciones++; await new Promise((ok) => setTimeout(ok, 300)); return { nombre: a.nombre }; },
  };
  // 1.ª llamada, 450 ms: «a» termina (300 ms); «b» empieza y no le da tiempo; «c» ni empieza.
  const r1 = await ejecutarLote(archivos, opciones, 450);
  assert.deepEqual(r1.hechos.map((h) => h.nombre), ["a.pdf"]);
  assert.deepEqual(r1.enCurso, ["b.pdf"]);
  assert.equal(r1.pendientes.length, 2);
  // 2.ª llamada con los pendientes: «b» se recoge (no se repite) y «c» se hace.
  const r2 = await ejecutarLote(archivos.slice(1), opciones, 2000);
  assert.deepEqual(r2.hechos.map((h) => h.nombre), ["b.pdf", "c.pdf"]);
  assert.equal(ejecuciones, 3, "cada archivo se procesa una sola vez");
});

test("un archivo que falla no para el lote", async () => {
  const archivos = ["x", "y"].map((n) => ({ ruta: path.join(docs, n + ".pdf"), nombre: n + ".pdf", tipo: "pdf", bytes: 1, modificado: 2 }));
  const r = await ejecutarLote(archivos, {
    aceptar: () => null,
    clave: (a) => claveDe("prueba-fallo", a, {}),
    trabajo: async (a) => { if (a.nombre === "x.pdf") throw new Error("roto"); return { nombre: a.nombre }; },
  }, 5000);
  assert.deepEqual(r.hechos.map((h) => h.nombre), ["y.pdf"]);
  assert.equal(r.fallos.length, 1);
  assert.match(r.fallos[0].motivo, /No he podido procesar «x.pdf»/);
});
