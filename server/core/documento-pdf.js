/*
 * Leer, analizar y tachar un PDF (docs/PROMPT_EXTENSION.md §5.3 y §5.4), igual que el
 * tachador de la web:
 *   1. el texto de cada página, con pdf.js y las reglas de la web (server/shared/); si
 *      una página no tiene texto (escaneada), se dibuja a 300 ppp y se lee con el lector
 *      de escaneados (server/core/escaneos.js);
 *   2. el detector de la web, también con los datos partidos entre dos páginas;
 *   3. cada dato se sitúa con la caja de sus letras que da PDFium (emparejando los
 *      caracteres visibles de los dos motores) o, en las escaneadas, con la caja de las
 *      palabras que da el lector;
 *   4. cada página se dibuja a 200 ppp, se pintan las barras (y, si se pide, su rótulo)
 *      y se guarda como imagen en un PDF nuevo, sin texto ni metadatos del original;
 *   5. se comprueba que el PDF final no tiene texto antes de darlo por bueno.
 * Nada sale del ordenador y el contenido no se registra en ningún sitio.
 */
import fs from "node:fs";
import { ErrorUsuario } from "./errores.js";
import { ROTULO, dejarVisible, enmascarar } from "./deteccion.js";
import { PPP_OCR, avisosDeLectura, leerTexto, rectangulosOcr } from "./escaneos.js";
import { detector, jpeg, pdfLib, pdfium, pdfjs, png, reglas } from "./motores.js";

export const PPP = 200;                 // resolución de las páginas tachadas, como la web
const ESCALA = PPP / 72;
const MARGEN_PT = 1.5;                  // margen alrededor de cada tachado (el de la web)
const CALIDAD_JPEG = 85;                // la de la web (0,85)
const MINIATURA = 520;                  // ancho de las miniaturas de la hoja de revisión

const ceder = () => new Promise((ok) => setImmediate(ok));   // deja respirar al servidor entre páginas

export const MENSAJES_PDF = {
  contrasena: (n) => "«" + n + "» tiene contraseña. Ábrelo en la web docuprivado.es/tachar-documento/ o quítale la contraseña primero (no me la escribas en el chat).",
  danado: (n) => "No he podido abrir «" + n + "»: parece dañado o no es un PDF.",
  // Hito de actualización 17: un archivo de 0 bytes no está dañado, está vacío.
  vacio: (n) => "«" + n + "» está vacío (0 bytes): no tiene nada dentro. ¿Se quedó a medias al descargarlo o copiarlo? Vuelve a guardarlo.",
};

// ------------------------------------------------------------------ abrir
/**
 * Abre un PDF con los dos motores. Devuelve { paginas, cerrar() } y los manejadores.
 * Con contraseña o dañado: error con el mensaje para el usuario.
 */
export async function abrir(ruta, nombre) {
  const bytes = fs.readFileSync(ruta);
  if (!bytes.length) throw new ErrorUsuario(MENSAJES_PDF.vacio(nombre), "vacio");
  const st = fs.statSync(ruta);
  const clave = ruta.toLowerCase() + "|" + st.size + "|" + st.mtimeMs;   // para recordar lo leído de sus escaneos
  const P = await pdfium();
  const M = P.pdfium;
  const ptr = M.wasmExports.malloc(bytes.length);
  M.HEAPU8.set(bytes, ptr);
  const doc = P.FPDF_LoadMemDocument(ptr, bytes.length, "");
  if (!doc) {
    const codigo = P.FPDF_GetLastError();
    M.wasmExports.free(ptr);
    if (codigo === 4 || codigo === 5) throw new ErrorUsuario(MENSAJES_PDF.contrasena(nombre), "contrasena");
    throw new ErrorUsuario(MENSAJES_PDF.danado(nombre), "danado");
  }
  const lib = await pdfjs();
  const tarea = lib.getDocument({ data: new Uint8Array(bytes), verbosity: 0, isEvalSupported: false, disableFontFace: true, useSystemFonts: false });
  let pdfjsDoc;
  try {
    pdfjsDoc = await tarea.promise;
  } catch (err) {
    P.FPDF_CloseDocument(doc);
    M.wasmExports.free(ptr);
    await tarea.destroy().catch(() => {});
    if (err && err.name === "PasswordException") throw new ErrorUsuario(MENSAJES_PDF.contrasena(nombre), "contrasena");
    throw new ErrorUsuario(MENSAJES_PDF.danado(nombre), "danado");
  }
  const paginas = P.FPDF_GetPageCount(doc);
  // Entorno de formularios: sin él, PDFium no dibuja lo escrito en los campos rellenables y
  // la copia saldría con los campos en blanco. Nunca se ejecuta el JavaScript del PDF.
  const infoFormulario = P.PDFiumExt_OpenFormFillInfo();
  const formulario = infoFormulario ? P.PDFiumExt_InitFormFillEnvironment(doc, infoFormulario) : 0;
  if (formulario) P.FPDF_RemoveFormFieldHighlight(formulario);
  let cerrado = false;
  return {
    P, M, doc, pdfjsDoc, paginas, formulario, bytes: bytes.length, clave,
    async cerrar() {
      if (cerrado) return;
      cerrado = true;
      if (formulario) P.PDFiumExt_ExitFormFillEnvironment(formulario);
      if (infoFormulario) P.PDFiumExt_CloseFormFillInfo(infoFormulario);
      P.FPDF_CloseDocument(doc);
      M.wasmExports.free(ptr);
      await tarea.destroy().catch(() => {});
    },
  };
}

