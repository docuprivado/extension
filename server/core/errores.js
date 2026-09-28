/*
 * Errores que se le explican al usuario tal cual (ruta fuera de las carpetas, archivo que
 * no existe, fecha mal escrita…). Cualquier otro error se considera inesperado y se
 * responde con un mensaje genérico (server/core/respuestas.js).
 */
export class ErrorUsuario extends Error {
  constructor(mensaje, codigo, extra) {
    super(mensaje);
    this.name = "ErrorUsuario";
    this.codigo = codigo;
    if (extra) this.extra = extra;
  }
}
