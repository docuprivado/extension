/*
 * Rutas seguras (docs/PROMPT_EXTENSION.md §4.2, CLAUDE.md §4.2 y §4.3).
 *
 * - Solo se tocan archivos dentro de las carpetas que el usuario autorizó al instalar.
 * - Primero se comprueba la ruta como texto: si no cae dentro de una carpeta permitida,
 *   se rechaza SIN mirar el disco. Así una ruta de red (\\servidor\...) o de otra unidad
 *   que llegue en una instrucción escondida en un documento no llega ni a abrirse.
 * - Después se sigue la ruta real (enlaces simbólicos y uniones de carpetas) y se vuelve
 *   a comprobar: un enlace dentro de la carpeta que apunte fuera también se rechaza.
 * - Los accesos directos de Windows (.lnk) no se siguen.
 * - Nunca se sobrescribe un archivo: si el nombre existe, se añade « (2)», « (3)»…
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ErrorUsuario } from "./errores.js";

const WIN = process.platform === "win32";
// Windows y macOS no distinguen mayúsculas en los nombres de archivo (por defecto).
const SIN_MAYUSCULAS = WIN || process.platform === "darwin";

export const LIMITE_BYTES = 100 * 1024 * 1024;   // 100 MB por archivo
export const LIMITE_ARCHIVOS = 200;              // archivos por llamada
const PROFUNDIDAD_BUSQUEDA = 8;                  // niveles de subcarpetas al buscar por nombre
const LIMITE_ENTRADAS = 50000;                   // entradas revisadas como máximo en una búsqueda
// Carpetas que no se recorren nunca: del sistema, de programas o de la propia extensión.
const CARPETAS_IGNORADAS = new Set(["node_modules", "$recycle.bin", "system volume information", "appdata", "library", "__pycache__"]);
// Nombres de dispositivo de Windows: abrir «CON» o «nul.pdf» no abre un archivo.
const RESERVADOS = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\.[^.]*)?$/i;

export const MENSAJES = {
  fuera: "Ese archivo está fuera de las carpetas que autorizaste. Si quieres usarlo, añade su carpeta en Ajustes → Extensiones → docuprivado.",
  carpetaFuera: "Esa carpeta está fuera de las carpetas que autorizaste. Si quieres usarla, añádela en Ajustes → Extensiones → docuprivado.",
  sinCarpetas: "No hay ninguna carpeta autorizada disponible. Elige al menos una en Ajustes → Extensiones → docuprivado (si ya la elegiste, puede que esa unidad no esté conectada).",
  nombreNoValido: "Esa ruta no es válida para un documento (lleva caracteres o nombres que Windows reserva). Indica el archivo con su nombre normal.",
  accesoDirecto: "Eso es un acceso directo, no el documento. Indica el archivo original al que apunta (y que esté en una carpeta autorizada).",
  noEsArchivo: "Eso es una carpeta, no un archivo.",
  noEsCarpeta: "Eso es un archivo, no una carpeta.",
  demasiadoGrande: "El archivo pasa de 100 MB, el máximo que admite la extensión. Divídelo o reduce su tamaño primero.",
};

export class ErrorRuta extends ErrorUsuario {
  constructor(mensaje, codigo, extra) {
    super(mensaje, codigo, extra);
    this.name = "ErrorRuta";
  }
}

// --------------------------------------------------------------- comparar rutas
function clave(ruta) {
  const r = path.resolve(ruta).normalize("NFC");
  return SIN_MAYUSCULAS ? r.toLowerCase() : r;
}

function claveNombre(nombre) {
  const n = String(nombre).normalize("NFC");
  return SIN_MAYUSCULAS ? n.toLowerCase() : n;
}

// ¿Está «ruta» dentro de «raiz» (o es la misma)? Solo compara textos: no toca el disco.
export function estaDentro(ruta, raiz) {
  const rel = path.relative(clave(raiz), clave(ruta));
  if (rel === "") return true;
  if (path.isAbsolute(rel)) return false;              // otra unidad
  return rel !== ".." && !rel.startsWith(".." + path.sep);
}

// Caracteres y nombres que no pueden formar parte de un documento normal.
function comprobarNombre(ruta) {
  if (typeof ruta !== "string" || !ruta.trim() || ruta.includes("\0")) throw new ErrorRuta(MENSAJES.nombreNoValido, "nombre");
  if (WIN) {
    if (/^\\\\[?.]\\/.test(ruta) || /^\/\/[?.]\//.test(ruta)) throw new ErrorRuta(MENSAJES.nombreNoValido, "nombre");
    // «C:nomina.pdf» (unidad sin barra): depende de la carpeta actual de esa unidad.
    if (/^[a-zA-Z]:(?![\\/])/.test(ruta)) throw new ErrorRuta(MENSAJES.nombreNoValido, "nombre");
    const sinUnidad = ruta.replace(/^[a-zA-Z]:/, "");
    // Dos puntos fuera de la letra de la unidad: flujo alternativo de NTFS («a.pdf:oculto»).
    if (sinUnidad.includes(":")) throw new ErrorRuta(MENSAJES.nombreNoValido, "nombre");
    for (const parte of ruta.split(/[\\/]+/)) {
      if (RESERVADOS.test(parte.replace(/[. ]+$/, ""))) throw new ErrorRuta(MENSAJES.nombreNoValido, "nombre");
    }
  }
}

// En macOS la barra invertida no separa carpetas, pero Claude puede escribirla por costumbre de
// Windows («Alquiler\nomina.pdf», «..\..»): se toma como separador. Y una ruta de Windows con
// unidad o de red («C:\Windows», «\\servidor\…») no está en este ordenador: fuera. Sin esto, en
// macOS «C:\Windows» era un nombre de carpeta y se creaba dentro de la autorizada (lo vieron
// las pruebas de GitHub en macOS, 29/09/2026). En Windows no cambia nada.
function aEsteSistema(texto, mensajeFuera) {
  if (WIN) return texto;
  if (/^(?:[A-Za-z]:(?:[\\/]|$)|\\\\)/.test(texto)) throw new ErrorRuta(mensajeFuera, "fuera");
  return texto.replace(/\\/g, "/");
}

// Quita comillas y espacios que a veces rodean una ruta copiada.
function limpiar(entrada) {
  return String(entrada).trim().replace(/^["'«“]+|["'»”]+$/g, "").trim();
}

function realOnull(ruta) {
  try {
    return fs.realpathSync.native(ruta);
  } catch {
    return null;
  }
}

// --------------------------------------------------------------- carpetas permitidas
/**
 * Prepara las carpetas autorizadas (argumentos del programa) y la de salida. Descarta
 * valores vacíos o sin sustituir («${user_config.…}»). Una carpeta que no existe ahora
 * (una unidad desconectada) se anota como no disponible.
 */