// ------------------------------------------------------------------ texto
/**
 * Paso 1: el texto de cada página, montado con las reglas de la web, y lo escrito en sus
 * campos de formulario rellenables (que no forma parte del texto de la página). Las
 * páginas escaneadas (casi sin texto) se leen con el lector, como en la web. Marca las
 * que merecen un aviso (texto girado, varias columnas, escaneo difícil de leer).
 */
export async function leerTextos(d) {
  const R = reglas();
  const paginas = [];
  for (let i = 0; i < d.paginas; i++) {
    const page = await d.pdfjsDoc.getPage(i + 1);
    const contenido = await page.getTextContent();
    const { texto, items } = R.montarTextoPdf(contenido.items);
    const campos = R.camposDeFormulario(await page.getAnnotations({ intent: "display" }).catch(() => []));   // reglas de la web
    // Casi sin texto y sin ninguna imagen («Página 1 de 3»): no es un escaneo, está casi en
    // blanco (hito de actualización 17 de la web, dibujaImagen).
    const escaneada = !R.tieneTexto(texto) && (!R.dibujaImagen || R.dibujaImagen((await page.getOperatorList()).fnArray, (await pdfjs()).OPS));
    page.cleanup();
    const pagina = { num: i + 1, texto, items, campos, escaneada, avisos: [] };
    if (pagina.escaneada) {
      await leerEscaneada(d, pagina);
    } else {
      const girados = items.filter((x) => x.it.transform && (Math.abs(x.it.transform[1]) > 0.01 || Math.abs(x.it.transform[2]) > 0.01)).length;
      if (girados && girados >= items.length * 0.05) pagina.avisos.push("texto girado");
    }
    if (pagina.texto.split("\n").filter((l) => l.includes("\t")).length >= 5) pagina.avisos.push("varias columnas");
    paginas.push(pagina);
    await ceder();
  }
  return paginas;
}

// Una página escaneada: se dibuja a 300 ppp (con lo escrito en sus campos, si los hay) y
// se lee con el lector. Su texto sustituye al poco que tuviera (un número de página…),
// igual que en la web (js/tachador-texto.js, leerPaginaPdf). Las cajas de las palabras
// quedan en puntos de la página (de arriba abajo, ya girada).
async function leerEscaneada(d, pagina) {
  const escala = PPP_OCR / 72;
  const pg = d.P.FPDF_LoadPage(d.doc, pagina.num - 1);
  let img;
  try {
    const W = Math.max(1, Math.round(d.P.FPDF_GetPageWidthF(pg) * escala));
    const H = Math.max(1, Math.round(d.P.FPDF_GetPageHeightF(pg) * escala));
    img = dibujarConTachados(d, pg, W, H, [], null);
  } finally {
    d.P.FPDF_ClosePage(pg);
  }
  const leido = await leerTexto(img, escala, d.clave + "|" + pagina.num);
  pagina.texto = leido.texto;
  pagina.items = leido.items;
  pagina.confianza = leido.confianza;
  pagina.ocr = true;
  pagina.avisos.push(...avisosDeLectura(pagina));
}

// ------------------------------------------------------------------ detección
/**
 * Paso 2: los datos de cada página con el detector de la web y los datos partidos entre
 * dos páginas (una sola marca con un trozo en cada una, como hace la web). Los que el
 * usuario quiere dejar visibles («no_tachar») se apartan y se cuentan.
 */
