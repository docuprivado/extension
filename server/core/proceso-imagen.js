/*
 * Una foto o imagen (JPG, PNG, WebP o HEIC) de principio a fin, para analizar y tachar,
 * como el tachador de la web con imágenes (/tachar-documento/imagen/):
 *   1. se abre derecha y, si es muy grande, a 3000 px de lado como máximo (como la web);
 *   2. se lee con el lector y se buscan los datos con el modo escaneo del detector;
 *   3. se tapan con barras negras, con el tipo de dato escrito dentro o pixelados;
 *   4. se guarda en el mismo formato (PNG si era PNG; si no, JPG, como la web), sin datos
 *      ocultos, y se comprueba que la copia no lleva ninguno antes de guardarla.
 * Nunca modifica el original.
 */
import fs from "node:fs";
import path from "node:path";
import { enmascarar } from "./deteccion.js";
import { detectar, miniatura, rotularImagen } from "./documento-pdf.js";
import { ErrorUsuario } from "./errores.js";
import { avisosDeLectura, leerTexto, rectangulosOcr } from "./escaneos.js";
import { CALIDAD_JPEG, CALIDAD_JPEG_ALTA, LADO_MAX_TACHAR, abrirFoto, codificar, metadatos, pintarNegro, pixelar } from "./imagenes.js";
import { porTipoDe } from "./proceso-pdf.js";
import { carpetaDeSalida, escribirSinSobrescribir } from "./rutas.js";

const AVISO_FOTO = {
  "escaneo ilegible": "no he encontrado texto que leer (si lo tiene, puede que esté girada o borrosa): revísala a mano",
  "escaneo difícil": "se lee con dificultad: revísala con más cuidado",
  "varias columnas": "parece tener varias columnas: revisa que no se haya mezclado nada",
};

// Abre la foto y lee su texto (lo leído se recuerda un rato, por si se analiza y se tacha).
async function leerFoto(archivo) {
  const bytes = new Uint8Array(fs.readFileSync(archivo.ruta));
  const foto = await abrirFoto(bytes, archivo.nombre, LADO_MAX_TACHAR);
  const clave = archivo.ruta.toLowerCase() + "|" + bytes.length + "|" + archivo.modificado + "|foto";
  const leido = await leerTexto(foto.img, 1, clave);
  const pagina = { num: 1, texto: leido.texto, items: leido.items, confianza: leido.confianza, ocr: true, campos: [], avisos: [] };
  pagina.avisos.push(...avisosDeLectura(pagina));
  if (pagina.texto.split("\n").filter((l) => l.includes("\t")).length >= 5) pagina.avisos.push("varias columnas");
  const avisos = pagina.avisos.map((a) => (AVISO_FOTO[a] || a).replace(/^./, (c) => c.toUpperCase()) + ".");
  return { foto, pagina, avisos };
}

const x = (a, b) => a + " × " + b + " px";

/** Solo contar: no escribe nada. */
export async function analizarImagen(archivo, det) {
  const { pagina, avisos } = await leerFoto(archivo);
  const { visibles } = detectar([pagina], det);
  const marcas = pagina.marcas.map((m) => ({ pagina: 1, tipo: m.tipo, valor: m.valor, confianza: m.confianza, campo: false }));
  return {
    ruta: archivo.ruta, nombre: archivo.nombre, tipo: "imagen", paginas: 1, escaneadas: [], marcas, porTipo: porTipoDe(marcas), visibles,
    campos: 0, dudosos: marcas.filter((m) => m.confianza !== "alta").length, avisos,
  };
}

/**
 * Tachar: copia nueva con los datos tapados. opciones: { estilo (negro, etiqueta o
 * pixelado), calidad, carpetaSalida }.
 */
export async function tacharImagen(ctx, archivo, det, opciones) {
  const { foto, pagina, avisos } = await leerFoto(archivo);
  const { visibles } = detectar([pagina], det);
  const marcas = pagina.marcas;
  const tachados = [];
  let sinSitio = 0;
  for (const m of marcas) {
    const rects = rectangulosOcr(pagina, m.inicio, m.fin);
    if (!rects.length) { sinSitio++; continue; }
    for (const r of rects) tachados.push({ ...r, tipo: m.tipo, dudoso: m.confianza !== "alta" });
  }
  const img = foto.img;
  if (opciones.estilo === "pixelado") {
    pixelar(img, tachados);
  } else {
    pintarNegro(img, tachados);
    if (opciones.estilo === "etiqueta" && tachados.length) await rotularImagen(img, tachados);
  }
  const formatoSalida = foto.formato === "png" ? "png" : "jpeg";
  const bytes = codificar(img, formatoSalida, opciones.calidad === "alta" ? CALIDAD_JPEG_ALTA : CALIDAD_JPEG);
  // Comprobación: la copia no lleva ubicación ni ningún otro dato oculto.
  const quedan = metadatos(new Uint8Array(bytes));
  if (quedan.hay) {
    throw new ErrorUsuario("No he guardado la copia de «" + archivo.nombre + "» porque no ha pasado la comprobación final (quedan datos ocultos en el archivo). Táchala en docuprivado.es/tachar-documento/imagen/ y avísanos.", "comprobacion");
  }
  const carpeta = carpetaDeSalida(ctx, archivo.ruta, opciones.carpetaSalida);
  const base = path.basename(archivo.nombre, path.extname(archivo.nombre));
  const copia = escribirSinSobrescribir(ctx, carpeta, base, "-tachado", formatoSalida === "png" ? ".png" : ".jpg", bytes);
  if (sinSitio) avisos.push("No he podido situar " + sinSitio + (sinSitio === 1 ? " dato" : " datos") + " en la foto: revisa la copia.");
  if (foto.reducida) avisos.push("Era muy grande (" + x(foto.anchoReal, foto.altoReal) + "): la copia se ha guardado a " + x(img.width, img.height) + ", como en la web.");
  if (foto.formato === "heic" || foto.formato === "webp") avisos.push("Era " + (foto.formato === "heic" ? "HEIC (la del iPhone)" : "WebP") + ": la copia es JPG, que se abre en cualquier sitio.");
  const dudosos = marcas.filter((m) => m.confianza !== "alta");
  return {
    ruta: archivo.ruta, nombre: archivo.nombre, tipo: "imagen", copia, paginas: 1, escaneadas: [], datos: marcas.length, porTipo: porTipoDe(marcas),
    campos: 0, dudosos: dudosos.length, visibles, avisos, bytes: bytes.length,
    miniaturas: [{
      num: 1, datos: marcas.length, campos: 0, trozos: 0, sinSitio, leida: true,
      dudosos: dudosos.map((m) => ({ tipo: m.tipo, valor: enmascarar(m.tipo, m.valor), campo: false })),
      miniatura: miniatura(img, tachados),
      rects: opciones.conRects ? tachados : undefined,       // solo para las pruebas de cobertura
    }],
  };
}