export function prepararCarpetas(lista, salida) {
  const permitidas = [];
  const noDisponibles = [];
  const vistas = new Set();
  for (const bruta of lista || []) {
    const original = limpiar(bruta || "");
    if (!original || original.startsWith("${")) continue;
    const resuelta = path.resolve(original);
    const real = realOnull(resuelta);
    let esCarpeta = false;
    try {
      esCarpeta = !!real && fs.statSync(real).isDirectory();
    } catch { /* sin acceso */ }
    if (!esCarpeta) {
      noDisponibles.push(original);
      continue;
    }
    if (vistas.has(clave(real))) continue;
    vistas.add(clave(real));
    permitidas.push({ original, resuelta, real, nombre: path.basename(real) || real });
  }
  let carpetaSalida = null;
  let avisoSalida = null;
  const s = limpiar(salida || "");
  if (s && !s.startsWith("${")) {
    const real = realOnull(path.resolve(s));
    if (!real) avisoSalida = "La carpeta de resultados elegida no existe ahora mismo: los resultados se guardarán junto a cada original.";
    else if (!permitidas.some((c) => estaDentro(real, c.real))) avisoSalida = "La carpeta de resultados elegida no está dentro de las carpetas autorizadas: los resultados se guardarán junto a cada original.";
    else carpetaSalida = real;
  }
  return { permitidas, noDisponibles, carpetaSalida, avisoSalida };
}