export function detectar(paginas, opciones) {
  const D = detector();
  // Como la web: las escaneadas con el texto leído y el modo escaneo del detector
  // (ocr: true, más tolerante con las letras mal leídas).
  const conTexto = paginas.map((p) => p.texto || "");
  for (const p of paginas) {
    p.marcas = !p.texto ? [] : D.detect(p.texto, { tipos: opciones.tipos, personalizados: opciones.personalizados, ocr: !!p.ocr })
      .map((m) => ({ tipo: m.tipo, valor: m.valor, confianza: m.confianza, inicio: m.inicio, fin: m.fin }));
  }
  const cruces = D.entrePaginas(conTexto, { tipos: opciones.tipos, personalizados: opciones.personalizados });
  for (const c of cruces) {
    const a = paginas[c.pagina];
    const b = paginas[c.pagina + 1];
    a.marcas = a.marcas.filter((m) => !(m.inicio < c.a.fin && m.fin > c.a.inicio));
    b.marcas = b.marcas.filter((m) => !(m.inicio < c.b.fin && m.fin > c.b.inicio));
    a.marcas.push({ tipo: c.tipo, valor: c.valor, confianza: c.confianza, inicio: c.a.inicio, fin: c.a.fin, sigue: { pagina: b.num, inicio: c.b.inicio, fin: c.b.fin } });
  }
  let visibles = 0;
  for (const p of paginas) {
    const antes = p.marcas.length;
    p.marcas = p.marcas.filter((m) => !dejarVisible(m.valor, opciones.noTachar));
    visibles += antes - p.marcas.length;
    const r = detectarEnCampos(D, p.campos || [], opciones);
    p.marcasCampo = r.marcas;
    visibles += r.visibles;
  }
  return { visibles };
}

/**
 * Datos en los campos de formulario, con las reglas de la web (js/tachador-reglas.js,
 * detectarEnCampos): se tapa el campo entero. Aquí solo se añade «no_tachar».
 */
function detectarEnCampos(D, campos, opciones) {
  let visibles = 0;
  const marcas = reglas().detectarEnCampos(D.detect, campos, { tipos: opciones.tipos, personalizados: opciones.personalizados })
    .filter((m) => {
      if (!dejarVisible(m.valor, opciones.noTachar)) return true;
      visibles++;
      return false;
    });
  return { marcas, visibles };
}

// ------------------------------------------------------------------ posiciones
// Caja «holgada» de cada carácter (alto de la letra según su fuente, como la barra de la
// web: desde lo alto de las tildes hasta el final de los rabitos), en puntos de la página.
function cajasDePagina(d, pg) {
  const { P, M } = d;
  const tp = P.FPDFText_LoadPage(pg);
  const n = P.FPDFText_CountChars(tp);
  const r = M.wasmExports.malloc(16);
  const chars = new Array(n);
  for (let i = 0; i < n; i++) {
    const u = P.FPDFText_GetUnicode(tp, i);
    const ok = P.FPDFText_GetLooseCharBox(tp, i, r);
    const f = new Float32Array(M.HEAPU8.buffer, r, 4);   // left, top, right, bottom
    chars[i] = { c: String.fromCodePoint(u || 32), ok: !!ok, l: f[0], t: f[1], r: f[2], b: f[3] };
  }
  M.wasmExports.free(r);
  P.FPDFText_ClosePage(tp);
  return chars;
}

// Empareja los caracteres visibles del texto de pdf.js con los de PDFium: en orden y, si
// uno falta, buscando el siguiente igual en una ventana corta.
const norm = (c) => c.normalize("NFKC");
function emparejar(texto, chars) {
  const vis = [];
  chars.forEach((c, i) => { if (/\S/.test(c.c)) vis.push({ c: norm(c.c), i }); });
  const mapa = new Map();
  let j = 0;
  for (let i = 0; i < texto.length; i++) {
    const c = norm(texto[i]);
    if (!/\S/.test(c)) continue;
    let k = j;
    while (k < vis.length && k < j + 40 && vis[k].c !== c) k++;
    if (k < vis.length && vis[k].c === c) {
      mapa.set(i, vis[k].i);
      j = k + 1;
    }
  }
  return mapa;
}

// Punto de la página (en puntos) → píxel del dibujo (tiene en cuenta el giro de la página).
function aPixel(d, pg, W, H, x, y, tmp) {
  d.P.FPDF_PageToDevice(pg, 0, 0, W, H, 0, x, y, tmp, tmp + 4);
  const v = new Int32Array(d.M.HEAPU8.buffer, tmp, 2);
  return [v[0], v[1]];
}

// Índice: para cada posición del texto, el trozo de pdf.js que la contiene (o -1).
function trozoDeCadaLetra(pagina) {
  const idx = new Int32Array(pagina.texto.length).fill(-1);
  pagina.items.forEach((e, n) => { for (let i = e.inicio; i < e.fin; i++) idx[i] = n; });
  return idx;
}

/**
 * Rectángulos (en píxeles del dibujo) de un trozo del texto, con las reglas de la web
 * (js/tachador-texto.js: alturaDeLetra y ensanchar):
 * - ancho: el de cada letra según PDFium (si alguna no tiene caja, el reparto
 *   proporcional del trozo de pdf.js, como la web cuando le falta la capa de texto);
 * - alto: del tamaño de la letra y su línea base, desde lo alto de las letras (más con
 *   una mayúscula con tilde) hasta el final de los rabitos;
 * - margen pequeño y proporcional a la letra (como máximo 1,5 puntos).
 * Las letras de una misma línea se unen en una sola barra.
 */
