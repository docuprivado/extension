/*
 * tachar_documentos (docs/PROMPT_EXTENSION.md §5.4): crea copias tachadas de uno o varios
 * PDF (con texto o escaneados) y fotos (JPG, PNG, WebP, HEIC), o de carpetas enteras, como
 * el tachador de la web. Nunca modifica los originales: cada copia es un archivo nuevo
 * («nomina-tachado.pdf», o « (2)» si ya existe), sin texto ni datos ocultos del original y
 * comprobado antes de guardarlo. Además deja una hoja de revisión con las páginas en
 * miniatura (sin datos).
 */
import path from "node:path";
import * as z from "zod/v4";
import { opcionesDeteccion, sumarPorTipo, textoPorTipo } from "../core/deteccion.js";
import { ErrorUsuario } from "../core/errores.js";
import { claveDe, ejecutarLote } from "../core/ejecutar-lote.js";
import { expandir } from "../core/lotes.js";
import { tacharImagen } from "../core/proceso-imagen.js";
import { tacharPdf } from "../core/proceso-pdf.js";
import { respuesta } from "../core/respuestas.js";
import { hojaDeRevision } from "../core/revision.js";
import { carpetaPedida, escribirSinSobrescribir } from "../core/rutas.js";
import { avisosAgrupados, lineaPendientes, motivoNoTachable, parametrosDeteccion, saltarHechos } from "./comunes.js";

export const FRASE_REVISAR = "Revisa las copias antes de enviarlas: la detección automática ayuda, pero puede no encontrarlo todo.";
// El mismo consejo que la web junto a la opción de pixelar (partials/tarjeta-tachador.html).
export const AVISO_PIXELADO = "El pixelado queda más natural en una foto, pero la barra negra es la opción más segura: no deja ni rastro de la forma de lo que había debajo.";

