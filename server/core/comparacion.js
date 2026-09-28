/*
 * Comparar dos versiones de un documento (docs/PROMPT_EXTENSION.md §5.9), igual que el
 * comparador de la web (/comparar-documentos/):
 *   1. el texto de cada versión, en párrafos:
 *      - Word (.docx): el cuerpo del documento, párrafo a párrafo, como lo lee la web
 *        (mammoth, «extractRawText»): sin encabezados, pies, comentarios, texto borrado de
 *        los cambios registrados ni códigos de campo;
 *      - PDF: el texto de cada página con pdf.js y las reglas de la web (cabeceras, pies y
 *        números de página fuera, palabras partidas a final de línea unidas); si no tiene
 *        texto (escaneado), se lee con el lector de escaneados, como la web;
 *      - texto (.txt, .md, .csv): en UTF-8 o, si no, en la codificación de Windows;
 *   2. el motor de la web (js/comparador-motor.js, copiado sin cambios): alinea los
 *      párrafos sin tener en cuenta la numeración de las cláusulas, compara palabra a
 *      palabra los modificados y marca los cambios importantes (importes, fechas y plazos,
 *      cuentas bancarias desde el hito de actualización 17 de la web,
 *      cláusulas nuevas y palabras delicadas);
 *   3. un informe HTML que se abre en el navegador, sin scripts ni nada de fuera;
 *   4. para el chat, los cambios importantes con los datos personales tapados (decisión de
 *      el titular, 28/09/2026: «Cambios, datos tapados»).
 */
import fs from "node:fs";
import path from "node:path";
import { ErrorUsuario } from "./errores.js";
import { enmascarar, opcionesDeteccion } from "./deteccion.js";
import { abrir as abrirPdf, dibujarPagina } from "./documento-pdf.js";
import { PPP_OCR, leerTexto as leerEscaneo } from "./escaneos.js";
import { comparadorMotor, detector } from "./motores.js";
import { leerTexto } from "./texto-archivo.js";
import { tipoDeArchivo } from "./tipos-archivo.js";
import { decodificarXml, MENSAJES_WORD } from "./word.js";
import { ErrorZip, datosDe, leerZip } from "./zip.js";

export const MAX_PAGINAS = 300;                // entre los dos documentos, como la web
const CARACTERES_POR_PAGINA = 2500;             // para contar páginas de un Word o un texto (la web)
export const AVISO = "Comparación orientativa; no sustituye el asesoramiento de un profesional.";
export const TIPOS_CAMBIO = { anadido: "añadido", eliminado: "eliminado", modificado: "modificado", movido: "movido de sitio" };
export const QUE_CAMBIA = { importe: "Importe", plazo: "Fecha o plazo", cuenta: "Cuenta bancaria", clausula: "Cláusula nueva", sensible: "Palabra delicada" };
// Los datos personales que se tapan en lo que va al chat. Los importes, las fechas de un
// plazo y las empresas no: son justo lo que cambia en un contrato.
const PERSONALES = ["dni", "nie", "iban", "cuenta", "tarjeta", "telefono", "email", "nss", "matricula", "direccion", "fecha_nac", "nombre"];

// ------------------------------------------------------------------ leer
// El texto del cuerpo de un Word como lo da mammoth: cada párrafo seguido de una línea en
// blanco, los saltos de línea como saltos y los tabuladores como tabuladores. Solo cuenta
// lo que se ve: ni el texto borrado de los cambios registrados ni los códigos de campo.
const RE_CUERPO = /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:tab\/>|<w:(?:br|cr)(?:\s[^>]*)?\/>|<\/w:p>|<w:noBreakHyphen\/>/g;

export function textoDeWord(bytes, nombre) {
  const b = Buffer.from(bytes);
  if (b.length >= 8 && b.readUInt32BE(0) === 0xd0cf11e0) throw new ErrorUsuario(MENSAJES_WORD.antiguo(nombre), "wordAntiguo");
  let xml;
  try {
    const cuerpo = leerZip(b).find((e) => e.nombre === "word/document.xml");
    if (!cuerpo) throw new ErrorZip("sin cuerpo");
    xml = datosDe(cuerpo).toString("utf8");
  } catch (err) {
    if (err instanceof ErrorZip || err instanceof RangeError) throw new ErrorUsuario(MENSAJES_WORD.noWord(nombre), "danado");
    throw err;
  }
  // Los cuadros de texto van dos veces (el de ahora y el de los Word antiguos): solo uno.
  xml = xml.replace(/<mc:Fallback>[\s\S]*?<\/mc:Fallback>/g, "");
  let texto = "";
  RE_CUERPO.lastIndex = 0;
  let m;
  while ((m = RE_CUERPO.exec(xml))) {
    if (m[1] !== undefined) texto += decodificarXml(m[1]);
    else if (m[0] === "<w:tab/>") texto += "\t";
    else if (m[0] === "<w:noBreakHyphen/>") texto += "-";
    else if (m[0] === "</w:p>") texto += "\n\n";
    else texto += "\n";
  }
  return texto;
}

