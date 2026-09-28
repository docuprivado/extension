/*
 * Anonimizar y restaurar un archivo de texto (.txt, .md, .csv) o un Word (.docx), de
 * principio a fin (docs/PROMPT_EXTENSION.md §5.6 y §5.7), con las reglas del anonimizador
 * de la web (server/shared/anonimizador-reglas.cjs): las mismas etiquetas ([PERSONA_1],
 * [DNI_1]…), los mismos grupos («Sr. Pérez» con «Juan Pérez García») y la misma tabla, que
 * vale también en docuprivado.es/anonimizar-texto-chatgpt/.
 * Nunca modifica el original y nunca devuelve los datos reales: esos solo van en la tabla.
 */
import fs from "node:fs";
import path from "node:path";
import { dejarVisible } from "./deteccion.js";
import { ErrorUsuario } from "./errores.js";
import { detector, reglasAnonimizador } from "./motores.js";
import { carpetaDeSalida, escribirSinSobrescribir } from "./rutas.js";
import { escribirTexto, leerTexto } from "./texto-archivo.js";
import { abrirWord, aplicarCambios, codificarXml, decodificarXml, guardarWord, limpiarFueraDelTexto, textoVisible } from "./word.js";
import { datosDe } from "./zip.js";

export const MAX_CARACTERES = 5000000;
export const AVISO_TABLA = "La tabla contiene los datos reales: no la compartas con nadie ni se la pases a una IA.";
export const MENSAJE_TABLA = "Ese archivo no es una tabla de equivalencias de docuprivado. Tiene que ser el «-tabla.json» que creé al anonimizar (o el .json que descargaste en la web).";

const EXTENSIONES_TEXTO = [".txt", ".md", ".csv"];

function hoy() {
  const d = new Date();
  const dos = (n) => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + dos(d.getMonth() + 1) + "-" + dos(d.getDate());
}

// El documento: su texto y lo necesario para volver a escribirlo igual.
function leerDocumento(archivo) {
  const bytes = fs.readFileSync(archivo.ruta);
  const ext = path.extname(archivo.nombre).toLowerCase();
  let doc;
  if (ext === ".docx") {
    const word = abrirWord(bytes, archivo.nombre);
    doc = { tipo: "word", ext, word, texto: word.texto };
  } else if (EXTENSIONES_TEXTO.includes(ext)) {
    const t = leerTexto(bytes);
    doc = { tipo: "texto", ext, texto: t.texto, codificacion: t.codificacion };
  } else {
    throw new ErrorUsuario("«" + archivo.nombre + "» no es un archivo de texto (.txt, .md, .csv) ni un Word (.docx).", "formato");
  }
  if (doc.texto.length > MAX_CARACTERES) throw new ErrorUsuario("«" + archivo.nombre + "» es demasiado largo (más de 5 millones de caracteres). Divídelo en partes y hazlas de una en una.", "largo");
  return doc;
}

