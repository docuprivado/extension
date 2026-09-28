/*
 * Copia desde el proyecto de la web las piezas que la extensión reutiliza sin
 * cambiarlas: el detector de datos personales, sus diccionarios y sus pruebas, las
 * reglas con las que el tachador monta el texto de cada página (js/tachador-reglas.js),
 * el motor que lee y quita los datos ocultos de las fotos (js/fotos-motor.js), las reglas
 * del anonimizador: etiquetas, tabla y restaurar (js/anonimizador-reglas.js), y el buscador
 * de bordes del Kit DNI (js/kit-dni-bordes.js) con el motor que usa, OpenCV.js 4.7.0, el
 * mismo archivo que sirve la web (lib/vendor/opencv/opencv.js), y el motor del comparador
 * (js/comparador-motor.js) con la librería que usa, diff-match-patch, y su licencia.
 * La web es la fuente de la verdad (CLAUDE.md §1): aquí no se editan a mano.
 *
 *   node scripts/sync-desde-web.mjs              copia y anota el origen en server/shared/ORIGEN.json
 *   node scripts/sync-desde-web.mjs --comprobar  solo dice si la copia está al día (sale con 1 si no)
 *
 * La carpeta de la web se busca junto a esta («../WEB A»); se puede cambiar con la
 * variable DOCUPRIVADO_WEB. De la web solo se LEEN los archivos de la lista: nunca
 * se escribe en ella ni se lee nada más (sus documentos privados de pruebas no se tocan).
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WEB = path.resolve(process.env.DOCUPRIVADO_WEB || path.join(RAIZ, "..", "WEB A"));
const DESTINO = path.join(RAIZ, "server", "shared");

// [origen en la web, destino en server/shared]. Los scripts de la web son IIFE que
// también exportan con module.exports: se guardan como .cjs para que Node los cargue
// con require() aunque la extensión use módulos ESM. El motor de las fotos, el buscador
// de bordes y el del comparador no exportan nada (se cuelgan de window.DP): se guardan como
// texto y los carga server/core/motores.js.
const ARCHIVOS = [
  ["js/detectores.js", "detectores.cjs"],
  ["js/tachador-reglas.js", "tachador-reglas.cjs"],
  ["js/fotos-motor.js", "fotos-motor.web.js"],
  ["js/anonimizador-reglas.js", "anonimizador-reglas.cjs"],
  ["js/kit-dni-bordes.js", "kit-dni-bordes.web.js"],
  ["lib/vendor/opencv/opencv.js", "opencv/opencv.js"],
  ["js/comparador-motor.js", "comparador-motor.web.js"],
  ["lib/vendor/diff_match_patch.js", "diff_match_patch.web.js"],
  ["lib/vendor/licencias/diff-match-patch-20190725-LICENSE.txt", "licencias/diff-match-patch-20190725-LICENSE.txt"],
  ["assets/data/nombres.json", "datos/nombres.json"],
  ["assets/data/apellidos.json", "datos/apellidos.json"],
  ["assets/data/excluir.json", "datos/excluir.json"],
  ["assets/data/empresas.bin", "datos/empresas.bin"],
  ["tests/casos-detectores.js", "pruebas/casos-detectores.cjs"],
  ["tests/runner-detectores.js", "pruebas/runner-detectores.cjs"],
];

const huella = (buf) => createHash("sha256").update(buf).digest("hex");

function git(args) {
  try {
    return execFileSync("git", ["-C", WEB, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

async function leerSiExiste(ruta) {
  try {
    return await readFile(ruta);
  } catch {
    return null;
  }
}

async function main() {
  const comprobar = process.argv.includes("--comprobar");
  const lista = [];
  for (const [origen, destino] of ARCHIVOS) {
    const datos = await readFile(path.join(WEB, origen)).catch(() => {
      throw new Error("No encuentro " + origen + " en la web (" + WEB + ")");
    });
    const actual = await leerSiExiste(path.join(DESTINO, destino));
    lista.push({ origen, destino, datos, alDia: !!actual && actual.equals(datos) });
  }

  if (comprobar) {
    const viejos = lista.filter((a) => !a.alDia);
    viejos.forEach((a) => console.error("Desactualizado: " + a.destino + " (en la web: " + a.origen + ")"));
    console.error(viejos.length ? viejos.length + " archivo(s) no coinciden con la web." : "La copia coincide con la web.");
    process.exit(viejos.length ? 1 : 0);
  }

  for (const a of lista) {
    const ruta = path.join(DESTINO, a.destino);
    await mkdir(path.dirname(ruta), { recursive: true });
    if (!a.alDia) await writeFile(ruta, a.datos);
  }

  const cambiosSinGuardar = git(["status", "--porcelain", "--", ...ARCHIVOS.map(([o]) => o)]);
  const origen = {
    aviso: "Copia automática de la web (scripts/sync-desde-web.mjs). No editar a mano.",
    copiado: new Date().toISOString(),
    web: {
      carpeta: path.relative(RAIZ, WEB).split(path.sep).join("/"),
      commit: git(["rev-parse", "--short", "HEAD"]),
      cambiosSinGuardar: cambiosSinGuardar ? cambiosSinGuardar.split("\n") : [],
    },
    archivos: lista.map((a) => ({ origen: a.origen, destino: a.destino, bytes: a.datos.length, sha256: huella(a.datos) })),
  };
  await writeFile(path.join(DESTINO, "ORIGEN.json"), JSON.stringify(origen, null, 2) + "\n");

  const nuevos = lista.filter((a) => !a.alDia).length;
  console.error("Copiados " + nuevos + " de " + lista.length + " archivos desde la web (commit " + (origen.web.commit || "?") + ").");
  if (origen.web.cambiosSinGuardar.length) {
    console.error("Ojo: en la web hay cambios sin guardar en el historial en: " + origen.web.cambiosSinGuardar.join("; "));
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