// Como la web: los párrafos de un texto de Word, separados por líneas en blanco.
function parrafosDeWord(M, texto) {
  return texto.split(/\n{2,}/).map((p) => M.unirLineas(p.split("\n"))).filter(Boolean);
}

async function parrafosDePdf(M, archivo) {
  let d;
  try {
    d = await abrirPdf(archivo.ruta, archivo.nombre);
  } catch (err) {
    if (err instanceof ErrorUsuario && err.codigo === "contrasena") {
      throw new ErrorUsuario("«" + archivo.nombre + "» tiene contraseña. Quítasela primero o compáralo en docuprivado.es/comparar-documentos/ (no me la escribas en el chat).", "contrasena");
    }
    throw err;
  }
  try {
    if (d.paginas > MAX_PAGINAS) throw new ErrorUsuario("«" + archivo.nombre + "» tiene " + d.paginas + " páginas: como mucho comparo " + MAX_PAGINAS + " entre los dos documentos.", "paginas");
    // Lo mismo que lee la web de cada página (js/comparador-lectura.js, leerPdf).
    const paginas = [];
    let conTexto = 0;
    for (let i = 1; i <= d.paginas; i++) {
      const page = await d.pdfjsDoc.getPage(i);
      const tc = await page.getTextContent();
      const items = tc.items.filter((it) => typeof it.str === "string").map((it) => ({
        str: it.str, x: it.transform[4], y: it.transform[5], w: it.width, h: it.height || Math.hypot(it.transform[2], it.transform[3]),
      }));
      if (items.map((it) => it.str).join("").replace(/\s/g, "").length >= 20) conTexto++;
      paginas.push(items);
      page.cleanup();
    }
    if (conTexto > 0) return { parrafos: M.parrafosDePdf(paginas), paginas: d.paginas, escaneado: false };
    // Escaneado: el texto se lee de la imagen de cada página, como la web
    // (js/comparador-lectura.js, leerEscaneado), con las cajas pasadas a puntos de la página.
    const escala = PPP_OCR / 72;
    const leidas = [];
    for (let i = 1; i <= d.paginas; i++) {
      const pg = d.P.FPDF_LoadPage(d.doc, i - 1);
      const alto = d.P.FPDF_GetPageHeightF(pg);
      d.P.FPDF_ClosePage(pg);
      const img = dibujarPagina(d, i, escala);
      const leido = await leerEscaneo(img, escala, d.clave + "|" + i);
      leidas.push((leido.items || []).map((it) => ({
        str: leido.texto.slice(it.inicio, it.fin), x: it.rect.x, y: alto - (it.rect.y + it.rect.h), w: it.rect.w, h: it.rect.h,
      })));
    }
    return { parrafos: M.parrafosDePdf(leidas, { ocr: true }), paginas: d.paginas, escaneado: true };
  } finally {
    await d.cerrar();
  }
}

/**
 * Los párrafos de una versión: { parrafos, paginas, escaneado }. Error para el usuario si
 * no es un Word, un PDF o un texto, o si no tiene texto.
 */
export async function leerParrafos(archivo) {
  const M = comparadorMotor();
  const tipo = tipoDeArchivo(archivo.ruta);
  let r;
  if (tipo === "pdf") {
    r = await parrafosDePdf(M, archivo);
  } else if (tipo === "word" || tipo === "texto") {
    const bytes = fs.readFileSync(archivo.ruta);
    const parrafos = tipo === "word" ? parrafosDeWord(M, textoDeWord(bytes, archivo.nombre)) : M.parrafosDeTexto(leerTexto(bytes).texto);
    r = { parrafos, paginas: Math.max(1, Math.ceil(parrafos.join(" ").length / CARACTERES_POR_PAGINA)), escaneado: false };
  } else {
    throw new ErrorUsuario("«" + archivo.nombre + "» no es un Word (.docx), un PDF ni un archivo de texto: son los que sé comparar.", "formato");
  }
  if (!r.parrafos.length) {
    throw new ErrorUsuario("No he encontrado texto en «" + archivo.nombre + "»" + (r.escaneado ? " (es un escaneo y no se lee nada: ¿está en blanco o muy borroso?)" : "") + ".", "sinTexto");
  }
  return r;
}