function rectangulos(d, pg, W, H, pagina, inicio, fin, tmp) {
  const tildeArriba = /[ÁÉÍÓÚÜÑÀÈÌÒÙÂÊÎÔÛÇÅ]/.test(pagina.texto.slice(inicio, fin));
  const cajas = [];
  for (let i = inicio; i < fin; i++) {
    if (!/\S/.test(pagina.texto[i])) continue;
    const e = pagina.trozo[i] >= 0 ? pagina.items[pagina.trozo[i]] : null;
    const t = e && e.it.transform;
    const recto = t && Math.abs(t[1]) < 0.01 && Math.abs(t[2]) < 0.01 && t[0] > 0 && t[3] > 0;
    const k = pagina.mapa.get(i);
    const c = k !== undefined && pagina.chars[k].ok ? pagina.chars[k] : null;
    let x0, x1, arriba, abajo, tam;
    if (c) {
      x0 = c.l; x1 = c.r;
    } else if (e && t) {
      const n = e.fin - e.inicio || 1;
      const ancho = e.it.width || 0;
      x0 = t[4] + (ancho * (i - e.inicio)) / n;
      x1 = t[4] + (ancho * (i - e.inicio + 1)) / n;
    } else {
      continue;
    }
    if (recto) {
      tam = t[3];
      arriba = t[5] + tam * (tildeArriba ? 0.95 : 0.8);
      abajo = t[5] - tam * 0.25;
    } else if (c) {                                  // texto girado: la caja de PDFium
      arriba = c.t; abajo = c.b; tam = Math.abs(c.t - c.b);
    } else {
      continue;
    }
    const p0 = aPixel(d, pg, W, H, x0, arriba, tmp);
    const p1 = aPixel(d, pg, W, H, x1, abajo, tmp);
    cajas.push({ x0: Math.min(p0[0], p1[0]), x1: Math.max(p0[0], p1[0]), y0: Math.min(p0[1], p1[1]), y1: Math.max(p0[1], p1[1]), tam: tam });
  }
  // Une las cajas de la misma línea (mismo centro vertical y sin un hueco grande).
  const lineas = [];
  for (const c of cajas) {
    const alto = c.y1 - c.y0 || 1;
    const l = lineas[lineas.length - 1];
    if (l && Math.abs((l.y0 + l.y1) / 2 - (c.y0 + c.y1) / 2) < alto * 0.5 && c.x0 - l.x1 < alto * 3 && c.x0 > l.x0 - alto) {
      l.x0 = Math.min(l.x0, c.x0); l.x1 = Math.max(l.x1, c.x1); l.y0 = Math.min(l.y0, c.y0); l.y1 = Math.max(l.y1, c.y1);
      l.tam = Math.max(l.tam, c.tam);
    } else {
      lineas.push({ ...c });
    }
  }
  return lineas.map((l) => {
    const mx = Math.min(MARGEN_PT, Math.max(0.4, l.tam * 0.12)) * ESCALA;
    const my = Math.min(MARGEN_PT, l.tam * 0.04) * ESCALA;
    return { x: l.x0 - mx, y: l.y0 - my, w: l.x1 - l.x0 + 2 * mx, h: l.y1 - l.y0 + 2 * my, tam: l.tam };
  });
}

// ------------------------------------------------------------------ datos escondidos
// «Tachado falso» (hito de actualización 18 de la web, js/tachador-reglas.js, escondido): datos
// que están en el texto del PDF pero no se ven (debajo de un recuadro negro, del color del
// fondo o en letra diminuta). Quien reciba el PDF original puede copiarlos; en la copia
// tachada ya no están. Se apunta en cada dato (m.escondido) y como aviso de su página.
export const TEXTO_ESCONDIDOS = "debajo de un recuadro negro, del color del fondo o en letra diminuta";
function anotarEscondidos(pagina) {
  const n = pagina.marcas.filter((m) => m.escondido).length;
  if (!n || pagina.avisos.some((a) => a.startsWith("escondidos:"))) return;
  pagina.avisos.push("escondidos:" + n);
}

/**
 * Para analizar sin tachar: dibuja las páginas con texto que tienen datos y mira si cada
 * uno se ve. Las escaneadas no: lo que lee el lector es lo que se ve.
 */