// La carpeta permitida que contiene una ruta ya real, o null.
export function carpetaQueContiene(ctx, real) {
  return ctx.permitidas.find((c) => estaDentro(real, c.real)) || null;
}

// --------------------------------------------------------------- resolver una ruta
/**
 * De lo que escribe el usuario (o Claude) a una ruta real dentro de una carpeta permitida.
 * Acepta rutas absolutas, relativas a una carpeta permitida («Alquiler\\nomina.pdf») y
 * nombres sueltos («nomina.pdf», se buscan dentro de las carpetas permitidas).
 * opciones.tipo: "archivo" | "carpeta" | "cualquiera".
 */
export function resolver(ctx, entrada, opciones = {}) {
  const tipo = opciones.tipo || "archivo";
  if (!ctx.permitidas.length) throw new ErrorRuta(MENSAJES.sinCarpetas, "sinCarpetas");
  let texto = limpiar(entrada == null ? "" : entrada);
  comprobarNombre(texto);
  const fuera = tipo === "carpeta" ? MENSAJES.carpetaFuera : MENSAJES.fuera;
  texto = aEsteSistema(texto, fuera);

  let candidatos = [];
  if (path.isAbsolute(texto)) {
    const abs = path.resolve(texto);
    // Solo texto: si no cae dentro de una carpeta permitida, ni se mira el disco.
    if (!ctx.permitidas.some((c) => estaDentro(abs, c.resuelta) || estaDentro(abs, c.real))) throw new ErrorRuta(fuera, "fuera");
    candidatos = [abs];
  } else {
    const anadir = (abs) => {
      if (!candidatos.some((x) => clave(x) === clave(abs))) candidatos.push(abs);
    };
    // Solo se añade si está dentro de la carpeta (texto) y existe con el tipo pedido.
    const anadirSiExiste = (abs, c) => {
      if (!estaDentro(abs, c.real)) return;             // «..\\otra-cosa»: se queda fuera
      let st;
      try {
        st = fs.statSync(abs);
      } catch {
        return;
      }
      if ((tipo === "archivo" && st.isDirectory()) || (tipo === "carpeta" && !st.isDirectory())) return;
      anadir(abs);
    };
    for (const v of variantes(texto)) {
      const partes = v.split(/[\\/]+/).filter(Boolean);
      if (partes.length === 1 && v !== "." && v !== "..") {
        // Nombre suelto: se busca en todas las carpetas permitidas y sus subcarpetas; si
        // hay más de uno con ese nombre, se pide que se precise (más abajo).
        buscarPorNombre(ctx, v, tipo).forEach(anadir);
      }
      for (const c of ctx.permitidas) {
        anadirSiExiste(path.resolve(c.real, v), c);
        // «Descargas\\nomina.pdf» o «Descargas» con la propia carpeta Descargas autorizada.
        if (partes.length && claveNombre(partes[0]) === claveNombre(c.nombre)) anadirSiExiste(path.resolve(c.real, ...partes.slice(1)), c);
      }
    }
    if (!candidatos.length) {
      const cualquiera = ctx.permitidas.map((c) => path.resolve(c.real, texto)).find((abs) => fs.existsSync(abs) && ctx.permitidas.some((c) => estaDentro(abs, c.real)));
      if (cualquiera) {
        if (tipo === "archivo") throw new ErrorRuta(MENSAJES.noEsArchivo, "noEsArchivo");
        if (tipo === "carpeta") throw new ErrorRuta(MENSAJES.noEsCarpeta, "noEsCarpeta");
      }
      if (ctx.permitidas.every((c) => !estaDentro(path.resolve(c.real, texto), c.real))) throw new ErrorRuta(fuera, "fuera");
      throw new ErrorRuta("No encuentro «" + texto + "» en las carpetas que autorizaste. Comprueba el nombre o busca con listar_documentos.", "noExiste");
    }
  }

  // Ruta real (sigue enlaces y uniones) y segunda comprobación.
  const reales = [];
  for (const cand of candidatos) {
    const real = realOnull(cand);
    if (!real) continue;
    if (!carpetaQueContiene(ctx, real)) {
      if (candidatos.length === 1) throw new ErrorRuta(fuera, "fuera");
      continue;
    }
    if (!reales.some((r) => clave(r) === clave(real))) reales.push(real);
  }
  if (!reales.length) throw new ErrorRuta("No encuentro «" + texto + "» en las carpetas que autorizaste.", "noExiste");
  if (reales.length > 1) {
    const lista = reales.slice(0, 10);
    throw new ErrorRuta("Hay " + reales.length + " archivos que se llaman «" + path.basename(texto) + "». Dime cuál, con su ruta completa:\n" +
      lista.map((r) => "- " + r).join("\n") + (reales.length > lista.length ? "\n- …" : ""), "varios", { rutas: reales });
  }
  const real = reales[0];
  const stat = fs.statSync(real);
  if (tipo === "archivo" && stat.isDirectory()) throw new ErrorRuta(MENSAJES.noEsArchivo, "noEsArchivo");
  if (tipo === "carpeta" && !stat.isDirectory()) throw new ErrorRuta(MENSAJES.noEsCarpeta, "noEsCarpeta");
  if (!stat.isDirectory()) {
    if (path.extname(real).toLowerCase() === ".lnk") throw new ErrorRuta(MENSAJES.accesoDirecto, "accesoDirecto");
    if (stat.size > LIMITE_BYTES) throw new ErrorRuta(MENSAJES.demasiadoGrande, "demasiadoGrande");
  }
  return { ruta: real, carpeta: carpetaQueContiene(ctx, real), esCarpeta: stat.isDirectory(), bytes: stat.size, modificado: stat.mtime };
}