// ------------------------------------------------------------------ datos tapados
/**
 * Un trozo de texto con los datos personales tapados como en analizar_datos_personales
 * (DNI ***4567**, nombres con la inicial…), para lo que se enseña en el chat.
 */
export function taparDatos(texto, contexto) {
  let t = String(texto == null ? "" : texto);
  if (!t.trim()) return t;
  const D = detector();
  const det = opcionesDeteccion({ tipos: PERSONALES });
  const buscar = (s) => D.detect(s, { tipos: det.tipos, personalizados: [], ocr: false }).filter((m) => m.fin > m.inicio);
  // Un dato suelto («03/01/1978») no dice qué es: se busca también en su párrafo («Fecha de
  // nacimiento: 03/01/1978»), y lo que allí es un dato personal se tapa aquí (hito de
  // actualización 17: las fechas de nacimiento salían sin tapar al comparar dos nóminas).
  if (contexto && String(contexto) !== t) {
    const ctx = String(contexto);
    const valores = buscar(ctx).map((m) => ({ tipo: m.tipo, valor: ctx.slice(m.inicio, m.fin) }))
      .filter((m) => m.valor.length >= 4 && t.includes(m.valor))
      .sort((a, b) => b.valor.length - a.valor.length);
    for (const m of valores) t = t.split(m.valor).join(enmascarar(m.tipo, m.valor));
  }
  const marcas = buscar(t).sort((a, b) => a.inicio - b.inicio || b.fin - a.fin);
  let out = "";
  let pos = 0;
  for (const m of marcas) {
    if (m.inicio < pos) continue;                        // dentro de otro ya tapado
    out += t.slice(pos, m.inicio) + enmascarar(m.tipo, t.slice(m.inicio, m.fin));
    pos = m.fin;
  }
  return out + t.slice(pos);
}