export async function buscarEscondidos(d, paginas) {
  const tmp = d.M.wasmExports.malloc(16);
  try {
    for (const pagina of paginas) {
      if (pagina.ocr || !pagina.marcas.length) continue;
      const pg = d.P.FPDF_LoadPage(d.doc, pagina.num - 1);
      try {
        const W = Math.max(1, Math.round(d.P.FPDF_GetPageWidthF(pg) * ESCALA));
        const H = Math.max(1, Math.round(d.P.FPDF_GetPageHeightF(pg) * ESCALA));
        pagina.chars = cajasDePagina(d, pg);
        pagina.mapa = emparejar(pagina.texto, pagina.chars);
        pagina.trozo = trozoDeCadaLetra(pagina);
        const examinar = [];
        for (const m of pagina.marcas) for (const r of rectangulos(d, pg, W, H, pagina, m.inicio, m.fin, tmp)) examinar.push({ ...r, marca: m });
        pagina.chars = pagina.mapa = pagina.trozo = null;
        if (examinar.length) dibujarConTachados(d, pg, W, H, [], null, examinar);
        anotarEscondidos(pagina);
      } finally {
        d.P.FPDF_ClosePage(pg);
      }
      await ceder();
    }
  } finally {
    d.M.wasmExports.free(tmp);
  }
}

// ------------------------------------------------------------------ tachar
/**
 * Paso 3: dibuja cada página con sus tachados y crea el PDF nuevo. opciones.estilo:
 * "negro" o "etiqueta" (barra negra con el tipo de dato en blanco); opciones.calidad:
 * "normal" (JPEG 0,85) o "alta" (PNG, sin pérdida). Devuelve los bytes del PDF, lo que se
 * ha tachado en cada página y una miniatura de cada página para la hoja de revisión.
 */
export async function tachar(d, paginas, opciones) {
  const { PDFDocument } = pdfLib();
  const salida = await PDFDocument.create({ updateMetadata: false });
  salida.setTitle("Documento tachado");
  salida.setProducer("docuprivado.es");
  const tmp = d.M.wasmExports.malloc(16);
  const resumen = [];
  try {
    // Trozos de datos partidos que caen en la página siguiente.
    const extra = new Map();
    for (const p of paginas) for (const m of p.marcas) if (m.sigue) {
      if (!extra.has(m.sigue.pagina)) extra.set(m.sigue.pagina, []);
      extra.get(m.sigue.pagina).push({ tipo: m.tipo, confianza: m.confianza, inicio: m.sigue.inicio, fin: m.sigue.fin, partido: true });
    }
    for (const pagina of paginas) {
      const pg = d.P.FPDF_LoadPage(d.doc, pagina.num - 1);
      const wPt = d.P.FPDF_GetPageWidthF(pg);
      const hPt = d.P.FPDF_GetPageHeightF(pg);
      const W = Math.max(1, Math.round(wPt * ESCALA));
      const H = Math.max(1, Math.round(hPt * ESCALA));
      const trozos = pagina.marcas.concat(extra.get(pagina.num) || []);
      const campos = pagina.marcasCampo || [];
      const tachados = [];
      let sinSitio = 0;
      if (trozos.length && pagina.ocr) {
        // Escaneada: las cajas de las palabras leídas (en puntos) pasadas a píxeles.
        for (const m of trozos) {
          const rects = rectangulosOcr(pagina, m.inicio, m.fin);
          if (!rects.length) { sinSitio++; continue; }
          for (const r of rects) tachados.push({ x: r.x * ESCALA, y: r.y * ESCALA, w: r.w * ESCALA, h: r.h * ESCALA, tipo: m.tipo, dudoso: m.confianza !== "alta" });
        }
      } else if (trozos.length) {
        pagina.chars = cajasDePagina(d, pg);
        pagina.mapa = emparejar(pagina.texto, pagina.chars);
        pagina.trozo = trozoDeCadaLetra(pagina);
        for (const m of trozos) {
          const rects = rectangulos(d, pg, W, H, pagina, m.inicio, m.fin, tmp);
          if (!rects.length) { sinSitio++; continue; }
          for (const r of rects) tachados.push({ ...r, tipo: m.tipo, dudoso: m.confianza !== "alta", marca: m.partido ? null : m });
        }
        pagina.chars = pagina.mapa = pagina.trozo = null;
      }
      // Campos de formulario con datos: se tapa el campo entero (con 1 punto de margen).
      for (const m of campos) {
        const [x1, y1, x2, y2] = m.rect;
        const a = aPixel(d, pg, W, H, x1, y2, tmp);
        const b = aPixel(d, pg, W, H, x2, y1, tmp);
        const mg = ESCALA;
        const x = Math.min(a[0], b[0]) - mg, y = Math.min(a[1], b[1]) - mg;
        tachados.push({ x, y, w: Math.abs(b[0] - a[0]) + 2 * mg, h: Math.abs(b[1] - a[1]) + 2 * mg, tipo: m.tipo, dudoso: m.confianza !== "alta", campo: true });
      }
      // Datos dudosos (confianza no alta, como el «revisa» de la web), tapados en parte,
      // para la lista «revisa primero» de la hoja de revisión.
      const dudosos = pagina.marcas.concat(campos).filter((m) => m.confianza !== "alta")
        .map((m) => ({ tipo: m.tipo, valor: enmascarar(m.tipo, m.valor), campo: !!m.campo }));
      const rotulos = opciones.estilo === "etiqueta" && tachados.length ? await capaDeRotulos(wPt, hPt, tachados, d) : null;
      // «Tachado falso» (hito de actualización 18 de la web): antes de pintar las barras, se
      // mira en la página limpia si cada dato se ve.
      const img = dibujarConTachados(d, pg, W, H, tachados, rotulos, pagina.ocr ? null : tachados.filter((t) => t.marca));
      anotarEscondidos(pagina);
      d.P.FPDF_ClosePage(pg);
      const bytes = opciones.calidad === "alta" ? png().sync.write({ width: W, height: H, data: Buffer.from(img.data.buffer, img.data.byteOffset, img.data.length) }) : jpeg().encode(img, CALIDAD_JPEG).data;
      const imagen = opciones.calidad === "alta" ? await salida.embedPng(bytes) : await salida.embedJpg(bytes);
      salida.addPage([wPt, hPt]).drawImage(imagen, { x: 0, y: 0, width: wPt, height: hPt });
      resumen.push({
        num: pagina.num, datos: pagina.marcas.length + campos.length, campos: campos.length, trozos: (extra.get(pagina.num) || []).length, sinSitio, dudosos, leida: !!pagina.ocr,
        miniatura: opciones.miniaturas ? miniatura(img, tachados) : null,
        rects: opciones.conRects ? tachados : undefined,       // solo para las pruebas de cobertura
      });
      await ceder();
    }
  } finally {
    d.M.wasmExports.free(tmp);
  }
  return { bytes: await salida.save(), paginas: resumen };
}

