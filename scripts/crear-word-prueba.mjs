/*
 * Crea «correo-cliente.docx», un Word FICTICIO para las pruebas de anonimizar y restaurar
 * (hito 4), con lo que suele complicar un Word de verdad:
 * - un nombre repartido entre fragmentos con formato distinto («Juan » y «Pé» en negrita,
 *   «rez García» sin ella) y un DNI partido en dos fragmentos en cursiva;
 * - un tabulador entre «DNI:» y el número;
 * - un encabezado, un comentario y un cambio registrado (un teléfono borrado, que no se ve
 *   pero sigue dentro del archivo);
 * - un enlace «mailto:» y un código de campo con el correo;
 * - el autor y la última persona que lo guardó en las propiedades, la empresa y la
 *   miniatura de la primera página.
 * Los datos son los ficticios de la web (tests/fixtures/texto-anonimizar.txt).
 *
 *   node scripts/crear-word-prueba.mjs <archivo.docx>
 */
import fs from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { escribirZip } from "../server/core/zip.js";

const require = createRequire(import.meta.url);
const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// Un fragmento con formato: [texto, "b" | "i" | ""].
const r = (texto, f = "") => "<w:r>" + (f ? "<w:rPr><w:" + f + "/></w:rPr>" : "") + '<w:t xml:space="preserve">' + esc(texto) + "</w:t></w:r>";
const p = (...runs) => "<w:p>" + runs.join("") + "</w:p>";

export const PARRAFOS_VISIBLES = [
  "Asunto: Documentación para el contrato de alquiler",
  "Te escribo en nombre de mi cliente, D. Juan Pérez García (DNI 12345678Z), con domicilio en Calle del Ejemplo 12, 3.º B, 28013 Madrid.",
  "DNI:\t12345678Z",
  "Puedes localizarle en el 612 345 678 o en juan.perez@example.com.",
  "La inquilina será Dña. María López Sánchez, con NIE X1234567L. La renta se ingresará en la cuenta ES91 2100 0418 4502 0005 1332.",
  "El Sr. Pérez me pide que le confirmes la cita del jueves.",
  "Un saludo,",
  "Carmen Ruiz Ortega",
];

function documento() {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document ' + W + "><w:body>" +
    p(r("Asunto: ", "b"), r("Documentación para el contrato de alquiler")) +
    p(r("Te escribo en nombre de mi cliente, D. "), r("Juan ", "b"), r("Pé", "b"), r("rez García"), r(" (DNI "), r("12345678", "i"), r("Z", "i"),
      r("), con domicilio en Calle del Ejemplo 12, 3.º B, 28013 Madrid."), '<w:commentRangeStart w:id="0"/>', '<w:commentRangeEnd w:id="0"/>',
      '<w:r><w:commentReference w:id="0"/></w:r>') +
    p(r("DNI:"), "<w:r><w:tab/></w:r>", r("12345678Z")) +
    p(r("Puedes localizarle en el 612 345 678"),
      '<w:del w:id="1" w:author="Juan Pérez García" w:date="2026-09-01T10:00:00Z"><w:r><w:delText xml:space="preserve"> (o en el 699 123 456)</w:delText></w:r></w:del>',
      r(" o en "), '<w:hyperlink r:id="rId3">' + r("juan.perez@example.com") + "</w:hyperlink>", r(".")) +
    p(r("La inquilina será Dña. María López Sánchez, con NIE X1234567L. La renta se ingresará en la cuenta ES91 2100 0418 4502 0005 1332.")) +
    p(r("El Sr. Pérez me pide que le confirmes la cita del jueves.")) +
    p('<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> HYPERLINK "mailto:juan.perez@example.com" </w:instrText></w:r>',
      '<w:r><w:fldChar w:fldCharType="separate"/></w:r>', r("Escríbele"), '<w:r><w:fldChar w:fldCharType="end"/></w:r>') +
    p(r("Un saludo,")) +
    p(r("Carmen Ruiz Ortega", "b")) +
    '<w:sectPr><w:headerReference w:type="default" r:id="rId1"/><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1417" w:right="1701" w:bottom="1417" w:left="1701" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr>' +
    "</w:body></w:document>";
}

const encabezado = () => '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:hdr ' + W + ">" + p(r("Cliente: Juan Pérez García")) + "</w:hdr>";
const comentarios = () => '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:comments ' + W + '><w:comment w:id="0" w:author="María López Sánchez" w:initials="MLS" w:date="2026-09-01T10:00:00Z">' +
  p(r("Confirmar el DNI 12345678Z con Juan Pérez García.")) + "</w:comment></w:comments>";

const TIPOS = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' +
  '<Default Extension="jpeg" ContentType="image/jpeg"/>' +
  '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
  '<Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>' +
  '<Override PartName="/word/comments.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"/>' +
  '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
  '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>';
