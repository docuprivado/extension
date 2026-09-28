/*
 * Parámetros y comprobaciones que comparten las herramientas de análisis y tachado.
 */
import path from "node:path";
import * as z from "zod/v4";
import { PERFILES, TIPOS } from "../core/deteccion.js";
import { copiaVigente } from "../core/lotes.js";
import { carpetaDeSalida } from "../core/rutas.js";

export function parametrosDeteccion() {
  return {
    tipos: z.array(z.enum(TIPOS)).optional().describe("Solo estos tipos de dato. Si no se indican, se usan los del perfil (preset). " +
      "Tipos: dni, nie, iban, cuenta, tarjeta, telefono, email, nss (Seguridad Social), matricula, direccion, cp, fecha_nac, nombre, empresa, cif (NIF de empresa), importe (cantidades de dinero). " +
      "Como las casillas de la web, algunos llevan otro con ellos: dni también el NIE (quien pide «el DNI» suele querer su número de identidad, sea DNI o NIE), direccion el código postal, iban las cuentas antiguas y empresa su NIF. " +
      "Para solo el NIE, nie; si el usuario quiere solo el DNI y no el NIE, díselo."),
    preset: z.enum(Object.keys(PERFILES)).optional().describe("Perfil por tipo de documento, como en docuprivado.es: general (todo, por defecto), contrato (todo), captura (todo) o nomina (deja a la vista la empresa, los importes, tarjetas y matrículas)."),
    personalizados: z.array(z.string()).optional().describe("Palabras o frases que el usuario quiere tachar además (por ejemplo, un número de expediente)."),
    no_tachar: z.array(z.string()).optional().describe("Palabras que el usuario quiere dejar visibles aunque se detecten (por ejemplo, el nombre de su propia empresa)."),
  };
}

// Avisos agrupados: «Página 1: tiene varias columnas…» de varios archivos en una sola
// línea, para que la respuesta no se llene de avisos repetidos.
export function avisosAgrupados(lista) {
  const grupos = new Map();
  for (const { nombre, avisos } of lista) {
    for (const a of avisos) {
      const texto = a.replace(/^Página \d+: /, "");
      const paginas = a.match(/^Página (\d+): /);
      if (!grupos.has(texto)) grupos.set(texto, new Map());
      const porArchivo = grupos.get(texto);
      if (!porArchivo.has(nombre)) porArchivo.set(nombre, []);
      if (paginas) porArchivo.get(nombre).push(paginas[1]);
    }
  }
  const lineas = [];
  for (const [texto, porArchivo] of grupos) {
    const donde = [...porArchivo].map(([n, p]) => "«" + n + "»" + (p.length ? " (pág. " + p.join(", ") + ")" : "")).join(", ");
    lineas.push("Aviso: " + donde + ": " + texto.charAt(0).toLowerCase() + texto.slice(1));
  }
  return lineas;
}

// Qué se puede analizar y tachar: PDF (con texto o escaneados) y fotos.
export function motivoNoTachable(a) {
  if (a.tipo === "pdf" || a.tipo === "imagen") return null;
  if (a.tipo === "word" || a.tipo === "texto") {
    return "«" + a.nombre + "» es un " + (a.tipo === "word" ? "Word" : "archivo de texto") + ": no se tacha, se anonimiza (sus datos se cambian por etiquetas " +
      "conservando el formato). Pídeme que lo anonimice.";
  }
  return "«" + a.nombre + "» no es un PDF ni una foto (JPG, PNG, WebP o HEIC).";
}

// Qué se puede limpiar de datos ocultos: solo fotos.
export function motivoNoFoto(a) {
  if (a.tipo === "imagen") return null;
  if (a.tipo === "pdf") return "«" + a.nombre + "» es un PDF: esta herramienta es para fotos. Para quitarle los datos personales, pídeme que lo tache (la copia tachada tampoco lleva los datos ocultos del original).";
  return "«" + a.nombre + "» no es una foto (JPG, PNG, WebP o HEIC).";
}

/**
 * No repetir lo ya hecho (mejora del hito 2, aprobada por el titular): de los archivos que
 * salen de recorrer carpetas, aparta los que ya tienen una copia («-tachado», «-sin-datos»)
 * más reciente que el original en su carpeta de resultados. Los pedidos por su nombre
 * siempre se procesan. Devuelve la lista de saltados y deja en el lote el resto.
 * extensionesDe(archivo): las extensiones que puede tener su copia (o null si no aplica).
 */
export function saltarHechos(ctx, lote, carpetaSalida, sufijo, extensionesDe) {
  const cuenta = new Map();
  lote.archivos.forEach((a) => { const b = path.basename(a.nombre, path.extname(a.nombre)).toLowerCase(); cuenta.set(b, (cuenta.get(b) || 0) + 1); });
  const repetidos = new Set([...cuenta].filter(([, n]) => n > 1).map(([b]) => b));
  const saltados = [];
  lote.archivos = lote.archivos.filter((a) => {
    const extensiones = a.deCarpeta ? extensionesDe(a) : null;
    if (!extensiones) return true;
    let carpeta;
    try {
      carpeta = carpetaDeSalida(ctx, a.ruta, carpetaSalida);
    } catch {
      return true;
    }
    const copia = copiaVigente(a, carpeta, repetidos, sufijo, extensiones);
    if (copia) saltados.push({ ruta: a.ruta, copia });
    return !copia;
  });
  return saltados;
}

// «Quedan N archivos. Dime «continúa» y sigo.», con lo que sigue en marcha.
export function lineaPendientes(pendientes, enCurso, que = "") {
  return "Quedan " + pendientes.length + (pendientes.length === 1 ? " archivo" : " archivos") + (que ? " " + que : "") + ". Dime «continúa» y sigo." +
    (enCurso && enCurso.length ? " (Sigo trabajando en «" + enCurso.join("», «") + "» mientras tanto.)" : "");
}
