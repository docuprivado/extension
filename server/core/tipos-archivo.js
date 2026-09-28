/*
 * Tipos de documento que entiende la extensión, por extensión del archivo.
 */
import path from "node:path";

export const TIPOS_DOCUMENTO = {
  pdf: { nombre: "PDF", extensiones: [".pdf"] },
  imagen: { nombre: "Imagen", extensiones: [".jpg", ".jpeg", ".png", ".webp", ".heic", ".heif"] },
  word: { nombre: "Word", extensiones: [".docx"] },
  texto: { nombre: "Texto", extensiones: [".txt", ".md", ".csv"] },
};

export const CLAVES_TIPO = Object.keys(TIPOS_DOCUMENTO);

export function tipoDeArchivo(ruta) {
  const ext = path.extname(ruta).toLowerCase();
  for (const clave of CLAVES_TIPO) {
    if (TIPOS_DOCUMENTO[clave].extensiones.includes(ext)) return clave;
  }
  return null;
}

// 1234567 → «1,2 MB», como se escribe en España.
export function tamanoLegible(bytes) {
  if (bytes < 1024) return bytes + " bytes";
  const unidades = ["KB", "MB", "GB"];
  let valor = bytes / 1024;
  let i = 0;
  while (valor >= 1024 && i < unidades.length - 1) {
    valor /= 1024;
    i++;
  }
  const texto = valor >= 100 ? String(Math.round(valor)) : valor.toFixed(1).replace(".", ",").replace(/,0$/, "");
  return texto + " " + unidades[i];
}

// Fecha en formato español (27/09/2026), en la hora local del ordenador.
export function fechaLegible(fecha) {
  const d = new Date(fecha);
  const dos = (n) => String(n).padStart(2, "0");
  return dos(d.getDate()) + "/" + dos(d.getMonth() + 1) + "/" + d.getFullYear();
}
