/*
 * listar_documentos (docs/PROMPT_EXTENSION.md §5.2): busca documentos en las carpetas
 * autorizadas para que Claude encuentre «la nómina de septiembre» sin que el usuario
 * escriba rutas. Solo lee nombres, tamaños y fechas: nunca abre los documentos.
 */
import fs from "node:fs";
import path from "node:path";
import * as z from "zod/v4";
import { ErrorUsuario } from "../core/errores.js";
import { LIMITE_ARCHIVOS, recorrer, resolver } from "../core/rutas.js";
import { respuesta } from "../core/respuestas.js";
import { CLAVES_TIPO, TIPOS_DOCUMENTO, fechaLegible, tamanoLegible, tipoDeArchivo } from "../core/tipos-archivo.js";

// Sin mayúsculas, sin tildes y con _ - . como espacios: «Nómina_Sept» ≈ «nomina sept».
function normal(s) {
  return String(s).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[_\-.]+/g, " ");
}

// «2026-09-01» o «01/09/2026» → fecha (inicio de ese día, hora local).
export function leerFecha(texto) {
  const t = String(texto).trim();
  let m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  let a, mes, d;
  if (m) [a, mes, d] = [m[1], m[2], m[3]];
  else if ((m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/))) [d, mes, a] = [m[1], m[2], m[3]];
  else return null;
  const f = new Date(Number(a), Number(mes) - 1, Number(d));
  if (f.getFullYear() !== Number(a) || f.getMonth() !== Number(mes) - 1 || f.getDate() !== Number(d)) return null;
  return f;
}

export function listarDocumentos(ctx, params) {
  const tipos = params.tipos && params.tipos.length ? params.tipos : CLAVES_TIPO;
  const palabras = params.buscar ? normal(params.buscar).split(/\s+/).filter(Boolean) : [];
  // Buscando por nombre se miran también las subcarpetas, salvo que se diga lo contrario.
  const recursivo = params.recursivo !== undefined ? !!params.recursivo : palabras.length > 0;
  let desde = null;
  if (params.modificados_desde) {
    desde = leerFecha(params.modificados_desde);
    if (!desde) throw new ErrorUsuario("No entiendo la fecha «" + params.modificados_desde + "». Escríbela como 2026-09-01 o 01/09/2026.", "fecha");
  }
  const carpetas = params.carpeta && params.carpeta.trim()
    ? [resolver(ctx, params.carpeta, { tipo: "carpeta" }).ruta]
    : ctx.permitidas.map((c) => c.real);
  if (!carpetas.length) throw new ErrorUsuario("No hay ninguna carpeta autorizada disponible. Elige al menos una en Ajustes → Extensiones → docuprivado.", "sinCarpetas");

  const encontrados = new Map();
  let cortado = false;
  for (const carpeta of carpetas) {
    const r = recorrer(ctx, carpeta, { recursivo }, (ruta, dirent) => {
      if (!dirent.isFile()) return;
      const tipo = tipoDeArchivo(ruta);
      if (!tipo || !tipos.includes(tipo)) return;
      const nombre = path.basename(ruta);
      if (palabras.length) {
        const n = normal(nombre);
        if (!palabras.every((p) => n.includes(p))) return;
      }
      encontrados.set(ruta, { ruta, nombre, tipo });
    });
    if (r.cortado) cortado = true;
  }

  // Tamaño y fecha de cada uno (solo de los que coinciden).
  let lista = [];
  for (const d of encontrados.values()) {
    try {
      const st = fs.statSync(d.ruta);
      if (desde && st.mtime < desde) continue;
      lista.push({ ...d, bytes: st.size, modificado: st.mtime });
    } catch { /* desapareció mientras tanto */ }
  }
  lista.sort((a, b) => b.modificado - a.modificado);
  const total = lista.length;
  lista = lista.slice(0, LIMITE_ARCHIVOS);
  return { total, lista, cortado, recursivo, carpetas, tipos, palabras };
}

