/*
 * Registro de la extensión: va a la salida de errores (Claude Desktop lo guarda en
 * %APPDATA%\Claude\logs\ en Windows y ~/Library/Logs/Claude en macOS).
 * Nunca se escribe el contenido de un documento, un dato detectado ni el nombre o la
 * ruta de un archivo del usuario (CLAUDE.md §4.7): solo cifras, tiempos y códigos.
 */
export function registrar(...partes) {
  process.stderr.write("[docuprivado] " + partes.join(" ") + "\n");
}

// De un error solo se registra lo que no puede llevar datos del usuario: su tipo y su
// código (ENOENT, EACCES…). El mensaje de Node suele incluir la ruta del archivo.
export function describirError(err) {
  if (!err) return "error desconocido";
  const partes = [err.name || "Error"];
  if (err.code) partes.push(String(err.code));
  return partes.join(" ");
}
