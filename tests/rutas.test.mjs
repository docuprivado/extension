/*
 * Rutas seguras (docs/PROMPT_EXTENSION.md §4.2): «..», enlaces que apuntan fuera,
 * mayúsculas en Windows, otras unidades, rutas de red, tildes y espacios, nombres
 * reservados, accesos directos, límite de tamaño y copias que nunca sobrescriben.
 * Todo se crea en una carpeta temporal y se borra al terminar.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { prepararCarpetas, resolver, estaDentro, escribirSinSobrescribir, carpetaDeSalida, carpetaPedida, nombreLibre, ErrorRuta, MENSAJES } from "../server/core/rutas.js";

const WIN = process.platform === "win32";
// La carpeta temporal, por su nombre real, como trabaja la extensión: en macOS está detrás de
// un enlace (/var → /private/var) y en Windows puede venir con nombres cortos (RUNNER~1).
const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "docuprivado-rutas-")));
after(() => fs.rmSync(base, { recursive: true, force: true }));

const permitida = path.join(base, "Mis documentos");
const fuera = path.join(base, "fuera");
const escribir = (rel, contenido = "x") => {
  const r = path.join(base, rel);
  fs.mkdirSync(path.dirname(r), { recursive: true });
  fs.writeFileSync(r, contenido);
  return r;
};
escribir("Mis documentos/Nóminas 2026/nómina septiembre.pdf");
escribir("Mis documentos/contrato.PDF");
escribir("Mis documentos/sub/contrato.PDF");
escribir("Mis documentos/sub/profunda/única.pdf");
escribir("Mis documentos/acceso.lnk");
escribir("fuera/secreto.pdf", "SECRETO");
fs.mkdirSync(path.join(base, "Otra permitida"));
escribir("Otra permitida/foto (1).HEIC");

// Unión de carpetas (en Windows no necesita permisos de administrador) que apunta fuera.
let hayUnion = true;
try {
  fs.symlinkSync(fuera, path.join(permitida, "atajo"), WIN ? "junction" : "dir");
} catch {
  hayUnion = false;
}
// Enlace simbólico a un archivo de fuera (en Windows suele requerir permisos: si no, se salta).
let hayEnlace = true;
try {
  fs.symlinkSync(path.join(fuera, "secreto.pdf"), path.join(permitida, "enlace.pdf"), "file");
} catch {
  hayEnlace = false;
}

const ctx = prepararCarpetas([permitida, path.join(base, "Otra permitida"), path.join(base, "no-existe"), "${user_config.carpetas_permitidas}"], undefined);

// Para comprobar que las rutas de fuera se rechazan SIN tocar el disco.
function sinTocarDisco(fn) {
  const original = fs.realpathSync.native;
  const existe = fs.existsSync;
  const llamadas = [];
  fs.realpathSync.native = (p, ...r) => { llamadas.push(p); return original(p, ...r); };
  fs.existsSync = (p) => { llamadas.push(p); return existe(p); };
  try {
    fn();
  } finally {
    fs.realpathSync.native = original;
    fs.existsSync = existe;
  }
  return llamadas;
}

const esFuera = (err) => err instanceof ErrorRuta && err.codigo === "fuera";

test("las carpetas se preparan: sin duplicados, sin valores sin sustituir y con las no disponibles aparte", () => {
  assert.equal(ctx.permitidas.length, 2);
  assert.deepEqual(ctx.noDisponibles, [path.join(base, "no-existe")]);
  assert.equal(ctx.carpetaSalida, null);
});

test("ruta absoluta dentro, con tildes y espacios", () => {
  const r = resolver(ctx, path.join(permitida, "Nóminas 2026", "nómina septiembre.pdf"));
  assert.equal(path.basename(r.ruta), "nómina septiembre.pdf");
});

test("ruta relativa a una carpeta permitida y entre comillas", () => {
  const r = resolver(ctx, "\"Nóminas 2026" + path.sep + "nómina septiembre.pdf\"");
  assert.equal(path.basename(r.ruta), "nómina septiembre.pdf");
});

test("nombre suelto: se busca en las subcarpetas", () => {
  assert.equal(path.basename(resolver(ctx, "única.pdf").ruta), "única.pdf");
  assert.equal(path.basename(resolver(ctx, "foto (1).HEIC").ruta), "foto (1).HEIC");
});

test("nombre suelto repetido: pide que se precise y da la lista", () => {
  assert.throws(() => resolver(ctx, "contrato.PDF"), (e) => e.codigo === "varios" && e.extra.rutas.length === 2);
});

test("mayúsculas y minúsculas distintas (Windows y macOS)", { skip: !(WIN || process.platform === "darwin") }, () => {
  const r = resolver(ctx, path.join(permitida, "NÓMINAS 2026", "NÓMINA SEPTIEMBRE.PDF"));
  assert.match(r.ruta, /nómina septiembre\.pdf$/i);
});

test("«..» para salir de la carpeta: se rechaza", () => {
  assert.throws(() => resolver(ctx, ".." + path.sep + "fuera" + path.sep + "secreto.pdf"), esFuera);
  assert.throws(() => resolver(ctx, path.join(permitida, "..", "fuera", "secreto.pdf")), esFuera);
});

test("ruta absoluta fuera: se rechaza sin tocar el disco", () => {
  const llamadas = sinTocarDisco(() => assert.throws(() => resolver(ctx, path.join(fuera, "secreto.pdf")), esFuera));
  assert.deepEqual(llamadas, []);
});

test("otra unidad y ruta de red: se rechazan sin tocar el disco", { skip: !WIN }, () => {
  const llamadas = sinTocarDisco(() => {
    assert.throws(() => resolver(ctx, "Z:\\Documentos\\nomina.pdf"), esFuera);
    assert.throws(() => resolver(ctx, "\\\\servidor-malicioso\\compartida\\nomina.pdf"), esFuera);
    assert.throws(() => resolver(ctx, "//servidor-malicioso/compartida/nomina.pdf"), esFuera);
  });
  assert.deepEqual(llamadas, [], "no debe intentar abrir rutas de red ni de otras unidades");
});

test("rutas especiales de Windows, flujos alternativos y nombres reservados: no válidas", { skip: !WIN }, () => {
  for (const r of ["\\\\?\\C:\\Windows\\win.ini", "\\\\.\\PhysicalDrive0", "nómina septiembre.pdf:oculto", "CON", "nul.pdf", "Nóminas 2026\\aux", "C:nomina.pdf"]) {
    assert.throws(() => resolver(ctx, r), (e) => e instanceof ErrorRuta && ["nombre", "fuera"].includes(e.codigo), r);
  }
});

test("C:\\Windows\\win.ini (prueba negativa del prompt): se rechaza", { skip: !WIN }, () => {
  assert.throws(() => resolver(ctx, "C:\\Windows\\win.ini"), esFuera);
});

// En cualquier sistema. En macOS «C:\Windows» era un nombre y la extensión creaba una carpeta
// con ese nombre dentro de la autorizada (lo vieron las pruebas de GitHub, hito 8).
test("rutas de Windows en cualquier sistema: «C:\\Windows», la ruta de red y «..\\..» están fuera, y no se crea nada", () => {
  const una = prepararCarpetas([permitida]);
  const antes = fs.readdirSync(permitida).sort();
  for (const r of ["C:\\Windows\\win.ini", "\\\\servidor\\compartida\\a.pdf", "..\\fuera\\secreto.pdf"]) assert.throws(() => resolver(una, r), esFuera, r);
  for (const r of ["C:\\Windows", "\\\\servidor\\compartida", "..\\..", "..\\fuera"]) assert.throws(() => carpetaPedida(una, r), esFuera, r);
  assert.deepEqual(fs.readdirSync(permitida).sort(), antes, "no se ha creado ninguna carpeta");
  // La barra invertida separa carpetas también en macOS, como la escribe Claude por costumbre.
  assert.equal(path.basename(resolver(una, "Nóminas 2026\\nómina septiembre.pdf").ruta), "nómina septiembre.pdf");
});

test("unión de carpetas dentro que apunta fuera: se rechaza", { skip: !hayUnion && "no se pudo crear la unión" }, () => {
  assert.throws(() => resolver(ctx, path.join(permitida, "atajo", "secreto.pdf")), esFuera);
  assert.throws(() => resolver(ctx, "atajo" + path.sep + "secreto.pdf"), esFuera);
});

test("enlace simbólico a un archivo de fuera: se rechaza", { skip: !hayEnlace && "este Windows no deja crear enlaces sin permisos" }, () => {
  assert.throws(() => resolver(ctx, path.join(permitida, "enlace.pdf")), esFuera);
});

test("acceso directo (.lnk): no se sigue", () => {
  assert.throws(() => resolver(ctx, "acceso.lnk"), (e) => e.codigo === "accesoDirecto");
});

test("carpeta donde se esperaba un archivo, y al revés", () => {
  assert.throws(() => resolver(ctx, "sub"), (e) => e.codigo === "noExiste" || e.codigo === "noEsArchivo");
  assert.throws(() => resolver(ctx, path.join(permitida, "sub")), (e) => e.codigo === "noEsArchivo");
  assert.throws(() => resolver(ctx, path.join(permitida, "contrato.PDF"), { tipo: "carpeta" }), (e) => e.codigo === "noEsCarpeta");
  assert.equal(resolver(ctx, "sub", { tipo: "carpeta" }).esCarpeta, true);
});

test("archivo que no existe: mensaje claro", () => {
  assert.throws(() => resolver(ctx, "no-existe.pdf"), (e) => e.codigo === "noExiste" && /No encuentro/.test(e.message));
});

test("vacío o sin texto: no válido", () => {
  for (const r of ["", "   ", null, undefined]) assert.throws(() => resolver(ctx, r), (e) => e instanceof ErrorRuta);
});

test("archivo de más de 100 MB: error claro", () => {
  const grande = path.join(permitida, "grande.pdf");
  const fd = fs.openSync(grande, "w");
  fs.ftruncateSync(fd, 150 * 1024 * 1024);
  fs.closeSync(fd);
  try {
    assert.throws(() => resolver(ctx, grande), (e) => e.codigo === "demasiadoGrande" && e.message === MENSAJES.demasiadoGrande);
  } finally {
    fs.rmSync(grande);
  }
});

test("estaDentro: misma carpeta, subcarpeta, carpeta con nombre parecido", () => {
  assert.equal(estaDentro(permitida, permitida), true);
  assert.equal(estaDentro(path.join(permitida, "a", "b.pdf"), permitida), true);
  assert.equal(estaDentro(permitida + " 2" + path.sep + "x.pdf", permitida), false);
  assert.equal(estaDentro(path.join(permitida, "..foo", "x.pdf"), permitida), true);
});

test("copias: nunca sobrescribe, añade (2), (3)…", () => {
  const original = path.join(permitida, "Nóminas 2026", "nómina septiembre.pdf");
  const destino = carpetaDeSalida(ctx, original);
  assert.equal(path.basename(destino), "docuprivado");
  const a = escribirSinSobrescribir(ctx, destino, "nómina septiembre", "-tachado", ".pdf", "uno");
  const b = escribirSinSobrescribir(ctx, destino, "nómina septiembre", "-tachado", ".pdf", "dos");
  const c = escribirSinSobrescribir(ctx, destino, "nómina septiembre", "-tachado", ".pdf", "tres");
  assert.deepEqual([a, b, c].map((r) => path.basename(r)), ["nómina septiembre-tachado.pdf", "nómina septiembre-tachado (2).pdf", "nómina septiembre-tachado (3).pdf"]);
  assert.equal(fs.readFileSync(a, "utf8"), "uno", "el primero no se ha tocado");
  assert.equal(nombreLibre(destino, "nómina septiembre", "-tachado", ".pdf"), "nómina septiembre-tachado (4).pdf");
  assert.equal(fs.readFileSync(original, "utf8"), "x", "el original sigue igual");
});

test("copias: no se escribe fuera de las carpetas permitidas", () => {
  assert.throws(() => escribirSinSobrescribir(ctx, fuera, "x", "-tachado", ".pdf", "no"), (e) => e.codigo === "fuera");
  assert.equal(fs.existsSync(path.join(fuera, "x-tachado.pdf")), false);
});

test("copias: una carpeta «docuprivado» que es una unión hacia fuera no se usa", { skip: !hayUnion && "no se pudo crear la unión" }, () => {
  const carpeta = path.join(permitida, "sub", "profunda");
  fs.symlinkSync(fuera, path.join(carpeta, "docuprivado"), WIN ? "junction" : "dir");
  assert.throws(() => escribirSinSobrescribir(ctx, path.join(carpeta, "docuprivado"), "única", "-tachado", ".pdf", "no"), (e) => e.codigo === "fuera");
  assert.equal(fs.existsSync(path.join(fuera, "única-tachado.pdf")), false);
});

test("carpeta de resultados elegida: se usa si está dentro; si no, aviso", () => {
  const dentro = prepararCarpetas([permitida], path.join(permitida, "sub"));
  assert.match(dentro.carpetaSalida, /sub$/);
  const mala = prepararCarpetas([permitida], fuera);
  assert.equal(mala.carpetaSalida, null);
  assert.match(mala.avisoSalida, /no está dentro/);
  const sinSustituir = prepararCarpetas([permitida], "${user_config.carpeta_salida}");
  assert.equal(sinSustituir.carpetaSalida, null);
  assert.equal(sinSustituir.avisoSalida, null);
});

test("carpetas que Windows y macOS enseñan traducidas: «Descargas» es «Downloads»", () => {
  const usuario = path.join(base, "usuario");
  fs.mkdirSync(path.join(usuario, "Downloads"), { recursive: true });
  fs.mkdirSync(path.join(usuario, "Documents", "Alquiler"), { recursive: true });
  fs.writeFileSync(path.join(usuario, "Downloads", "recibo luz.pdf"), "x");
  fs.writeFileSync(path.join(usuario, "Documents", "Alquiler", "fianza.pdf"), "x");
  // Autorizada la propia carpeta Descargas.
  const soloDescargas = prepararCarpetas([path.join(usuario, "Downloads")]);
  assert.equal(path.basename(resolver(soloDescargas, "Descargas", { tipo: "carpeta" }).ruta), "Downloads");
  assert.equal(path.basename(resolver(soloDescargas, "Descargas" + path.sep + "recibo luz.pdf").ruta), "recibo luz.pdf");
  assert.equal(path.basename(resolver(soloDescargas, "Downloads", { tipo: "carpeta" }).ruta), "Downloads");
  // Autorizada la carpeta del usuario: «Documentos\Alquiler» está dentro.
  const todoElUsuario = prepararCarpetas([usuario]);
  assert.equal(path.basename(resolver(todoElUsuario, "Documentos" + path.sep + "Alquiler", { tipo: "carpeta" }).ruta), "Alquiler");
  assert.equal(path.basename(resolver(todoElUsuario, "Mis documentos" + path.sep + "Alquiler" + path.sep + "fianza.pdf").ruta), "fianza.pdf");
  assert.equal(path.basename(resolver(todoElUsuario, "descargas", { tipo: "carpeta" }).ruta), "Downloads");
  // Y sigue sin poder salir de las carpetas autorizadas.
  assert.throws(() => resolver(soloDescargas, "Documentos", { tipo: "carpeta" }), (e) => e.codigo === "noExiste");
});
