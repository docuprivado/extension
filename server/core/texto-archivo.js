/*
 * Archivos de texto (.txt, .md, .csv): leerlos sabiendo cómo están escritos y guardarlos
 * igual, para que la copia se abra como el original.
 * - UTF-8 (con o sin la marca del principio) y UTF-16, tal cual.
 * - Si no es UTF-8, se lee como Windows-1252 (lo que usan Excel y el Bloc de notas antiguo
 *   en España). La copia se guarda en UTF-8 con la marca del principio: así Excel y el Bloc
 *   de notas la abren bien, con sus tildes y eñes, y no se pierde ningún carácter.
 */
const BOM8 = [0xef, 0xbb, 0xbf];

export function leerTexto(buf) {
  const b = Buffer.from(buf);
  if (b[0] === BOM8[0] && b[1] === BOM8[1] && b[2] === BOM8[2]) return { texto: b.subarray(3).toString("utf8"), codificacion: "utf8-bom" };
  if (b[0] === 0xff && b[1] === 0xfe) return { texto: b.subarray(2).toString("utf16le"), codificacion: "utf16le" };
  if (b[0] === 0xfe && b[1] === 0xff) {
    const le = Buffer.from(b.subarray(2));
    for (let i = 0; i + 1 < le.length; i += 2) { const x = le[i]; le[i] = le[i + 1]; le[i + 1] = x; }
    return { texto: le.toString("utf16le"), codificacion: "utf16be" };
  }
  try {
    return { texto: new TextDecoder("utf-8", { fatal: true }).decode(b), codificacion: "utf8" };
  } catch {
    return { texto: new TextDecoder("windows-1252").decode(b), codificacion: "windows-1252" };
  }
}

export function escribirTexto(texto, codificacion) {
  if (codificacion === "utf8") return Buffer.from(texto, "utf8");
  if (codificacion === "utf16le") return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(texto, "utf16le")]);
  if (codificacion === "utf16be") {
    const b = Buffer.from(texto, "utf16le");
    for (let i = 0; i + 1 < b.length; i += 2) { const x = b[i]; b[i] = b[i + 1]; b[i + 1] = x; }
    return Buffer.concat([Buffer.from([0xfe, 0xff]), b]);
  }
  return Buffer.concat([Buffer.from(BOM8), Buffer.from(texto, "utf8")]);   // utf8-bom y windows-1252
}
