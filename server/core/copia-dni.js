/*
 * Copia protegida del DNI (docs/PROMPT_EXTENSION.md §5.8), igual que el Kit DNI de la web
 * (/dni/: js/kit-dni.js, kit-dni-editor.js y kit-dni-exportar.js):
 *   1. cada cara se abre (JPG, PNG, WebP, HEIC o la página de un PDF), derecha y con 2500 px
 *      de lado como mucho;
 *   2. se buscan los bordes del documento con el buscador de la web (js/kit-dni-bordes.js y
 *      OpenCV.js, copiados sin cambios) y se endereza a su tamaño real a 300 ppp: tarjeta ID-1
 *      (DNI, NIE o TIE, carnet de conducir) 1011 × 638 px y pasaporte ID-3 1476 × 1039 px;
 *   3. la marca de agua se funde en los píxeles (PDFium la dibuja encima de la foto): diagonal
 *      repetida a −30° o franja central, 7 % del alto, filas cada 2,2 veces el tamaño, 40 % de
 *      opacidad y gris 40,44,48 (las medidas de la web);
 *   4. se crea un PDF A4 con las caras a tamaño real (85,60 × 53,98 mm), dos JPG o una sola
 *      imagen, sin nada del original, y se comprueba antes de darlo por bueno.
 * En la web, si los bordes no están claros, la persona ajusta las esquinas a mano. Aquí no hay
 * pantalla: esa cara va entera, sin recortar, y se avisa.
 * Mejoras del hito 5: las dos caras en la misma imagen (buscarDosCaras, con detectarVarias de la
 * web), cada cara derecha y reconocida con el lector de escaneados (reconocerCara) y el nombre
 * corto de cada finalidad cuando se hacen varias copias (nombreDeMarca).
 */
import fs from "node:fs";
import { ErrorUsuario } from "./errores.js";
import { abrir as abrirPdf, dibujarPagina, MENSAJES_PDF } from "./documento-pdf.js";
import { abrirFoto, codificar, formatoDe, metadatos, orientar } from "./imagenes.js";
import { ppm } from "./escaneos.js";
import { leer } from "./lector.js";
import { bordesDni, jpeg, opencv, pdfLib, pdfium, pdfjs } from "./motores.js";
import { describirError, registrar } from "./registro.js";
import { escribirJuntos } from "./rutas.js";

export const DOCUMENTOS = {
  dni: { nombre: "DNI", formato: "id1", caras: 2, archivo: "dni-protegido" },
  nie_tie: { nombre: "NIE o TIE", formato: "id1", caras: 2, archivo: "nie-protegido" },
  carnet_conducir: { nombre: "carnet de conducir", formato: "id1", caras: 2, archivo: "carnet-protegido" },
  pasaporte: { nombre: "pasaporte", formato: "id3", caras: 1, archivo: "pasaporte-protegido" },
};
// Tamaños reales: ID-1 85,60 × 53,98 mm e ID-3 125 × 88 mm, a 300 ppp y en puntos para el PDF.
export const FORMATOS = {
  id1: { px: [1011, 638], pt: [242.65, 153.01], mm: "85,60 × 53,98 mm" },
  id3: { px: [1476, 1039], pt: [354.33, 249.45], mm: "125 × 88 mm" },
};
export const A4 = [595.28, 841.89];
export const LARGO_MAX_MARCA = 80;          // como la casilla de la web (maxlength="80")
const LADO_MAX = 2500;                      // la web abre las fotos a 2500 px de lado como mucho
const COLORES = { gris: [40, 44, 48], rojo: [176, 32, 32], azul: [22, 64, 140] };
const TAMANOS = { pequeno: 0.05, mediano: 0.07, grande: 0.09 };
const UMBRAL_BORROSA = 90;                  // varianza del laplaciano (la de la web)
const CALIDAD_PDF = 90;                     // la web: 0,9 dentro del PDF y 0,92 en las imágenes
const CALIDAD_IMAGEN = 92;
const SEPARACION_UNICA = 24;                // píxeles entre las dos caras en la imagen única

// ------------------------------------------------------------------ abrir
/**
 * Las caras que hay en un archivo: una foto es una cara; un PDF, su primera página o, si
 * «hasta» es 2, sus dos primeras (la segunda es la trasera, como en la web).
 * Devuelve [{ img: RGBA derecha, pagina }].
 */
