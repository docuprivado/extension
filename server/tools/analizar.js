/*
 * analizar_datos_personales (docs/PROMPT_EXTENSION.md §5.3): cuenta los datos personales
 * de uno o varios PDF (con texto o escaneados) y fotos sin modificarlos. Por defecto no devuelve los datos; solo si el
 * usuario pide verlos (mostrar_valores) y entonces tapados en parte (CLAUDE.md §4.4).
 */
import * as z from "zod/v4";
import { NOMBRE_TIPO, enmascarar, opcionesDeteccion, sumarPorTipo, textoPorTipo } from "../core/deteccion.js";
import { claveDe, ejecutarLote } from "../core/ejecutar-lote.js";
import { expandir } from "../core/lotes.js";
import { analizarImagen } from "../core/proceso-imagen.js";
import { analizarPdf } from "../core/proceso-pdf.js";
import { respuesta } from "../core/respuestas.js";
import { avisosAgrupados, lineaPendientes, motivoNoTachable, parametrosDeteccion } from "./comunes.js";

export function definir(ctx) {
  return {
    nombre: "analizar_datos_personales",
    config: {
      title: "Contar datos personales",
      description: "Cuenta los datos personales (DNI, NIE, nombres, direcciones, IBAN, teléfonos, correos…) de uno o varios documentos PDF (con texto o escaneados) " +
        "y fotos o capturas (JPG, PNG, WebP y HEIC) sin modificarlos: páginas, páginas escaneadas, cuántos datos de cada tipo y su confianza. " +
        "Los escaneados y las fotos se leen con un lector de texto en el propio ordenador. " +
        "No devuelve los datos salvo que el usuario pida expresamente verlos (mostrar_valores: true), y entonces tapados en parte (un DNI como ***4567**, como recomienda la AEPD). " +
        "Úsala cuando el usuario quiera saber qué datos hay antes de tachar. Admite archivos o carpetas de las carpetas autorizadas. No sirve para Word ni archivos de texto. " +
        "Avisa si un PDF lleva datos escondidos (debajo de un recuadro negro, del color del fondo o en letra diminuta): no se ven, pero se pueden copiar del PDF; es un «tachado falso».",
      inputSchema: z.object({
        rutas: z.array(z.string()).min(1).describe("Archivos o carpetas: ruta completa, relativa a una carpeta autorizada o solo el nombre."),
        recursivo: z.boolean().optional().describe("true para incluir también las subcarpetas de las carpetas indicadas."),
        ...parametrosDeteccion(),
        mostrar_valores: z.boolean().optional().describe("Solo si el usuario pide expresamente ver los datos: los devuelve tapados en parte. Por defecto, false."),
      }),
      outputSchema: z.object({
        archivos: z.array(z.object({
          nombre: z.string(), ruta: z.string(), tipo: z.enum(["pdf", "imagen"]), paginas: z.number(), paginasEscaneadas: z.array(z.number()),
          datos: z.number(), porTipo: z.record(z.string(), z.number()), confianza: z.record(z.string(), z.number()), dudosos: z.number(), campos: z.number(),
          visibles: z.number(), avisos: z.array(z.string()), escondidos: z.number().optional(),
          valores: z.array(z.object({ pagina: z.number(), tipo: z.string(), valor: z.string(), confianza: z.string(), escondido: z.string().nullable().optional() })).optional(),
        })),
        total: z.number(),
        porTipo: z.record(z.string(), z.number()),
        noAnalizados: z.array(z.object({ ruta: z.string(), motivo: z.string() })),
        pendientes: z.array(z.string()),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    fn: async (params) => {
      const det = opcionesDeteccion(params);
      const lote = expandir(ctx, params.rutas, params.recursivo);
      const r = await ejecutarLote(lote.archivos, {
        aceptar: motivoNoTachable,
        clave: (a) => claveDe("analizar", a, det),
        trabajo: (a) => (a.tipo === "pdf" ? analizarPdf(a, det) : analizarImagen(a, det)),
      });
      const mostrar = params.mostrar_valores === true;
      const archivos = r.hechos.map((h) => {
        const confianza = {};
        h.marcas.forEach((m) => { confianza[m.confianza] = (confianza[m.confianza] || 0) + 1; });
        const salida = { nombre: h.nombre, ruta: h.ruta, tipo: h.tipo, paginas: h.paginas, paginasEscaneadas: h.escaneadas, datos: h.marcas.length, porTipo: h.porTipo, confianza, dudosos: h.dudosos, campos: h.campos, visibles: h.visibles, avisos: h.avisos, escondidos: h.escondidos || 0 };
        if (mostrar) salida.valores = h.marcas.map((m) => ({ pagina: m.pagina, tipo: m.tipo, valor: enmascarar(m.tipo, m.valor), confianza: m.confianza, escondido: m.escondido || null }));
        return salida;
      });
      const porTipo = {};
      archivos.forEach((a) => sumarPorTipo(porTipo, a.porTipo));
      const total = archivos.reduce((s, a) => s + a.datos, 0);
      const noAnalizados = lote.errores.concat(r.fallos).map((f) => ({ ruta: f.ruta, motivo: f.motivo }));
      const pendientes = r.pendientes.concat(lote.pendientes.map((a) => a.ruta));

      const l = [];
      for (const a of archivos) {
        let linea = "«" + a.nombre + "»: " + (a.datos ? a.datos + (a.datos === 1 ? " dato personal" : " datos personales") : "ningún dato personal encontrado") +
          (a.tipo === "imagen" ? "" : " en " + a.paginas + (a.paginas === 1 ? " página" : " páginas")) + (a.datos ? " (" + textoPorTipo(a.porTipo) + ")" : "") + ".";
        if (a.tipo === "imagen") linea += " Es una foto: la he leído con el lector de texto, así que la detección es menos segura.";
        else if (a.paginasEscaneadas.length) {
          linea += " " + (a.paginasEscaneadas.length === a.paginas ? (a.paginas === 1 ? "Está escaneada" : "Está escaneado entero") : (a.paginasEscaneadas.length === 1 ? "La página " + a.paginasEscaneadas[0] + " está escaneada" : "Las páginas " + a.paginasEscaneadas.join(", ") + " están escaneadas")) +
            ": " + (a.paginasEscaneadas.length === 1 ? "la he leído" : "las he leído") + " con el lector de texto, así que ahí la detección es menos segura.";
        }
        if (a.dudosos) linea += " " + a.dudosos + (a.dudosos === 1 ? " es dudoso (conviene revisarlo)." : " son dudosos (conviene revisarlos).");
        if (a.campos) linea += " " + a.campos + (a.campos === 1 ? " está" : " están") + " en campos de formulario rellenables.";
        if (a.visibles) linea += " " + a.visibles + (a.visibles === 1 ? " dato coincide" : " datos coinciden") + " con lo que pediste no tachar.";
        l.push(linea);
        if (mostrar && a.valores.length) {
          a.valores.forEach((v) => l.push("  - " + (NOMBRE_TIPO[v.tipo] || v.tipo) + ": " + v.valor + " (página " + v.pagina + (v.confianza !== "alta" ? ", dudoso" : "") + (v.escondido ? ", escondido: no se ve" : "") + ")"));
        }
      }
      avisosAgrupados(archivos).forEach((x) => l.push(x));
      if (archivos.length > 1) l.push("En total: " + total + " datos personales en " + archivos.length + " documentos" + (total ? " (" + textoPorTipo(porTipo) + ")" : "") + ".");
      noAnalizados.forEach((f) => l.push("No analizado: " + f.motivo));
      if (pendientes.length) l.push(lineaPendientes(pendientes, r.enCurso, "por analizar"));
      if (archivos.length && !mostrar) l.push("No te enseño los datos; si quieres verlos, pídemelo y te los muestro tapados en parte.");
      if (!archivos.length && !noAnalizados.length && !pendientes.length) l.push("No he encontrado ningún PDF ni ninguna foto en lo que me has indicado.");
      return respuesta(l.join("\n"), { archivos, total, porTipo, noAnalizados, pendientes });
    },
  };
}
