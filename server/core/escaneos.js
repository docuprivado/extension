/*
 * Páginas escaneadas y fotos: su texto con el lector (server/core/lector.js) y dónde van
 * los tachados, con las mismas reglas que el tachador de la web:
 * - el texto y la caja de cada palabra, con montarTextoOcr de js/tachador-reglas.js
 *   (copiado en server/shared/): líneas, tabulador entre columnas y alto de la línea;
 * - los rectángulos, con rectangulosLeidos de js/tachador-reglas.js: el trozo de la caja
 *   de la palabra que ocupa el dato (sin dejar asomar media letra), un margen pequeño
 *   proporcional a la línea y las barras de una misma línea unidas.
 * Unidades: las de la página (puntos en un PDF, píxeles en una foto).
 * Lo leído se recuerda un rato en memoria (nunca en disco) para no volver a leer el mismo
 * escaneo si se analiza y después se tacha.
 */
import { leer } from "./lector.js";
import { reglas } from "./motores.js";

export const PPP_OCR = 300;            // como la web: el lector necesita más resolución
const MARGEN = 1.5;                    // el de la web (js/tachador.js, MARGEN)
const RECORDAR_MS = 30 * 60 * 1000;
const RECORDAR_MAX = 300;

// Imagen RGBA → PPM (P6): los píxeles tal cual, con lo transparente sobre blanco.
export function ppm(img) {
  const { data, width, height } = img;
  const cab = Buffer.from("P6\n" + width + " " + height + "\n255\n", "latin1");
  const rgb = Buffer.allocUnsafe(width * height * 3);
  for (let i = 0, j = 0; j < rgb.length; i += 4, j += 3) {
    const a = data[i + 3];
    if (a === 255) {
      rgb[j] = data[i]; rgb[j + 1] = data[i + 1]; rgb[j + 2] = data[i + 2];
    } else {
      const f = a / 255;
      rgb[j] = data[i] * f + 255 * (1 - f); rgb[j + 1] = data[i + 1] * f + 255 * (1 - f); rgb[j + 2] = data[i + 2] * f + 255 * (1 - f);
    }
  }
  return Buffer.concat([cab, rgb]);
}

const recordados = new Map();
function recordar(clave, valor) {
  const ahora = Date.now();
  for (const [k, v] of recordados) if (ahora - v.t > RECORDAR_MS) recordados.delete(k);
  while (recordados.size >= RECORDAR_MAX) recordados.delete(recordados.keys().next().value);
  recordados.set(clave, { t: ahora, valor });
}

/**
 * Lee una imagen RGBA de una página o foto. escala: píxeles de la imagen por unidad de
 * página. clave: identifica el archivo y la página (para no leerla dos veces).
 * Devuelve { texto, items: [{ inicio, fin, rect }], confianza }.
 */
export async function leerTexto(img, escala, clave) {
  const r = clave && recordados.get(clave);
  if (r && Date.now() - r.t <= RECORDAR_MS) return r.valor;
  const datos = await leer(ppm(img), { blocks: true });
  const montado = reglas().montarTextoOcr(datos, escala);
  const valor = { texto: montado.texto, items: montado.items, confianza: typeof datos.confidence === "number" ? datos.confidence : null };
  if (clave) recordar(clave, valor);
  return valor;
}

// Avisos de una página leída: casi nada legible (girada, borrosa) o lectura difícil.
export function avisosDeLectura(pagina) {
  if (!reglas().tieneTexto(pagina.texto)) return ["escaneo ilegible"];
  if (pagina.confianza !== null && pagina.confianza < 60) return ["escaneo difícil"];
  return [];
}

/**
 * Rectángulos (en unidades de la página) de un trozo del texto leído, con las reglas de la
 * web (js/tachador-reglas.js, rectangulosLeidos): la parte de la caja de cada palabra que
 * ocupa el dato, la palabra entera si lo que queda son solo signos («12345678Z.») y media
 * letra más si el corte cae entre letras; margen pequeño y barras de una línea unidas.
 */
export function rectangulosOcr(pagina, inicio, fin) {
  return reglas().rectangulosLeidos(pagina, inicio, fin, MARGEN);
}
