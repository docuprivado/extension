/*
 * Plantillas de peticiones (server/core/plantillas.js, hito 7): las cuatro del prompt
 * (§5.10), con título y cada dato explicado, iguales en el servidor y en manifest.json,
 * que se rellenan bien aunque falte un dato opcional y que solo nombran herramientas que
 * existen.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { arrancar } from "./cliente-mcp.mjs";
import { PLANTILLAS, paraManifiesto, rellenar } from "../server/core/plantillas.js";

const manifiesto = JSON.parse(fs.readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));
// La carpeta temporal, por su nombre real, como trabaja la extensión: en macOS está detrás de
// un enlace (/var → /private/var) y en Windows puede venir con nombres cortos (RUNNER~1).
const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "docuprivado-plantillas-")));

let s;
before(async () => {
  s = arrancar({ carpetas: [base] });
  await s.iniciar();
});
after(async () => {
  await s.cerrar();
  fs.rmSync(base, { recursive: true, force: true });
});

test("las cuatro plantillas del prompt, con título, descripción y cada dato explicado", async () => {
  assert.deepEqual(PLANTILLAS.map((p) => p.titulo), [
    "Tachar todos los documentos de una carpeta",
    "Preparar mi DNI para entregarlo",
    "Anonimizar un documento antes de pasárselo a una IA",
    "Ver qué ha cambiado en un contrato",
  ]);
  const r = await s.pedir("prompts/list", {});
  assert.equal(r.result.prompts.length, 4);
  for (const p of r.result.prompts) {
    const def = PLANTILLAS.find((x) => x.nombre === p.name);
    assert.ok(def, p.name);
    assert.equal(p.title, def.titulo);
    assert.ok(p.description.length > 40, p.name + " con descripción corta");
    assert.ok(p.arguments.length >= 1 && p.arguments.length <= 2, p.name + ": pide lo mínimo");
    for (const a of p.arguments) {
      assert.ok(a.description && a.description.length > 20, p.name + "." + a.name + " sin explicar");
      assert.equal(a.required, def.argumentos.find((x) => x.nombre === a.name).obligatorio);
    }
    assert.ok(p.arguments.some((a) => a.required), p.name + " sin ningún dato obligatorio");
  }
});

test("manifest.json lleva las mismas plantillas que el servidor", () => {
  assert.deepEqual(manifiesto.prompts, paraManifiesto());
  for (const p of manifiesto.prompts) {
    for (const a of p.arguments) assert.ok(p.text.includes("${arguments." + a + "}"), p.name + " no usa " + a);
  }
});

test("se rellenan con los datos, y un dato opcional vacío se lee bien", async () => {
  const r = await s.pedir("prompts/get", { name: "tachar_carpeta", arguments: { carpeta: "Alquiler", dejar_visible: "Inmobiliaria Ejemplo" } });
  const m = r.result.messages;
  assert.equal(m.length, 1);
  assert.equal(m[0].role, "user");
  assert.match(m[0].content.text, /carpeta «Alquiler»/);
  assert.match(m[0].content.text, /visibles \(si no pone nada, ninguno\): Inmobiliaria Ejemplo\n/);
  const vacio = await s.pedir("prompts/get", { name: "preparar_dni", arguments: { finalidad: "Alquiler de vivienda" } });
  const t = vacio.result.messages[0].content.text;
  assert.match(t, /Para qué es: Alquiler de vivienda\n/);
  assert.match(t, /\(si no pone nada, búscalos tú\): \n/);
  for (const p of PLANTILLAS) {
    const texto = rellenar(p, {});
    assert.ok(!texto.includes("${"), p.nombre + " deja una marca sin rellenar");
    assert.ok(!texto.includes("undefined"), p.nombre);
  }
});

test("sin un dato obligatorio, error (Claude Desktop lo pide antes)", async () => {
  const r = await s.pedir("prompts/get", { name: "comparar_contrato", arguments: { original: "contrato-v1.docx" } });
  assert.ok(r.error, "tenía que dar error");
});

test("solo nombran herramientas que existen, y encadenan las que hacen falta", async () => {
  const r = await s.pedir("tools/list", {});
  const herramientas = new Set(r.result.tools.map((t) => t.name));
  const usadas = {};
  for (const p of PLANTILLAS) {
    usadas[p.nombre] = [...p.texto.matchAll(/\b[a-z]+_[a-z_]+\b/g)].map((x) => x[0])
      .filter((n) => !p.argumentos.some((a) => a.nombre === n));
    for (const n of usadas[p.nombre]) assert.ok(herramientas.has(n), p.nombre + " nombra «" + n + "», que no existe");
  }
  assert.ok(usadas.tachar_carpeta.includes("listar_documentos") && usadas.tachar_carpeta.includes("tachar_documentos"));
  assert.ok(usadas.preparar_dni.includes("proteger_copia_dni"));
  assert.ok(usadas.anonimizar_para_ia.includes("anonimizar_archivo") && usadas.anonimizar_para_ia.includes("restaurar_archivo"));
  assert.ok(usadas.comparar_contrato.includes("comparar_documentos"));
});

test("piden no enseñar los datos y recuerdan revisar el resultado", () => {
  const t = Object.fromEntries(PLANTILLAS.map((p) => [p.nombre, p.texto]));
  assert.match(t.tachar_carpeta, /No me enseñes los datos/);
  assert.match(t.tachar_carpeta, /revisar las copias/);
  assert.match(t.anonimizar_para_ia, /No me enseñes el texto ni los datos/);
  assert.match(t.preparar_dni, /comprobar que las dos caras se ven bien/);
  assert.match(t.comparar_contrato, /orientativa/);
});