/**
 * Dibuja la página «num» (desde 1), con lo escrito en sus campos. «escala»: píxeles por punto,
 * o una función que la calcula con el ancho y el alto de la página en puntos. Devuelve RGBA.
 */
export function dibujarPagina(d, num, escala) {
  const pg = d.P.FPDF_LoadPage(d.doc, num - 1);
  try {
    const wPt = d.P.FPDF_GetPageWidthF(pg);
    const hPt = d.P.FPDF_GetPageHeightF(pg);
    const e = typeof escala === "function" ? escala(wPt, hPt) : escala;
    const W = Math.max(1, Math.round(wPt * e));
    const H = Math.max(1, Math.round(hPt * e));
    return dibujarConTachados(d, pg, W, H, [], null);
  } finally {
    d.P.FPDF_ClosePage(pg);
  }
}

// Dibuja la página en blanco + contenido, pinta las barras negras directamente en los
// píxeles y, si hay capa de rótulos, la dibuja encima. Devuelve RGBA.
function dibujarConTachados(d, pg, W, H, tachados, rotulos, examinar) {
  const { P, M } = d;
  const bmp = P.FPDFBitmap_Create(W, H, 1);
  try {
    P.FPDFBitmap_FillRect(bmp, 0, 0, W, H, 0xffffffff);
    P.FPDF_RenderPageBitmap(bmp, pg, 0, 0, W, H, 0, 0x01 | 0x800);    // con anotaciones, calidad de impresión
    if (d.formulario) {                                                // y lo escrito en los formularios
      P.FORM_OnAfterLoadPage(pg, d.formulario);
      P.FPDF_FFLDraw(d.formulario, bmp, pg, 0, 0, W, H, 0, 0x01 | 0x800);
      P.FORM_OnBeforeClosePage(pg, d.formulario);
    }
    const stride = P.FPDFBitmap_GetStride(bmp);
    const buf = P.FPDFBitmap_GetBuffer(bmp);
    // «Tachado falso»: ¿se ve cada dato en la página limpia? (antes de pintar nada encima)
    if (examinar && examinar.length) {
      const R = reglas();
      const px = { datos: M.HEAPU8, ancho: W, alto: H, fila: stride, inicio: buf };
      for (const t of examinar) {
        if (t.marca.escondido) continue;
        const motivo = R.escondido(px, t, t.tam);
        if (motivo) t.marca.escondido = motivo;
      }
    }
    // Barras negras, píxel a píxel (sin bordes suavizados que dejen asomar nada).
    const heap = M.HEAPU8;
    for (const r of tachados) {
      const x0 = Math.max(0, Math.floor(r.x)), x1 = Math.min(W, Math.ceil(r.x + r.w));
      const y0 = Math.max(0, Math.floor(r.y)), y1 = Math.min(H, Math.ceil(r.y + r.h));
      for (let y = y0; y < y1; y++) {
        const fila = buf + y * stride;
        for (let x = x0; x < x1; x++) {
          const o = fila + x * 4;
          heap[o] = 0; heap[o + 1] = 0; heap[o + 2] = 0; heap[o + 3] = 255;
        }
      }
    }
    if (rotulos) {
      const cap = P.FPDF_LoadPage(rotulos.doc, 0);
      P.FPDF_RenderPageBitmap(bmp, cap, 0, 0, W, H, 0, 0x800);
      P.FPDF_ClosePage(cap);
      P.FPDF_CloseDocument(rotulos.doc);
      M.wasmExports.free(rotulos.ptr);
    }
    const rgba = new Uint8Array(W * H * 4);
    const h8 = M.HEAPU8;
    for (let y = 0; y < H; y++) {
      let o = buf + y * stride;
      let q = y * W * 4;
      for (let x = 0; x < W; x++, o += 4, q += 4) {
        rgba[q] = h8[o + 2]; rgba[q + 1] = h8[o + 1]; rgba[q + 2] = h8[o]; rgba[q + 3] = 255;
      }
    }
    return { data: rgba, width: W, height: H };
  } finally {
    P.FPDFBitmap_Destroy(bmp);
  }
}

