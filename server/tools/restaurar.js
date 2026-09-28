/*
 * restaurar_archivo (docs/PROMPT_EXTENSION.md §5.7): devuelve los datos reales a un
 * archivo con etiquetas (por ejemplo, la respuesta de una IA guardada en un archivo) con
 * la tabla que creó anonimizar_archivo o la que se descarga en la web. Reconoce las
 * etiquetas como la web: con o sin corchetes, en minúsculas, sin confundir PERSONA_1 con
 * PERSONA_10 y solo las que están en la tabla. Nunca devuelve el contenido restaurado.
 */
import path from "node:path";
import * as z from "zod/v4";
import { ErrorUsuario } from "../core/errores.js";
import { claveDe, ejecutarLote } from "../core/ejecutar-lote.js";
import { leerTablaDeArchivo, restaurarArchivo } from "../core/proceso-anonimizar.js";
import { respuesta } from "../core/respuestas.js";
import { carpetaPedida, resolver } from "../core/rutas.js";
import { archivoDeTexto } from "./anonimizar.js";
import { lineaPendientes } from "./comunes.js";

export function definir(ctx) {
  return {
    nombre: "restaurar_archivo",
    config: {
      title: "Devolver los datos reales",
      description: "Devuelve los datos reales a un archivo de texto (.txt, .md, .csv) o Word (.docx) que lleva etiquetas como [PERSONA_1] o [DNI_1] " +
        "(por ejemplo, la respuesta de una IA guardada en un archivo), usando la tabla «<nombre>-tabla.json» que creó anonimizar_archivo " +
        "(o el .json que se descarga en docuprivado.es). Reconoce las etiquetas aunque la IA las haya cambiado un poco (sin corchetes, en minúsculas) " +
        "y solo cambia las que están en la tabla. Crea «<nombre>-restaurado.<ext>» y nunca modifica el original. " +
        "No devuelve el contenido restaurado, porque lleva los datos reales.",
      inputSchema: z.object({
        ruta: z.string().min(1).describe("El archivo con etiquetas: ruta completa, relativa a una carpeta autorizada o solo el nombre."),
        tabla: z.string().min(1).describe("La tabla de equivalencias («<nombre>-tabla.json»): ruta completa, relativa o solo el nombre."),
        carpeta_salida: z.string().optional().describe("Carpeta donde guardar la copia restaurada (dentro de las autorizadas). Si no se indica, la elegida al instalar o una subcarpeta «docuprivado» junto al archivo."),
      }),
      outputSchema: z.object({
        original: z.string(),
        copia: z.string().optional(),
        restauradas: z.number(),
        desconocidas: z.array(z.string()),
        pendiente: z.boolean(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    fn: async (params) => {
      const archivo = archivoDeTexto(ctx, params.ruta);
      const rutaTabla = resolver(ctx, params.tabla, { tipo: "archivo" }).ruta;
      if (path.extname(rutaTabla).toLowerCase() !== ".json") throw new ErrorUsuario("La tabla tiene que ser el archivo «-tabla.json» que creé al anonimizar.", "tabla");
      const tabla = leerTablaDeArchivo(rutaTabla);
      const opciones = { carpetaSalida: null };
      if (params.carpeta_salida && params.carpeta_salida.trim()) opciones.carpetaSalida = carpetaPedida(ctx, params.carpeta_salida);
      const r = await ejecutarLote([archivo], {
        aceptar: () => null,
        clave: (a) => claveDe("restaurar", a, { tabla: rutaTabla.toLowerCase(), opciones }),
        trabajo: (a) => restaurarArchivo(ctx, a, tabla, opciones),
      });
      if (r.fallos.length) throw new ErrorUsuario(r.fallos[0].motivo, "fallo");
      if (!r.hechos.length) return respuesta(lineaPendientes([archivo.ruta], r.enCurso), { original: archivo.ruta, restauradas: 0, desconocidas: [], pendiente: true });
      const h = r.hechos[0];
      const l = [];
      if (!h.copia) {
        l.push("No he encontrado en «" + archivo.nombre + "» ninguna etiqueta de esa tabla, así que no he creado ninguna copia. ¿Es la tabla del documento que anonimizaste?");
      } else {
        l.push("He creado «" + path.basename(h.copia) + "» con " + h.restauradas + (h.restauradas === 1 ? " etiqueta cambiada por su dato real" : " etiquetas cambiadas por sus datos reales") +
          ", en " + path.dirname(h.copia) + ".");
        l.push("La copia restaurada lleva datos reales: trátala con el mismo cuidado que el documento original.");
      }
      if (h.desconocidas.length) l.push("Estas etiquetas no están en la tabla y se han dejado tal cual: " + h.desconocidas.join(", ") + ".");
      const datos = { original: h.ruta, restauradas: h.restauradas, desconocidas: h.desconocidas, pendiente: false };
      if (h.copia) datos.copia = h.copia;
      return respuesta(l.join("\n"), datos);
    },
  };
}
