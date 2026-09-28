/*
 * «Quedan N archivos. Dime «continúa» y sigo» a través del servidor: con un presupuesto
 * de tiempo muy corto, la primera llamada deja archivos pendientes; al volver a llamar
 * con ellos, se terminan todos, sin repetir ninguno ni crear copias duplicadas.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { arrancar } from "./cliente-mcp.mjs";

const RAIZ = fileURLToPath(new URL("..", import.meta.url));
const NOMINA = path.join(path.resolve(process.env.DOCUPRIVADO_WEB || path.join(RAIZ, "..", "WEB A")), "tests", "fixtures", "nomina-ficticia.pdf");
// La carpeta temporal, por su nombre real, como trabaja la extensión: en macOS está detrás de
// un enlace (/var → /private/var) y en Windows puede venir con nombres cortos (RUNNER~1).
const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "docuprivado-continua-")));
after(() => fs.rmSync(base, { recursive: true, force: true }));

test("lote que no cabe en una llamada: pendientes, «continúa» y ninguna copia repetida", { skip: !fs.existsSync(NOMINA) && "sin la nómina de prueba" }, async () => {
  const lote = path.join(base, "Lote");
  fs.mkdirSync(lote);
  for (let i = 1; i <= 8; i++) fs.copyFileSync(NOMINA, path.join(lote, "nomina-" + i + ".pdf"));
  const s = arrancar({ carpetas: [base], presupuestoMs: 250 });
  await s.iniciar();
  const r1 = await s.llamar("tachar_documentos", { rutas: ["Lote"] });
  const d1 = s.largas(r1.result.structuredContent);
  assert.ok(d1.pendientes.length > 0, "con 250 ms no caben 8 nóminas");
  assert.match(r1.result.content[0].text, /Quedan \d+ archivos?\. Dime «continúa» y sigo\./);
  let hechas = d1.copias.length;
  let pendientes = d1.pendientes;
  for (let vuelta = 0; pendientes.length && vuelta < 20; vuelta++) {
    const r = await s.llamar("tachar_documentos", { rutas: pendientes });
    hechas += s.largas(r.result.structuredContent).copias.length;
    pendientes = s.largas(r.result.structuredContent).pendientes;
  }
  await s.cerrar();
  assert.equal(pendientes.length, 0);
  assert.equal(hechas, 8, "cada nómina se entrega una sola vez");
  const copias = fs.readdirSync(path.join(lote, "docuprivado")).filter((f) => f.endsWith(".pdf")).sort();
  assert.equal(copias.length, 8);
  assert.ok(copias.every((f) => /^nomina-\d-tachado\.pdf$/.test(f)), "sin copias « (2)»: " + copias.join(", "));
});
