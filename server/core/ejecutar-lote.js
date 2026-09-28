/*
 * Procesa una lista de archivos dentro del presupuesto de tiempo de una llamada
 * (server/core/trabajos.js). Lo que no da tiempo a empezar queda en «pendientes»; lo que
 * ya ha empezado sigue en segundo plano y se entrega en la llamada siguiente.
 */
import { ErrorUsuario } from "./errores.js";
import { describirError, registrar } from "./registro.js";
import { esperar, lanzar, recoger, reloj } from "./trabajos.js";

export function mensajeDeError(err, nombre) {
  if (err instanceof ErrorUsuario) return err.message;
  registrar("fallo inesperado con un archivo (" + describirError(err) + ")");
  return "No he podido procesar «" + nombre + "» (" + describirError(err) + "). Prueba en docuprivado.es o escríbenos a contacto@docuprivado.es con ese código.";
}

/**
 * opciones.aceptar(archivo) → null si se procesa, o el motivo por el que no.
 * opciones.clave(archivo) → clave del trabajo (mismo archivo y mismas opciones = mismo trabajo).
 * opciones.trabajo(archivo) → promesa con el resultado.
 */
export async function ejecutarLote(archivos, opciones, presupuesto) {
  const r = reloj(presupuesto);
  const hechos = [];
  const fallos = [];
  const pendientes = [];
  const enCurso = [];
  for (const a of archivos) {
    const motivo = opciones.aceptar(a);
    if (motivo) {
      fallos.push({ ruta: a.ruta, nombre: a.nombre, motivo });
      continue;
    }
    if (r.queda() <= 0) {
      pendientes.push(a.ruta);
      continue;
    }
    const k = opciones.clave(a);
    const t = lanzar(k, () => opciones.trabajo(a));
    await esperar(t, r.queda());
    if (t.estado === "en curso") {
      pendientes.push(a.ruta);
      enCurso.push(a.nombre);
      continue;
    }
    recoger(k);
    if (t.estado === "error") fallos.push({ ruta: a.ruta, nombre: a.nombre, motivo: mensajeDeError(t.error, a.nombre) });
    else hechos.push(t.resultado);
  }
  return { hechos, fallos, pendientes, enCurso, ms: r.transcurrido() };
}

// Clave estable de un archivo con sus opciones: si el archivo cambia, es otro trabajo.
export function claveDe(herramienta, archivo, opciones) {
  return herramienta + "|" + archivo.ruta.toLowerCase() + "|" + archivo.bytes + "|" + archivo.modificado + "|" + JSON.stringify(opciones);
}
