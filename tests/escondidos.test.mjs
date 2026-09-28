/*
 * «Tachado falso» (hito de actualización 18 de la web, la sugerencia de la revisión): datos
 * que están en el texto de un PDF pero no se ven (debajo de un recuadro negro, del color del
 * fondo o en letra diminuta). La regla es la de la web (js/tachador-reglas.js, escondido), y
 * aquí se prueba a través del servidor, como Claude. Y la carta de la revisión en Word.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { arrancar } from "./cliente-mcp.mjs";
import { reglas } from "../server/core/motores.js";
import { crearDatosEscondidos, crearNominasMedicion } from "../scripts/crear-pruebas-finales.mjs";
import { crearCartaRevision } from "../scripts/crear-word-prueba.mjs";

const RAIZ = fileURLToPath(new URL("..", import.meta.url));
const WEB = path.resolve(process.env.DOCUPRIVADO_WEB || path.join(RAIZ, "..", "WEB A"));
const FIX = path.join(WEB, "tests", "fixtures");
const base = fs.mkdtempSync(path.join(os.tmpdir(), "docuprivado-escondidos-"));
const docs = path.join(base, "Pruebas");
fs.mkdirSync(docs, { recursive: true });
let s;
const texto = (r) => r.result.content.map((c) => c.text).join("\n");

before(async () => {
  fs.writeFileSync(path.join(docs, "datos-escondidos.pdf"), await crearDatosEscondidos());
  fs.writeFileSync(path.join(docs, "carta-cliente.docx"), crearCartaRevision());
  fs.writeFileSync(path.join(docs, "nomina.pdf"), (await crearNominasMedicion())[0].datos);
  for (const f of ["nomina-ficticia.pdf", "contrato-ficticio.pdf", "contrato-letra-pequena.pdf", "formulario-ficticio.pdf"]) {
    if (fs.existsSync(path.join(FIX, f))) fs.copyFileSync(path.join(FIX, f), path.join(docs, f));
  }
  s = arrancar({ carpetas: [docs] });
  await s.iniciar();
});
after(async () => {
  await s.cerrar();
  fs.rmSync(base, { recursive: true, force: true });
});

test("la regla: tono uniforme oscuro (tapado), uniforme claro (invisible), letras a la vista (null) y letra diminuta", () => {
  const R = reglas();
  const imagen = (fn, ancho = 100, alto = 40) => {
    const datos = new Uint8Array(ancho * alto * 4);
    for (let y = 0; y < alto; y++) for (let x = 0; x < ancho; x++) datos.set(fn(x, y), (y * ancho + x) * 4);
    return { datos, ancho, alto };
  };
  const rect = { x: 10, y: 5, w: 80, h: 30 };
  assert.equal(R.escondido(imagen(() => [0, 0, 0, 255]), rect, 11), "tapado");
  assert.equal(R.escondido(imagen(() => [255, 255, 255, 255]), rect, 11), "invisible");
  assert.equal(R.escondido(imagen((x) => (x % 6 < 2 ? [0, 0, 0, 255] : [255, 255, 255, 255])), rect, 11), null);
  assert.equal(R.escondido(imagen((x) => (x % 6 < 2 ? [0, 0, 0, 255] : [255, 255, 255, 255])), rect, 1), "diminuto");
  // Con fila y principio distintos (el mapa de bits de PDFium, BGRA con relleno al final).
  const px = imagen(() => [255, 255, 255, 255], 110, 40);
  assert.equal(R.escondido({ datos: px.datos, ancho: 100, alto: 40, fila: 110 * 4, inicio: 0 }, rect, 11), "invisible");
});

test("analizar: el DNI en blanco, el IBAN debajo de un recuadro y el correo diminuto salen como escondidos", async () => {
  const r = await s.llamar("analizar_datos_personales", { rutas: ["datos-escondidos.pdf"], mostrar_valores: true });
  const a = r.result.structuredContent.archivos[0];
  assert.equal(a.escondidos, 3);
  const escondidos = a.valores.filter((v) => v.escondido).map((v) => v.tipo + ": " + v.escondido).sort();
  assert.deepEqual(escondidos, ["dni: invisible", "email: diminuto", "iban: tapado"]);
  assert.ok(a.valores.filter((v) => !v.escondido).map((v) => v.tipo).sort().join() === "nombre,telefono", "lo que se ve no es escondido");
  assert.match(texto(r), /tiene 3 datos escondidos \(debajo de un recuadro negro, del color del fondo o en letra diminuta\): no se ven, pero cualquiera puede copiarlos del PDF original/);
});

test("tachar: lo dice, y la copia no lleva ni rastro", async () => {
  const r = await s.llamar("tachar_documentos", { rutas: ["datos-escondidos.pdf"] });
  const c = r.result.structuredContent.copias[0];
  assert.equal(c.escondidos, 3);
  assert.match(texto(r), /En la copia tachada ya no están/);
  const copia = fs.readFileSync(s.largas(r.result.structuredContent).copias[0].copia);
  for (const v of ["12345678Z", "1332", "example.com"]) assert.ok(!copia.includes(v), "la copia lleva " + v);
});

test("sin falsas alarmas en los documentos de prueba normales", async () => {
  const nombres = fs.readdirSync(docs).filter((f) => f.endsWith(".pdf") && f !== "datos-escondidos.pdf");
  const r = await s.llamar("analizar_datos_personales", { rutas: nombres });
  for (const a of r.result.structuredContent.archivos) assert.equal(a.escondidos, 0, a.nombre + ": " + a.avisos.join("; "));
  assert.ok(!/escondido/.test(texto(r)));
});

test("la carta de la revisión en Word: «Un saludo» intacto y el nombre de la tabla entero", async () => {
  const r = await s.llamar("anonimizar_archivo", { ruta: "carta-cliente.docx", mostrar_texto: true });
  const t = r.result.structuredContent.texto;
  assert.match(t, /^Un saludo, \[PERSONA_\d\]/m);
  assert.ok(!/Vega|Castillo/.test(t), t);
  assert.match(t, /\[IBAN_1\]\./);
});
