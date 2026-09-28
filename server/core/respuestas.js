/*
 * Forma común de las respuestas de las herramientas (docs/PROMPT_EXTENSION.md §4.3):
 * un texto corto en español para el usuario y los mismos datos estructurados. Los
 * errores llevan un mensaje humano con qué hacer; nunca el contenido de un documento.
 */
import { ErrorUsuario } from "./errores.js";
import { describirError, registrar } from "./registro.js";

export function respuesta(texto, datos) {
  const r = { content: [{ type: "text", text: texto }] };
  if (datos !== undefined) r.structuredContent = datos;
  return r;
}

export function respuestaError(texto) {
  return { content: [{ type: "text", text: texto }], isError: true };
}

// Aplica «acortar» a todos los textos de una respuesta (solo objetos y listas normales).
export function acortarTodo(valor, acortar) {
  if (typeof valor === "string") return acortar(valor);
  if (Array.isArray(valor)) return valor.map((v) => acortarTodo(v, acortar));
  if (valor && typeof valor === "object" && [Object.prototype, null].includes(Object.getPrototypeOf(valor))) {
    return Object.fromEntries(Object.entries(valor).map(([k, v]) => [k, acortarTodo(v, acortar)]));
  }
  return valor;
}

/**
 * Envuelve la función de una herramienta: mide el tiempo, registra solo cifras y
 * convierte cualquier fallo en un mensaje claro. Los fallos inesperados se registran
 * con su tipo y código, sin rutas ni datos.
 * «acortar» (rutas.js, acortador) cambia en toda la respuesta, texto y datos, las rutas
 * completas por las cortas: el nombre de usuario del ordenador no llega a la conversación.
 */
export function protegida(nombre, fn, acortar) {
  const corta = (r) => (acortar ? acortarTodo(r, acortar) : r);
  return async (params, extra) => {
    const t0 = Date.now();
    try {
      const r = await fn(params || {}, extra);
      registrar(nombre + ": bien en " + (Date.now() - t0) + " ms");
      return corta(r);
    } catch (err) {
      if (err instanceof ErrorUsuario) {
        registrar(nombre + ": aviso «" + err.codigo + "» en " + (Date.now() - t0) + " ms");
        return corta(respuestaError(err.message));
      }
      registrar(nombre + ": fallo inesperado (" + describirError(err) + ") en " + (Date.now() - t0) + " ms");
      return respuestaError("Algo ha fallado en la extensión (" + describirError(err) + "). Vuelve a intentarlo; si se repite, escribe a contacto@docuprivado.es con ese código.");
    }
  };
}
