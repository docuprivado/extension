/*
 * Tachado de escaneados y fotos (docs/PROMPT_EXTENSION.md §8.1): con
 * contrato-escaneado.pdf y captura-ficticia.png de la web, cada dato que la detección
 * encuentra con seguridad desaparece del resultado. Se comprueba volviendo a leer la copia
 * con el mismo lector: ninguno de esos datos se puede leer.
 * Además: el PDF resultante no tiene texto; las fotos salen derechas, en su formato, sin
 * datos ocultos; los estilos «etiqueta» y «pixelado»; los formatos (WebP, HEIC, CMYK,
 * PNG de 16 bits…) y las fotos muy grandes (a 3000 px, como la web).
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import "../server/core/salida-segura.js";
import { opcionesDeteccion } from "../server/core/deteccion.js";
import { abrir, comprobarSinTexto, detectar, leerTextos } from "../server/core/documento-pdf.js";
import { abrirFoto, formatoDe, metadatos, orientar, repararJpeg } from "../server/core/imagenes.js";
import { leerTexto } from "../server/core/escaneos.js";
import { cerrarLector } from "../server/core/lector.js";
import { analizarImagen, tacharImagen } from "../server/core/proceso-imagen.js";
import { analizarPdf, tacharPdf } from "../server/core/proceso-pdf.js";
import { prepararCarpetas } from "../server/core/rutas.js";

const RAIZ = fileURLToPath(new URL("..", import.meta.url));
const WEB = path.resolve(process.env.DOCUPRIVADO_WEB || path.join(RAIZ, "..", "WEB A"));
const F = path.join(WEB, "tests", "fixtures");
const hayWeb = fs.existsSync(path.join(F, "contrato-escaneado.pdf"));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "docuprivado-escaneados-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
after(() => cerrarLector());
const ctx = prepararCarpetas([tmp]);
const det = opcionesDeteccion({});

function copiar(rel, nombre) {
  const d = path.join(tmp, nombre || path.basename(rel));
  fs.copyFileSync(path.join(F, rel), d);
  const st = fs.statSync(d);
  return { ruta: d, nombre: path.basename(d), bytes: st.size, modificado: st.mtimeMs + Math.random(), tipo: /\.pdf$/i.test(d) ? "pdf" : "imagen" };
}
// Letras y números seguidos, sin espacios ni signos, en minúsculas: «ES91 2100…» → «es912100…».
const compacto = (s) => String(s).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");

test("escaneado: se lee, se tacha y en la copia ya no se puede leer ningún dato seguro", { skip: !hayWeb }, async () => {
  const a = copiar("contrato-escaneado.pdf");
  const antes = await analizarPdf(a, det);
  assert.deepEqual(antes.escaneadas, [1, 2, 3]);
  const tipos = new Set(antes.marcas.map((m) => m.tipo));
  for (const t of ["dni", "nie", "iban", "telefono", "nombre"]) assert.ok(tipos.has(t), "encuentra " + t);
  const r = await tacharPdf(ctx, a, det, { estilo: "negro", calidad: "normal" });
  assert.equal(r.escaneadas.length, 3);
  assert.equal(r.datos, antes.marcas.length);
  // La copia: sin texto, con las mismas páginas.
  const bytes = fs.readFileSync(r.copia);
  assert.deepEqual(await comprobarSinTexto(bytes, 3, antes.marcas.map((m) => m.valor)), []);
  // Se vuelve a leer la copia (es toda imagen): ningún dato seguro se puede leer.
  const d = await abrir(r.copia, "copia");
  try {
    const paginas = await leerTextos(d);
    assert.ok(paginas.every((p) => p.ocr), "la copia es imagen: se lee con el lector");
    const leido = compacto(paginas.map((p) => p.texto).join("\n"));
    assert.ok(leido.length > 1000, "el resto del contrato se sigue leyendo");
    const seguros = antes.marcas.filter((m) => m.confianza === "alta" && compacto(m.valor).length >= 6);
    assert.ok(seguros.length >= 8);
    for (const m of seguros) assert.ok(!leido.includes(compacto(m.valor)), "en la copia se lee aún un dato: " + m.tipo);
    detectar(paginas, det);
    const quedan = paginas.flatMap((p) => p.marcas).filter((m) => ["dni", "nie", "iban", "telefono"].includes(m.tipo));
    assert.deepEqual(quedan.map((m) => m.tipo), [], "el detector no encuentra ni DNI, ni NIE, ni IBAN, ni teléfonos en la copia");
    // Hito de actualización 19 de la web: la dirección con piso y puerta («3.º B», que el
    // lector lee «3.? B») y el correo leído con un espacio («maria .lopez…») se tapan
    // enteros, aunque su confianza sea media. Antes quedaban «3.º B, 28013 Madrid» y «maria».
    const entre = (desde, hasta) => {
      const i = leido.indexOf(compacto(desde));
      const f = leido.indexOf(compacto(hasta), i);
      assert.ok(i >= 0 && f > i, "en la copia se leen «" + desde + "» y «" + hasta + "»");
      return leido.slice(i + compacto(desde).length, f);
    };
    const domicilio = entre("domicilio", "adelante");
    assert.ok(!/madrid|28013|ejemplo/.test(domicilio), "en la copia se lee aún algo de la dirección: " + domicilio);
    const correo = entre("electrónico", "adelante");
    assert.ok(!/maria|lopez|example/.test(correo), "en la copia se lee aún algo del correo: " + correo);
  } finally {
    await d.cerrar();
  }
});

test("escaneado: la dirección con piso y puerta y el correo se detectan enteros (hito de actualización 19 de la web)", { skip: !hayWeb }, async () => {
  const a = copiar("contrato-escaneado.pdf", "contrato-escaneado-19.pdf");
  const r = await analizarPdf(a, det);
  const de = (tipo) => r.marcas.filter((m) => m.tipo === tipo).map((m) => m.valor.replace(/\s+/g, " "));
  assert.ok(de("direccion").some((v) => /^Calle del Ejemplo 12, 3\.\S? ?B, 28013 Madrid$/.test(v)), "la primera dirección entera: " + de("direccion").join(" / "));
  assert.ok(de("direccion").some((v) => /^Avenida de la Prueba 45, 2\S* A, 28080 Madrid$/.test(v)), "la segunda dirección entera: " + de("direccion").join(" / "));
  assert.ok(de("email").some((v) => /^maria ?\. ?lopez\S+example\.com$/.test(v)), "el correo entero: " + de("email").join(" / "));
});

test("captura (PNG): copia PNG del mismo tamaño, sin datos ocultos y sin los datos a la vista", { skip: !hayWeb }, async () => {
  const a = copiar("captura-ficticia.png");
  const antes = await analizarImagen(a, det);
  assert.ok(antes.marcas.length >= 3);
  const r = await tacharImagen(ctx, a, det, { estilo: "negro", calidad: "normal" });
  assert.equal(path.extname(r.copia), ".png");
  const salida = new Uint8Array(fs.readFileSync(r.copia));
  assert.equal(formatoDe(salida), "png");
  assert.equal(metadatos(salida).hay, false);
  const o = await abrirFoto(new Uint8Array(fs.readFileSync(a.ruta)), "o", 1e9);
  const s = await abrirFoto(salida, "s", 1e9);
  assert.deepEqual([s.img.width, s.img.height], [o.img.width, o.img.height]);
  const despues = await analizarImagen({ ...a, ruta: r.copia, nombre: "copia.png", modificado: Math.random() }, det);
  const leido = despues.marcas.map((m) => compacto(m.valor));
  for (const m of antes.marcas.filter((x) => compacto(x.valor).length >= 6)) assert.ok(!leido.includes(compacto(m.valor)), "en la copia se lee aún un dato: " + m.tipo);
});

test("cobertura en fotos: si tras el dato solo quedan signos («12345678Z.»), la palabra entera queda bajo la barra", { skip: !hayWeb }, async () => {
  // Hito de actualización 11 de la web: antes asomaba media Z del DNI de la captura.
  const a = copiar("captura-ficticia.png", "captura-cobertura.png");
  const r = await tacharImagen(ctx, a, det, { estilo: "negro", calidad: "normal", conRects: true });
  const barras = r.miniaturas[0].rects;
  const foto = await abrirFoto(new Uint8Array(fs.readFileSync(a.ruta)), a.nombre, 3000);
  const leido = await leerTexto(foto.img, 1, null);
  const pagina = { num: 1, texto: leido.texto, items: leido.items, ocr: true, campos: [], avisos: [] };
  detectar([pagina], det);
  let palabrasEnteras = 0;
  for (const m of pagina.marcas) {
    for (const e of pagina.items) {
      if (e.fin <= m.inicio || e.inicio >= m.fin) continue;
      const resto = pagina.texto.slice(Math.max(m.fin, e.inicio), e.fin);
      if (/[0-9A-Za-zÀ-ÿ]/.test(resto)) continue;
      palabrasEnteras++;
      const dentro = barras.some((b) => b.x <= e.rect.x + 0.5 && b.y <= e.rect.y + 0.5 && b.x + b.w >= e.rect.x + e.rect.w - 0.5 && b.y + b.h >= e.rect.y + e.rect.h - 0.5);
      assert.ok(dentro, m.tipo + ": la palabra «" + pagina.texto.slice(e.inicio, e.fin).replace(/[0-9A-Za-z]/g, "*") + "» no queda entera bajo la barra");
    }
  }
  assert.ok(palabrasEnteras >= 3, "teléfono, correo y DNI");
});

test("foto girada (EXIF 6): se lee y se guarda derecha, en JPG, sin EXIF", { skip: !hayWeb }, async () => {
  const a = copiar("foto-exif-rotada.jpg");
  const r = await tacharImagen(ctx, a, det, { estilo: "negro", calidad: "alta" });
  const salida = new Uint8Array(fs.readFileSync(r.copia));
  assert.equal(path.extname(r.copia), ".jpg");
  assert.deepEqual(restosJpeg(salida), []);
  const s = await abrirFoto(salida, "s", 1e9);
  assert.deepEqual([s.img.width, s.img.height], [1200, 900], "apaisada, como se ve");
  assert.ok(r.datos >= 1, "encuentra el DNI de la foto");
});

// Sin EXIF ni otros bloques: solo JFIF y los de la imagen.
function restosJpeg(b) {
  const mal = [];
  for (let i = 2; i + 4 <= b.length;) {
    if (b[i] !== 0xff) break;
    const m = b[i + 1];
    if (m === 0xda) break;
    if (m >= 0xe1 && m <= 0xef) mal.push("APP" + (m - 0xe0));
    if (m === 0xfe) mal.push("comentario");
    i += 2 + ((b[i + 2] << 8) | b[i + 3]);
  }
  return mal;
}

test("estilos en fotos: «etiqueta» escribe el tipo en blanco dentro de la barra; «pixelado» no deja la zona en negro", { skip: !hayWeb }, async () => {
  const a = copiar("captura-ficticia.png", "captura-etiqueta.png");
  const r = await tacharImagen(ctx, a, det, { estilo: "etiqueta", calidad: "normal", conRects: true });
  const s = await abrirFoto(new Uint8Array(fs.readFileSync(r.copia)), "s", 1e9);
  const barra = r.miniaturas[0].rects.sort((x, y) => y.w * y.h - x.w * x.h)[0];
  let blancos = 0, negros = 0;
  for (let y = Math.ceil(barra.y); y < barra.y + barra.h - 1; y++) for (let x = Math.ceil(barra.x); x < barra.x + barra.w - 1; x++) {
    const o = (y * s.img.width + x) * 4;
    const v = s.img.data[o] + s.img.data[o + 1] + s.img.data[o + 2];
    if (v > 600) blancos++; else if (v < 60) negros++;
  }
  assert.ok(blancos > 20 && negros > blancos, "rótulo blanco sobre negro (" + blancos + " blancos, " + negros + " negros)");

  const b = copiar("captura-ficticia.png", "captura-pixelado.png");
  const r2 = await tacharImagen(ctx, b, det, { estilo: "pixelado", calidad: "normal", conRects: true });
  const s2 = await abrirFoto(new Uint8Array(fs.readFileSync(r2.copia)), "s", 1e9);
  const z = r2.miniaturas[0].rects[0];
  const colores = new Set();
  for (let y = Math.ceil(z.y); y < z.y + z.h - 1; y++) for (let x = Math.ceil(z.x); x < z.x + z.w - 1; x++) {
    const o = (y * s2.img.width + x) * 4;
    colores.add(s2.img.data[o] + "," + s2.img.data[o + 1] + "," + s2.img.data[o + 2]);
  }
  assert.ok(colores.size >= 2 && colores.size < 60, "bloques de color, no una barra negra ni la imagen original (" + colores.size + " colores)");
});

test("formatos: WebP, HEIC, CMYK, PNG de 16 bits y de paleta, JPG con bytes sueltos; y fotos enormes a 3000 px", { skip: !hayWeb }, async () => {
  const M = path.join(F, "fotos", "metadatos");
  for (const [f, w, h] of [["webp-datos.webp", null, null], ["iphone-gps.heic", null, null], ["cmyk.jpg", 800, 600], ["png-16bits.png", null, null],
    ["png-paleta.png", null, null], ["relleno-entre-bloques.jpg", null, null], ["diminuta.jpg", 16, 16]]) {
    const foto = await abrirFoto(new Uint8Array(fs.readFileSync(path.join(M, f))), f, 3000);
    assert.ok(foto.img.width > 0 && foto.img.height > 0, f);
    if (w) assert.deepEqual([foto.img.width, foto.img.height], [w, h], f);
    // Que no salga negra ni vacía: algo de variación.
    const muestra = new Set();
    const paso = 4 * Math.max(1, Math.floor(foto.img.width * foto.img.height / 500));
    for (let i = 0; i < foto.img.data.length; i += paso) muestra.add(foto.img.data[i] >> 4);
    assert.ok(muestra.size > 2, f + " parece vacía");
  }
  assert.equal(repararJpeg(new Uint8Array(fs.readFileSync(path.join(M, "relleno-entre-bloques.jpg")))).length, fs.statSync(path.join(M, "relleno-entre-bloques.jpg")).size - 4);
  const enorme = await abrirFoto(new Uint8Array(fs.readFileSync(path.join(M, "enorme-48mpx.jpg"))), "enorme", 3000);
  assert.equal(enorme.reducida, true);
  assert.deepEqual([enorme.img.width, enorme.img.height, enorme.anchoReal], [3000, 2250, 8000]);
  // No es una foto: error claro.
  await assert.rejects(abrirFoto(new Uint8Array(fs.readFileSync(path.join(M, "animada.gif"))), "animada.gif", 3000), (e) => e.codigo === "formato" && /GIF/.test(e.message));
  await assert.rejects(abrirFoto(new Uint8Array(fs.readFileSync(path.join(M, "no-es-una-foto.jpg"))), "x.jpg", 3000), (e) => e.codigo === "danado");
});

test("orientar: las 8 orientaciones EXIF dan la misma foto derecha", { skip: !hayWeb }, async () => {
  const M = path.join(F, "fotos", "metadatos");
  const ref = await abrirFoto(new Uint8Array(fs.readFileSync(path.join(M, "referencia-derecha.png"))), "ref", 1e9);
  for (let o = 1; o <= 8; o++) {
    const foto = await abrirFoto(new Uint8Array(fs.readFileSync(path.join(M, "orientacion-" + o + ".jpg"))), "o", 1e9);
    let s = 0;
    for (let i = 0; i < ref.img.data.length; i += 4) s += Math.abs(ref.img.data[i] - foto.img.data[i]) + Math.abs(ref.img.data[i + 1] - foto.img.data[i + 1]) + Math.abs(ref.img.data[i + 2] - foto.img.data[i + 2]);
    assert.ok(s / (ref.img.width * ref.img.height * 3) <= 6, "orientación " + o);
  }
  // Y la función sola: girar 4 veces la 6 vuelve al principio.
  const img = { data: Uint8Array.from({ length: 6 * 4 * 4 }, (_, i) => i % 251), width: 6, height: 4 };
  let g = img;
  for (let k = 0; k < 4; k++) g = orientar(g, 6);
  assert.deepEqual(Array.from(g.data), Array.from(img.data));
});
