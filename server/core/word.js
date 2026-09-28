/*
 * Word (.docx) para anonimizar y restaurar sin tocar el formato (docs/PROMPT_EXTENSION.md
 * §5.6 y §5.7).
 *
 * Un .docx es un ZIP con XML. El texto va en trozos <w:t> dentro de fragmentos con formato
 * (<w:r>), y una palabra puede estar repartida entre varios («Pé» en negrita y «rez» no).
 * Aquí se monta el texto seguido de todas las partes con texto (cuerpo, encabezados, pies,
 * notas y comentarios), sabiendo de qué trozo sale cada letra, y los cambios se hacen en
 * ese texto: la etiqueta entra en el primer trozo y el resto del dato se quita de los
 * demás, así que cada trozo conserva su formato.
 *
 * También cuenta el texto que no se ve: los cambios registrados que se borraron
 * (<w:delText>) y los códigos de campo (<w:instrText>, por ejemplo el «mailto:» de un
 * enlace): ahí también puede haber datos.
 */
import { ErrorUsuario } from "./errores.js";
import { ErrorZip, datosDe, escribirZip, leerZip } from "./zip.js";

// Partes con texto, en este orden (el cuerpo primero, para que las etiquetas se numeren
// como se lee el documento).
const PARTES = [/^word\/document\.xml$/, /^word\/header\d*\.xml$/, /^word\/footer\d*\.xml$/, /^word\/footnotes\.xml$/, /^word\/endnotes\.xml$/, /^word\/comments\.xml$/,
  /^word\/diagrams\/data\d*\.xml$/, /^word\/charts\/chart\d*\.xml$/];
const SEPARADOR_PARTES = "\n\n";

// Trozos de texto (<w:t>, <w:delText>, <w:instrText> y <a:t>, el de los esquemas SmartArt y
// los gráficos), tabuladores, saltos y finales de párrafo.
const RE_WORD = /<(w:t|w:delText|w:instrText|a:t)(\s[^>]*)?>([^<]*)<\/\1>|<w:tab\/>|<w:(?:br|cr)(?:\s[^>]*)?\/>|<\/[wa]:p>|<w:noBreakHyphen\/>/g;

const ENTIDADES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
export function decodificarXml(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e) => {
    if (e[0] === "#") return String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return ENTIDADES[e.toLowerCase()] || m;
  });
}
export function codificarXml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export const MENSAJES_WORD = {
  noWord: (n) => "No he podido abrir «" + n + "» como Word: parece dañado o no es un .docx.",
  antiguo: (n) => "«" + n + "» es un Word antiguo (.doc) o tiene contraseña. Ábrelo en Word y guárdalo como .docx sin contraseña; después vuelve a pedírmelo.",
};

/** Abre un .docx: sus entradas y el texto de sus partes con texto. */
export function abrirWord(bytes, nombre) {
  const b = Buffer.from(bytes);
  if (b.length >= 8 && b.readUInt32BE(0) === 0xd0cf11e0) throw new ErrorUsuario(MENSAJES_WORD.antiguo(nombre), "wordAntiguo");
  let entradas;
  try {
    entradas = leerZip(b);
  } catch (err) {
    if (err instanceof ErrorZip) throw new ErrorUsuario(MENSAJES_WORD.noWord(nombre), "danado");
    throw err;
  }
  if (!entradas.some((e) => e.nombre === "word/document.xml")) throw new ErrorUsuario(MENSAJES_WORD.noWord(nombre), "danado");
  const partes = [];
  for (const re of PARTES) {
    for (const e of entradas.filter((x) => re.test(x.nombre)).sort((x, y) => x.nombre.localeCompare(y.nombre, "en", { numeric: true }))) {
      let xml;
      try {
        xml = datosDe(e).toString("utf8");
      } catch {
        throw new ErrorUsuario(MENSAJES_WORD.noWord(nombre), "danado");
      }
      partes.push({ entrada: e, xml });
    }
  }
  // El texto seguido de todas las partes y, por cada trozo <w:t…>, dónde está en el XML y en el texto.
  let texto = "";
  for (const p of partes) {
    if (texto) texto += SEPARADOR_PARTES;
    p.inicio = texto.length;
    p.trozos = [];
    RE_WORD.lastIndex = 0;
    let m;
    while ((m = RE_WORD.exec(p.xml))) {
      if (m[1]) {
        const campo = m[1] === "w:instrText";
        if (campo) texto += "\n";                         // un código de campo, en su propia línea
        const abreFin = m.index + m[0].indexOf(">") + 1;
        const valor = decodificarXml(m[3]);
        p.trozos.push({ tipo: m[1], abreIni: m.index, abreFin, fin: abreFin + m[3].length, inicio: texto.length, texto: valor });
        texto += valor;
        if (campo) texto += "\n";
      } else if (m[0] === "<w:tab/>") texto += "\t";
      else if (m[0] === "<w:noBreakHyphen/>") texto += "-";
      else texto += "\n";                                  // fin de párrafo o salto de línea
    }
    p.fin = texto.length;
  }
  return { entradas, partes, texto };
}

