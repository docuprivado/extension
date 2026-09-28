/*
 * Cliente mínimo para las pruebas: arranca el servidor como lo hace Claude Desktop
 * (node server/index.js <carpetas…>) con la red bloqueada y habla el protocolo a mano
 * por la entrada y la salida estándar. Comprueba que cada línea de la salida estándar es
 * un mensaje del protocolo.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const RAIZ = fileURLToPath(new URL("..", import.meta.url));

export function arrancar({ carpetas, salida, servidor = "server/index.js", cwd = RAIZ, presupuestoMs } = {}) {
  const env = { ...process.env };
  if (presupuestoMs) env.DOCUPRIVADO_PRESUPUESTO_MS = String(presupuestoMs);
  else delete env.DOCUPRIVADO_PRESUPUESTO_MS;
  if (salida !== undefined) env.DOCUPRIVADO_CARPETA_SALIDA = salida;
  else delete env.DOCUPRIVADO_CARPETA_SALIDA;
  const bloqueo = pathToFileURL(fileURLToPath(new URL("../scripts/bloquear-red.mjs", import.meta.url))).href;
  const hijo = spawn(process.execPath, ["--import", bloqueo, servidor, ...carpetas], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
  const mensajes = [];
  const lineasMalas = [];
  let resto = "";
  let stderr = "";
  hijo.stdout.setEncoding("utf8");
  hijo.stderr.setEncoding("utf8");
  hijo.stdout.on("data", (d) => {
    resto += d;
    let i;
    while ((i = resto.indexOf("\n")) >= 0) {
      const linea = resto.slice(0, i);
      resto = resto.slice(i + 1);
      if (!linea.trim()) continue;
      try {
        mensajes.push(JSON.parse(linea));
      } catch {
        lineasMalas.push(linea);
      }
    }
  });
  hijo.stderr.on("data", (d) => (stderr += d));
  let siguienteId = 1;
  const salidaProceso = new Promise((ok) => hijo.on("exit", (codigo) => ok(codigo)));

  function esperar(id, ms = 30000) {
    return new Promise((ok, mal) => {
      const t0 = Date.now();
      const t = setInterval(() => {
        const m = mensajes.find((x) => x.id === id);
        if (m) { clearInterval(t); ok(m); } else if (Date.now() - t0 > ms) { clearInterval(t); mal(new Error("sin respuesta a " + id + "\n" + stderr)); }
      }, 5);
    });
  }
  const enviar = (m) => hijo.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n");
  async function pedir(method, params) {
    const id = siguienteId++;
    enviar({ id, method, params });
    return esperar(id);
  }
  async function iniciar() {
    const r = await pedir("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "pruebas-docuprivado", version: "1" } });
    enviar({ method: "notifications/initialized" });
    return r;
  }
  const llamar = (name, args, meta) => pedir("tools/call", { name, arguments: args, ...(meta ? { _meta: meta } : {}) });
  async function cerrar() {
    hijo.stdin.end();
    const codigo = await Promise.race([salidaProceso, new Promise((ok) => setTimeout(() => { hijo.kill(); ok("matado"); }, 3000))]);
    return { codigo, stderr, lineasMalas, mensajes };
  }
  // Las respuestas llevan rutas cortas, desde el nombre de la carpeta autorizada
  // («Carpeta\Alquiler\x.pdf», mejora 1 del hito 7). Para abrir en las pruebas los archivos
  // que crea la extensión, largas() las devuelve a su ruta completa.
  const raices = carpetas.map((c) => {
    try {
      return fs.realpathSync.native(c);
    } catch {
      return path.resolve(c);
    }
  });
  function larga(ruta) {
    for (const r of raices) {
      const n = path.basename(r).toLowerCase();
      const t = ruta.toLowerCase();
      if (t === n || t.startsWith(n + path.sep)) return path.join(path.dirname(r), ruta);
    }
    return ruta;
  }
  const largas = (v) => (typeof v === "string" ? larga(v) : Array.isArray(v) ? v.map(largas)
    : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, largas(x)])) : v);
  return { iniciar, pedir, llamar, cerrar, mensajes, largas, get stderr() { return stderr; }, lineasMalas };
}
