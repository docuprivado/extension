/*
 * Quitar la ubicación y los datos ocultos de una foto, igual que «Quitar la ubicación» de
 * la herramienta Fotos de la web (/imagen/quitar-metadatos/, js/fotos.js) y con su mismo
 * motor (js/fotos-motor.js, copiado sin cambios):
 *   - si se puede, sin volver a comprimir la imagen (JPG, PNG y WebP): se quitan los
 *     bloques de datos y se deja, si hace falta, solo la orientación, para que no salga de
 *     lado; también el vídeo de las «fotos en movimiento», las imágenes escondidas y lo
 *     pegado al final del archivo;
 *   - si no (HEIC del iPhone, estructuras raras), se rehace la imagen: derecha, a 4096 px
 *     de lado como máximo, en PNG si era PNG o tiene transparencias y si no en JPG de
 *     calidad alta (0,92);
 *   - y se comprueba que la copia ya no lleva nada antes de guardarla.
 * Nunca modifica el original. Nunca devuelve los datos (ni la ubicación): solo qué había.
 */
import fs from "node:fs";
import path from "node:path";
import { ErrorUsuario } from "./errores.js";
import { CALIDAD_JPEG, LADO_MAX_FOTOS, MENSAJES_IMAGEN, abrirFoto, codificar, formatoDe, metadatos } from "./imagenes.js";
import { fotosMotor } from "./motores.js";
import { carpetaDeSalida, escribirSinSobrescribir } from "./rutas.js";

const EXTENSION = { jpeg: ".jpg", png: ".png", webp: ".webp" };
const MISMO_FORMATO = { jpeg: /^\.(jpe?g|jfif)$/i, png: /^\.png$/i, webp: /^\.webp$/i };

async function aBytes(blob) {
  return new Uint8Array(await blob.arrayBuffer());
}

export async function limpiarFoto(ctx, archivo, opciones) {
  const M = fotosMotor();
  const bytes = new Uint8Array(fs.readFileSync(archivo.ruta));
  // Vacía (0 bytes): se dice así, no «dañada» (hito de actualización 17). El código sigue siendo el de la web.
  if (!bytes.length) throw new ErrorUsuario("«" + archivo.nombre + "» está vacía (0 bytes): no tiene nada dentro. ¿Se quedó a medias al copiarla? Vuelve a guardarla.", "danado");
  const meta = metadatos(bytes);
  let salida = null;
  let formatoSalida = formatoDe(bytes);
  let sinPerdida = false;
  let reducida = null;
  const limpio = meta.sinPerdida ? M.limpiarSinPerdida(bytes, meta) : null;
  if (limpio) {
    salida = await aBytes(limpio);
    sinPerdida = true;
  } else {
    const foto = await abrirFoto(bytes, archivo.nombre, LADO_MAX_FOTOS);   // también dice si no es una foto
    formatoSalida = meta.formato === "png" || meta.alfa || foto.formato === "png" || foto.alfa ? "png" : "jpeg";
    salida = new Uint8Array(codificar(foto.img, formatoSalida, CALIDAD_JPEG));
    const m2 = metadatos(salida);
    const b2 = m2.hay ? M.limpiarSinPerdida(salida, m2) : null;
    if (b2) salida = await aBytes(b2);
    if (foto.reducida) reducida = { de: [foto.anchoReal, foto.altoReal], a: [foto.img.width, foto.img.height] };
  }
  // Comprobación: se vuelve a leer la copia; no puede quedar nada.
  if (metadatos(salida).hay) {
    throw new ErrorUsuario("No he guardado la copia de «" + archivo.nombre + "» porque no ha pasado la comprobación final (quedan datos ocultos). Prueba en docuprivado.es/imagen/quitar-metadatos/ y avísanos.", "comprobacion");
  }
  const ext = path.extname(archivo.nombre);
  const extSalida = MISMO_FORMATO[formatoSalida] && MISMO_FORMATO[formatoSalida].test(ext) ? ext : EXTENSION[formatoSalida];
  const carpeta = carpetaDeSalida(ctx, archivo.ruta, opciones.carpetaSalida);
  const copia = escribirSinSobrescribir(ctx, carpeta, path.basename(archivo.nombre, ext), "-sin-datos", extSalida, salida);
  return {
    ruta: archivo.ruta, nombre: archivo.nombre, copia, formato: meta.formato === "otro" ? formatoDe(bytes) : meta.formato, formatoSalida,
    // Un mismo dato puede ir en dos sitios de la foto (el autor en el EXIF y en el XMP): una vez.
    sinPerdida, reducida, ubicacion: !!meta.gps, datos: [...new Set(meta.campos.map((c) => c.etiqueta))], bytes: salida.length,
  };
}
