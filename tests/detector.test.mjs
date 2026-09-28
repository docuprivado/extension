/*
 * Los casos del detector de la web (tests/casos-detectores.js), ejecutados con la
 * copia de server/shared/. Si la web añade casos, basta con volver a sincronizar.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const compartido = new URL("../server/shared/", import.meta.url);
const leerJson = (rel) => JSON.parse(readFileSync(new URL(rel, compartido), "utf8"));

const DP_DETECT = require("../server/shared/detectores.cjs");
const CASOS = require("../server/shared/pruebas/casos-detectores.cjs");
const RUNNER = require("../server/shared/pruebas/runner-detectores.cjs");

DP_DETECT.setData({
  nombres: leerJson("datos/nombres.json"),
  apellidos: leerJson("datos/apellidos.json"),
  excluir: leerJson("datos/excluir.json"),
});
const bin = readFileSync(new URL("datos/empresas.bin", compartido));
DP_DETECT.setData({ empresas: bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength) });

const res = RUNNER.ejecutar(DP_DETECT, CASOS);

test("hay casos del detector", () => {
  assert.ok(res.total > 200, "solo " + res.total + " casos");
});

for (const r of res.resultados) {
  test("detector " + r.n + ". " + r.nombre, () => {
    assert.ok(r.ok, r.error);
  });
}