export function definir(ctx) {
  const esquemaDocumento = z.object({
    nombre: z.string(),
    ruta: z.string(),
    tipo: z.string(),
    bytes: z.number(),
    tamano: z.string(),
    modificado: z.string(),
    modificadoLegible: z.string(),
  });
  return {
    nombre: "listar_documentos",
    config: {
      title: "Buscar documentos",
      description: "Busca y lista documentos (PDF, imágenes, Word .docx y texto) en las carpetas que el usuario autorizó para docuprivado, " +
        "con su nombre, ruta, tipo, tamaño y fecha de modificación, de más reciente a más antiguo. " +
        "Úsala para encontrar un documento que el usuario menciona sin dar la ruta (por ejemplo, «la nómina de septiembre») o para ver qué hay en una carpeta. " +
        "Solo lee nombres, tamaños y fechas: no abre ni lee el contenido de ningún documento. " +
        "Las rutas van sin la parte del ordenador: empiezan por el nombre de la carpeta autorizada y sirven tal cual en las demás herramientas. " +
        "Buscando por nombre («buscar») recorre también las subcarpetas; sin «buscar», solo la carpeta indicada salvo que pongas recursivo: true.",
      inputSchema: z.object({
        carpeta: z.string().optional().describe("Carpeta donde buscar: su ruta completa, relativa a una carpeta autorizada o solo su nombre. Si no se indica, se busca en todas las carpetas autorizadas."),
        buscar: z.string().optional().describe("Palabras que debe contener el nombre del archivo (sin distinguir mayúsculas ni tildes), por ejemplo «nomina septiembre»."),
        tipos: z.array(z.enum(["pdf", "imagen", "word", "texto"])).optional().describe("Tipos de documento: pdf, imagen (JPG, PNG, WebP, HEIC), word (.docx) o texto (.txt, .md, .csv). Por defecto, todos."),
        recursivo: z.boolean().optional().describe("true para buscar también en las subcarpetas."),
        modificados_desde: z.string().optional().describe("Solo documentos modificados desde esta fecha (AAAA-MM-DD o DD/MM/AAAA)."),
      }),
      outputSchema: z.object({
        total: z.number(),
        mostrados: z.number(),
        documentos: z.array(esquemaDocumento),
        carpetas: z.array(z.string()),
        subcarpetas: z.boolean(),
        busquedaIncompleta: z.boolean(),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    fn: async (params) => {
      const r = listarDocumentos(ctx, params);
      const docs = r.lista.map((d) => ({
        nombre: d.nombre,
        ruta: d.ruta,
        tipo: TIPOS_DOCUMENTO[d.tipo].nombre,
        bytes: d.bytes,
        tamano: tamanoLegible(d.bytes),
        modificado: d.modificado.toISOString(),
        modificadoLegible: fechaLegible(d.modificado),
      }));
      const filtros = [];
      if (r.palabras.length) filtros.push("con «" + params.buscar.trim() + "» en el nombre");
      if (params.tipos && params.tipos.length) filtros.push("de tipo " + params.tipos.map((t) => TIPOS_DOCUMENTO[t].nombre).join(", "));
      if (params.modificados_desde) filtros.push("modificados desde el " + fechaLegible(leerFecha(params.modificados_desde)));
      const donde = r.carpetas.length === 1 ? "en " + r.carpetas[0] : "en tus " + r.carpetas.length + " carpetas autorizadas";
      const sub = r.recursivo ? " (incluidas las subcarpetas)" : "";
      const lineas = [];
      if (!r.total) {
        lineas.push("No he encontrado documentos" + (filtros.length ? " " + filtros.join(", ") : "") + " " + donde + sub + ".");
        if (!r.recursivo) lineas.push("No he mirado en las subcarpetas: puedo buscar también en ellas si quieres.");
      } else {
        lineas.push("He encontrado " + r.total + (r.total === 1 ? " documento" : " documentos") + (filtros.length ? " " + filtros.join(", ") : "") + " " + donde + sub +
          (r.total > docs.length ? "; te enseño los " + docs.length + " más recientes" : "") + ":");
        docs.forEach((d) => lineas.push("- " + d.nombre + " · " + d.tipo + ", " + d.tamano + ", modificado el " + d.modificadoLegible + " · " + d.ruta));
      }
      if (r.cortado) lineas.push("Aviso: hay tantos archivos que no he podido revisarlos todos; indica una carpeta más concreta.");
      return respuesta(lineas.join("\n"), {
        total: r.total,
        mostrados: docs.length,
        documentos: docs,
        carpetas: r.carpetas,
        subcarpetas: r.recursivo,
        busquedaIncompleta: r.cortado,
      });
    },
  };
}