export async function abrirCaras(archivo, hasta) {
  const bytes = new Uint8Array(fs.readFileSync(archivo.ruta));
  if (formatoDe(bytes) !== "pdf") {
    const foto = await abrirFoto(bytes, archivo.nombre, LADO_MAX);
    return [{ img: foto.img, pagina: null }];
  }
  let d;
  try {
    d = await abrirPdf(archivo.ruta, archivo.nombre);
  } catch (err) {
    if (err instanceof ErrorUsuario && err.codigo === "contrasena") {
      throw new ErrorUsuario("«" + archivo.nombre + "» tiene contraseña. Quítasela primero o prepara la copia en docuprivado.es/dni/ (no me la escribas en el chat).", "contrasena");
    }
    throw err;
  }
  try {
    const caras = [];
    for (let n = 1; n <= Math.min(d.paginas, hasta); n++) {
      // Como la web: a 3 veces su tamaño como mucho y sin pasar de 2500 px de lado.
      caras.push({ img: dibujarPagina(d, n, (w, h) => Math.min(3, LADO_MAX / Math.max(w, h))), pagina: n });
    }
    if (!caras.length) throw new ErrorUsuario(MENSAJES_PDF.danado(archivo.nombre), "danado");
    return caras;
  } finally {
    await d.cerrar();
  }
}

// ------------------------------------------------------------------ recortar
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

// Las mismas comprobaciones que la web (js/kit-dni-editor.js, quadValido): un cuadrilátero
// de al menos el 6 % de la foto (en una hoja A4 escaneada, la tarjeta ocupa un 7,4 %; hasta
// el hito de actualización 14 de la web era el 8 %) y con lados de más del 5 % de su lado mayor.
function cuadrilateroValido(q, W, H) {
  if (!q || q.length !== 4 || q.some((p) => !p || !Number.isFinite(p.x) || !Number.isFinite(p.y))) return false;
  const area = Math.abs((q[0].x * q[1].y - q[1].x * q[0].y) + (q[1].x * q[2].y - q[2].x * q[1].y) +
    (q[2].x * q[3].y - q[3].x * q[2].y) + (q[3].x * q[0].y - q[0].x * q[3].y)) / 2;
  if (area < W * H * 0.06) return false;
  const lados = [dist(q[0], q[1]), dist(q[1], q[2]), dist(q[2], q[3]), dist(q[3], q[0])];
  return Math.min(...lados) > Math.max(W, H) * 0.05;
}

// Cambia qué esquina va arriba a la izquierda: cada vez, el documento gira 90° a la derecha.
function rotarEsquinas(q, veces) {
  const out = q.slice();
  for (let i = 0; i < ((veces % 4) + 4) % 4; i++) out.unshift(out.pop());
  return out;
}

function varianzaLaplaciano(cv, mat) {
  const gris = new cv.Mat();
  const lap = new cv.Mat();
  const media = new cv.Mat();
  const desv = new cv.Mat();
  try {
    cv.cvtColor(mat, gris, cv.COLOR_RGBA2GRAY);
    cv.Laplacian(gris, lap, cv.CV_64F);
    cv.meanStdDev(lap, media, desv);
    const d = desv.doubleAt(0, 0);
    return d * d;
  } catch {
    return Infinity;
  } finally {
    [gris, lap, media, desv].forEach((m) => m.delete());
  }
}

// Endereza el cuadrilátero a w × h (fondo blanco fuera de la foto) y mide si está borrosa.
function enderezar(cv, img, q, w, h) {
  const src = cv.matFromImageData({ data: img.data, width: img.width, height: img.height });
  const de = cv.matFromArray(4, 1, cv.CV_32FC2, q.flatMap((p) => [p.x, p.y]));
  const a = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, w, 0, w, h, 0, h]);
  const M = cv.getPerspectiveTransform(de, a);
  const warp = new cv.Mat();
  try {
    cv.warpPerspective(src, warp, M, new cv.Size(w, h), cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar(255, 255, 255, 255));
    return { img: { data: Uint8Array.from(warp.data), width: w, height: h }, varianza: varianzaLaplaciano(cv, warp) };
  } finally {
    [src, de, a, M, warp].forEach((m) => m.delete());
  }
}