// Primer trozo que acaba después de «pos» (los trozos van en orden).
function primerTrozo(trozos, pos) {
  let a = 0;
  let z = trozos.length;
  while (a < z) {
    const m = (a + z) >> 1;
    if (trozos[m].inicio + trozos[m].texto.length <= pos) a = m + 1; else z = m;
  }
  return a;
}

/**
 * Aplica cambios al texto del Word: [{ inicio, fin, nuevo }], en el orden del texto y sin
 * solaparse. Lo nuevo entra en el primer trozo que toca el cambio y lo demás se quita de
 * los siguientes. Devuelve las partes con su XML nuevo.
 */
export function aplicarCambios(word, cambios) {
  const porTrozo = new Map();
  for (const c of cambios) {
    const parte = word.partes.find((p) => c.inicio >= p.inicio && c.inicio < p.fin + SEPARADOR_PARTES.length);
    if (!parte) continue;
    let puesto = false;
    for (let i = primerTrozo(parte.trozos, c.inicio); i < parte.trozos.length; i++) {
      const t = parte.trozos[i];
      if (t.inicio >= c.fin) break;
      const desde = Math.max(c.inicio, t.inicio) - t.inicio;
      const hasta = Math.min(c.fin, t.inicio + t.texto.length) - t.inicio;
      if (hasta <= desde && t.texto.length) continue;
      if (!porTrozo.has(t)) porTrozo.set(t, []);
      porTrozo.get(t).push({ desde, hasta, nuevo: puesto ? "" : c.nuevo });
      puesto = true;
    }
  }
  for (const p of word.partes) {
    let xml = p.xml;
    const tocados = p.trozos.filter((t) => porTrozo.has(t));
    for (let i = tocados.length - 1; i >= 0; i--) {         // de atrás adelante: las posiciones no se mueven
      const t = tocados[i];
      let s = t.texto;
      for (const k of porTrozo.get(t).sort((x, y) => y.desde - x.desde)) s = s.slice(0, k.desde) + k.nuevo + s.slice(k.hasta);
      let abre = xml.slice(t.abreIni, t.abreFin);
      if (/^\s|\s$/.test(s) && !/xml:space=/.test(abre)) abre = abre.replace(/>$/, ' xml:space="preserve">');
      xml = xml.slice(0, t.abreIni) + abre + codificarXml(s) + xml.slice(t.fin);
    }
    p.xmlNuevo = xml;
  }
  return word.partes;
}

/** Solo el texto que se ve del cuerpo del documento (para enseñarlo si se pide). */
export function textoVisible(xml) {
  let texto = "";
  RE_WORD.lastIndex = 0;
  let m;
  while ((m = RE_WORD.exec(xml))) {
    if (m[1]) { if (m[1] === "w:t") texto += decodificarXml(m[3]); } else if (m[0] === "<w:tab/>") texto += "\t";
    else if (m[0] === "<w:noBreakHyphen/>") texto += "-";
    else texto += "\n";
  }
  return texto.replace(/\n{3,}/g, "\n\n").trim();
}

/** Escribe el .docx con las partes cambiadas (y, si se dan, otras entradas nuevas o quitadas). */
export function guardarWord(word, otros = new Map(), quitar = new Set()) {
  const nuevos = new Map(word.partes.filter((p) => p.xmlNuevo !== undefined && p.xmlNuevo !== p.xml).map((p) => [p.entrada.nombre, p.xmlNuevo]));
  for (const [n, x] of otros) nuevos.set(n, x);
  return escribirZip(word.entradas.filter((e) => !quitar.has(e.nombre)).map((e) => (nuevos.has(e.nombre) ? { ...e, datos: Buffer.from(nuevos.get(e.nombre), "utf8") } : e)));
}