export function definir(ctx) {
  return {
    nombre: "tachar_documentos",
    config: {
      title: "Tachar datos personales",
      description: "Crea copias tachadas de documentos PDF (con texto o escaneados) y de fotos o capturas (JPG, PNG, WebP y HEIC), de uno en uno, varios o carpetas enteras, " +
        "con los datos personales tapados de forma irreversible. Los escaneados y las fotos se leen con un lector de texto en el propio ordenador. " +
        "En los PDF, cada página de la copia es una imagen, sin texto ni metadatos del original, y se comprueba antes de guardarla; las fotos se guardan en el mismo formato (PNG si era PNG; si no, JPG) sin ubicación ni datos ocultos. " +
        "Nunca modifica ni borra los originales: guarda «<nombre>-tachado.pdf» (o .jpg/.png) en una subcarpeta «docuprivado» junto al original (o en la carpeta de resultados) " +
        "y una hoja de revisión con las páginas en miniatura (con los datos dudosos marcados para revisarlos primero). También tapa lo escrito en los campos de formularios rellenables. Avisa si el PDF llevaba datos escondidos (un «tachado falso»: debajo de un recuadro negro, del color del fondo o en letra diminuta), que en la copia ya no están. " +
        "Al repetir una carpeta sin opciones, salta los documentos que ya tienen una copia tachada más reciente (salvo repetir: true); con opciones (tipos, estilo, no_tachar…) los vuelve a tachar. Si no ha tachado nada, lo dice en la primera línea: no lo des por hecho. No devuelve los datos tachados. " +
        "No sirve para Word ni archivos de texto. Si un PDF tiene contraseña, no la pidas: indica que se abra en la web.",
      inputSchema: z.object({
        rutas: z.array(z.string()).min(1).describe("Archivos o carpetas: ruta completa, relativa a una carpeta autorizada o solo el nombre."),
        recursivo: z.boolean().optional().describe("true para incluir también las subcarpetas de las carpetas indicadas."),
        ...parametrosDeteccion(),
        estilo: z.enum(["negro", "etiqueta", "pixelado"]).optional().describe("negro (por defecto, lo más seguro): barras negras; etiqueta: barras negras con el tipo de dato escrito dentro (DNI, NOMBRE…); " +
          "pixelado: solo en fotos (en los PDF se usan barras negras), queda más natural pero es menos seguro que la barra negra."),
        calidad: z.enum(["normal", "alta"]).optional().describe("normal (por defecto, archivos ligeros) o alta (PDF con páginas PNG sin pérdida y fotos JPG con más calidad; archivos más grandes)."),
        carpeta_salida: z.string().optional().describe("Carpeta donde guardar las copias (dentro de las autorizadas). Si no se indica, se usa la elegida al instalar o una subcarpeta «docuprivado» junto a cada original."),
        repetir: z.boolean().optional().describe("Al tachar una carpeta sin opciones, los documentos que ya tienen una copia tachada más reciente que el original se saltan. true para volver a tacharlos. Con opciones (tipos, estilo, no_tachar…) no se salta nada. Los archivos pedidos por su nombre siempre se tachan."),
      }),
      outputSchema: z.object({
        copias: z.array(z.object({
          original: z.string(), copia: z.string(), tipo: z.enum(["pdf", "imagen"]), paginas: z.number(), paginasLeidas: z.number(), datos: z.number(),
          porTipo: z.record(z.string(), z.number()), dudosos: z.number(), campos: z.number(), visibles: z.number(), avisos: z.array(z.string()),
          escondidos: z.number().optional(),
        })),
        saltados: z.array(z.object({ ruta: z.string(), copia: z.string() })),
        total: z.number(),
        porTipo: z.record(z.string(), z.number()),
        hojaRevision: z.string().optional(),
        noTachados: z.array(z.object({ ruta: z.string(), motivo: z.string() })),
        pendientes: z.array(z.string()),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    fn: async (params) => {
      const det = opcionesDeteccion(params);
      const opciones = { estilo: params.estilo || "negro", calidad: params.calidad || "normal", carpetaSalida: null };
      if (params.carpeta_salida && params.carpeta_salida.trim()) opciones.carpetaSalida = carpetaPedida(ctx, params.carpeta_salida);
      const lote = expandir(ctx, params.rutas, params.recursivo);
      // No repetir lo ya tachado: al recorrer carpetas, se saltan los documentos que ya
      // tienen una copia tachada más reciente que ellos, salvo con «repetir» o si se piden
      // opciones (otros tipos de dato, otro estilo, palabras que dejar a la vista…): eso es
      // pedir otro tachado (hito de actualización 17; antes se saltaba todo sin más).
      const conOpciones = ["tipos", "preset", "personalizados", "no_tachar", "estilo", "calidad"]
        .some((k) => params[k] !== undefined && params[k] !== null && !(Array.isArray(params[k]) && !params[k].length));
      const saltados = params.repetir || conOpciones ? [] : saltarHechos(ctx, lote, opciones.carpetaSalida, "-tachado",
        (a) => (a.tipo === "pdf" ? ["pdf"] : a.tipo === "imagen" ? ["jpg", "png"] : null));
      const r = await ejecutarLote(lote.archivos, {
        aceptar: motivoNoTachable,
        clave: (a) => claveDe("tachar", a, { det, opciones }),
        trabajo: (a) => (a.tipo === "pdf" ? tacharPdf(ctx, a, det, opciones) : tacharImagen(ctx, a, det, opciones)),
      });
      const copias = r.hechos.map((h) => ({
        original: h.ruta, copia: h.copia, tipo: h.tipo, paginas: h.paginas, paginasLeidas: h.tipo === "imagen" ? 1 : h.escaneadas.length, datos: h.datos, porTipo: h.porTipo,
        dudosos: h.dudosos, campos: h.campos, visibles: h.visibles, avisos: h.avisos, escondidos: h.escondidos || 0,
      }));
      const porTipo = {};
      copias.forEach((c) => sumarPorTipo(porTipo, c.porTipo));
      const total = copias.reduce((s, c) => s + c.datos, 0);
      const noTachados = lote.errores.concat(r.fallos).map((f) => ({ ruta: f.ruta, motivo: f.motivo }));
      const pendientes = r.pendientes.concat(lote.pendientes.map((a) => a.ruta));

      // Hoja de revisión (en la carpeta de la primera copia).
      let hoja;
      if (r.hechos.length) {
        const html = hojaDeRevision(r.hechos.map((h) => ({ nombre: h.nombre, copia: h.copia, datos: h.datos, porTipo: h.porTipo, dudosos: h.dudosos, avisos: h.avisos, paginas: h.miniaturas })));
        const hoy = new Date();
        const dos = (n) => String(n).padStart(2, "0");
        const base = "revision-tachado-" + hoy.getFullYear() + "-" + dos(hoy.getMonth() + 1) + "-" + dos(hoy.getDate()) + "-" + dos(hoy.getHours()) + dos(hoy.getMinutes());
        try {
          hoja = escribirSinSobrescribir(ctx, path.dirname(r.hechos[0].copia), base, "", ".html", html);
        } catch (err) {
          if (!(err instanceof ErrorUsuario)) throw err;
        }
      }

      const l = [];
      if (copias.length) {
        const carpetas = [...new Set(copias.map((c) => path.dirname(c.copia)))];
        l.push("He creado " + (copias.length === 1 ? "1 copia tachada" : copias.length + " copias tachadas") + " en " + carpetas.join(" y ") + ". " +
          (total ? total + (total === 1 ? " dato oculto" : " datos ocultos") + " (" + textoPorTipo(porTipo) + ")." : "No he encontrado datos personales que tachar."));
        copias.slice(0, 15).forEach((c) => l.push("- " + path.basename(c.copia) + ": " + c.datos + (c.datos === 1 ? " dato" : " datos") +
          (c.tipo === "imagen" ? "" : " en " + c.paginas + (c.paginas === 1 ? " página" : " páginas")) + (c.datos === 0 ? " (ninguno encontrado: revísala)" : "")));
        if (copias.length > 15) l.push("- … y " + (copias.length - 15) + " más.");
        const escaneadas = copias.filter((c) => c.tipo === "pdf").reduce((s, c) => s + c.paginasLeidas, 0);
        const fotos = copias.filter((c) => c.tipo === "imagen").length;
        if (escaneadas || fotos) {
          l.push("He leído con el lector de texto " + [escaneadas ? escaneadas + (escaneadas === 1 ? " página escaneada" : " páginas escaneadas") : "", fotos ? fotos + (fotos === 1 ? " foto" : " fotos") : ""].filter(Boolean).join(" y ") +
            ": ahí la detección es menos segura que con texto de verdad, revísalas bien.");
        }
        const dudosos = copias.reduce((s, c) => s + c.dudosos, 0);
        if (dudosos) l.push(dudosos + (dudosos === 1 ? " de esos datos es dudoso" : " de esos datos son dudosos") + " (la detección está menos segura): revísalos primero; en la hoja de revisión salen en amarillo, en una lista al principio.");
        const campos = copias.reduce((s, c) => s + c.campos, 0);
        if (campos) l.push(campos + (campos === 1 ? " dato estaba escrito" : " datos estaban escritos") + " en campos de formulario rellenables: he tapado esos campos enteros.");
        const visibles = copias.reduce((s, c) => s + c.visibles, 0);
        if (visibles) l.push("He dejado a la vista " + visibles + (visibles === 1 ? " dato que coincide" : " datos que coinciden") + " con lo que pediste no tachar.");
        if (opciones.estilo === "pixelado") {
          if (fotos) l.push(AVISO_PIXELADO);
          if (copias.some((c) => c.tipo === "pdf")) l.push("En los PDF he usado barras negras: el pixelado solo se aplica a las fotos.");
        }
        avisosAgrupados(copias.map((c) => ({ nombre: path.basename(c.original), avisos: c.avisos }))).forEach((x) => l.push(x));
        if (hoja) l.push("Hoja de revisión (ábrela en el navegador para ver todas las páginas de un vistazo): " + hoja);
      }
      if (saltados.length) {
        // Si no se ha hecho nada, se dice lo primero y claro: que Claude no lo dé por hecho.
        l.push((copias.length ? "He saltado " : "No he tachado nada nuevo: he saltado ") +
          (saltados.length === 1 ? "1 documento que ya tenía" : saltados.length + " documentos que ya tenían") + " una copia tachada más reciente que el original (" +
          saltados.slice(0, 5).map((x) => "«" + path.basename(x.ruta) + "»").join(", ") + (saltados.length > 5 ? "…" : "") + "). " +
          "Si quieres rehacerlos (por ejemplo, con otras opciones), dímelo y los vuelvo a tachar (repetir: true).");
      }
      noTachados.forEach((f) => l.push("No tachado: " + f.motivo));
      if (pendientes.length) l.push(lineaPendientes(pendientes, r.enCurso));
      if (!copias.length && !noTachados.length && !pendientes.length && !saltados.length) l.push("No he encontrado ningún PDF ni ninguna foto en lo que me has indicado.");
      if (copias.length || pendientes.length) l.push(FRASE_REVISAR);
      const datos = { copias, saltados, total, porTipo, noTachados, pendientes };
      if (hoja) datos.hojaRevision = hoja;
      return respuesta(l.join("\n"), datos);
    },
  };
}
