/*
 * Fotos e imágenes: abrirlas (JPG, PNG, WebP y HEIC), ponerlas derechas, reducirlas,
 * tapar zonas y guardarlas. Todo en JavaScript y WebAssembly, sin nada nativo
 * (CLAUDE.md §4.9):
 * - JPG con jpeg-js y PNG con pngjs;
 * - WebP con el mismo lector de escaneados (su motor sabe abrirlos), sin librerías nuevas;
 * - HEIC con libheif (LGPL, archivo aparte y sin modificar).
 * Las imágenes se manejan como { data: RGBA, width, height }.
 */
import { ErrorUsuario } from "./errores.js";
import { leer } from "./lector.js";
import { fotosMotor, jpeg, libheif, png } from "./motores.js";

export const LADO_MAX_TACHAR = 3000;   // como el tachador de la web (DP.loadImage, maxSide 3000)
export const LADO_MAX_FOTOS = 4096;    // como la herramienta Fotos de la web (js/fotos.js, LADO_MAX)
export const CALIDAD_JPEG = 92;        // la de la web al guardar una foto (0,92)
export const CALIDAD_JPEG_ALTA = 97;

const NOMBRE_FORMATO = { gif: "GIF", bmp: "BMP", tiff: "TIFF", avif: "AVIF", pdf: "PDF" };
export const MENSAJES_IMAGEN = {
  danado: (n) => "No he podido abrir «" + n + "»: parece dañada o no es una foto.",
  formato: (n, f) => "«" + n + "» es " + (f === "pdf" ? "un PDF con nombre de foto" : "una imagen " + (NOMBRE_FORMATO[f] || f)) +
    ": solo trabajo con fotos JPG, PNG, WebP y HEIC." + (f === "pdf" ? " Cámbiale la extensión a .pdf y vuelve a pedírmelo." : ""),
};

// Qué es el archivo según sus primeros bytes (no según su extensión).
export function formatoDe(b) {
  if (!b || b.length < 12) return "otro";
  const a = (i, n) => String.fromCharCode(...b.subarray(i, i + n));
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
  if (b[0] === 0x89 && a(1, 3) === "PNG") return "png";
  if (a(0, 4) === "RIFF" && a(8, 4) === "WEBP") return "webp";
  if (a(4, 4) === "ftyp") return /^avi[fs]$/.test(a(8, 4)) ? "avif" : "heic";
  if (a(0, 3) === "GIF") return "gif";
  if (a(0, 2) === "BM") return "bmp";
  if (a(0, 4) === "II*\0" || a(0, 4) === "MM\0*") return "tiff";
  if (a(0, 5) === "%PDF-" || a(0, 1024).includes("%PDF-")) return "pdf";
  return "otro";
}

/** Los datos ocultos de la foto según el motor de la web, o nada si no se pueden leer. */
export function metadatos(bytes) {
  try {
    return fotosMotor().leerMetadatos(bytes);
  } catch {
    // Estructura que no sabe leer: como en la web, no se enseña nada y se rehace entera.
    return { campos: [], gps: null, orientacion: 1, formato: "otro", alfa: false, sinPerdida: false, hay: false };
  }
}

function hayTransparencia(data) {
  for (let i = 3; i < data.length; i += 4) if (data[i] !== 255) return true;
  return false;
}

function decodificarJpeg(bytes) {
  const r = jpeg().decode(bytes, { useTArray: true, formatAsRGBA: true, tolerantDecoding: true, maxResolutionInMP: 250, maxMemoryUsageInMB: 2048 });
  return { data: r.data, width: r.width, height: r.height };
}

// JPG con bytes sueltos entre sus bloques de cabecera (algunos programas los dejan): los
// navegadores los saltan con un aviso; aquí se quitan antes de decodificar. Solo se toca
// la cabecera, hasta el comienzo de la imagen (SOS); la imagen se copia tal cual.
export function repararJpeg(b) {
  const partes = [b.subarray(0, 2)];
  let i = 2;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) { i++; continue; }                  // byte suelto entre bloques
    const m = b[i + 1];
    if (m === 0xff) { i++; continue; }                     // relleno
    if (m === 0xd9) break;
    if (m === 0xda) { partes.push(b.subarray(i)); return Buffer.concat(partes); }
    const n = (b[i + 2] << 8) | b[i + 3];
    partes.push(b.subarray(i, i + 2 + n));
    i += 2 + n;
  }
  return null;
}

function decodificarPng(bytes) {
  const r = png().sync.read(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length));
  return { data: new Uint8Array(r.data.buffer, r.data.byteOffset, r.data.length), width: r.width, height: r.height };
}

// El motor del lector (Leptonica, con libjpeg y libwebp) también abre fotos y las devuelve
// como PNG. Si ve la orientación EXIF en los primeros 500 bytes, gira la imagen (su regla,
// en tesseract.js: src/worker-script/utils/setImage.js); aquí el giro lo hace orientar(),
// igual para todos los formatos, así que se le cambia ese valor por 1 (sin giro).
function sinGiroParaLector(bytes) {
  const copia = Uint8Array.from(bytes);
  const texto = Array.from(copia.subarray(0, 500)).join(" ");
  const m = texto.match(/1 18 0 3 0 0 0 1 0 (\d)/);
  if (m) copia[texto.slice(0, m.index + m[0].length - 1).split(" ").length - 1] = 1;
  return copia;
}