// La foto entera, centrada y sin deformar sobre blanco (la «salida de emergencia» de la web).
async function encajar(img, w, h) {
  const { cv } = await opencv();
  const f = Math.min(w / img.width, h / img.height);
  const cw = Math.max(1, Math.round(img.width * f));
  const ch = Math.max(1, Math.round(img.height * f));
  const src = cv.matFromImageData({ data: img.data, width: img.width, height: img.height });
  const peq = new cv.Mat();
  try {
    cv.resize(src, peq, new cv.Size(cw, ch), 0, 0, f < 1 ? cv.INTER_AREA : cv.INTER_CUBIC);
    const out = new Uint8Array(w * h * 4).fill(255);
    const x0 = Math.floor((w - cw) / 2);
    const y0 = Math.floor((h - ch) / 2);
    const datos = peq.data;
    for (let y = 0; y < ch; y++) {
      out.set(datos.subarray(y * cw * 4, (y + 1) * cw * 4), ((y + y0) * w + x0) * 4);
    }
    return { data: out, width: w, height: h };
  } finally {
    src.delete();
    peq.delete();
  }
}

/**
 * Deja una cara lista: la busca en la foto y la endereza a su tamaño real o, si no se ven
 * claros sus bordes (o si se pide no recortar), la pone entera. «girar»: grados en el sentido
 * de las agujas del reloj (0, 90, 180 o 270). «deteccion»: lo que ya encontró el buscador
 * (las dos caras en la misma imagen); si no, se buscan aquí.
 * Devuelve { img, recorte: "automatico" | "ya_recortada" | "sin_bordes" | "sin_recortar",
 * confianza, borrosa }.
 */
export async function prepararCara(img, formato, opciones = {}) {
  const [w, h] = FORMATOS[formato].px;
  const giros = Math.round((opciones.girar || 0) / 90) % 4;
  let confianza = null;
  if (opciones.automatico !== false) {
    const B = await bordesDni();
    let res = opciones.deteccion || null;
    if (!res) {
      try {
        res = B.detectar(img, formato);
      } catch (err) {
        registrar("bordes del DNI: fallo (" + describirError(err) + ")");
      }
    }
    confianza = res ? res.confianza : null;
    const q = res && res.esquinas;
    // Con confianza baja la web pide ajustar las esquinas a mano; aquí va la foto entera.
    if (cuadrilateroValido(q, img.width, img.height) && res.confianza !== "baja") {
      // Si el documento sale de pie, se gira para que quede apaisado (como la web).
      const ancho = (dist(q[0], q[1]) + dist(q[3], q[2])) / 2;
      const alto = (dist(q[0], q[3]) + dist(q[1], q[2])) / 2;
      const esquinas = rotarEsquinas(alto > ancho ? rotarEsquinas(q, 1) : q, giros);
      const r = enderezar(B.cv, img, esquinas, w, h);
      return { img: r.img, recorte: res.origen === "foto-entera" ? "ya_recortada" : "automatico", confianza, borrosa: r.varianza < UMBRAL_BORROSA };
    }
  }
  const girada = giros ? orientar(img, [1, 6, 3, 8][giros]) : img;
  return { img: await encajar(girada, w, h), recorte: opciones.automatico === false ? "sin_recortar" : "sin_bordes", confianza, borrosa: false };
}

/**
 * Mejora 1 del hito 5: las dos caras en la misma imagen (una hoja escaneada por delante y por
 * detrás, o una foto de las dos), con el buscador de la web (detectarVarias, hito de
 * actualización 14). Devuelve las dos detecciones en orden de lectura (arriba o izquierda
 * primero) o null si no hay dos tarjetas claras.
 */
export async function buscarDosCaras(img, formato) {
  const B = await bordesDni();
  let varias = [];
  try {
    varias = B.detectarVarias(img, formato, 2);
  } catch (err) {
    registrar("dos caras: fallo (" + describirError(err) + ")");
    return null;
  }
  if (varias.length < 2 || varias.some((r) => r.confianza === "baja" || !cuadrilateroValido(r.esquinas, img.width, img.height))) return null;
  return varias;
}

