/*
 * docuprivado para Claude Desktop — arranque del servidor MCP (por la entrada y la
 * salida estándar) y registro de las herramientas y de las plantillas de peticiones.
 *
 * Claude Desktop lo arranca con:
 *   node server/index.js <carpeta autorizada> [<otra carpeta>…]
 * y la carpeta de resultados (opcional) en DOCUPRIVADO_CARPETA_SALIDA. Las carpetas van
 * como argumentos porque el formato de las extensiones solo puede pasar una lista así
 * (docs/DECISIONES.md, «Las carpetas permitidas llegan como argumentos»).
 *
 * La extensión no se conecta a nada: ningún código propio abre conexiones y
 * scripts/comprobar-sin-red.mjs lo comprueba con todas las herramientas.
 */
import "./core/salida-segura.js";          // lo primero: nada de console.log por la salida estándar
import fs from "node:fs";
import * as z from "zod/v4";
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { cerrarLector } from "./core/lector.js";
import { registrar } from "./core/registro.js";
import { acortador, prepararCarpetas } from "./core/rutas.js";
import { PLANTILLAS, rellenar } from "./core/plantillas.js";
import { protegida } from "./core/respuestas.js";
import * as ayuda from "./tools/ayuda.js";
import * as listar from "./tools/listar.js";
import * as analizar from "./tools/analizar.js";
import * as tachar from "./tools/tachar.js";
import * as limpiar from "./tools/limpiar.js";
import * as anonimizar from "./tools/anonimizar.js";
import * as restaurar from "./tools/restaurar.js";
import * as protegerDni from "./tools/proteger-dni.js";
import * as comparar from "./tools/comparar.js";

const manifiesto = JSON.parse(fs.readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));
const carpetas = prepararCarpetas(process.argv.slice(2), process.env.DOCUPRIVADO_CARPETA_SALIDA);
const ctx = { version: manifiesto.version, ...carpetas };

// Solo cifras: ni rutas ni nombres (CLAUDE.md §4.7).
registrar("versión " + ctx.version + " · Node " + process.versions.node +
  (process.versions.electron ? " (el que trae Claude Desktop, Electron " + process.versions.electron + ")" : " (Node del sistema)") +
  " · " + process.platform + " " + process.arch +
  " · carpetas autorizadas: " + ctx.permitidas.length + (ctx.noDisponibles.length ? " (+" + ctx.noDisponibles.length + " no disponibles)" : "") +
  " · carpeta de resultados: " + (ctx.carpetaSalida ? "elegida" : "junto a cada original"));

const HERRAMIENTAS = [ayuda, listar, analizar, tachar, limpiar, anonimizar, restaurar, protegerDni, comparar];

serveStdio(() => {
  const server = new McpServer({ name: "docuprivado", version: ctx.version });
  // Rutas cortas en las respuestas (mejora 1 del hito 7): sin la carpeta del usuario.
  const acortar = acortador(ctx);
  for (const modulo of HERRAMIENTAS) {
    const h = modulo.definir(ctx);
    server.registerTool(h.nombre, h.config, protegida(h.nombre, h.fn, acortar));
  }
  // Plantillas de peticiones (server/core/plantillas.js): solo devuelven el texto.
  for (const p of PLANTILLAS) {
    const campos = Object.fromEntries(p.argumentos.map((a) => {
      const campo = z.string().describe(a.descripcion);
      return [a.nombre, a.obligatorio ? campo : campo.optional()];
    }));
    server.registerPrompt(p.nombre, { title: p.titulo, description: p.descripcion, argsSchema: z.object(campos) },
      (datos) => ({ description: p.titulo, messages: [{ role: "user", content: { type: "text", text: rellenar(p, datos) } }] }));
  }
  return server;
});

// Cuando Claude Desktop cierra la conexión, se cierra también el hilo del lector de
// escaneados, para que el proceso termine solo.
process.stdin.once("end", () => { cerrarLector(); });

process.on("uncaughtException", (err) => {
  registrar("error no controlado: " + (err && err.name) + " " + (err && err.code ? err.code : ""));
});