// Carpetas del sistema que Windows y macOS enseñan traducidas: el Explorador y el Finder
// dicen «Descargas», pero la carpeta de verdad se llama «Downloads».
const TRADUCIDAS = {
  descargas: "Downloads", documentos: "Documents", "mis documentos": "Documents", escritorio: "Desktop",
  imagenes: "Pictures", "mis imagenes": "Pictures", musica: "Music", videos: "Videos", "mis videos": "Videos", peliculas: "Movies",
};
const sinTildes = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

// La ruta tal cual y, si su primer tramo es una carpeta traducida, también con el nombre real.
function variantes(texto) {
  const partes = texto.split(/[\\/]+/);
  const real = TRADUCIDAS[sinTildes(partes[0])];
  return real ? [texto, [real, ...partes.slice(1)].join(path.sep)] : [texto];
}

// Nombre suelto: se busca dentro de las carpetas permitidas (sin distinguir mayúsculas).
function buscarPorNombre(ctx, nombre, tipo) {
  const objetivo = claveNombre(nombre);
  const encontrados = [];
  for (const c of ctx.permitidas) {
    recorrer(ctx, c.real, { recursivo: true }, (ruta, dirent) => {
      const esCarpeta = dirent.isDirectory();
      if (tipo === "archivo" && esCarpeta) return;
      if (tipo === "carpeta" && !esCarpeta) return;
      if (claveNombre(path.basename(ruta)) === objetivo) encontrados.push(ruta);
    });
  }
  return encontrados;
}

// --------------------------------------------------------------- recorrer carpetas
/**
 * Recorre una carpeta (ya real y permitida) y llama a «visitar(ruta, dirent)» con cada
 * archivo y subcarpeta. No entra en carpetas ocultas ni del sistema; los enlaces y
 * uniones solo se siguen si su destino real está dentro de una carpeta permitida.
 * Devuelve { revisadas, cortado }.
 */