// ------------------------------------------------------------ datos fuera del texto
/**
 * Lo que un Word lleva de quien lo hizo o lo tocó, fuera del texto: autor y última persona
 * que lo guardó, empresa, autores de comentarios y de cambios registrados, y la miniatura
 * de la primera página (una imagen con el texto original). Devuelve { otros (entradas con
 * XML nuevo), quitar (entradas que se quitan), avisos }. sustituir(texto): cambia en un
 * texto suelto los datos encontrados por sus etiquetas.
 */
export function limpiarFueraDelTexto(word, xmlDe, sustituir) {
  const otros = new Map();
  const quitar = new Set();
  const avisos = [];
  const quitado = new Set();          // qué se ha quitado, para decírselo al usuario
  const conTexto = (xml, et) => new RegExp("<" + et + "(\\s[^>]*)?>[^<\\s][^<]*</" + et + ">").test(xml);
  const vaciar = (xml, etiquetas) => etiquetas.reduce((x, et) => x.replace(new RegExp("<" + et + "(\\s[^>]*)?>[^<]*</" + et + ">", "g"), "<" + et + "$1></" + et + ">"), xml);
  const cambiarTextos = (xml, etiquetas) => etiquetas.reduce((x, et) => x.replace(new RegExp("(<" + et + "(?:\\s[^>]*)?>)([^<]*)(</" + et + ">)", "g"),
    (m, a, t, c) => a + codificarXml(sustituir(decodificarXml(t))) + c), xml);
  for (const e of word.entradas) {
    const n = e.nombre;
    if (n === "docProps/core.xml") {
      let xml = xmlDe(n);
      if (conTexto(xml, "dc:creator") || conTexto(xml, "cp:lastModifiedBy")) quitado.add("el autor");
      xml = vaciar(xml, ["dc:creator", "cp:lastModifiedBy"]);
      xml = cambiarTextos(xml, ["dc:title", "dc:subject", "dc:description", "cp:keywords", "cp:category"]);
      otros.set(n, xml);
    } else if (n === "docProps/app.xml") {
      if (conTexto(xmlDe(n), "Company") || conTexto(xmlDe(n), "Manager")) quitado.add("la empresa");
      otros.set(n, vaciar(xmlDe(n), ["Company", "Manager"]));
    } else if (/^docProps\/thumbnail\.[a-z]+$/i.test(n)) {
      quitar.add(n);
      quitado.add("la miniatura de la primera página");
    } else if (/^word\/.+\.xml$/.test(n)) {
      // Autores de comentarios y de cambios registrados (en el cuerpo, en comments.xml,
      // en people.xml…), también en las partes con texto ya cambiado.
      const xml = xmlDe(n);
      const limpio = autores(xml);
      if (limpio !== xml) {
        otros.set(n, limpio);
        quitado.add("los autores de comentarios y cambios");
      }
    }
  }
  // Las relaciones: la miniatura fuera y los «mailto:» con el dato cambiado.
  for (const e of word.entradas) {
    if (!/\.rels$/.test(e.nombre)) continue;
    const xml = xmlDe(e.nombre);
    let nuevo = xml.replace(/<Relationship\b[^>]*Type="[^"]*\/thumbnail"[^>]*\/>/g, "");
    // Rutas de este ordenador (la plantilla de Word, «file:///C:/Users/juan.perez/…»): solo el nombre del archivo.
    if (/Target="file:/i.test(nuevo)) quitado.add("la ruta de la plantilla en este ordenador");
    nuevo = nuevo.replace(/(Target=")file:[^"]*?([^"\\/]*)(")/gi, "$1$2$3");
    nuevo = nuevo.replace(/(Target=")([^"]*)(")/g, (m, a, t, c) => a + codificarXml(sustituir(decodificarXml(t))) + c);
    if (nuevo !== xml) otros.set(e.nombre, nuevo);
  }
  if (word.entradas.some((e) => /^word\/(media|embeddings)\//.test(e.nombre))) {
    avisos.push("Lleva imágenes u objetos incrustados (fotos, hojas de cálculo…): esos no los he revisado; si hay un dato dentro (la foto de un DNI, por ejemplo), sigue ahí.");
  }
  return { otros, quitar, avisos, quitado: [...quitado] };
}

// Autores de comentarios y cambios registrados: «Autor», sin iniciales ni identificador.
export function autores(xml) {
  return xml.replace(/\b(w:author|w15:author)="[^"]*"/g, '$1="Autor"').replace(/\bw:initials="[^"]*"/g, 'w:initials="A"').replace(/\bw15:userId="[^"]*"/g, 'w15:userId=""');
}