const REL = "http://schemas.openxmlformats.org";
const RELS = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="' + REL + '/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="' + REL + '/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
  '<Relationship Id="rId2" Type="' + REL + '/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
  '<Relationship Id="rId3" Type="' + REL + '/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>' +
  '<Relationship Id="rId4" Type="' + REL + '/package/2006/relationships/metadata/thumbnail" Target="docProps/thumbnail.jpeg"/></Relationships>';
const RELS_DOC = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="' + REL + '/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="' + REL + '/officeDocument/2006/relationships/header" Target="header1.xml"/>' +
  '<Relationship Id="rId2" Type="' + REL + '/officeDocument/2006/relationships/comments" Target="comments.xml"/>' +
  '<Relationship Id="rId3" Type="' + REL + '/officeDocument/2006/relationships/hyperlink" Target="mailto:juan.perez@example.com" TargetMode="External"/></Relationships>';
const CORE = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ' +
  'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
  "<dc:title>Contrato de Juan Pérez García</dc:title><dc:creator>Juan Pérez García</dc:creator><cp:lastModifiedBy>María López Sánchez</cp:lastModifiedBy>" +
  '<dcterms:created xsi:type="dcterms:W3CDTF">2026-09-01T10:00:00Z</dcterms:created></cp:coreProperties>';
const APP = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties">' +
  "<Application>Microsoft Office Word</Application><Company>Inmobiliaria Los Almendros del Tormes S.L.</Company></Properties>";

// Una «respuesta de una IA» ficticia sobre correo-cliente.docx ya anonimizado, con las
// etiquetas que salen al anonimizarlo (una en minúsculas y otra sin corchetes, como a
// veces las devuelve una IA), para probar restaurar_archivo.
export const RESPUESTA_IA = [
  "Hola, [PERSONA_3]:",
  "",
  "He revisado el correo. Resumen para el contrato:",
  "- Arrendador: [PERSONA_1] (DNI [DNI_1]), con domicilio en [DIRECCION_1].",
  "- Inquilina: [persona_2], con NIE NIE_1.",
  "- La renta se ingresará en la cuenta [IBAN_1].",
  "- Contacto: [TELEFONO_1] o [EMAIL_1].",
  "",
  "Conviene pedir a [PERSONA_1] que confirme la cita del jueves.",
  "",
].join("\n");

export function crearCorreoCliente() {
  const jpeg = require("jpeg-js");
  const miniatura = jpeg.encode({ data: Buffer.alloc(16 * 16 * 4, 200), width: 16, height: 16 }, 80).data;
  const e = (nombre, datos) => ({ nombre, datos: Buffer.from(datos) });
  return escribirZip([
    e("[Content_Types].xml", TIPOS), e("_rels/.rels", RELS), e("docProps/core.xml", CORE), e("docProps/app.xml", APP),
    e("docProps/thumbnail.jpeg", miniatura), e("word/document.xml", documento()), e("word/_rels/document.xml.rels", RELS_DOC),
    e("word/header1.xml", encabezado()), e("word/comments.xml", comentarios()),
  ]);
}

// Revisión con otro chat de Claude (hito de actualización 17 de la web): una carta FICTICIA
// con lo que falló al anonimizar. «Sr. Andrés Castillo» en el texto y «Andrés Castillo Vega»
// solo en la casilla de una tabla; «Madrid.» al final de una línea y «Un saludo» al empezar
// la siguiente; y el IBAN seguido de punto.
export function crearCartaRevision() {
  const celda = (t) => "<w:tc>" + p(r(t)) + "</w:tc>";
  const doc = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document ' + W + "><w:body>" +
    p(r("Carta al cliente (ficticia)", "b")) +
    p(r("Estimado Sr. Andrés Castillo: le confirmamos el cargo en su cuenta ES91 2100 0418 4502 0005 1332.")) +
    p(r("Enviaremos la documentación a Calle Río Duero 17, 4.º C, 28029 Madrid.")) +
    p(r("Un saludo, Marta Iglesias Pardo (Departamento Legal).")) +
    "<w:tbl><w:tblPr><w:tblW w:w=\"0\" w:type=\"auto\"/></w:tblPr><w:tr>" + celda("Titular") + celda("Teléfono") + "</w:tr>" +
    "<w:tr>" + celda("Andrés Castillo Vega") + celda("612 345 678") + "</w:tr></w:tbl>" +
    p(r("Todos los datos de esta carta son inventados.")) +
    '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:body></w:document>';
  const tipos = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>';
  const rels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="' + REL + '/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="' + REL + '/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>';
  return escribirZip([{ nombre: "[Content_Types].xml", datos: Buffer.from(tipos) }, { nombre: "_rels/.rels", datos: Buffer.from(rels) },
    { nombre: "word/document.xml", datos: Buffer.from(doc) }]);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const destino = process.argv[2];
  if (!destino) {
    console.error("Uso: node scripts/crear-word-prueba.mjs <archivo.docx>");
    process.exit(1);
  }
  fs.writeFileSync(destino, crearCorreoCliente(), { flag: "wx" });
  console.error("Creado " + destino + " (ficticio)");
}
