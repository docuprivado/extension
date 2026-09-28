/*
 * El servidor completo, arrancado como lo hace Claude Desktop y con la red bloqueada:
 * herramientas con título y anotaciones, respuestas correctas, parámetros inválidos,
 * rutas de fuera, privacidad de las respuestas (sin datos salvo que se pidan, y entonces
 * tapados), originales intactos, copias que no se pisan, nada por la salida estándar
 * salvo el protocolo y un registro sin nombres de carpetas ni de archivos.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { arrancar } from "./cliente-mcp.mjs";
import { fotosMotor } from "../server/core/motores.js";
import { crearCorreoCliente } from "../scripts/crear-word-prueba.mjs";

const RAIZ = fileURLToPath(new URL("..", import.meta.url));
const WEB = path.resolve(process.env.DOCUPRIVADO_WEB || path.join(RAIZ, "..", "WEB A"));
const NOMINA = path.join(WEB, "tests", "fixtures", "nomina-ficticia.pdf");
const hayWeb = fs.existsSync(NOMINA);
// Los datos (ficticios) de la nómina de prueba, según el tachador de la web.
const PARIDAD = JSON.parse(fs.readFileSync(new URL("paridad/web-tachador.json", import.meta.url), "utf8"));
const VALORES = PARIDAD.archivos["nomina-ficticia.pdf"].marcas.map((m) => m.valor).filter((v) => v.length >= 6);

// La carpeta temporal, por su nombre real, como trabaja la extensión: en macOS está detrás de

// un enlace (/var → /private/var) y en Windows puede venir con nombres cortos (RUNNER~1).

const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "docuprivado-servidor-")));
const docs = path.join(base, "Carpeta Secreta Ñandú");
const original = path.join(docs, "Alquiler", "nomina-confidencial-perez.pdf");
fs.mkdirSync(path.join(docs, "Alquiler"), { recursive: true });
if (hayWeb) fs.copyFileSync(NOMINA, original); else fs.writeFileSync(original, "x");
// Fotos de viaje (ficticias): dos con la ubicación y una sin nada; y una captura con datos.
const FOTOS = [["fotos/foto-gps.jpg", "playa-benidorm.jpg"], ["fotos/metadatos/iphone-gps.heic", "atardecer.heic"], ["fotos/metadatos/sin-datos.jpg", "sin-ubicacion.jpg"]];
fs.mkdirSync(path.join(docs, "Viaje"));
if (hayWeb) for (const [f, n] of FOTOS) fs.copyFileSync(path.join(WEB, "tests", "fixtures", f), path.join(docs, "Viaje", n));
if (hayWeb) fs.copyFileSync(path.join(WEB, "tests", "fixtures", "captura-ficticia.png"), path.join(docs, "Alquiler", "captura-casero.png"));
// Lo que dicen de verdad las fotos (ubicación, móvil…): nunca puede salir en la respuesta.
const DATOS_FOTOS = hayWeb ? FOTOS.flatMap(([f]) => fotosMotor().leerMetadatos(new Uint8Array(fs.readFileSync(path.join(WEB, "tests", "fixtures", f)))).campos
  .map((c) => c.valor).filter((v) => v.length >= 5 && !/^S[íi]/.test(v))) : [];
const huellasFotos = hayWeb ? FOTOS.map(([, n]) => huella0(path.join(docs, "Viaje", n))) : [];
function huella0(f) { return createHash("sha256").update(fs.readFileSync(f)).digest("hex"); }
// Un Word ficticio para anonimizar y la «respuesta de una IA» con etiquetas para restaurar.
fs.mkdirSync(path.join(docs, "Clientes"));
fs.writeFileSync(path.join(docs, "Clientes", "correo-cliente.docx"), crearCorreoCliente());
const DATOS_WORD = ["Juan Pérez García", "12345678Z", "612 345 678", "juan.perez@example.com", "X1234567L", "ES91 2100 0418 4502 0005 1332", "María López Sánchez"];
fs.mkdirSync(path.join(base, "fuera"));
fs.writeFileSync(path.join(base, "fuera", "otra.pdf"), "x");
const huella = (f) => createHash("sha256").update(fs.readFileSync(f)).digest("hex");
const huellaOriginal = huella(original);

let s;
let fin;
before(async () => {
  s = arrancar({ carpetas: [docs] });
  await s.iniciar();
});
after(async () => {
  if (!fin) fin = await s.cerrar();
  fs.rmSync(base, { recursive: true, force: true });
});
const texto = (r) => r.result.content.map((c) => c.text).join("\n");

test("inicio con un cliente del protocolo 2025-06-18 (como Claude Desktop)", () => {
  const ini = s.mensajes.find((m) => m.id === 1);
  assert.equal(ini.result.protocolVersion, "2025-06-18");
  assert.equal(ini.result.serverInfo.name, "docuprivado");
});

test("lista de herramientas: título, descripción y anotaciones explícitas en todas", async () => {
  const r = await s.pedir("tools/list", {});
  const nombres = r.result.tools.map((t) => t.name).sort();
  assert.deepEqual(nombres, ["analizar_datos_personales", "anonimizar_archivo", "ayuda_docuprivado", "comparar_documentos", "limpiar_metadatos_imagen", "listar_documentos", "proteger_copia_dni", "restaurar_archivo", "tachar_documentos"]);
  for (const t of r.result.tools) {
    assert.ok(t.title, t.name + " sin título");
    assert.ok(t.name.length < 64);
    assert.ok(t.description.length > 40, t.name + " con descripción corta");
    for (const k of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"]) assert.equal(typeof t.annotations[k], "boolean", t.name + " sin " + k);
    assert.equal(t.annotations.openWorldHint, false);
    assert.equal(t.annotations.destructiveHint, false, "ninguna herramienta destruye nada");
    if (t.outputSchema) assert.ok(!t.outputSchema.$schema || t.outputSchema.$schema.includes("2020-12"), "Claude Desktop solo admite JSON Schema 2020-12");
  }
  const tachar = r.result.tools.find((t) => t.name === "tachar_documentos");
  assert.equal(tachar.annotations.readOnlyHint, false, "tachar crea archivos");
});

test("ayuda: versión, carpetas autorizadas, ejemplos y enlace", async () => {
  const r = await s.llamar("ayuda_docuprivado", {});
  const d = s.largas(r.result.structuredContent);
  assert.equal(d.version, JSON.parse(fs.readFileSync(new URL("../manifest.json", import.meta.url), "utf8")).version);
  assert.deepEqual(d.carpetasAutorizadas, [docs]);
  assert.ok(d.ejemplos.length >= 4);
  assert.equal(d.enlace, "https://docuprivado.es/claude/");
  assert.match(texto(r), /no se conecta a internet/);
});

test("listar: encuentra por nombre en subcarpetas", async () => {
  const r = await s.llamar("listar_documentos", { buscar: "nómina" });
  assert.equal(r.result.isError, undefined);
  assert.equal(s.largas(r.result.structuredContent).total, 1);
  assert.match(texto(r), /nomina-confidencial-perez\.pdf/);
});

test("listar: una carpeta de fuera se rechaza con el mensaje de CLAUDE.md §7", async () => {
  const r = await s.llamar("listar_documentos", { carpeta: path.join(base, "fuera") });
  assert.equal(r.result.isError, true);
  assert.match(texto(r), /fuera de las carpetas que autorizaste.*Ajustes → Extensiones → docuprivado/);
});

test("analizar: cuenta los datos y NO los devuelve", { skip: !hayWeb }, async () => {
  const r = await s.llamar("analizar_datos_personales", { rutas: ["nomina-confidencial-perez.pdf"] });
  const d = s.largas(r.result.structuredContent);
  assert.equal(d.total, 25);
  assert.equal(d.archivos[0].valores, undefined);
  const todo = JSON.stringify(r.result);
  for (const v of VALORES) assert.ok(!todo.includes(v), "la respuesta no puede llevar el dato «" + v.slice(0, 3) + "…»");
});

test("analizar con mostrar_valores: tapados en parte, nunca enteros", { skip: !hayWeb }, async () => {
  const r = await s.llamar("analizar_datos_personales", { rutas: ["nomina-confidencial-perez.pdf"], mostrar_valores: true });
  const valores = s.largas(r.result.structuredContent).archivos[0].valores;
  assert.equal(valores.length, 25);
  assert.ok(valores.find((v) => v.tipo === "dni").valor === "***4567**");
  const todo = JSON.stringify(r.result);
  for (const v of VALORES) assert.ok(!todo.includes(v), "un dato entero en la respuesta: «" + v.slice(0, 3) + "…»");
});

test("tachar: copia nueva comprobada, original intacto, hoja de revisión y frase de revisar", { skip: !hayWeb }, async () => {
  const r = await s.llamar("tachar_documentos", { rutas: [original] });
  const d = s.largas(r.result.structuredContent);
  assert.equal(d.copias.length, 1);
  assert.equal(path.basename(d.copias[0].copia), "nomina-confidencial-perez-tachado.pdf");
  assert.equal(path.basename(path.dirname(d.copias[0].copia)), "docuprivado");
  assert.ok(fs.existsSync(d.copias[0].copia));
  assert.ok(fs.existsSync(d.hojaRevision));
  assert.equal(d.total, 25);
  assert.match(texto(r), /Revisa las copias antes de enviarlas: la detección automática ayuda, pero puede no encontrarlo todo\./);
  // Datos dudosos (mejora): se cuentan, se dicen y encabezan la hoja de revisión, tapados.
  assert.ok(d.copias[0].dudosos > 0);
  assert.match(texto(r), /dudosos? .*revísalos primero/);
  const hojaHtml = fs.readFileSync(d.hojaRevision, "utf8");
  assert.match(hojaHtml, /Revisa primero: \d+ datos? dudosos?/);
  assert.equal(huella(original), huellaOriginal, "el original no cambia");
  const todo = JSON.stringify(r.result) + fs.readFileSync(d.hojaRevision, "utf8");
  for (const v of VALORES) assert.ok(!todo.includes(v), "ni la respuesta ni la hoja pueden llevar datos");
});

test("tachar dos veces: la segunda copia no pisa la primera", { skip: !hayWeb }, async () => {
  const r = await s.llamar("tachar_documentos", { rutas: [original] });
  assert.equal(path.basename(s.largas(r.result.structuredContent).copias[0].copia), "nomina-confidencial-perez-tachado (2).pdf");
  const copias = fs.readdirSync(path.join(docs, "Alquiler", "docuprivado")).filter((f) => f.endsWith(".pdf"));
  assert.equal(copias.length, 2);
});

test("tachar la carpeta otra vez: salta lo ya tachado; con «repetir», lo vuelve a tachar", { skip: !hayWeb }, async () => {
  // La nómina ya está tachada: se salta. La captura (una foto) es nueva: se tacha.
  const r = await s.llamar("tachar_documentos", { rutas: ["Alquiler"] });
  const d = s.largas(r.result.structuredContent);
  assert.deepEqual(d.copias.map((c) => [path.basename(c.copia), c.tipo]), [["captura-casero-tachado.png", "imagen"]]);
  assert.equal(d.saltados.length, 1);
  assert.match(texto(r), /He saltado 1 documento que ya tenía una copia tachada más reciente que el original/);
  assert.match(texto(r), /He leído con el lector de texto 1 foto/);
  const r2 = await s.llamar("tachar_documentos", { rutas: ["Alquiler"], repetir: true });
  assert.deepEqual(s.largas(r2.result.structuredContent).copias.map((c) => path.basename(c.copia)).sort(), ["captura-casero-tachado (2).png", "nomina-confidencial-perez-tachado (3).pdf"]);
  // Si el original cambia después de la copia, se vuelve a tachar sin pedirlo.
  const ahora = new Date(Date.now() + 5000);
  fs.utimesSync(original, ahora, ahora);
  const r3 = await s.llamar("tachar_documentos", { rutas: ["Alquiler"] });
  assert.deepEqual(s.largas(r3.result.structuredContent).copias.map((c) => path.basename(c.original)), ["nomina-confidencial-perez.pdf"]);
  assert.equal(huella(original), huellaOriginal, "el original sigue igual (solo cambió su fecha)");
});

test("tachar una foto: copia PNG sin datos ocultos y la respuesta sin los datos", { skip: !hayWeb }, async () => {
  const captura = path.join(docs, "Alquiler", "captura-casero.png");
  const antes = huella0(captura);
  const r = await s.llamar("tachar_documentos", { rutas: ["captura-casero.png"], estilo: "pixelado" });
  const c = s.largas(r.result.structuredContent).copias[0];
  assert.equal(c.tipo, "imagen");
  assert.ok(c.datos >= 3, "teléfono, correo y DNI de la captura");
  assert.match(texto(r), /El pixelado queda más natural en una foto, pero la barra negra es la opción más segura/);
  assert.equal(fotosMotor().leerMetadatos(new Uint8Array(fs.readFileSync(c.copia))).hay, false);
  assert.equal(huella0(captura), antes, "el original no cambia");
  const todo = JSON.stringify(r.result);
  for (const v of ["612 345 678", "12345678", "example.com"]) assert.ok(!todo.includes(v), "la respuesta no lleva «" + v.slice(0, 3) + "…»");
});

test("quitar la ubicación de las fotos de una carpeta: cuántas la llevaban, sin decir dónde", { skip: !hayWeb }, async () => {
  const r = await s.llamar("limpiar_metadatos_imagen", { rutas: ["Viaje"] });
  const d = s.largas(r.result.structuredContent);
  assert.equal(d.total, 3);
  assert.equal(d.conUbicacion, 2);
  assert.match(texto(r), /^2 de 3 fotos llevaban la ubicación exacta de dónde se hicieron/);
  assert.deepEqual(d.copias.map((c) => path.basename(c.copia)).sort(), ["atardecer-sin-datos.jpg", "playa-benidorm-sin-datos.jpg", "sin-ubicacion-sin-datos.jpg"]);
  for (const c of d.copias) {
    assert.equal(path.basename(path.dirname(c.copia)), "docuprivado");
    assert.equal(fotosMotor().leerMetadatos(new Uint8Array(fs.readFileSync(c.copia))).hay, false, path.basename(c.copia) + " sigue con datos");
  }
  assert.equal(d.copias.find((c) => c.formato === "heic").sinPerdida, false, "la HEIC se rehace en JPG");
  assert.ok(d.copias.filter((c) => c.formato === "jpeg").every((c) => c.sinPerdida), "los JPG, sin volver a comprimir");
  const todo = JSON.stringify(r.result);
  assert.ok(DATOS_FOTOS.length >= 2);
  for (const v of DATOS_FOTOS) assert.ok(!todo.includes(v), "la respuesta no puede llevar lo que decía la foto («" + v.slice(0, 4) + "…»)");
  assert.deepEqual(FOTOS.map(([, n]) => huella0(path.join(docs, "Viaje", n))), huellasFotos, "los originales no cambian");
  // Otra vez: se saltan las que ya tienen copia; con «repetir», se hacen de nuevo.
  const r2 = await s.llamar("limpiar_metadatos_imagen", { rutas: ["Viaje"] });
  assert.equal(s.largas(r2.result.structuredContent).copias.length, 0);
  assert.equal(s.largas(r2.result.structuredContent).saltados.length, 3);
  const r3 = await s.llamar("limpiar_metadatos_imagen", { rutas: ["Viaje"], repetir: true });
  assert.ok(s.largas(r3.result.structuredContent).copias.every((c) => / \(2\)\.jpg$/.test(c.copia)));
  // Un PDF no es una foto: se explica qué usar.
  const r4 = await s.llamar("limpiar_metadatos_imagen", { rutas: [original] });
  assert.match(texto(r4), /es un PDF: esta herramienta es para fotos/);
});

test("tachar fuera de las carpetas: se niega y no escribe nada fuera", async () => {
  const r = await s.llamar("tachar_documentos", { rutas: [path.join(base, "fuera", "otra.pdf")] });
  assert.match(texto(r), /fuera de las carpetas que autorizaste/);
  assert.deepEqual(fs.readdirSync(path.join(base, "fuera")), ["otra.pdf"]);
  const r2 = await s.llamar("tachar_documentos", { rutas: ["Alquiler"], carpeta_salida: path.join(base, "fuera") });
  assert.equal(r2.result.isError, true);
  assert.deepEqual(fs.readdirSync(path.join(base, "fuera")), ["otra.pdf"]);
});

test("parámetros inválidos y vacíos: error, no un fallo del servidor", async () => {
  const malos = [
    ["listar_documentos", { tipos: ["exe"] }],
    ["listar_documentos", { recursivo: "sí" }],
    ["listar_documentos", { modificados_desde: "ayer" }],
    ["listar_documentos", { carpeta: "carpeta-que-no-existe" }],
    ["analizar_datos_personales", {}],
    ["analizar_datos_personales", { rutas: [] }],
    ["analizar_datos_personales", { rutas: ["x.pdf"], tipos: ["pasaporte"] }],
    ["tachar_documentos", { rutas: ["Alquiler"], estilo: "borroso" }],
    ["limpiar_metadatos_imagen", {}],
    ["limpiar_metadatos_imagen", { rutas: ["Alquiler"], recursivo: "sí" }],
    ["tachar_documentos", { rutas: ["Alquiler"], preset: "factura" }],
  ];
  for (const [nombre, args] of malos) {
    const r = await s.llamar(nombre, args);
    assert.equal(r.result.isError, true, nombre + " " + JSON.stringify(args));
  }
});

test("anonimizar un Word y restaurar la respuesta de la IA: los datos solo van en la tabla", async () => {
  const r = await s.llamar("anonimizar_archivo", { ruta: "correo-cliente.docx" });
  const d = s.largas(r.result.structuredContent);
  assert.equal(r.result.isError, undefined, texto(r));
  assert.equal(path.basename(d.copia), "correo-cliente-anonimo.docx");
  assert.equal(path.basename(d.tabla), "correo-cliente-tabla.json");
  assert.ok(d.datos >= 8);
  assert.match(texto(r), /La tabla contiene los datos reales: no la compartas con nadie ni se la pases a una IA\./);
  assert.match(texto(r), /Mantenlas exactamente igual en tu respuesta/);
  const todo = JSON.stringify(r.result);
  for (const v of DATOS_WORD) assert.ok(!todo.includes(v), "la respuesta no puede llevar «" + v.slice(0, 4) + "…»");
  const tabla = fs.readFileSync(d.tabla, "utf8");
  assert.ok(DATOS_WORD.every((v) => tabla.includes(v)), "la tabla sí los lleva");
  // Con mostrar_texto, el texto anónimo (sin los datos).
  const r2 = await s.llamar("anonimizar_archivo", { ruta: "correo-cliente.docx", mostrar_texto: true });
  assert.match(s.largas(r2.result.structuredContent).texto, /D\. \[PERSONA_1\] \(DNI \[DNI_1\]\)/);
  assert.equal(path.basename(s.largas(r2.result.structuredContent).copia), "correo-cliente-anonimo (2).docx", "no pisa la primera copia");
  for (const v of DATOS_WORD) assert.ok(!JSON.stringify(r2.result).includes(v));
  // La «respuesta de la IA», con etiquetas cambiadas por la IA y una que no existe.
  fs.writeFileSync(path.join(docs, "Clientes", "respuesta-ia.txt"), "Resumen: [PERSONA_1] (dni_1) alquila a [persona_2]. Revisar [PERSONA_9].\n");
  const r3 = await s.llamar("restaurar_archivo", { ruta: "respuesta-ia.txt", tabla: d.tabla });
  const d3 = s.largas(r3.result.structuredContent);
  assert.equal(d3.restauradas, 3);
  assert.deepEqual(d3.desconocidas, ["PERSONA_9"]);
  assert.equal(fs.readFileSync(d3.copia, "utf8"), "Resumen: Juan Pérez García (12345678Z) alquila a María López Sánchez. Revisar [PERSONA_9].\n");
  for (const v of DATOS_WORD) assert.ok(!JSON.stringify(r3.result).includes(v), "restaurar no devuelve los datos");
  // Un PDF no se anonimiza: se explica qué usar.
  const r4 = await s.llamar("anonimizar_archivo", { ruta: original });
  assert.match(texto(r4), /es un PDF: .*estilo «etiqueta»/);
});

test("anonimizar una carpeta entera con una sola tabla (un expediente)", async () => {
  const exp = path.join(docs, "Expediente García");
  fs.mkdirSync(exp);
  fs.writeFileSync(path.join(exp, "correo.docx"), crearCorreoCliente());
  fs.writeFileSync(path.join(exp, "notas.txt"), "Llamar a juan pérez garcía (DNI 12345678Z) el lunes.\n");
  if (hayWeb) fs.copyFileSync(NOMINA, path.join(exp, "nomina.pdf"));
  const r = await s.llamar("anonimizar_archivo", { rutas: ["Expediente García"] });
  const d = s.largas(r.result.structuredContent);
  assert.equal(r.result.isError, undefined, texto(r));
  assert.deepEqual(d.copias.map((c) => path.basename(c.copia)).sort(), ["correo-anonimo.docx", "notas-anonimo.txt"]);
  assert.equal(path.basename(d.tabla), "Expediente García-tabla.json");
  assert.match(texto(r), /He anonimizado 2 documentos con una sola tabla, así que la misma persona lleva la misma etiqueta en todos/);
  assert.equal(fs.readFileSync(d.copias.find((c) => /notas/.test(c.copia)).copia, "utf8"), "Llamar a [PERSONA_1] (DNI [DNI_1]) el lunes.\n");
  assert.doesNotMatch(texto(r), /nomina\.pdf/, "el PDF de la carpeta se deja estar, sin avisos");
  for (const v of DATOS_WORD) assert.ok(!JSON.stringify(r.result).includes(v));
});

test("rutas cortas: ninguna respuesta lleva la carpeta del usuario ni la ruta completa de la carpeta autorizada", async () => {
  const r = await s.llamar("ayuda_docuprivado", {});
  // Dentro de la carpeta del usuario (Windows) o en la carpeta temporal del sistema (macOS).
  assert.match(r.result.content[0].text, /Carpetas que puede usar: «Carpeta Secreta Ñandú» \(en .+\)\./);
  // Todas las respuestas de este archivo, tal como le llegan a Claude (texto y datos).
  const respuestas = s.mensajes.filter((m) => m.id && (m.result || m.error) && !(m.result && m.result.protocolVersion));
  assert.ok(respuestas.length > 20, "pocas respuestas: " + respuestas.length);
  const prohibidos = [os.homedir(), base, docs].map((p) => p.toLowerCase());
  for (const m of respuestas) {
    const j = JSON.stringify(m.result || m.error).toLowerCase().replace(/\\\\/g, "\\");
    for (const p of prohibidos) assert.ok(!j.includes(p) && !j.includes(p.replace(/\\/g, "/")), "una respuesta lleva «" + p + "»: " + j.slice(0, 300));
  }
  // Y una ruta corta de una respuesta vale tal cual en otra herramienta.
  const lista = await s.llamar("listar_documentos", { buscar: "nomina-confidencial" });
  const corta = lista.result.structuredContent.documentos.find((d) => path.basename(d.ruta) === "nomina-confidencial-perez.pdf").ruta;
  assert.ok(corta.startsWith("Carpeta Secreta Ñandú" + path.sep), corta);
  const a = await s.llamar("analizar_datos_personales", { rutas: [corta] });
  assert.ok(!a.result.isError && a.result.structuredContent.archivos.length === 1);
});

test("salida estándar limpia, sin conexiones y registro sin rutas, nombres ni datos", async () => {
  fin = await s.cerrar();
  assert.deepEqual(fin.lineasMalas, [], "todo lo que sale por la salida estándar tiene que ser del protocolo");
  assert.match(fin.stderr, /ningún intento de conexión/);
  assert.doesNotMatch(fin.stderr, /Ñandú|Secreta|nomina-confidencial|perez|Alquiler|Viaje|playa|benidorm|atardecer|casero|Clientes|correo-cliente|respuesta-ia|Expediente|notas/i, "el registro no puede llevar nombres de carpetas ni de archivos");
  for (const v of VALORES.concat(DATOS_FOTOS, DATOS_WORD)) assert.ok(!fin.stderr.includes(v), "el registro no puede llevar datos");
  assert.match(fin.stderr, /\[docuprivado\] versión .* · Node /);
});