// «Juan Pérez García» → todas las veces que aparece como palabra entera (no dentro de otra).
function reEntero(v) {
  return new RegExp("(?<![\\p{L}\\p{N}])" + v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(?![\\p{L}\\p{N}])", "gu");
}

// Entre documento y documento del texto conjunto: un carácter que no está en ningún dato,
// así que nada se une de un documento a otro.
const SEPARADOR_DOCS = "\n\n\n\n";

// Cambia en un texto suelto (propiedades del Word, descripciones de imágenes…) los datos
// ya encontrados por su etiqueta.
function sustituidor(valores) {
  return (s) => valores.reduce((t, x) => (x.valor.length >= 3 ? t.replace(reEntero(x.valor), x.etiqueta) : t), s);
}

// ¿Quedan en el texto anónimo apariciones enteras de datos ya encontrados? Con la segunda
// pasada de las reglas de la web casi nunca; si pasa, se avisa con las etiquetas, sin el dato.
function restos(texto, valores) {
  const quedan = new Map();
  for (const x of valores) {
    if (x.valor.length < 4) continue;
    const n = (texto.match(reEntero(x.valor)) || []).length;
    if (n) quedan.set(x.etiqueta, (quedan.get(x.etiqueta) || 0) + n);
  }
  return quedan;
}

function resumenGrupos(grupos) {
  return grupos.filter((g) => g.activa).map((g) => ({ etiqueta: g.etiqueta, tipo: g.tipo, veces: g.ocurrencias.length, dudoso: g.confianza !== "alta" }));
}

// Los cambios en un texto: [{ inicio, fin, nuevo }], en orden y sin solaparse.
function aplicarATexto(texto, cambios) {
  let salida = "";
  let pos = 0;
  for (const c of cambios) {
    salida += texto.slice(pos, c.inicio) + c.nuevo;
    pos = c.fin;
  }
  return salida + texto.slice(pos);
}

/**
 * Busca los datos de varios documentos y los reparte en etiquetas comunes: cada documento
 * se lee con su propio contexto, pero la misma persona lleva la misma etiqueta en todos
 * (mejora aprobada por el titular el 28/09/2026). det: { tipos, personalizados, noTachar }.
 */
function etiquetarVarios(docs, det) {
  const D = detector();
  const R = reglasAnonimizador();
  let texto = "";
  const hallazgos = [];
  for (const d of docs) {
    if (texto) texto += SEPARADOR_DOCS;
    d.inicio = texto.length;
    texto += d.texto;
    d.visibles = 0;
    for (const h of D.detect(d.texto, { tipos: det.tipos, personalizados: det.personalizados, ocr: false })) {
      if (dejarVisible(h.valor, det.noTachar)) { d.visibles++; continue; }
      hallazgos.push({ ...h, inicio: h.inicio + d.inicio, fin: h.fin + d.inicio });
    }
  }
  // Las reglas de la web, sobre todo junto (también su segunda pasada: un dato de un
  // documento que aparece sin reconocerse en otro lleva igualmente su etiqueta).
  const { grupos, ocurrencias } = R.construir(texto, hallazgos);
  // Los mismos cambios que hace el texto anónimo de la web (textoAnonimo), repartidos por documento.
  let pos = 0;
  for (const d of docs) d.cambios = [];
  for (const oc of ocurrencias) {
    if (!oc.grupo.activa || oc.inicio < pos) continue;
    pos = oc.fin;
    const d = docs.find((x) => oc.inicio >= x.inicio && oc.fin <= x.inicio + x.texto.length);
    if (d) d.cambios.push({ inicio: oc.inicio - d.inicio, fin: oc.fin - d.inicio, nuevo: oc.grupo.etiqueta, grupo: oc.grupo });
  }
  // Cada valor distinto encontrado, con su etiqueta, de más largo a más corto.
  const valores = [];
  const vistos = new Set();
  for (const oc of ocurrencias) {
    const v = oc.valor.trim();
    if (!v || vistos.has(v)) continue;
    vistos.add(v);
    valores.push({ valor: v, etiqueta: oc.grupo.etiqueta });
  }
  valores.sort((a, b) => b.valor.length - a.valor.length);
  return { grupos, valores };
}

// La copia anónima de un documento, en memoria (todavía no se guarda nada).
function prepararCopia(doc, valores, opciones) {
  const avisos = [];
  const sustituir = sustituidor(valores);
  let salida;
  let textoNuevo;
  let textoVisto;
  let quitado = [];
  if (doc.tipo === "texto") {
    textoNuevo = aplicarATexto(doc.texto, doc.cambios);
    salida = escribirTexto(textoNuevo, doc.codificacion);
    textoVisto = textoNuevo;
    if (doc.codificacion === "windows-1252") avisos.push("El original no estaba en UTF-8: la copia se ha guardado en UTF-8, que se abre bien en Excel y en el Bloc de notas.");
  } else {
    const word = doc.word;
    aplicarCambios(word, doc.cambios);
    const xmlDe = (n) => {
      const p = word.partes.find((x) => x.entrada.nombre === n);
      if (p) return p.xmlNuevo !== undefined ? p.xmlNuevo : p.xml;
      return datosDe(word.entradas.find((x) => x.nombre === n)).toString("utf8");
    };
    const fuera = limpiarFueraDelTexto(word, xmlDe, sustituir);
    // Descripciones de imágenes (texto alternativo) y títulos: también pueden llevar el dato.
    for (const en of word.entradas) {
      if (!/\.xml$/i.test(en.nombre) || fuera.quitar.has(en.nombre)) continue;
      const actual = fuera.otros.has(en.nombre) ? fuera.otros.get(en.nombre) : xmlDe(en.nombre);
      const nuevo = actual.replace(/\b(descr|title)="([^"]*)"/g, (m, a, v) => a + '="' + codificarXml(sustituir(decodificarXml(v))) + '"');
      if (nuevo !== actual) fuera.otros.set(en.nombre, nuevo);
    }
    avisos.push(...fuera.avisos);
    quitado = fuera.quitado;
    salida = guardarWord(word, fuera.otros, fuera.quitar);
    // Comprobación: el Word nuevo se vuelve a abrir y no puede llevar ninguno de los datos
    // cambiados en sus propiedades ni en los textos alternativos.
    const nuevo = abrirWord(salida, doc.archivo.nombre);
    textoNuevo = nuevo.texto;
    const fuera2 = [];
    for (const en of nuevo.entradas) {
      const xml = datosDe(en).toString("utf8");
      if (en.nombre === "docProps/core.xml") fuera2.push(xml.replace(/<[^>]+>/g, "\n"));
      if (en.nombre === "docProps/app.xml") fuera2.push(...[...xml.matchAll(/<(Company|Manager)>([^<]*)</g)].map((m) => m[2]));
      if (/\.rels$/i.test(en.nombre)) fuera2.push(...[...xml.matchAll(/Target="([^"]*)"/g)].map((m) => m[1]));
      if (/\.xml$/i.test(en.nombre)) fuera2.push(...[...xml.matchAll(/\b(?:descr|title)="([^"]*)"/g)].map((m) => m[1]));
    }
    if (restos(decodificarXml(fuera2.join("\n")), valores).size) {
      throw new ErrorUsuario("No he guardado la copia de «" + doc.archivo.nombre + "» porque no ha pasado la comprobación final (queda un dato en las propiedades del documento). Avísanos en contacto@docuprivado.es.", "comprobacion");
    }
    textoVisto = textoVisible(nuevo.partes[0] ? nuevo.partes[0].xml : "");
  }
  const quedan = restos(textoNuevo, valores);
  if (quedan.size) {
    const n = [...quedan.values()].reduce((s, x) => s + x, 0);
    avisos.push("Algún dato ya encontrado vuelve a aparecer " + n + (n === 1 ? " vez más" : " veces más") + " sin reconocerse (" + [...quedan.keys()].slice(0, 5).join(", ") +
      "): búscalo en la copia y cámbialo a mano, o dime que lo añada como palabra a anonimizar.");
  }
  return { salida, avisos, quitado, texto: opciones.mostrarTexto ? textoVisto : undefined };
}

/**
 * Anonimizar uno o varios documentos con una sola tabla. Cada documento con datos tiene su
 * copia «-anonimo» y todos comparten las etiquetas y la tabla. Primero se prepara todo en
 * memoria (con sus comprobaciones) y solo después se guarda: si algo falla, no queda nada a
 * medias. opciones: { carpetaSalida, mostrarTexto, nombreTabla }.
 * Devuelve { tabla, documentos: [...], noAnonimizados: [...], grupos, datos, apariciones, visibles }.
 */
export async function anonimizarVarios(ctx, archivos, det, opciones = {}) {
  const R = reglasAnonimizador();
  const docs = [];
  const noAnonimizados = [];
  for (const a of archivos) {
    try {
      docs.push({ archivo: a, ...leerDocumento(a) });
    } catch (err) {
      if (!(err instanceof ErrorUsuario)) throw err;
      noAnonimizados.push({ ruta: a.ruta, motivo: err.message, error: err });
    }
  }
  if (!docs.length) {
    if (noAnonimizados.length === 1) throw noAnonimizados[0].error;
    return { tabla: null, documentos: [], noAnonimizados: noAnonimizados.map((x) => ({ ruta: x.ruta, motivo: x.motivo })), grupos: [], datos: 0, apariciones: 0, visibles: 0 };
  }
  const { grupos, valores } = etiquetarVarios(docs, det);
  const preparados = docs.map((d) => (d.cambios.length ? { d, ...prepararCopia(d, valores, opciones) } : { d }));
  // Ahora sí, a guardar: las copias y, al final, la tabla.
  const documentos = [];
  for (const p of preparados) {
    const d = p.d;
    const r = { ruta: d.archivo.ruta, nombre: d.archivo.nombre, tipo: d.tipo, copia: null, datos: new Set(d.cambios.map((c) => c.grupo)).size,
      apariciones: d.cambios.length, visibles: d.visibles, avisos: p.avisos || [], quitado: p.quitado || [] };
    if (p.salida) {
      const carpeta = carpetaDeSalida(ctx, d.archivo.ruta, opciones.carpetaSalida);
      const base = path.basename(d.archivo.nombre, path.extname(d.archivo.nombre));
      r.copia = escribirSinSobrescribir(ctx, carpeta, base, "-anonimo", d.ext, p.salida);
      if (p.texto !== undefined) r.texto = p.texto;
    }
    documentos.push(r);
  }
  let tabla = null;
  const copias = documentos.filter((r) => r.copia);
  if (copias.length) {
    const carpeta = path.dirname(copias[0].copia);
    const base = opciones.nombreTabla || path.basename(copias[0].nombre, path.extname(copias[0].nombre));
    const datosTabla = { ...R.archivoTabla(grupos, hoy()) };
    if (copias.length === 1) datosTabla.documento = path.basename(copias[0].copia);
    else datosTabla.documentos = copias.map((r) => path.basename(r.copia));
    tabla = escribirSinSobrescribir(ctx, carpeta, base, "-tabla", ".json", JSON.stringify(datosTabla, null, 2) + "\n");
  }
  return {
    tabla, documentos, noAnonimizados: noAnonimizados.map((x) => ({ ruta: x.ruta, motivo: x.motivo })), grupos: resumenGrupos(grupos), datos: grupos.length,
    apariciones: documentos.reduce((s, r) => s + r.apariciones, 0), visibles: documentos.reduce((s, r) => s + r.visibles, 0),
  };
}

/**
 * Anonimizar un documento: copia «-anonimo» con los datos cambiados por etiquetas y la
 * tabla «-tabla.json». opciones: { carpetaSalida, mostrarTexto }.
 */
export async function anonimizarArchivo(ctx, archivo, det, opciones = {}) {
  const r = await anonimizarVarios(ctx, [archivo], det, opciones);
  const d = r.documentos[0];
  const resultado = {
    ruta: archivo.ruta, nombre: archivo.nombre, tipo: d.tipo, copia: d.copia, tabla: r.tabla, grupos: d.copia ? r.grupos : [],
    datos: d.copia ? r.datos : 0, apariciones: d.apariciones, visibles: d.visibles, avisos: d.avisos, quitado: d.quitado,
  };
  if (d.texto !== undefined) resultado.texto = d.texto;
  return resultado;
}

/** Lee una tabla de equivalencias (la de la extensión o la de la web). */
export function leerTablaDeArchivo(ruta) {
  let datos;
  try {
    datos = JSON.parse(leerTexto(fs.readFileSync(ruta)).texto);
  } catch {
    throw new ErrorUsuario(MENSAJE_TABLA, "tabla");
  }
  const tabla = reglasAnonimizador().leerTabla(datos);
  if (!tabla) throw new ErrorUsuario(MENSAJE_TABLA, "tabla");
  return tabla;
}

/**
 * Restaurar: copia «-restaurado» con las etiquetas cambiadas por los datos reales de la
 * tabla. Reconoce las etiquetas aunque la IA las haya cambiado un poco (reglas de la web).
 */
export async function restaurarArchivo(ctx, archivo, tabla, opciones = {}) {
  const R = reglasAnonimizador();
  const doc = leerDocumento(archivo);
  let salida;
  let restauradas = 0;
  let desconocidas = [];
  if (doc.tipo === "texto") {
    const r = R.restaurar(doc.texto, tabla);
    restauradas = r.restauradas;
    desconocidas = r.desconocidas;
    salida = escribirTexto(r.texto, doc.codificacion);
  } else {
    const cambios = [];
    for (const et of R.etiquetasEn(doc.texto)) {
      if (Object.prototype.hasOwnProperty.call(tabla, et.clave)) {
        cambios.push({ inicio: et.inicio, fin: et.fin, nuevo: tabla[et.clave] });
        restauradas++;
      } else if (R.parecePuesta(et.trozo) && !desconocidas.includes(et.clave)) {
        desconocidas.push(et.clave);
      }
    }
    aplicarCambios(doc.word, cambios);
    salida = guardarWord(doc.word);
  }
  const carpeta = carpetaDeSalida(ctx, archivo.ruta, opciones.carpetaSalida);
  const base = path.basename(archivo.nombre, path.extname(archivo.nombre)).replace(/-anonimo( \(\d+\))?$/, "");
  const copia = restauradas ? escribirSinSobrescribir(ctx, carpeta, base, "-restaurado", doc.ext, salida) : null;
  return { ruta: archivo.ruta, nombre: archivo.nombre, tipo: doc.tipo, copia, restauradas, desconocidas };
}
