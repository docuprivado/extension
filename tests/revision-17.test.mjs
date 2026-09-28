/*
 * Hito de actualización 17: los fallos que encontró la revisión de la extensión con otro
 * chat de Claude (28/09/2026), cada uno con su prueba, a través del servidor (como Claude).
 * Los del detector y del comparador de la web tienen además sus casos en la web
 * (tests/casos-detectores.js y tests/comparador/), que la extensión copia.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { arrancar } from "./cliente-mcp.mjs";
import { crearNominasMedicion } from "../scripts/crear-pruebas-finales.mjs";

const require = createRequire(import.meta.url);
const { PDFDocument, StandardFonts } = require("pdf-lib/dist/pdf-lib.min.js");
const RAIZ = fileURLToPath(new URL("..", import.meta.url));
const WEB = path.resolve(process.env.DOCUPRIVADO_WEB || path.join(RAIZ, "..", "WEB A"));
const CAPTURA = path.join(WEB, "tests", "fixtures", "captura-ficticia.png");

const base = fs.mkdtempSync(path.join(os.tmpdir(), "docuprivado-rev17-"));
const docs = path.join(base, "Pruebas");
fs.mkdirSync(path.join(docs, "Nominas"), { recursive: true });
let s;
const texto = (r) => (r.result ? r.result.content.map((c) => c.text).join("\n") : JSON.stringify(r.error));

async function pdf(paginas) {
  const doc = await PDFDocument.create();
  const f = await doc.embedFont(StandardFonts.Helvetica);
  for (const lineas of paginas) {
    const p = doc.addPage([595, 842]);
    lineas.forEach((l, i) => p.drawText(l, { x: 50, y: 780 - i * 16, size: 11, font: f }));
  }
  return Buffer.from(await doc.save());
}

before(async () => {
  const nominas = await crearNominasMedicion();
  for (const n of nominas.slice(0, 3)) fs.writeFileSync(path.join(docs, "Nominas", n.archivo), n.datos);
  // Texto (ficticio) con los casos del anonimizador que falló la revisión.
  fs.writeFileSync(path.join(docs, "carta.txt"), "Estimado Sr. Andrés Castillo: le confirmamos el cargo en su cuenta ES91 2100 0418 4502 0005 1332.\n" +
    "Enviaremos la documentación a Calle Río Duero 17, 4.º C, 28029 Madrid.\nUn saludo, Marta Iglesias Pardo (Departamento Legal).\nTitular\nAndrés Castillo Vega\nTeléfono\n612 345 678\n");
  // Un PDF con dos páginas casi en blanco («Página 1 de 3») y una con datos (ficticios).
  fs.writeFileSync(path.join(docs, "casi-en-blanco.pdf"), await pdf([["Página 1 de 3"], ["Página 2 de 3"],
    ["Página 3 de 3", "Nombre: Andrés Castillo Vega, con DNI 12345678Z y teléfono 612 345 678."]]));
  fs.writeFileSync(path.join(docs, "vacio.pdf"), "");
  if (fs.existsSync(CAPTURA)) fs.copyFileSync(CAPTURA, path.join(docs, "captura.png"));
  s = arrancar({ carpetas: [docs] });
  await s.iniciar();
});
after(async () => {
  await s.cerrar();
  fs.rmSync(base, { recursive: true, force: true });
});

test("anonimizar: «Un» no es un nombre, la forma larga del nombre entra entera y el punto tras el IBAN se queda", async () => {
  const r = await s.llamar("anonimizar_archivo", { ruta: "carta.txt", mostrar_texto: true });
  const t = r.result.structuredContent.texto;
  assert.match(t, /^Un saludo, \[PERSONA_\d\]/m, "«Un» no se toca: " + t);
  assert.ok(!/Vega/.test(t), "se ve el segundo apellido: " + t);
  assert.match(t, /\[IBAN_1\]\.\n/, "el punto final de la frase se queda fuera del IBAN");
  // Y la vuelta devuelve el texto exacto (sin «1332..»).
  const copia = s.largas(r.result.structuredContent).copia;
  const tabla = s.largas(r.result.structuredContent).tabla;
  const v = await s.llamar("restaurar_archivo", { ruta: copia, tabla });
  const restaurado = fs.readFileSync(s.largas(v.result.structuredContent).copia, "utf8");
  assert.ok(restaurado.includes("ES91 2100 0418 4502 0005 1332.\n"), restaurado);
  assert.ok(!restaurado.includes("1332.."));
});

test("comparar dos nóminas: fecha de nacimiento tapada, cambio de cuenta importante y la antigüedad (igual) no sale", async () => {
  const r = await s.llamar("comparar_documentos", { original: "nomina-01-septiembre-2026.pdf", nuevo: "nomina-02-septiembre-2026.pdf", control_de_cambios: false });
  const t = texto(r);
  const d = r.result.structuredContent;
  assert.ok(!t.includes("03/01/1978") && !t.includes("05/02/1979"), "fechas de nacimiento a la vista: " + t);
  assert.ok(d.importantes.some((c) => c.cambios.some((x) => x.que === "cuenta")), "el cambio de cuenta no es importante: " + t);
  assert.ok(!/ES80 ?2100|ES\d{2}(?: ?\d{4}){5}/.test(t.replace(/\*/g, "")), "una cuenta entera a la vista: " + t);
  assert.ok(!d.importantes.some((c) => c.cambios.some((x) => x.antes.includes("01/02/2019") || x.despues.includes("01/02/2019"))), "la antigüedad, igual en las dos, sale como cambio: " + t);
  assert.ok(d.importantes.some((c) => c.cambios.some((x) => x.que === "importe" && /1\.500,00/.test(x.antes))), "el salario sin «€» no es importante: " + t);
});