// Capa transparente con el tipo de dato en blanco dentro de cada barra (estilo «etiqueta»),
// que PDFium dibuja encima: el rótulo queda en los píxeles, no como texto.
async function capaDeRotulos(wPt, hPt, tachados, d) {
  const { PDFDocument, StandardFonts, rgb } = pdfLib();
  const doc = await PDFDocument.create({ updateMetadata: false });
  const page = doc.addPage([wPt, hPt]);
  const font = await doc.embedFont(StandardFonts.HelveticaBold);
  for (const r of tachados) {
    const texto = ROTULO[r.tipo] || "OCULTO";
    const w = r.w / ESCALA, h = r.h / ESCALA;
    let size = Math.min(h * 0.62, 11);
    const ancho = font.widthOfTextAtSize(texto, size);
    if (ancho > w - 2) size = size * (w - 2) / ancho;
    if (size < 4) continue;
    const x = r.x / ESCALA + (w - font.widthOfTextAtSize(texto, size)) / 2;
    const y = hPt - (r.y / ESCALA + h / 2) - size * 0.35;
    page.drawText(texto, { x, y, size, font, color: rgb(1, 1, 1) });
  }
  const bytes = await doc.save();
  const ptr = d.M.wasmExports.malloc(bytes.length);
  d.M.HEAPU8.set(bytes, ptr);
  return { doc: d.P.FPDF_LoadMemDocument(ptr, bytes.length, ""), ptr };
}

/**
 * Rótulos del estilo «etiqueta» sobre una foto ya tachada (RGBA): la misma capa que en
 * los PDF, dibujada por PDFium encima de los píxeles de la foto.
 */
export async function rotularImagen(img, tachados) {
  const P = await pdfium();
  const M = P.pdfium;
  const W = img.width;
  const H = img.height;
  const capa = await capaDeRotulos(W / ESCALA, H / ESCALA, tachados, { P, M });
  const bmp = P.FPDFBitmap_Create(W, H, 1);
  try {
    const stride = P.FPDFBitmap_GetStride(bmp);
    const buf = P.FPDFBitmap_GetBuffer(bmp);
    let heap = M.HEAPU8;
    for (let y = 0; y < H; y++) {
      for (let x = 0, o = buf + y * stride, q = y * W * 4; x < W; x++, o += 4, q += 4) {
        heap[o] = img.data[q + 2]; heap[o + 1] = img.data[q + 1]; heap[o + 2] = img.data[q]; heap[o + 3] = 255;
      }
    }
    const cap = P.FPDF_LoadPage(capa.doc, 0);
    P.FPDF_RenderPageBitmap(bmp, cap, 0, 0, W, H, 0, 0x800);
    P.FPDF_ClosePage(cap);
    heap = M.HEAPU8;
    for (let y = 0; y < H; y++) {
      for (let x = 0, o = buf + y * stride, q = y * W * 4; x < W; x++, o += 4, q += 4) {
        img.data[q] = heap[o + 2]; img.data[q + 1] = heap[o + 1]; img.data[q + 2] = heap[o];
      }
    }
  } finally {
    P.FPDFBitmap_Destroy(bmp);
    P.FPDF_CloseDocument(capa.doc);
    M.wasmExports.free(capa.ptr);
  }
}

// Miniatura de la página ya tachada, con un borde de color alrededor de cada tachado
// (nunca enseña el dato: la barra negra ya está pintada debajo).
const COLORES = { nombre: [220, 38, 38], dni: [37, 99, 235], nie: [37, 99, 235], iban: [22, 163, 74], cuenta: [22, 163, 74], direccion: [217, 119, 6], cp: [217, 119, 6] };
export const COLOR_OTROS = [147, 51, 234];
export const COLOR_DUDOSO = [234, 179, 8];
export function colorDe(tipo) { return COLORES[tipo] || COLOR_OTROS; }