// Palabras que el lector lee con seguridad (al menos 3 letras o cifras y confianza de 80).
const PALABRAS_SEGURAS = 5;
async function leerCara(img) {
  const d = await leer(ppm(img), { blocks: true, text: true });
  const palabras = (d.blocks || []).flatMap((b) => (b.paragraphs || []).flatMap((p) => (p.lines || []).flatMap((l) => l.words || [])));
  return {
    seguras: palabras.filter((w) => w.confidence >= 80 && /[\p{L}\p{N}]{3,}/u.test(w.text)).length,
    // Las líneas de abajo de la trasera del DNI o del NIE (y de la página del pasaporte):
    // «IDESP…<<<<<<». Solo se mira si están; lo leído no se guarda ni se enseña.
    lineasDeAbajo: /[<«]{4,}/.test(d.text || ""),
    // Hito de actualización 17: ¿lleva algún rótulo de un documento de identidad? Sirve para
    // avisar si se ha dado una foto que no lo parece (una captura, una carta).
    pareceDocumento: RE_ROTULOS_DOCUMENTO.test(quitarTildesMay(d.text || "")),
  };
}

// Rótulos que llevan el DNI, el NIE o TIE, el carnet de conducir y el pasaporte (en español
// y en inglés), y sus líneas «<<<<». No se guarda ni se enseña lo leído.
const RE_ROTULOS_DOCUMENTO = /DOCUMENTO NACIONAL|IDENTIDAD|PASAPORTE|PASSPORT|PERMISO DE CONDUC|DRIVING LICEN|EXTRANJERO|RESIDENCIA|APELLIDOS|NACIONALIDAD|NATIONALITY|SEXO|VALIDEZ|VALIDO HASTA|FECHA DE EXPEDICION|DOCUMENTO DE PRUEBA|IDESP|[<«]{4,}/;
const quitarTildesMay = (t) => t.normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase();

/**
 * Mejora 2 del hito 5: lee la cara ya recortada con el lector de escaneados para saber si
 * está del revés (derecha se leen de 8 a 16 palabras seguras; del revés, 0 o 1) y si es la
 * trasera (lleva las líneas «<<<<» de abajo). Si no se puede leer, no cambia nada.
 * Devuelve { img (derecha), delReves, lineasDeAbajo, leida, pareceDocumento (null si no se pudo leer) }.
 */
export async function reconocerCara(img) {
  try {
    const derecha = await leerCara(img);
    if (derecha.seguras >= PALABRAS_SEGURAS) return { img, delReves: false, lineasDeAbajo: derecha.lineasDeAbajo, leida: true, pareceDocumento: derecha.pareceDocumento };
    const girada = mediaVuelta(img);
    const alReves = await leerCara(girada);
    if (alReves.seguras >= PALABRAS_SEGURAS && alReves.seguras > derecha.seguras + 2) return { img: girada, delReves: true, lineasDeAbajo: alReves.lineasDeAbajo, leida: true, pareceDocumento: alReves.pareceDocumento };
    return { img, delReves: false, lineasDeAbajo: derecha.lineasDeAbajo, leida: derecha.seguras >= PALABRAS_SEGURAS, pareceDocumento: derecha.pareceDocumento || alReves.pareceDocumento };
  } catch (err) {
    registrar("reconocer la cara: fallo (" + describirError(err) + ")");
    return { img, delReves: false, lineasDeAbajo: false, leida: false, pareceDocumento: null };
  }
}

/** La cara girada 180°. */
export function mediaVuelta(img) {
  return orientar(img, 3);
}

/**
 * Mejora 3 del hito 5: un nombre corto para el archivo de cada finalidad cuando se piden
 * varias («Solo para la inmobiliaria» → «la-inmobiliaria»).
 */
export function nombreDeMarca(texto) {
  let s = String(texto || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/^\s*(solo|sólo|copia|unicamente|exclusivamente)\s+(para|de)\s+/, "")
    .replace(/[^a-z0-9ñ]+/g, "-").replace(/^-+|-+$/g, "");
  if (s.length > 30) s = s.slice(0, 30).replace(/-[^-]*$/, "") || s.slice(0, 30);
  return s;
}

// ------------------------------------------------------------------ marca de agua
/**
 * Texto de la marca tal como se escribe: el del usuario y, si se pide, « · 28/09/2026».
 * Solo letras, números y signos que sabe escribir la letra de la marca (sin emojis).
 */
