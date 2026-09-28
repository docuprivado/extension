/*
 * Crea un formulario rellenable FICTICIO para las pruebas de los campos de formulario
 * (mejora aprobada por el titular el 27/09/2026): texto normal con un DNI inventado y campos
 * rellenos con un nombre, un DNI, una cuenta, una localidad (que no se tacha), un nombre
 * sin apellidos que el detector no conoce («Xiana», se tacha por el nombre del campo) y una
 * casilla. Todos los datos son inventados (el DNI 12345678Z es el de prueba de siempre).
 *
 *   node scripts/crear-formulario-prueba.mjs <ruta de salida.pdf>
 *
 * Con él se hizo ../WEB A/tests/fixtures/formulario-ficticio.pdf (anotado en su FUENTES.md).
 */
import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { PDFDocument, StandardFonts } = require("pdf-lib/dist/pdf-lib.min.js");

const salida = process.argv[2];
if (!salida) {
  console.error("Uso: node scripts/crear-formulario-prueba.mjs <ruta de salida.pdf>");
  process.exit(1);
}
const doc = await PDFDocument.create({ updateMetadata: false });
doc.setTitle("Formulario de prueba (ficticio)");
const font = await doc.embedFont(StandardFonts.Helvetica);
const page = doc.addPage([595, 842]);
page.drawText("Solicitud de prueba (documento ficticio)", { x: 60, y: 780, size: 14, font });
page.drawText("Expediente del solicitante con DNI 11111111H.", { x: 60, y: 750, size: 11, font });
const rotulos = [["Nombre y apellidos:", 720], ["DNI:", 690], ["Cuenta:", 660], ["Localidad:", 630], ["Nombre del hijo:", 600]];
for (const [t, y] of rotulos) page.drawText(t, { x: 60, y, size: 11, font });
const form = doc.getForm();
const campos = [["nombre_solicitante", "Juan Pérez García", 715], ["dni", "12345678Z", 685], ["cuenta_iban", "ES91 2100 0418 4502 0005 1332", 655],
  ["localidad", "Madrid", 625], ["nombre_hijo", "Xiana", 595]];
for (const [nombre, valor, y] of campos) {
  const f = form.createTextField(nombre);
  f.setText(valor);
  f.addToPage(page, { x: 180, y: y - 4, width: 300, height: 18, font });
}
form.createCheckBox("acepto").addToPage(page, { x: 60, y: 560, width: 12, height: 12 });
page.drawText("Acepto las condiciones", { x: 80, y: 562, size: 10, font });
fs.writeFileSync(salida, await doc.save());
console.error("Formulario ficticio creado: " + salida);
