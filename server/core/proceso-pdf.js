/*
 * Un PDF de principio a fin, para las herramientas analizar_datos_personales y
 * tachar_documentos. Nunca modifica el original: la copia tachada es un archivo nuevo.
 * Las páginas escaneadas se leen con el lector, como en la web.
 */
import path from "node:path";
import { ErrorUsuario } from "./errores.js";
import { TEXTO_ESCONDIDOS, abrir, buscarEscondidos, comprobarSinTexto, detectar, leerTextos, tachar } from "./documento-pdf.js";
import { carpetaDeSalida, escribirSinSobrescribir } from "./rutas.js";

export const AVISO_PAGINA = {
  "texto girado": "tiene texto girado: la detección puede fallar ahí",
  "varias columnas": "parece tener varias columnas: revisa que no se haya mezclado nada",
  "escaneo ilegible": "está escaneada y no he podido leer casi nada (¿está girada, borrosa o es una foto?): revísala a mano",
  "escaneo difícil": "está escaneada y se lee con dificultad: revísala con más cuidado",
};

export function avisosDe(paginas, prefijo = "Página ", enLaCopia = false) {
  const avisos = [];
  for (const p of paginas) for (const a of p.avisos) avisos.push(prefijo + (prefijo ? p.num + ": " : "") + (AVISO_PAGINA[a] || textoAviso(a, enLaCopia)) + ".");
  return avisos;
}

// «escondidos:3» → el aviso del «tachado falso» (hito de actualización 18 de la web).
function textoAviso(a, enLaCopia) {
  const m = /^escondidos:(\d+)$/.exec(a);
  if (!m) return a;
  const n = Number(m[1]);
  return (n === 1 ? "tiene 1 dato escondido" : "tiene " + n + " datos escondidos") + " (" + TEXTO_ESCONDIDOS + "): no se " + (n === 1 ? "ve" : "ven") +
    ", pero cualquiera puede copiarlo" + (n === 1 ? "" : "s") + " del PDF original; tapar con un recuadro no borra lo de debajo" +
    (enLaCopia ? ". En la copia tachada ya no está" + (n === 1 ? "" : "n") : "");
}

export function porTipoDe(marcas) {
  const cuenta = {};
  for (const m of marcas) cuenta[m.tipo] = (cuenta[m.tipo] || 0) + 1;
  return cuenta;
}

/** Solo contar: no escribe nada. */
export async function analizarPdf(archivo, det) {
  const d = await abrir(archivo.ruta, archivo.nombre);
  try {
    const paginas = await leerTextos(d);
    const { visibles } = detectar(paginas, det);
    await buscarEscondidos(d, paginas);   // «tachado falso»
    const marcas = paginas.flatMap((p) => p.marcas.concat(p.marcasCampo || [])
      .map((m) => ({ pagina: p.num, tipo: m.tipo, valor: m.valor, confianza: m.confianza, campo: !!m.campo, escondido: m.escondido || null })));
    const escaneadas = paginas.filter((p) => p.ocr).map((p) => p.num);
    return {
      ruta: archivo.ruta, nombre: archivo.nombre, tipo: "pdf", paginas: d.paginas, escaneadas, marcas, porTipo: porTipoDe(marcas), visibles,
      campos: marcas.filter((m) => m.campo).length, dudosos: marcas.filter((m) => m.confianza !== "alta").length, avisos: avisosDe(paginas),
      escondidos: marcas.filter((m) => m.escondido).length,
    };
  } finally {
    await d.cerrar();
  }
}

/**
 * Tachar: copia nueva con los datos tapados, comprobada antes de guardarla.
 * opciones: { estilo, calidad, carpetaSalida }. El pixelado es solo para fotos: en un PDF,
 * barras negras.
 */
export async function tacharPdf(ctx, archivo, det, opciones) {
  const d = await abrir(archivo.ruta, archivo.nombre);
  try {
    const paginas = await leerTextos(d);
    const escaneadas = paginas.filter((p) => p.ocr).map((p) => p.num);
    const { visibles } = detectar(paginas, det);
    const marcas = paginas.flatMap((p) => p.marcas.concat(p.marcasCampo || []));
    const estilo = opciones.estilo === "pixelado" ? "negro" : opciones.estilo;
    const r = await tachar(d, paginas, { estilo, calidad: opciones.calidad, miniaturas: true });
    const problemas = await comprobarSinTexto(r.bytes, d.paginas, marcas.map((m) => m.valor));
    if (problemas.length) {
      // Nunca se entrega una copia que no pase la comprobación (CLAUDE.md §4.5).
      throw new ErrorUsuario("No he guardado la copia de «" + archivo.nombre + "» porque no ha pasado la comprobación final (" + problemas.join("; ") + "). Táchalo en docuprivado.es/tachar-documento/ y avísanos.", "comprobacion");
    }
    const carpeta = carpetaDeSalida(ctx, archivo.ruta, opciones.carpetaSalida);
    const ext = path.extname(archivo.nombre);
    const copia = escribirSinSobrescribir(ctx, carpeta, path.basename(archivo.nombre, ext), "-tachado", ".pdf", r.bytes);
    const sinSitio = r.paginas.reduce((s, p) => s + p.sinSitio, 0);
    const avisos = avisosDe(paginas, "Página ", true);
    if (sinSitio) avisos.push("No he podido situar " + sinSitio + (sinSitio === 1 ? " dato" : " datos") + " en la página: revisa la copia (en la hoja de revisión salen marcadas).");
    return {
      ruta: archivo.ruta, nombre: archivo.nombre, tipo: "pdf", copia, paginas: d.paginas, escaneadas, datos: marcas.length, porTipo: porTipoDe(marcas),
      campos: marcas.filter((m) => m.campo).length, dudosos: marcas.filter((m) => m.confianza !== "alta").length,
      visibles, avisos, miniaturas: r.paginas, bytes: r.bytes.length, pixeladoNoAplicado: opciones.estilo === "pixelado",
      escondidos: marcas.filter((m) => m.escondido).length,
    };
  } finally {
    await d.cerrar();
  }
}
