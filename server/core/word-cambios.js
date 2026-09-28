/*
 * Mejora 3 del hito 6: un Word con control de cambios (una «versión con marcas de revisión»)
 * a partir de una comparación. Es el texto de la versión nueva, párrafo a párrafo, con lo
 * que cambia respecto a la anterior marcado como lo marca Word al revisar:
 *   - lo quitado, como texto eliminado (<w:del>), y lo añadido, como texto insertado (<w:ins>);
 *   - un párrafo quitado o añadido entero, también con su marca de párrafo;
 *   - un párrafo movido, quitado donde estaba y añadido donde está ahora.
 * Al aceptar todos los cambios queda la versión nueva, y al rechazarlos, la anterior. Los
 * cambios que se hagan después en Word también se marcan (<w:trackRevisions/>).
 * Lleva el texto y los párrafos, no el formato del original (negritas, tablas, estilos). El
 * autor de las marcas es «docuprivado», nunca el nombre de nadie.
 */
import { escribirZip } from "./zip.js";

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const AUTOR = "docuprivado";
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
// Caracteres que no pueden ir en un XML (restos de algún PDF raro).
const limpio = (s) => String(s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, "");

/**
 * El .docx (Buffer) con los cambios de «r» (el resultado del motor del comparador) marcados.
 * meta: { original, nuevo, fecha (Date) }.
 */
export function wordConCambios(r, meta) {
  const fecha = (meta.fecha || new Date()).toISOString().replace(/\.\d+Z$/, "Z");
  let id = 1;
  const marca = (tipo) => "<w:" + tipo + ' w:id="' + id++ + '" w:author="' + AUTOR + '" w:date="' + fecha + '"';
  const texto = (t) => '<w:r><w:t xml:space="preserve">' + esc(limpio(t)) + "</w:t></w:r>";
  const quitado = (t) => marca("del") + '><w:r><w:delText xml:space="preserve">' + esc(limpio(t)) + "</w:delText></w:r></w:del>";
  const puesto = (t) => marca("ins") + ">" + texto(t) + "</w:ins>";
  const parrafo = (contenido) => "<w:p>" + contenido + "</w:p>";
  // Un párrafo entero quitado o añadido: también su marca de párrafo, para que al aceptar o
  // rechazar no quede una línea vacía.
  const parrafoQuitado = (t) => "<w:p><w:pPr><w:rPr>" + marca("del") + "/></w:rPr></w:pPr>" + quitado(t) + "</w:p>";
  const parrafoPuesto = (t) => "<w:p><w:pPr><w:rPr>" + marca("ins") + "/></w:rPr></w:pPr>" + puesto(t) + "</w:p>";

  // Un párrafo que el comparador da por igual puede cambiar solo la numeración («SÉPTIMA.
  // Obras» → «OCTAVA. Obras»), las comillas o los espacios: también se marca, para que al
  // rechazar los cambios quede exactamente la versión anterior. Lo común del principio y del
  // final se deja tal cual y lo del medio va como quitado y puesto.
  const casiIgual = (a, b) => {
    if (a === b) return texto(b);
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    let j = 0;
    while (j < a.length - i && j < b.length - i && a[a.length - 1 - j] === b[b.length - 1 - j]) j++;
    const partes = [];
    if (i) partes.push(texto(b.slice(0, i)));
    if (a.length - j > i) partes.push(quitado(a.slice(i, a.length - j)));
    if (b.length - j > i) partes.push(puesto(b.slice(i, b.length - j)));
    if (j) partes.push(texto(b.slice(b.length - j)));
    return partes.join("");
  };

  const cuerpo = [];
  for (const f of r.filas) {
    if (f.tipo === "igual") {
      cuerpo.push(parrafo(casiIgual(r.a[f.a], r.b[f.b])));
    } else if (f.tipo === "eliminado") {
      cuerpo.push(parrafoQuitado(r.a[f.a]));                   // también donde estaba uno movido
    } else if (f.tipo === "anadido") {
      cuerpo.push(parrafoPuesto(r.b[f.b]));
    } else if (f.tipo === "movido") {
      cuerpo.push(parrafoPuesto(r.b[f.b]));                    // ya se quitó donde estaba
    } else {
      const c = r.cambios[f.cambio];
      const ops = c && c.palabras ? c.palabras : [[-1, r.a[f.a]], [1, r.b[f.b]]];
      cuerpo.push(parrafo(ops.filter(([, t]) => t).map(([op, t]) => (op === 0 ? texto(t) : op === -1 ? quitado(t) : puesto(t))).join("")));
    }
  }

  const documento = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document ' + W + "><w:body>" + cuerpo.join("") +
    '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1417" w:right="1701" w:bottom="1417" w:left="1701" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr>' +
    "</w:body></w:document>";
  const estilos = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:styles ' + W + ">" +
    '<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri" w:eastAsia="Calibri"/><w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="es-ES"/></w:rPr></w:rPrDefault>' +
    '<w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>' +
    '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style></w:styles>';
  const ajustes = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:settings ' + W + '><w:trackRevisions/><w:defaultTabStop w:val="708"/><w:lang w:val="es-ES"/></w:settings>';
  const titulo = "Cambios de " + meta.original + " a " + meta.nuevo;
  const core = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ' +
    'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
    "<dc:title>" + esc(limpio(titulo)) + "</dc:title><dc:creator>" + AUTOR + "</dc:creator>" +
    '<dcterms:created xsi:type="dcterms:W3CDTF">' + fecha + "</dcterms:created></cp:coreProperties>";
  const app = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>docuprivado</Application></Properties>';
  const tipos = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
    '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
    '<Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>' +
    '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
    '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>';
  const REL = "http://schemas.openxmlformats.org";
  const rels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="' + REL + '/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="' + REL + '/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
    '<Relationship Id="rId2" Type="' + REL + '/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
    '<Relationship Id="rId3" Type="' + REL + '/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>';
  const relsDoc = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="' + REL + '/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="' + REL + '/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
    '<Relationship Id="rId2" Type="' + REL + '/officeDocument/2006/relationships/settings" Target="settings.xml"/></Relationships>';
  const e = (nombre, datos) => ({ nombre, datos: Buffer.from(datos, "utf8") });
  return escribirZip([
    e("[Content_Types].xml", tipos), e("_rels/.rels", rels), e("docProps/core.xml", core), e("docProps/app.xml", app),
    e("word/document.xml", documento), e("word/_rels/document.xml.rels", relsDoc), e("word/styles.xml", estilos), e("word/settings.xml", ajustes),
  ]);
}
