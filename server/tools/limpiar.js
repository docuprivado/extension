/*
 * limpiar_metadatos_imagen (docs/PROMPT_EXTENSION.md §5.5): crea copias de fotos sin la
 * ubicación ni los demás datos ocultos (modelo del móvil, fecha, números de serie, vídeo
 * de las fotos en movimiento…), igual que «Quitar la ubicación» de la herramienta Fotos de
 * la web (server/core/proceso-foto.js). Nunca modifica los originales y nunca devuelve los
 * datos: solo cuántas fotos llevaban la ubicación y qué tipo de datos llevaba cada una.
 */
import path from "node:path";
import * as z from "zod/v4";
import { claveDe, ejecutarLote } from "../core/ejecutar-lote.js";
import { expandir } from "../core/lotes.js";
import { limpiarFoto } from "../core/proceso-foto.js";
import { respuesta } from "../core/respuestas.js";
import { carpetaPedida } from "../core/rutas.js";
import { lineaPendientes, motivoNoFoto, saltarHechos } from "./comunes.js";

const UBICACION = "Ubicación exacta (GPS)";
const NOMBRE_FORMATO = { jpeg: "JPG", png: "PNG", webp: "WebP", heic: "HEIC" };

// «Ubicación exacta (GPS), Autor, Número de serie…» en minúsculas y como lista corta.
function queLlevaba(datos) {
  const lista = datos.map((d) => d.charAt(0).toLowerCase() + d.slice(1));
  if (lista.length <= 1) return lista.join("");
  return lista.slice(0, -1).join(", ") + " y " + lista[lista.length - 1];
}

