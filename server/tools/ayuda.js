/*
 * ayuda_docuprivado (docs/PROMPT_EXTENSION.md §5.1): qué puede hacer la extensión,
 * frases de ejemplo, carpetas autorizadas, versión y enlace. Solo lectura.
 */
import * as z from "zod/v4";
import { CAPACIDADES, ENLACE, capacidadesDisponibles } from "../core/catalogo.js";
import { respuesta } from "../core/respuestas.js";
import { dondeEsta } from "../core/rutas.js";

export function definir(ctx) {
  return {
    nombre: "ayuda_docuprivado",
    config: {
      title: "Ayuda de docuprivado",
      description: "Explica qué puede hacer la extensión de docuprivado y da ejemplos de cómo pedirlo. " +
        "Úsala cuando el usuario pregunte qué puede hacer, no sepa cómo pedirlo o quiera saber qué carpetas puede usar la extensión. " +
        "No lee ningún documento.",
      inputSchema: z.object({}),
      outputSchema: z.object({
        version: z.string(),
        disponible: z.array(z.string()),
        enPreparacion: z.array(z.string()),
        ejemplos: z.array(z.string()),
        carpetasAutorizadas: z.array(z.string()),
        carpetasNoDisponibles: z.array(z.string()),
        carpetaResultados: z.string(),
        enlace: z.string(),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    fn: async () => {
      const disponibles = capacidadesDisponibles();
      const pendientes = CAPACIDADES.filter((c) => !c.disponible);
      // Un ejemplo de cada cosa que ya sabe hacer y, si cabe, los demás (como mucho 8).
      const ejemplos = disponibles.map((c) => c.ejemplos[0])
        .concat(disponibles.flatMap((c) => c.ejemplos.slice(1))).slice(0, 8);
      const carpetas = ctx.permitidas.map((c) => c.original);
      const resultados = ctx.carpetaSalida || "una subcarpeta «docuprivado» junto a cada documento original";

      const lineas = [];
      lineas.push("docuprivado (versión " + ctx.version + ") trabaja con tus documentos sin que salgan de tu ordenador: " +
        "no se conecta a internet, no modifica ni borra tus archivos (siempre crea copias nuevas) y el contenido de tus documentos " +
        "no entra en esta conversación salvo que pidas verlo.");
      lineas.push("");
      lineas.push("Ya puedes:");
      disponibles.forEach((c) => lineas.push("- " + c.que));
      if (pendientes.length) {
        lineas.push("");
        lineas.push("En preparación (llegarán en próximas versiones):");
        pendientes.forEach((c) => lineas.push("- " + c.que));
      }
      lineas.push("");
      // Con dónde está cada una, pero sin la carpeta del usuario (su nombre): mejora 1 del hito 7.
      lineas.push("Carpetas que puede usar: " + (carpetas.length ? ctx.permitidas.map((c) => "«" + c.nombre + "» (en " + dondeEsta(c) + ")").join("; ") : "ninguna disponible ahora mismo") + ".");
      if (ctx.noDisponibles.length) lineas.push("No están disponibles ahora (¿unidad desconectada?): " + ctx.noDisponibles.join("; ") + ".");
      lineas.push("Los resultados se guardan en " + resultados + ".");
      if (ctx.avisoSalida) lineas.push(ctx.avisoSalida);
      lineas.push("Para cambiar las carpetas: Ajustes → Extensiones → docuprivado.");
      lineas.push("");
      lineas.push("Ejemplos de lo que puedes pedirme:");
      ejemplos.forEach((e) => lineas.push("- «" + e + "»"));
      lineas.push("");
      lineas.push("Más información y la última versión: " + ENLACE);

      return respuesta(lineas.join("\n"), {
        version: ctx.version,
        disponible: disponibles.map((c) => c.que),
        enPreparacion: pendientes.map((c) => c.que),
        ejemplos,
        carpetasAutorizadas: carpetas,
        carpetasNoDisponibles: ctx.noDisponibles,
        carpetaResultados: resultados,
        enlace: ENLACE,
      });
    },
  };
}