export async function textoDeMarca(base, conFecha, hoy = new Date()) {
  const texto = String(base || "").replace(/\s+/g, " ").trim();
  if (!texto) return "";
  const dos = (n) => String(n).padStart(2, "0");
  const final = conFecha ? texto + " · " + dos(hoy.getDate()) + "/" + dos(hoy.getMonth() + 1) + "/" + hoy.getFullYear() : texto;
  const { PDFDocument, StandardFonts } = pdfLib();
  const font = await (await PDFDocument.create()).embedFont(StandardFonts.HelveticaBold);
  const malos = [...final].filter((c) => {
    try {
      font.widthOfTextAtSize(c, 10);
      return false;
    } catch {
      return true;
    }
  });
  if (malos.length) {
    throw new ErrorUsuario("La marca de agua no puede llevar «" + [...new Set(malos)].join(" ") + "»: solo letras, números y signos habituales (sin emojis ni otros alfabetos). Dime el texto sin esos caracteres.", "marcaCaracteres");
  }
  return final;
}

// Capa con la marca (página de w × h puntos: un punto por píxel), que PDFium dibuja encima.
async function capaDeMarca(w, h, cfg) {
  const { PDFDocument, StandardFonts, rgb, degrees } = pdfLib();
  const doc = await PDFDocument.create({ updateMetadata: false });
  const page = doc.addPage([w, h]);
  const font = await doc.embedFont(StandardFonts.HelveticaBold);
  const [r, g, b] = COLORES[cfg.color] || COLORES.gris;
  const color = rgb(r / 255, g / 255, b / 255);
  const size = Math.round(h * (TAMANOS[cfg.tamano] || TAMANOS.mediano));
  const opacidad = cfg.opacidad == null ? 0.4 : cfg.opacidad;
  // La web centra el texto en vertical (textBaseline «middle»); aquí se escribe sobre la línea
  // base, así que se baja un 35 % del tamaño.
  const medio = (t) => t * 0.35;
  if (cfg.estilo === "franja") {
    const alto = size * 2;
    page.drawRectangle({ x: 0, y: h / 2 - alto / 2, width: w, height: alto, color, opacity: opacidad });
    let t = size;
    while (font.widthOfTextAtSize(cfg.texto, t) > w * 0.9 && t > 10) t -= 2;
    page.drawText(cfg.texto, { x: (w - font.widthOfTextAtSize(cfg.texto, t)) / 2, y: h / 2 - medio(t), size: t, font, color: rgb(1, 1, 1), opacity: 0.95 });
  } else {
    // Diagonal repetida: cubre toda la tarjeta, también la foto y los datos. Las filas y los
    // pasos son los de la web, en su marco girado (y hacia abajo), pasados a la página (y hacia arriba).
    const pasoX = font.widthOfTextAtSize(cfg.texto, size) + font.widthOfTextAtSize(" ", size) * 1.5;
    const pasoY = size * 2.2;
    const diag = Math.hypot(w, h);
    const ang = (30 * Math.PI) / 180;
    const cos = Math.cos(ang);
    const sin = Math.sin(ang);
    let fila = 0;
    for (let y = -diag / 2; y <= diag / 2; y += pasoY) {
      const desfase = fila % 2 ? pasoX / 2 : 0;
      for (let x = -diag / 2 - pasoX + desfase; x <= diag / 2; x += pasoX) {
        const vy = -y - medio(size);
        page.drawText(cfg.texto, { x: w / 2 + x * cos - vy * sin, y: h / 2 + x * sin + vy * cos, size, font, color, opacity: opacidad, rotate: degrees(30) });
      }
      fila++;
    }
  }
  return doc.save();
}