export function definir(ctx) {
  return {
    nombre: "limpiar_metadatos_imagen",
    config: {
      title: "Quitar la ubicación de las fotos",
      description: "Crea copias de fotos (JPG, PNG, WebP y HEIC del iPhone), de una en una o de carpetas enteras, sin la ubicación GPS ni los demás datos ocultos " +
        "(modelo del móvil, fecha, números de serie, miniaturas, datos de edición, el vídeo de las «fotos en movimiento»…), respetando la orientación. " +
        "Si puede, no vuelve a comprimir la imagen (queda exactamente igual); las HEIC se guardan en JPG. Comprueba cada copia antes de guardarla. " +
        "Nunca modifica ni borra los originales: guarda «<nombre>-sin-datos.<ext>» en una subcarpeta «docuprivado» junto al original (o en la carpeta de resultados). " +
        "Devuelve cuántas fotos llevaban la ubicación y qué tipo de datos llevaba cada una, nunca los datos en sí. No tapa nada de lo que se ve en la foto (para datos escritos en ella, tachar_documentos).",
      inputSchema: z.object({
        rutas: z.array(z.string()).min(1).describe("Fotos o carpetas: ruta completa, relativa a una carpeta autorizada o solo el nombre."),
        recursivo: z.boolean().optional().describe("true para incluir también las subcarpetas de las carpetas indicadas."),
        carpeta_salida: z.string().optional().describe("Carpeta donde guardar las copias (dentro de las autorizadas). Si no se indica, se usa la elegida al instalar o una subcarpeta «docuprivado» junto a cada original."),
        repetir: z.boolean().optional().describe("Al limpiar una carpeta, las fotos que ya tienen una copia limpia más reciente que el original se saltan. true para volver a hacerlas. Las fotos pedidas por su nombre siempre se hacen."),
      }),
      outputSchema: z.object({
        copias: z.array(z.object({
          original: z.string(), copia: z.string(), formato: z.string(), formatoCopia: z.string(), sinPerdida: z.boolean(),
          ubicacion: z.boolean(), datosQuitados: z.array(z.string()), reducida: z.boolean(),
        })),
        conUbicacion: z.number(),
        conDatos: z.number(),
        total: z.number(),
        saltados: z.array(z.object({ ruta: z.string(), copia: z.string() })),
        noLimpiadas: z.array(z.object({ ruta: z.string(), motivo: z.string() })),
        pendientes: z.array(z.string()),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    fn: async (params) => {
      const opciones = { carpetaSalida: null };
      if (params.carpeta_salida && params.carpeta_salida.trim()) opciones.carpetaSalida = carpetaPedida(ctx, params.carpeta_salida);
      const lote = expandir(ctx, params.rutas, params.recursivo);
      // Al recorrer carpetas solo cuentan las fotos: lo demás no es un error, se deja estar.
      const otros = lote.archivos.filter((a) => a.deCarpeta && a.tipo !== "imagen").length;
      lote.archivos = lote.archivos.filter((a) => !a.deCarpeta || a.tipo === "imagen");
      const saltados = params.repetir ? [] : saltarHechos(ctx, lote, opciones.carpetaSalida, "-sin-datos", () => ["jpg", "jpeg", "jfif", "png", "webp"]);
      const r = await ejecutarLote(lote.archivos, {
        aceptar: motivoNoFoto,
        clave: (a) => claveDe("limpiar", a, opciones),
        trabajo: (a) => limpiarFoto(ctx, a, opciones),
      });
      const copias = r.hechos.map((h) => ({
        original: h.ruta, copia: h.copia, formato: h.formato, formatoCopia: h.formatoSalida, sinPerdida: h.sinPerdida,
        ubicacion: h.ubicacion, datosQuitados: h.datos, reducida: !!h.reducida, _reducida: h.reducida,
      }));
      const conUbicacion = copias.filter((c) => c.ubicacion).length;
      const conDatos = copias.filter((c) => c.datosQuitados.length).length;
      const noLimpiadas = lote.errores.concat(r.fallos).map((f) => ({ ruta: f.ruta, motivo: f.motivo }));
      const pendientes = r.pendientes.concat(lote.pendientes.map((a) => a.ruta));

      const l = [];
      if (copias.length) {
        const carpetas = [...new Set(copias.map((c) => path.dirname(c.copia)))];
        const n = copias.length;
        // Lo que hace útil la herramienta: cuántas decían dónde se hicieron.
        l.push((conUbicacion ? conUbicacion + " de " + n + (n === 1 ? " foto llevaba" : " fotos llevaban") + " la ubicación exacta de dónde se hicieron"
          : (n === 1 ? "La foto no llevaba" : "Ninguna de las " + n + " fotos llevaba") + " la ubicación de dónde se hizo") +
          (conDatos > conUbicacion ? "; " + conDatos + " llevaban otros datos ocultos" : "") + ".");
        l.push("He creado " + (n === 1 ? "1 copia limpia" : n + " copias limpias") + " en " + carpetas.join(" y ") + ", sin ubicación ni otros datos ocultos (comprobado en cada una).");
        copias.slice(0, 15).forEach((c) => {
          const partes = [c.datosQuitados.length ? "llevaba " + queLlevaba(c.datosQuitados) : "no llevaba datos ocultos"];
          if (c.sinPerdida) partes.push("la imagen no cambia (no se ha vuelto a comprimir)");
          else partes.push("rehecha en " + (NOMBRE_FORMATO[c.formatoCopia] || c.formatoCopia) + " de calidad alta" + (c.formato === "heic" ? " (era HEIC, la del iPhone)" : ""));
          if (c._reducida) partes.push("guardada a " + c._reducida.a.join(" × ") + " px porque era muy grande");
          l.push("- " + path.basename(c.copia) + ": " + partes.join("; ") + ".");
        });
        if (n > 15) l.push("- … y " + (n - 15) + " más.");
      }
      if (saltados.length) {
        l.push("He saltado " + (saltados.length === 1 ? "1 foto que ya tenía" : saltados.length + " fotos que ya tenían") + " una copia limpia más reciente que el original (" +
          saltados.slice(0, 5).map((x) => "«" + path.basename(x.ruta) + "»").join(", ") + (saltados.length > 5 ? "…" : "") + "). Si quieres volver a hacerlas, dímelo.");
      }
      noLimpiadas.forEach((f) => l.push("No limpiada: " + f.motivo));
      if (otros) l.push("En las carpetas había " + otros + (otros === 1 ? " archivo que no es una foto" : " archivos que no son fotos") + ": no los he tocado.");
      if (pendientes.length) l.push(lineaPendientes(pendientes, r.enCurso));
      if (!copias.length && !noLimpiadas.length && !pendientes.length && !saltados.length) l.push("No he encontrado ninguna foto en lo que me has indicado.");
      if (copias.length) {
        l.push("Esto quita los datos escondidos en el archivo, no lo que se ve en la foto: si en ella se lee algún dato personal (un DNI, un papel), pídeme que la tache; " +
          "las matrículas se pueden tapar en docuprivado.es/imagen/tapar-matricula/.");
      }
      copias.forEach((c) => delete c._reducida);
      return respuesta(l.join("\n"), { copias, conUbicacion, conDatos, total: copias.length, saltados, noLimpiadas, pendientes });
    },
  };
}
