/*
 * De lo que pide el usuario («estas nóminas», «la carpeta Alquiler») a la lista de
 * archivos que se van a procesar, dentro de las carpetas autorizadas.
 * - Carpetas: sus archivos (con las subcarpetas solo si se pide «recursivo»), sin entrar
 *   en las subcarpetas «docuprivado» (donde se guardan los resultados) ni repetir copias
 *   ya tachadas («-tachado.pdf»).
 * - Como máximo LIMITE_ARCHIVOS por llamada: el resto queda pendiente.
 * - copiaVigente(): la copia tachada que ya tiene un documento, si es más reciente que él
 *   (para no volver a tacharlo al repetir una carpeta; mejora aprobada por el titular).
 */
import fs from "node:fs";
import path from "node:path";
import { ErrorUsuario } from "./errores.js";
import { LIMITE_ARCHIVOS, LIMITE_BYTES, MENSAJES, recorrer, resolver } from "./rutas.js";
import { tipoDeArchivo } from "./tipos-archivo.js";

const ES_RESULTADO = /-(tachado|anonimo|protegido|restaurado|sin-datos)( \(\d+\))?\.[a-z0-9]+$/i;

export function expandir(ctx, rutas, recursivo) {
  if (!Array.isArray(rutas) || !rutas.length) throw new ErrorUsuario("Dime qué archivos o carpetas quieres usar (rutas).", "sinRutas");
  const vistos = new Set();
  const archivos = [];
  const errores = [];
  for (const entrada of rutas) {
    let r;
    try {
      r = resolver(ctx, entrada, { tipo: "cualquiera" });
    } catch (err) {
      if (err instanceof ErrorUsuario) { errores.push({ ruta: String(entrada), motivo: err.message }); continue; }
      throw err;
    }
    if (r.esCarpeta) {
      const dentro = [];
      recorrer(ctx, r.ruta, { recursivo: !!recursivo }, (ruta, dirent) => {
        if (dirent.isDirectory()) return;
        if (path.basename(path.dirname(ruta)).toLowerCase() === "docuprivado") return;   // resultados anteriores
        if (ES_RESULTADO.test(path.basename(ruta))) return;
        dentro.push(ruta);
      });
      dentro.sort((a, b) => a.localeCompare(b, "es"));
      for (const f of dentro) anadir(f, true);
    } else {
      anadir(r.ruta, false);
    }
  }
  // deCarpeta: el archivo sale de recorrer una carpeta (no se pidió por su nombre).
  function anadir(ruta, deCarpeta) {
    const k = ruta.toLowerCase();
    if (vistos.has(k)) return;
    vistos.add(k);
    let st;
    try {
      st = fs.statSync(ruta);
    } catch {
      return;
    }
    if (st.size > LIMITE_BYTES) {
      errores.push({ ruta, motivo: MENSAJES.demasiadoGrande });
      return;
    }
    archivos.push({ ruta, nombre: path.basename(ruta), tipo: tipoDeArchivo(ruta), bytes: st.size, modificado: st.mtimeMs, deCarpeta });
  }
  const pendientes = archivos.length > LIMITE_ARCHIVOS ? archivos.splice(LIMITE_ARCHIVOS) : [];
  return { archivos, errores, pendientes };
}

/**
 * La copia tachada (o limpia) más reciente de «archivo» en su carpeta de resultados, si es
 * posterior al original (entonces no hace falta volver a hacerla). Con una carpeta de
 * resultados común a varias carpetas, solo si ningún otro archivo del lote se llama igual
 * (su copia podría ser la del otro). sufijo: «-tachado» o «-sin-datos»; extensiones: las
 * que puede tener la copia.
 */
export function copiaVigente(archivo, carpetaResultados, nombresRepetidos, sufijo = "-tachado", extensiones = ["pdf"]) {
  const ext = path.extname(archivo.nombre);
  const base = path.basename(archivo.nombre, ext);
  const junto = path.join(path.dirname(archivo.ruta), "docuprivado").toLowerCase() === carpetaResultados.toLowerCase();
  if (!junto && nombresRepetidos.has(base.toLowerCase())) return null;
  const escapar = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patron = new RegExp("^" + escapar(base) + escapar(sufijo) + "( \\(\\d+\\))?\\.(" + extensiones.map(escapar).join("|") + ")$", "i");
  let mejor = null;
  let entradas;
  try {
    entradas = fs.readdirSync(carpetaResultados);
  } catch {
    return null;
  }
  for (const n of entradas) {
    if (!patron.test(n)) continue;
    try {
      const st = fs.statSync(path.join(carpetaResultados, n));
      if (st.mtimeMs >= archivo.modificado && (!mejor || st.mtimeMs > mejor.t)) mejor = { ruta: path.join(carpetaResultados, n), t: st.mtimeMs };
    } catch { /* desapareció */ }
  }
  return mejor ? mejor.ruta : null;
}