export function miniatura(img, tachados) {
  const f = MINIATURA / img.width;
  const w = MINIATURA, h = Math.max(1, Math.round(img.height * f));
  const out = new Uint8Array(w * h * 4);
  const paso = 1 / f;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // Media de un bloque de píxeles (reducción suave).
      let r = 0, g = 0, b = 0, n = 0;
      const sx0 = Math.floor(x * paso), sy0 = Math.floor(y * paso);
      const sx1 = Math.min(img.width, Math.floor((x + 1) * paso)), sy1 = Math.min(img.height, Math.floor((y + 1) * paso));
      for (let sy = sy0; sy < Math.max(sy1, sy0 + 1); sy += 2) for (let sx = sx0; sx < Math.max(sx1, sx0 + 1); sx += 2) {
        const o = (sy * img.width + sx) * 4;
        r += img.data[o]; g += img.data[o + 1]; b += img.data[o + 2]; n++;
      }
      const o = (y * w + x) * 4;
      out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = 255;
    }
  }
  // Los dudosos, al final (encima) y con un recuadro amarillo más grueso.
  for (const t of tachados.slice().sort((a, b) => (a.dudoso ? 1 : 0) - (b.dudoso ? 1 : 0))) {
    const [cr, cg, cb] = t.dudoso ? COLOR_DUDOSO : colorDe(t.tipo);
    const g = t.dudoso ? 4 : 2;
    const x0 = Math.max(0, Math.floor(t.x * f) - g), x1 = Math.min(w - 1, Math.ceil((t.x + t.w) * f) + g - 1);
    const y0 = Math.max(0, Math.floor(t.y * f) - g), y1 = Math.min(h - 1, Math.ceil((t.y + t.h) * f) + g - 1);
    const pintar = (x, y) => { if (x >= 0 && x < w && y >= 0 && y < h) { const o = (y * w + x) * 4; out[o] = cr; out[o + 1] = cg; out[o + 2] = cb; } };
    for (let k = 0; k < g; k++) {
      for (let x = x0; x <= x1; x++) { pintar(x, y0 + k); pintar(x, y1 - k); }
      for (let y = y0; y <= y1; y++) { pintar(x0 + k, y); pintar(x1 - k, y); }
    }
  }
  return Buffer.from(jpeg().encode({ data: out, width: w, height: h }, 72).data).toString("base64");
}

// ------------------------------------------------------------------ comprobar
/**
 * Paso 4: abre el PDF generado con los dos motores y comprueba que no tiene ni un
 * carácter de texto, que tiene las páginas que debe y que no lleva ninguno de los
 * valores tachados en sus bytes. Si algo falla, el resultado no se da por bueno.
 */
export async function comprobarSinTexto(bytes, paginasEsperadas, valores) {
  const P = await pdfium();
  const M = P.pdfium;
  const ptr = M.wasmExports.malloc(bytes.length);
  M.HEAPU8.set(bytes, ptr);
  const doc = P.FPDF_LoadMemDocument(ptr, bytes.length, "");
  const problemas = [];
  try {
    if (!doc) return ["el PDF generado no se puede abrir"];
    const n = P.FPDF_GetPageCount(doc);
    if (n !== paginasEsperadas) problemas.push("tiene " + n + " páginas y debería tener " + paginasEsperadas);
    for (let i = 0; i < n; i++) {
      const pg = P.FPDF_LoadPage(doc, i);
      const tp = P.FPDFText_LoadPage(pg);
      const c = P.FPDFText_CountChars(tp);
      P.FPDFText_ClosePage(tp);
      P.FPDF_ClosePage(pg);
      if (c > 0) problemas.push("la página " + (i + 1) + " tiene texto");
    }
  } finally {
    if (doc) P.FPDF_CloseDocument(doc);
    M.wasmExports.free(ptr);
  }
  const lib = await pdfjs();
  const tarea = lib.getDocument({ data: new Uint8Array(bytes), verbosity: 0, isEvalSupported: false, disableFontFace: true });
  try {
    const pdf = await tarea.promise;
    for (let i = 1; i <= pdf.numPages; i++) {
      const trozos = (await (await pdf.getPage(i)).getTextContent()).items.filter((x) => x.str && x.str.trim());
      if (trozos.length) problemas.push("pdf.js encuentra texto en la página " + i);
    }
  } finally {
    await tarea.destroy().catch(() => {});
  }
  const crudo = Buffer.from(bytes).toString("latin1");
  const utf16 = Buffer.from(bytes).toString("utf16le");
  if (valores.some((v) => v.length >= 5 && (crudo.includes(v) || utf16.includes(v)))) problemas.push("lleva algún valor tachado en sus bytes");
  return problemas;
}

// Solo para las pruebas (tests/tachado.test.mjs): comprobar letra a letra la cobertura.
export const _paraPruebas = { emparejar, aPixel, ESCALA };