export function recorrer(ctx, carpeta, opciones, visitar) {
  const recursivo = !!opciones.recursivo;
  const profundidadMax = opciones.profundidad || PROFUNDIDAD_BUSQUEDA;
  const limite = opciones.limite || LIMITE_ENTRADAS;
  const visitadas = new Set([clave(carpeta)]);
  const pendientes = [{ dir: carpeta, nivel: 0 }];
  let revisadas = 0;
  let cortado = false;
  while (pendientes.length) {
    const { dir, nivel } = pendientes.shift();
    let entradas;
    try {
      entradas = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;                                    // sin permiso para leerla: se salta
    }
    for (const e of entradas) {
      if (++revisadas > limite) {
        cortado = true;
        return { revisadas: limite, cortado };
      }
      if (e.name.startsWith(".") || e.name.startsWith("~$")) continue;   // ocultos y temporales de Office
      let ruta = path.join(dir, e.name);
      let dirent = e;
      if (e.isSymbolicLink()) {
        const real = realOnull(ruta);
        if (!real || !carpetaQueContiene(ctx, real)) continue;          // apunta fuera: se ignora
        try {
          const st = fs.statSync(real);
          dirent = { isDirectory: () => st.isDirectory(), isFile: () => st.isFile(), name: e.name };
          ruta = real;
        } catch {
          continue;
        }
      }
      if (dirent.isDirectory()) {
        if (CARPETAS_IGNORADAS.has(e.name.toLowerCase())) continue;
        visitar(ruta, dirent);
        if (recursivo && nivel + 1 < profundidadMax && !visitadas.has(clave(ruta))) {
          visitadas.add(clave(ruta));
          pendientes.push({ dir: ruta, nivel: nivel + 1 });
        }
      } else if (dirent.isFile()) {
        visitar(ruta, dirent);
      }
    }
  }
  return { revisadas, cortado };
}

// --------------------------------------------------------------- rutas cortas
// Mejora 1 del hito 7 (aprobada por el titular el 28/09/2026): las respuestas no llevan la
// ruta completa del ordenador, que empieza por la carpeta del usuario («C:\Users\ana…») y
// suele llevar su nombre, sino la ruta desde la carpeta autorizada: «Documents\Alquiler\
// docuprivado\nomina-tachado.pdf». resolver() la entiende tal cual (empieza por el nombre
// de una carpeta autorizada), así que Claude puede volver a usarla.
export const CARPETA_USUARIO = "(tu carpeta de usuario)";

// El nombre corto de cada carpeta autorizada: su nombre, o con las de encima si dos se
// llaman igual («ana\Documents» y «D:\Documents» → «ana\Documents» y «Documents»).
function nombresCortos(permitidas) {
  const partes = permitidas.map((c) => c.real.split(/[\\/]+/).filter(Boolean));
  const tramos = permitidas.map(() => 1);
  // Una unidad entera («D:\») no tiene nombre: se queda como está.
  const corto = (i) => (partes[i].length > 1 ? partes[i].slice(-tramos[i]).join(path.sep) : permitidas[i].real);
  for (let vuelta = 0; vuelta < 10; vuelta++) {
    const vistos = new Map();
    permitidas.forEach((_, i) => {
      const k = claveNombre(corto(i));
      vistos.set(k, [...(vistos.get(k) || []), i]);
    });
    const repetidos = [...vistos.values()].filter((l) => l.length > 1).flat();
    if (!repetidos.length) break;
    for (const i of repetidos) if (tramos[i] < partes[i].length) tramos[i]++;
  }
  return permitidas.map((_, i) => corto(i));
}

// La ruta como patrón, con cualquier barra (\ o /) entre tramos.
const patronDe = (ruta) => ruta.replace(/[\\/]+$/, "").split(/[\\/]+/)
  .map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[\\\\/]+");

/**
 * Devuelve una función que cambia en un texto las rutas completas por las cortas: la de
 * cada carpeta autorizada (como la eligió el usuario y su ruta real) por su nombre corto
 * y, lo que quede, la carpeta del usuario por «(tu carpeta de usuario)».
 */