async function decodificarConLector(bytes) {
  const datos = await leer(Buffer.from(sinGiroParaLector(bytes)), { text: false, imageColor: true });
  const b64 = String(datos.imageColor || "").replace(/^data:image\/png;base64,/, "");
  if (!b64) return null;
  return decodificarPng(new Uint8Array(Buffer.from(b64, "base64")));
}

// WebP: lo abre el motor del lector (no hace falta otra librería). Antes se le quitan los
// datos ocultos si se puede, y el giro, como en decodificarConLector.
async function decodificarWebp(bytes, meta) {
  let entrada = bytes;
  if (meta && meta.sinPerdida) {
    const limpio = fotosMotor().limpiarSinPerdida(bytes, { ...meta, orientacion: 1 });
    if (limpio) entrada = new Uint8Array(await limpio.arrayBuffer());
  }
  return decodificarConLector(entrada);
}

// HEIC: libheif ya la entrega derecha (aplica el giro que lleva dentro).
async function decodificarHeic(bytes) {
  const heif = await libheif();
  const imagenes = new heif.HeifDecoder().decode(bytes);
  if (!imagenes || !imagenes.length) return null;
  try {
    const im = imagenes[0];
    const width = im.get_width();
    const height = im.get_height();
    const datos = await new Promise((ok, mal) => im.display({ data: new Uint8ClampedArray(width * height * 4), width, height }, (d) => (d ? ok(d.data) : mal(new Error("HEIC")))));
    return { data: new Uint8Array(datos.buffer, datos.byteOffset, datos.length), width, height };
  } finally {
    imagenes.forEach((i) => { try { i.free(); } catch { /* ya liberada */ } });
  }
}

/**
 * Abre una foto: la decodifica, la pone derecha según su orientación y, si es más grande
 * que ladoMax, la reduce (como la web). Devuelve { img, formato, meta, reducida,
 * anchoReal, altoReal, alfa }. Si no es una foto que se pueda abrir, error para el usuario.
 */
export async function abrirFoto(bytes, nombre, ladoMax) {
  const formato = formatoDe(bytes);
  if (!["jpeg", "png", "webp", "heic"].includes(formato)) {
    if (NOMBRE_FORMATO[formato]) throw new ErrorUsuario(MENSAJES_IMAGEN.formato(nombre, formato), "formato");
    throw new ErrorUsuario(MENSAJES_IMAGEN.danado(nombre), "danado");
  }
  const meta = metadatos(bytes);
  let img = null;
  try {
    if (formato === "jpeg") img = decodificarJpeg(bytes);
    else if (formato === "png") img = decodificarPng(bytes);
    else if (formato === "webp") img = await decodificarWebp(bytes, meta);
    else img = await decodificarHeic(bytes);
  } catch (err) {
    if (err instanceof ErrorUsuario && err.codigo === "lector") throw err;
    img = null;
  }
  // JPG o PNG que el lector de JavaScript no entiende: se quitan los bytes sueltos entre
  // bloques y, si aun así no, se prueba con el motor del lector, como haría el navegador.
  if (!img && formato === "jpeg") {
    const reparado = repararJpeg(bytes);
    if (reparado) { try { img = decodificarJpeg(reparado); } catch { img = null; } }
  }
  if (!img && (formato === "jpeg" || formato === "png")) img = await decodificarConLector(bytes).catch(() => null);
  if (!img || !img.width || !img.height) throw new ErrorUsuario(MENSAJES_IMAGEN.danado(nombre), "danado");
  if (formato !== "heic") img = orientar(img, meta.orientacion || 1);
  const anchoReal = img.width;
  const altoReal = img.height;
  img = reducir(img, ladoMax);
  return { img, formato, meta, reducida: img.width < anchoReal, anchoReal, altoReal, alfa: hayTransparencia(img.data) };
}

/**
 * Pone derecha una imagen según la orientación EXIF (1 a 8), como hace el navegador
 * («image-orientation: from-image»).
 */
export function orientar(img, o) {
  if (!(o >= 2 && o <= 8)) return img;
  const { data, width: W, height: H } = img;
  const girada = o >= 5;
  const w = girada ? H : W;
  const h = girada ? W : H;
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sx, sy;
      switch (o) {
        case 2: sx = W - 1 - x; sy = y; break;
        case 3: sx = W - 1 - x; sy = H - 1 - y; break;
        case 4: sx = x; sy = H - 1 - y; break;
        case 5: sx = y; sy = x; break;
        case 6: sx = y; sy = H - 1 - x; break;
        case 7: sx = W - 1 - y; sy = H - 1 - x; break;
        default: sx = W - 1 - y; sy = x; break;   // 8
      }
      const s = (sy * W + sx) * 4;
      const d = (y * w + x) * 4;
      out[d] = data[s]; out[d + 1] = data[s + 1]; out[d + 2] = data[s + 2]; out[d + 3] = data[s + 3];
    }
  }
  return { data: out, width: w, height: h };
}