test("tachar una carpeta otra vez: sin opciones se salta y lo dice lo primero; con opciones se rehace", async () => {
  const r1 = await s.llamar("tachar_documentos", { rutas: ["Nominas"] });
  assert.equal(r1.result.structuredContent.copias.length, 3);
  const r2 = await s.llamar("tachar_documentos", { rutas: ["Nominas"] });
  assert.equal(r2.result.structuredContent.copias.length, 0);
  assert.match(texto(r2), /^No he tachado nada nuevo: he saltado 3 documentos/);
  assert.ok(!texto(r2).includes("Revisa las copias"), "no hay copias que revisar");
  const r3 = await s.llamar("tachar_documentos", { rutas: ["Nominas"], tipos: ["dni"] });
  assert.equal(r3.result.structuredContent.copias.length, 3, "con otras opciones se vuelven a tachar");
  assert.equal(r3.result.structuredContent.saltados.length, 0);
});

test("carpeta de resultados que no existe: se crea dentro de las autorizadas; fuera, no", async () => {
  const r = await s.llamar("tachar_documentos", { rutas: ["nomina-01-septiembre-2026.pdf"], carpeta_salida: "Pruebas/Resultados nuevos" });
  assert.ok(!r.result.isError, texto(r));
  assert.ok(fs.existsSync(path.join(docs, "Resultados nuevos", "nomina-01-septiembre-2026-tachado.pdf")));
  const fuera = await s.llamar("tachar_documentos", { rutas: ["nomina-01-septiembre-2026.pdf"], carpeta_salida: path.join(base, "fuera-nueva") });
  assert.ok(fuera.result.isError, "tenía que negarse");
  assert.ok(!fs.existsSync(path.join(base, "fuera-nueva")), "no crea nada fuera");
});

test("un PDF vacío se dice vacío; y las páginas casi en blanco sin imágenes no son escaneos", async () => {
  const r = await s.llamar("analizar_datos_personales", { rutas: ["vacio.pdf", "casi-en-blanco.pdf"] });
  const t = texto(r);
  assert.match(t, /«vacio\.pdf» está vacío \(0 bytes\)/);
  const a = r.result.structuredContent.archivos.find((x) => x.nombre === "casi-en-blanco.pdf");
  assert.deepEqual(a.paginasEscaneadas, [], "páginas en blanco leídas como escaneos");
  assert.ok(!a.avisos.some((x) => /escaneada/.test(x)), a.avisos.join("; "));
  assert.ok(a.porTipo.dni === 1 && a.porTipo.nombre >= 1);
});

test("copia del DNI con una captura que no es un documento: sin deformarla y avisando", { skip: !fs.existsSync(CAPTURA) && "falta la captura de prueba de la web" }, async () => {
  const r = await s.llamar("proteger_copia_dni", { delantera: "captura.png", texto_marca: "Solo para pruebas" });
  const d = r.result.structuredContent;
  assert.equal(d.caras[0].recorte, "sin_bordes");
  assert.ok(d.avisos.some((a) => /no parece un documento de identidad/.test(a)), "sin aviso: " + texto(r));
});

test("DNI tapado como recomienda la AEPD: solo las cifras 4.ª a 7.ª", async () => {
  const r = await s.llamar("analizar_datos_personales", { rutas: ["casi-en-blanco.pdf"], tipos: ["dni"], mostrar_valores: true });
  assert.match(texto(r), /\*\*\*4567\*\*/);
  assert.ok(!texto(r).includes("12345678Z"));
});