/** Funde la marca de agua en los píxeles de la cara (RGBA, se modifica). */
export async function fundirMarca(img, cfg) {
  if (!cfg || !cfg.texto) return img;
  const P = await pdfium();
  const M = P.pdfium;
  const W = img.width;
  const H = img.height;
  const bytes = await capaDeMarca(W, H, cfg);
  const ptr = M.wasmExports.malloc(bytes.length);
  M.HEAPU8.set(bytes, ptr);
  const capa = P.FPDF_LoadMemDocument(ptr, bytes.length, "");
  const bmp = P.FPDFBitmap_Create(W, H, 1);
  try {
    if (!capa) throw new Error("capa de la marca");
    const stride = P.FPDFBitmap_GetStride(bmp);
    const buf = P.FPDFBitmap_GetBuffer(bmp);
    let heap = M.HEAPU8;
    for (let y = 0; y < H; y++) {
      for (let x = 0, o = buf + y * stride, q = y * W * 4; x < W; x++, o += 4, q += 4) {
        heap[o] = img.data[q + 2]; heap[o + 1] = img.data[q + 1]; heap[o + 2] = img.data[q]; heap[o + 3] = 255;
      }
    }
    const pg = P.FPDF_LoadPage(capa, 0);
    P.FPDF_RenderPageBitmap(bmp, pg, 0, 0, W, H, 0, 0);
    P.FPDF_ClosePage(pg);
    heap = M.HEAPU8;
    for (let y = 0; y < H; y++) {
      for (let x = 0, o = buf + y * stride, q = y * W * 4; x < W; x++, o += 4, q += 4) {
        img.data[q] = heap[o + 2]; img.data[q + 1] = heap[o + 1]; img.data[q + 2] = heap[o]; img.data[q + 3] = 255;
      }
    }
    return img;
  } finally {
    P.FPDFBitmap_Destroy(bmp);
    if (capa) P.FPDF_CloseDocument(capa);
    M.wasmExports.free(ptr);
  }
}

// ------------------------------------------------------------------ archivos finales
/**
 * PDF A4 con las caras a tamaño real, una debajo de otra, como la web (kit-dni-exportar.js):
 * si se pide, arriba «Copia de DNI · <marca>» y debajo «Es copia» con una línea para firmar.
 * Devuelve { bytes, textos } (textos: lo único que se puede leer como texto en el PDF).
 */
export async function crearPdf(caras, documento, marca, extras = {}) {
  const { PDFDocument, StandardFonts, rgb } = pdfLib();
  const pdf = await PDFDocument.create({ updateMetadata: false });
  pdf.setTitle("Copia protegida");
  pdf.setProducer("docuprivado.es");
  pdf.setCreator("docuprivado.es");
  const page = pdf.addPage(A4);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const [anchoPt, altoPt] = FORMATOS[documento.formato].pt;
  const x = (A4[0] - anchoPt) / 2;
  let arriba = A4[1] - 90;
  const textos = [];
  if (extras.linea) {
    const linea = "Copia de " + documento.nombre + (marca ? " · " + marca : "");
    let t = 11;
    while (font.widthOfTextAtSize(linea, t) > A4[0] - 80 && t > 7) t -= 0.5;   // que no se salga de la hoja
    page.drawText(linea, { x: (A4[0] - font.widthOfTextAtSize(linea, t)) / 2, y: A4[1] - 60, size: t, font, color: rgb(0.25, 0.28, 0.3) });
    textos.push(linea);
  }
  for (const c of caras) {
    const jpg = await pdf.embedJpg(codificar(c, "jpeg", CALIDAD_PDF));
    page.drawImage(jpg, { x, y: arriba - altoPt, width: anchoPt, height: altoPt });
    arriba = arriba - altoPt - 40;
  }
  if (extras.esCopia) {
    const y = arriba - 10;
    page.drawText("Es copia", { x, y, size: 11, font, color: rgb(0.25, 0.28, 0.3) });
    page.drawLine({ start: { x, y: y - 45 }, end: { x: x + 220, y: y - 45 }, thickness: 0.7, color: rgb(0.55, 0.6, 0.62) });
    page.drawText("Firma", { x, y: y - 60, size: 9, font, color: rgb(0.45, 0.5, 0.52) });
    textos.push("Es copia", "Firma");
  }
  return { bytes: await pdf.save(), textos };
}

/** Las dos caras, una debajo de otra, en una sola imagen sobre blanco (como la web). */
export function unirCaras(caras) {
  const ancho = Math.max(...caras.map((c) => c.width));
  const alto = caras.reduce((t, c) => t + c.height, 0) + SEPARACION_UNICA * (caras.length - 1);
  const out = new Uint8Array(ancho * alto * 4).fill(255);
  let y0 = 0;
  for (const c of caras) {
    const x0 = Math.floor((ancho - c.width) / 2);
    for (let y = 0; y < c.height; y++) out.set(c.data.subarray(y * c.width * 4, (y + 1) * c.width * 4), ((y0 + y) * ancho + x0) * 4);
    y0 += c.height + SEPARACION_UNICA;
  }
  return { data: out, width: ancho, height: alto };
}

