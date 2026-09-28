/*
 * Lector de escaneados y fotos: tesseract.js 7.0.0 (el mismo que la web), con su núcleo y
 * el español «4.0.0_best_int» (el mismo que descarga la web) dentro del paquete.
 * - Se arranca la primera vez que hace falta, en su propio hilo (server/core/lector-hilo.cjs,
 *   que no deja escribir nada por la salida estándar), y se cierra tras unos minutos sin
 *   uso para devolver la memoria.
 * - El idioma se lee de una carpeta local: con una ruta de disco no hay ninguna dirección
 *   de internet de la que pueda descargar nada, y con cacheMethod "none" no escribe nada.
 * - Cada imagen se le entrega como PPM (los píxeles tal cual, sin comprimir): lee
 *   exactamente lo mismo que con el PNG que le da la web, y es más rápido.
 */
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ErrorUsuario } from "./errores.js";
import { describirError, registrar } from "./registro.js";

const require = createRequire(import.meta.url);
const INACTIVO_MS = 3 * 60 * 1000;

export const MENSAJE_SIN_LECTOR = "No he podido arrancar el lector de escaneados en este ordenador. Mientras, puedes tacharlo en docuprivado.es/tachar-documento/.";

let lectorPromesa = null;
let temporizador = null;
let enUso = 0;

// tesseract.js carga «node-fetch» (que no viaja en el paquete) si el entorno no tiene
// «fetch». La extensión nunca descarga nada, así que en ese caso se pone uno que siempre
// falla. Lo mismo hace el hilo del lector (lector-hilo.cjs).
export function sinFetch() {
  if (typeof globalThis.fetch !== "function") globalThis.fetch = () => Promise.reject(new Error("docuprivado no se conecta a internet"));
}

// Qué módulo falta, sin rutas (pueden llevar el nombre del usuario): para el registro.
function moduloQueFalta(err) {
  const m = /Cannot find module '([^']+)'/.exec(String(err && err.message));
  if (!m) return "";
  const partes = m[1].split(/[\\/]node_modules[\\/]/);
  return " «" + partes[partes.length - 1].replace(/^[A-Za-z]:.*[\\/]/, "") + "»";
}

function arrancar() {
  if (!lectorPromesa) {
    lectorPromesa = (async () => {
      const t0 = Date.now();
      sinFetch();
      const { createWorker } = require("tesseract.js");
      // La carpeta del español se busca por su archivo de datos (el paquete del idioma solo
      // lleva los datos: su index.js no viaja, y buscarlo por el nombre del paquete fallaba).
      const langPath = path.dirname(require.resolve("@tesseract.js-data/spa/4.0.0_best_int/spa.traineddata.gz"));
      const worker = await createWorker("spa", 1, {                 // 1 = solo LSTM, como la web
        langPath,
        cacheMethod: "none",
        gzip: true,
        workerPath: fileURLToPath(new URL("./lector-hilo.cjs", import.meta.url)),
      });
      registrar("lector de escaneados listo en " + (Date.now() - t0) + " ms");
      return worker;
    })();
    lectorPromesa.catch((err) => {
      registrar("el lector de escaneados no arranca (" + describirError(err instanceof Error ? err : new Error(String(err))) + moduloQueFalta(err) + ")");
      lectorPromesa = null;
    });
  }
  return lectorPromesa;
}

function programarCierre() {
  clearTimeout(temporizador);
  temporizador = setTimeout(() => { if (!enUso) cerrarLector(); }, INACTIVO_MS);
  temporizador.unref();
}

/**
 * Lee una imagen (bytes de un PPM, PNG, JPG o WebP). salida: lo que se pide al lector
 * (por defecto, las palabras por bloques, como la web). Devuelve sus datos.
 */
export async function leer(bytes, salida = { blocks: true }) {
  let worker;
  try {
    worker = await arrancar();
  } catch {
    throw new ErrorUsuario(MENSAJE_SIN_LECTOR, "lector");
  }
  enUso++;
  clearTimeout(temporizador);
  try {
    return (await worker.recognize(bytes, {}, salida)).data;
  } finally {
    enUso--;
    if (!enUso) programarCierre();
  }
}

/** Cierra el lector (al terminar la conversación, en las pruebas o tras un rato sin uso). */
export async function cerrarLector() {
  clearTimeout(temporizador);
  const p = lectorPromesa;
  lectorPromesa = null;
  if (!p) return;
  try {
    await (await p).terminate();
  } catch { /* ya estaba cerrado */ }
}