export function acortador(ctx) {
  const reglas = [];
  const cortos = nombresCortos(ctx.permitidas);
  ctx.permitidas.forEach((c, i) => {
    if (cortos[i] === c.real) return;                  // una unidad entera: no lleva el nombre de nadie
    for (const larga of new Set([c.real, c.resuelta, path.resolve(c.original)])) reglas.push([larga, cortos[i]]);
  });
  const casa = os.homedir();
  if (casa && path.isAbsolute(casa) && casa.split(/[\\/]+/).filter(Boolean).length >= 2) reglas.push([casa, CARPETA_USUARIO]);
  reglas.sort((a, b) => b[0].length - a[0].length);
  // Solo si detrás viene el final, una barra o algo que no forme parte de un nombre de
  // carpeta: «C:\…\Docs» no se cambia dentro de «C:\…\Docs2».
  const patrones = reglas.map(([larga, corta]) => [new RegExp(patronDe(larga) + "(?=$|[\\\\/\\s\"'«»“”)\\],;:.])", SIN_MAYUSCULAS ? "gi" : "g"), corta]);
  return (texto) => {
    if (typeof texto !== "string" || !texto) return texto;
    let t = texto;
    for (const [re, corta] of patrones) t = t.replace(re, () => corta);
    return t;
  };
}

// Dónde está una carpeta autorizada, sin el nombre de usuario: «Desktop\Proyectos, dentro de
// tu carpeta de usuario», «tu carpeta de usuario» o «D:\».
export function dondeEsta(carpeta) {
  const padre = path.dirname(carpeta.real);
  const casa = os.homedir();
  if (casa && estaDentro(padre, casa)) {
    const rel = path.relative(casa, padre);
    return rel ? rel + ", dentro de tu carpeta de usuario" : "tu carpeta de usuario";
  }
  return padre;
}

// --------------------------------------------------------------- dónde guardar
/**
 * Carpeta donde se guarda el resultado de «original»: la de salida elegida al instalar
 * o, si no hay, una subcarpeta «docuprivado» junto al original.
 */
export function carpetaDeSalida(ctx, original, pedida) {
  if (pedida) return carpetaPedida(ctx, pedida);
  if (ctx.carpetaSalida) return ctx.carpetaSalida;
  // Un archivo que ya está en una carpeta de resultados (restaurar la copia anónima): su
  // copia va a la misma carpeta, no a «docuprivado\docuprivado».
  const destino = path.basename(path.dirname(original)).toLowerCase() === "docuprivado" ? path.dirname(original) : path.join(path.dirname(original), "docuprivado");
  if (!carpetaQueContiene(ctx, path.dirname(original))) throw new ErrorRuta(MENSAJES.fuera, "fuera");
  return destino;
}

/**
 * La carpeta de resultados que pide el usuario («carpeta_salida»). Si no existe y cae dentro
 * de una carpeta autorizada, se crea, igual que la subcarpeta «docuprivado» (hito de
 * actualización 17: antes daba error). Nunca fuera de las autorizadas, tampoco a través de
 * un enlace: lo que ya existe del camino tiene que estar dentro de verdad.
 */
export function carpetaPedida(ctx, entrada) {
  try {
    return resolver(ctx, entrada, { tipo: "carpeta" }).ruta;
  } catch (err) {
    if (!(err instanceof ErrorRuta) || err.codigo !== "noExiste") throw err;
  }
  const texto = aEsteSistema(limpiar(entrada), MENSAJES.carpetaFuera);
  comprobarNombre(texto);
  let destino = null;
  if (path.isAbsolute(texto)) {
    destino = path.resolve(texto);
  } else {
    const partes = texto.split(/[\\/]+/).filter(Boolean);
    // «carpeta-de-prueba\Nueva» (con el nombre de la carpeta autorizada delante) o, si solo
    // hay una autorizada, «Nueva» dentro de ella.
    const c = ctx.permitidas.find((x) => partes.length > 1 && claveNombre(partes[0]) === claveNombre(x.nombre)) ||
      (ctx.permitidas.length === 1 ? ctx.permitidas[0] : null);
    if (!c) throw new ErrorRuta("No encuentro la carpeta «" + texto + "». Dime en cuál de tus carpetas autorizadas la creo (por ejemplo, «" + ctx.permitidas[0].nombre + "\\" + texto + "»).", "noExiste");
    destino = claveNombre(partes[0]) === claveNombre(c.nombre) && partes.length > 1 ? path.resolve(c.real, ...partes.slice(1)) : path.resolve(c.real, texto);
  }
  if (!ctx.permitidas.some((c) => estaDentro(destino, c.real) || estaDentro(destino, c.resuelta))) throw new ErrorRuta(MENSAJES.carpetaFuera, "fuera");
  // Lo que ya existe del camino, por su ruta real (un enlace dentro que apunte fuera, no).
  let existe = destino;
  while (!fs.existsSync(existe) && path.dirname(existe) !== existe) existe = path.dirname(existe);
  const real = realOnull(existe);
  if (!real || !carpetaQueContiene(ctx, real)) throw new ErrorRuta(MENSAJES.carpetaFuera, "fuera");
  if (!fs.statSync(real).isDirectory()) throw new ErrorRuta(MENSAJES.noEsCarpeta, "noEsCarpeta");
  fs.mkdirSync(destino, { recursive: true });
  return realOnull(destino) || destino;
}