export function imagenJpg(img) {
  return new Uint8Array(codificar(img, "jpeg", CALIDAD_IMAGEN));
}

// ------------------------------------------------------------------ comprobar
const sinEspacios = (s) => String(s).replace(/\s+/g, "");

/**
 * Abre el PDF generado y comprueba que es lo que debe: una hoja A4, una imagen por cara con
 * las medidas reales del documento y, como texto, solo lo que se pidió escribir (la marca va
 * fundida en las imágenes). Devuelve la lista de problemas (vacía si todo está bien).
 */
export async function comprobarPdf(bytes, caras, formato, textos) {
  const problemas = [];
  const P = await pdfium();
  const M = P.pdfium;
  const ptr = M.wasmExports.malloc(bytes.length);
  M.HEAPU8.set(bytes, ptr);
  const doc = P.FPDF_LoadMemDocument(ptr, bytes.length, "");
  const cajas = M.wasmExports.malloc(16);
  try {
    if (!doc) return ["el PDF generado no se puede abrir"];
    if (P.FPDF_GetPageCount(doc) !== 1) problemas.push("no tiene una sola hoja");
    const pg = P.FPDF_LoadPage(doc, 0);
    try {
      const w = P.FPDF_GetPageWidthF(pg);
      const h = P.FPDF_GetPageHeightF(pg);
      if (Math.abs(w - A4[0]) > 0.5 || Math.abs(h - A4[1]) > 0.5) problemas.push("la hoja no es A4");
      const [anchoPt, altoPt] = FORMATOS[formato].pt;
      let imagenes = 0;
      for (let i = 0; i < P.FPDFPage_CountObjects(pg); i++) {
        const obj = P.FPDFPage_GetObject(pg, i);
        if (P.FPDFPageObj_GetType(obj) !== 3) continue;           // 3: imagen
        imagenes++;
        P.FPDFPageObj_GetBounds(obj, cajas, cajas + 4, cajas + 8, cajas + 12);
        const [l, b, r, t] = Array.from(M.HEAPF32.subarray(cajas / 4, cajas / 4 + 4));
        if (Math.abs(r - l - anchoPt) > 0.5 || Math.abs(t - b - altoPt) > 0.5) problemas.push("una cara no tiene las medidas reales");
      }
      if (imagenes !== caras) problemas.push("tiene " + imagenes + " imágenes y debería tener " + caras);
    } finally {
      P.FPDF_ClosePage(pg);
    }
  } finally {
    if (doc) P.FPDF_CloseDocument(doc);
    M.wasmExports.free(cajas);
    M.wasmExports.free(ptr);
  }
  const lib = await pdfjs();
  const tarea = lib.getDocument({ data: new Uint8Array(bytes), verbosity: 0, isEvalSupported: false, disableFontFace: true });
  try {
    const pdf = await tarea.promise;
    const leido = (await (await pdf.getPage(1)).getTextContent()).items.map((x) => x.str).join("");
    if (sinEspacios(leido) !== sinEspacios(textos.join(""))) problemas.push("lleva texto que no debería");
  } finally {
    await tarea.destroy().catch(() => {});
  }
  return problemas;
}

/** Comprueba una imagen generada: se abre, mide lo que debe y no lleva datos ocultos. */
export function comprobarImagen(bytes, ancho, alto) {
  const problemas = [];
  try {
    const r = jpeg().decode(bytes, { useTArray: true });
    if (r.width !== ancho || r.height !== alto) problemas.push("no mide lo que debe");
  } catch {
    problemas.push("no se puede abrir");
  }
  if (metadatos(bytes).hay) problemas.push("lleva datos ocultos");
  return problemas;
}

// ------------------------------------------------------------------ guardar
/**
 * Guarda los archivos de una copia (uno o dos) con el mismo número si hace falta: «dni-
 * protegido-delantera-2026-09-28 (2).jpg» y «…-trasera-… (2).jpg», nunca uno con (2) y otro
 * sin él. Nunca sobrescribe nada. archivos: [{ nombre (sin extensión), ext, datos }].
 */
export function guardarJuntos(ctx, carpeta, archivos) {
  return escribirJuntos(ctx, carpeta, archivos);
}

export const _paraPruebas = { cuadrilateroValido, rotarEsquinas };
