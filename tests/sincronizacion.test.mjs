/*
 * La copia de la web (server/shared/) tiene que coincidir con la web. Si alguien cambia
 * el detector o sus diccionarios en la web, esta prueba falla hasta que se ejecute
 * `node scripts/sync-desde-web.mjs`: así no se empaqueta una extensión con piezas viejas.
 * Si la carpeta de la web no está (otro ordenador, o GitHub con solo los documentos de
 * prueba), la prueba se salta y lo dice.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const RAIZ = fileURLToPath(new URL("..", import.meta.url));
const WEB = path.resolve(process.env.DOCUPRIVADO_WEB || path.join(RAIZ, "..", "WEB A"));

// Con solo los documentos de prueba de la web (GitHub, scripts/fixtures-para-github.mjs) no
// hay con qué comparar: también se salta.
const hayWeb = existsSync(path.join(WEB, "js", "detectores.js"));
test("la copia de la web está al día", { skip: hayWeb ? false : "no encuentro la carpeta de la web (" + WEB + ")" }, () => {
  try {
    execFileSync(process.execPath, [path.join(RAIZ, "scripts", "sync-desde-web.mjs"), "--comprobar"], { stdio: "pipe" });
  } catch (err) {
    assert.fail("La copia de la web está desactualizada. Ejecuta: node scripts/sync-desde-web.mjs\n" + String(err.stderr || ""));
  }
});