// Pesos de cada píxel de origen en cada píxel de destino (reducción por áreas).
function pesos(origen, destino) {
  const r = origen / destino;
  const lista = [];
  for (let d = 0; d < destino; d++) {
    const a = d * r;
    const b = a + r;
    const partes = [];
    for (let s = Math.floor(a); s < Math.min(origen, Math.ceil(b)); s++) {
      const p = Math.min(b, s + 1) - Math.max(a, s);
      if (p > 0) partes.push(s, p / r);
    }
    lista.push(partes);
  }
  return lista;
}

/** Reduce la imagen para que su lado mayor sea como mucho ladoMax (media por áreas). */
export function reducir(img, ladoMax) {
  const { data, width: W, height: H } = img;
  const f = Math.min(1, ladoMax / Math.max(W, H));
  if (f >= 1) return img;
  const w = Math.max(1, Math.round(W * f));
  const h = Math.max(1, Math.round(H * f));
  const px = pesos(W, w);
  const py = pesos(H, h);
  const out = new Uint8Array(w * h * 4);
  const fila = new Float64Array(w * 4);
  for (let y = 0; y < h; y++) {
    fila.fill(0);
    const pys = py[y];
    for (let k = 0; k < pys.length; k += 2) {
      const sy = pys[k];
      const wy = pys[k + 1];
      const base = sy * W * 4;
      for (let x = 0; x < w; x++) {
        const pxs = px[x];
        let r = 0, g = 0, b = 0, a = 0;
        for (let j = 0; j < pxs.length; j += 2) {
          const o = base + pxs[j] * 4;
          const wx = pxs[j + 1];
          r += data[o] * wx; g += data[o + 1] * wx; b += data[o + 2] * wx; a += data[o + 3] * wx;
        }
        const q = x * 4;
        fila[q] += r * wy; fila[q + 1] += g * wy; fila[q + 2] += b * wy; fila[q + 3] += a * wy;
      }
    }
    const d = y * w * 4;
    for (let q = 0; q < w * 4; q++) out[d + q] = Math.min(255, Math.round(fila[q]));
  }
  return { data: out, width: w, height: h };
}

/** Guarda la imagen: «png» (con transparencia si la tiene) o «jpeg» (sobre blanco). */
export function codificar(img, formato, calidad = CALIDAD_JPEG) {
  const { data, width, height } = img;
  const buf = Buffer.from(data.buffer, data.byteOffset, data.length);
  if (formato === "png") {
    return png().sync.write({ width, height, data: buf }, { colorType: hayTransparencia(data) ? 6 : 2, inputHasAlpha: true, deflateLevel: 6 });
  }
  let entrada = buf;
  if (hayTransparencia(data)) {
    entrada = Buffer.allocUnsafe(data.length);
    for (let i = 0; i < data.length; i += 4) {
      const f = data[i + 3] / 255;
      entrada[i] = data[i] * f + 255 * (1 - f); entrada[i + 1] = data[i + 1] * f + 255 * (1 - f); entrada[i + 2] = data[i + 2] * f + 255 * (1 - f); entrada[i + 3] = 255;
    }
  }
  return jpeg().encode({ data: entrada, width, height }, calidad).data;
}

const recorte = (img, r) => ({
  x0: Math.max(0, Math.floor(r.x)), x1: Math.min(img.width, Math.ceil(r.x + r.w)),
  y0: Math.max(0, Math.floor(r.y)), y1: Math.min(img.height, Math.ceil(r.y + r.h)),
});

/** Barras negras, píxel a píxel (sin bordes suavizados por donde pueda asomar nada). */
export function pintarNegro(img, rects) {
  for (const r of rects) {
    const { x0, x1, y0, y1 } = recorte(img, r);
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const o = (y * img.width + x) * 4;
        img.data[o] = 0; img.data[o + 1] = 0; img.data[o + 2] = 0; img.data[o + 3] = 255;
      }
    }
  }
}

/**
 * Pixelado, solo para fotos, igual que la web (js/tachador.js, pixelar): bloques de al
 * menos 6 píxeles, un sexto del lado menor de la zona, del color de su esquina.
 */
export function pixelar(img, rects) {
  for (const r of rects) {
    const { x0, x1, y0, y1 } = recorte(img, r);
    const paso = Math.max(6, Math.round(Math.min(r.w, r.h) / 6));
    for (let by = y0; by < y1; by += paso) {
      for (let bx = x0; bx < x1; bx += paso) {
        const s = (by * img.width + bx) * 4;
        const c0 = img.data[s], c1 = img.data[s + 1], c2 = img.data[s + 2], c3 = img.data[s + 3];
        for (let y = by; y < Math.min(y1, by + paso); y++) {
          for (let x = bx; x < Math.min(x1, bx + paso); x++) {
            const o = (y * img.width + x) * 4;
            img.data[o] = c0; img.data[o + 1] = c1; img.data[o + 2] = c2; img.data[o + 3] = c3;
          }
        }
      }
    }
  }
}