// «nomina» + «-tachado» + «.pdf» → «nomina-tachado.pdf», o « (2)», « (3)»… si ya existe.
export function nombreLibre(carpeta, base, sufijo, ext) {
  for (let n = 1; n < 1000; n++) {
    const nombre = base + sufijo + (n > 1 ? " (" + n + ")" : "") + ext;
    if (!fs.existsSync(path.join(carpeta, nombre))) return nombre;
  }
  throw new ErrorRuta("Hay demasiadas copias con ese nombre en la carpeta de resultados.", "demasiadasCopias");
}

/**
 * Guarda varios archivos que van juntos (las dos caras de una copia del DNI, el informe y el
 * Word de una comparación) con el mismo número si hace falta: «x (2).html» y «x (2).docx»,
 * nunca uno con (2) y otro sin él. Nunca sobrescribe nada. archivos: [{ nombre (sin
 * extensión), ext, datos }]. Devuelve las rutas, en el mismo orden.
 */
export function escribirJuntos(ctx, carpeta, archivos) {
  const libre = (n) => archivos.every((a) => !fs.existsSync(path.join(carpeta, a.nombre + (n > 1 ? " (" + n + ")" : "") + a.ext)));
  let n = 1;
  while (n < 1000 && fs.existsSync(carpeta) && !libre(n)) n++;
  const sufijo = n > 1 ? " (" + n + ")" : "";
  return archivos.map((a) => escribirSinSobrescribir(ctx, carpeta, a.nombre + sufijo, "", a.ext, a.datos));
}

/**
 * Escribe «datos» en «carpeta» con el nombre pedido sin sobrescribir nunca nada: la
 * escritura falla si el archivo ya existe (aunque aparezca en el último momento) y
 * entonces se prueba con « (2)», « (3)»… Devuelve la ruta final.
 */
export function escribirSinSobrescribir(ctx, carpeta, base, sufijo, ext, datos) {
  const destino = path.resolve(carpeta);
  // La carpeta de destino tiene que estar dentro de las permitidas (también su ruta real).
  const padre = realOnull(fs.existsSync(destino) ? destino : path.dirname(destino));
  if (!padre || !carpetaQueContiene(ctx, padre) || !ctx.permitidas.some((c) => estaDentro(destino, c.real) || estaDentro(destino, c.resuelta))) {
    throw new ErrorRuta(MENSAJES.carpetaFuera, "fuera");
  }
  fs.mkdirSync(destino, { recursive: true });
  for (let n = 1; n < 1000; n++) {
    const nombre = base + sufijo + (n > 1 ? " (" + n + ")" : "") + ext;
    const ruta = path.join(destino, nombre);
    try {
      fs.writeFileSync(ruta, datos, { flag: "wx" });
      return ruta;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
    }
  }
  throw new ErrorRuta("Hay demasiadas copias con ese nombre en la carpeta de resultados.", "demasiadasCopias");
}