// ------------------------------------------------------------------ informe
const esc = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function corta(s, n) {
  const t = String(s || "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1).replace(/\s+\S*$/, "") + "…" : t;
}

export function frasesResumen(res) {
  const partes = [];
  if (res.modificados) partes.push(res.modificados + (res.modificados === 1 ? " modificado" : " modificados"));
  if (res.anadidos) partes.push(res.anadidos + (res.anadidos === 1 ? " añadido" : " añadidos"));
  if (res.eliminados) partes.push(res.eliminados + (res.eliminados === 1 ? " eliminado" : " eliminados"));
  if (res.movidos) partes.push(res.movidos + (res.movidos === 1 ? " movido de sitio" : " movidos de sitio"));
  // Posibles errores al leer un escaneo (hito de actualización 15 de la web): aparte.
  const lectura = res.lectura ? res.lectura + (res.lectura === 1 ? " posible error de lectura del escaneo" : " posibles errores de lectura del escaneo") : "";
  if (!res.total) {
    return lectura ? "No hay cambios de verdad; " + lectura + ", marcados aparte." : "Los dos documentos dicen lo mismo (sin contar la numeración de las cláusulas ni el formato).";
  }
  return res.total + (res.total === 1 ? " cambio" : " cambios") + " (" + partes.join(", ") + ")" +
    (res.importantes ? "; " + res.importantes + (res.importantes === 1 ? " importante" : " importantes") : "; ninguno en importes, fechas, plazos, cuentas bancarias ni cláusulas nuevas") + "." +
    (lectura ? " Además, " + lectura + ", marcados aparte." : "");
}

// «modificado», «movido de sitio (antes en SEGUNDA. Duración)», «posible error de lectura».
export function nombreCambio(c) {
  if (c.lectura) return "posible error de lectura";
  return TIPOS_CAMBIO[c.tipo] + (c.tipo === "movido" && c.desde ? " (antes en " + c.desde + ")" : "");
}

function textoImportante(imp) {
  if (imp.etiqueta === "clausula") return ["", imp.despues];
  if (imp.etiqueta === "sensible") return ["", "Aparece: " + imp.despues];
  return [imp.antes || "—", imp.despues || "—"];
}

// Un párrafo modificado, palabra a palabra: lo quitado tachado y lo añadido resaltado.
function palabrasHtml(ops) {
  return ops.map(([op, t]) => (op === -1 ? "<del>" + esc(t) + "</del>" : op === 1 ? "<ins>" + esc(t) + "</ins>" : esc(t))).join("");
}

/**
 * El informe: una página HTML sola (estilos dentro, sin scripts ni nada que se descargue de
 * fuera: lo impide también su política de contenido), con el resumen, los cambios
 * importantes y todos los cambios, palabra a palabra en los modificados.
 */
export function informeHtml(r, meta) {
  const imps = [];
  r.cambios.forEach((c) => c.importantes.forEach((imp) => {
    const [antes, despues] = textoImportante(imp);
    imps.push("<tr><td>" + esc(c.donde) + "</td><td>" + esc(QUE_CAMBIA[imp.etiqueta] || imp.etiqueta) + "</td><td>" + esc(corta(antes, 300)) + "</td><td>" + esc(corta(despues, 300)) + "</td></tr>");
  }));
  const todos = r.cambios.map((c, i) => {
    let cuerpo;
    if (c.tipo === "modificado" || c.tipo === "movido") cuerpo = "<p class=\"texto\">" + palabrasHtml(c.palabras || []) + "</p>";
    else if (c.tipo === "anadido") cuerpo = "<p class=\"texto\"><ins>" + esc(r.b[c.b]) + "</ins></p>";
    else cuerpo = "<p class=\"texto\"><del>" + esc(r.a[c.a]) + "</del></p>";
    const marcas = c.importantes.map((imp) => "<span class=\"marca\">" + esc(QUE_CAMBIA[imp.etiqueta] || imp.etiqueta) + "</span>").join(" ");
    return "<li class=\"cambio " + c.tipo + (c.lectura ? " lectura" : "") + "\"><div class=\"cab\"><span class=\"num\">" + (i + 1) + "</span> <span class=\"tipo\">" + esc(nombreCambio(c)) + "</span> " +
      "<strong>" + esc(c.donde) + "</strong> " + marcas + "</div>" + cuerpo + "</li>";
  });
  const aviso = AVISO + " Solo se compara el texto: no el formato, las imágenes ni las firmas." +
    (meta.escaneado ? " Uno de los documentos era un escaneo y su texto se leyó automáticamente: los cambios que parecen solo letras mal leídas van marcados como «posible error de lectura», pero revísalos." : "");
  return "<!DOCTYPE html>\n<html lang=\"es-ES\">\n<head>\n<meta charset=\"utf-8\">\n" +
    "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; style-src 'unsafe-inline'\">\n" +
    "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n<meta name=\"robots\" content=\"noindex, nofollow\">\n" +
    "<title>Informe de cambios · " + esc(meta.original) + " → " + esc(meta.nuevo) + "</title>\n<style>\n" +
    ":root{--texto:#1b2429;--suave:#5b6970;--marca:#0f5c6e;--linea:#dde3e6;--fondo:#fff;--caja:#e3f0f3;--del:#fde2e1;--delt:#9b1c1c;--ins:#dcf5e3;--inst:#146c2e}\n" +
    "@media (prefers-color-scheme:dark){:root{--texto:#e6ecef;--suave:#a4b1b7;--marca:#5fb8cc;--linea:#34414a;--fondo:#12181c;--caja:#1c2a30;--del:#4a1f1f;--delt:#ffb4ae;--ins:#173b24;--inst:#9be3b0}}\n" +
    "body{font-family:system-ui,-apple-system,'Segoe UI',Roboto,Arial,sans-serif;color:var(--texto);background:var(--fondo);max-width:980px;margin:0 auto;padding:24px 16px;line-height:1.5}\n" +
    "h1{font-size:1.6rem;margin:0 0 4px}h2{font-size:1.2rem;margin:28px 0 8px;color:var(--marca)}.suave{color:var(--suave);font-size:.9rem}\n" +
    ".resumen{font-weight:600;font-size:1.1rem}.aviso{background:var(--caja);border-radius:8px;padding:10px 14px;font-size:.92rem}\n" +
    "table{border-collapse:collapse;width:100%;font-size:.92rem}th,td{border:1px solid var(--linea);padding:6px 8px;text-align:left;vertical-align:top}th{background:var(--marca);color:var(--fondo)}\n" +
    "ol{padding:0;list-style:none}.cambio{border:1px solid var(--linea);border-radius:8px;padding:10px 12px;margin:10px 0}.cab{font-size:.95rem}\n" +
    ".num{color:var(--suave)}.tipo{text-transform:uppercase;font-size:.75rem;font-weight:700;letter-spacing:.04em;padding:2px 6px;border-radius:4px;background:var(--caja)}\n" +
    ".marca{font-size:.75rem;font-weight:600;padding:2px 6px;border-radius:4px;border:1px solid var(--marca);color:var(--marca)}\n" +
    ".lectura{opacity:.75}.texto{margin:8px 0 0;white-space:pre-wrap}del{background:var(--del);color:var(--delt)}ins{background:var(--ins);color:var(--inst);text-decoration:none}\n" +
    "@media print{body{max-width:none}.cambio{break-inside:avoid}}\n</style>\n</head>\n<body>\n" +
    "<h1>Informe de cambios</h1>\n<p class=\"suave\">Creado el " + esc(meta.fecha) + " con la extensión de docuprivado para Claude Desktop, en tu propio ordenador: los documentos no se han enviado a ningún sitio.</p>\n" +
    "<p>Versión original: <strong>" + esc(meta.original) + "</strong><br>Versión nueva: <strong>" + esc(meta.nuevo) + "</strong></p>\n" +
    "<p class=\"resumen\">" + esc(frasesResumen(r.resumen)) + "</p>\n<p class=\"aviso\">" + esc(aviso) + "</p>\n" +
    "<h2>Cambios importantes</h2>\n" + (imps.length
      ? "<table><thead><tr><th>Dónde</th><th>Qué</th><th>Antes</th><th>Ahora</th></tr></thead><tbody>\n" + imps.join("\n") + "\n</tbody></table>\n"
      : "<p>No hay cambios en importes, fechas, plazos ni cláusulas nuevas.</p>\n") +
    "<h2>Todos los cambios</h2>\n" + (todos.length ? "<p class=\"suave\">Tachado en rojo, lo que quita la versión nueva; resaltado en verde, lo que añade.</p>\n<ol>\n" + todos.join("\n") + "\n</ol>\n" : "<p>Los dos documentos dicen lo mismo.</p>\n") +
    "</body>\n</html>\n";
}

// ------------------------------------------------------------------ comparar
/**
 * Compara dos archivos ({ ruta, nombre }): { r (resultado del motor), escaneados, paginas }.
 */
export async function compararArchivos(original, nuevo) {
  const a = await leerParrafos(original);
  const b = await leerParrafos(nuevo);
  if (a.paginas + b.paginas > MAX_PAGINAS) {
    throw new ErrorUsuario("Entre los dos documentos hay unas " + (a.paginas + b.paginas) + " páginas: como mucho comparo " + MAX_PAGINAS + ".", "paginas");
  }
  // Con un escaneo, los cambios que son solo de leer mal la imagen se marcan aparte.
  const r = comparadorMotor().comparar(a.parrafos, b.parrafos, { escaneado: a.escaneado || b.escaneado });
  return { r, escaneados: [a.escaneado ? original.nombre : null, b.escaneado ? nuevo.nombre : null].filter(Boolean), paginas: a.paginas + b.paginas };
}

/**
 * Lo que va al chat de cada cambio importante, con los datos personales tapados:
 * [{ donde, tipo, cambios: [{ que, antes, despues }] }].
 */
export function importantesParaElChat(r) {
  return r.cambios.filter((c) => c.importantes.length).map((c) => ({
    donde: taparDatos(c.donde),
    tipo: c.tipo,
    desde: c.desde ? taparDatos(c.desde) : null,
    cambios: c.importantes.map((imp) => ({
      que: imp.etiqueta,
      antes: taparDatos(corta(imp.antes, 160), c.a !== null && c.a !== undefined ? r.a[c.a] : null),
      despues: taparDatos(corta(imp.despues, 160), c.b !== null && c.b !== undefined ? r.b[c.b] : null),
    })),
  }));
}

/** El nombre del informe: «comparacion-<original>-<nuevo>» (sin extensiones, cortos). */
export function nombreInforme(original, nuevo) {
  const base = (n) => {
    const s = path.basename(n, path.extname(n)).replace(/\s+/g, " ").trim();
    return s.length > 40 ? s.slice(0, 40).trim() : s;
  };
  return "comparacion-" + base(original) + "-" + base(nuevo);
}
