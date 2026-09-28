/*
 * Quitar la ubicación y los datos ocultos de las fotos (limpiar_metadatos_imagen), con los
 * casos de la web (tests/fixtures/fotos/metadatos/casos.json, los mismos que prueba
 * WEB A/tools/probar_fotos.py) y sus fotos reales (NASA, iPhone):
 * - enseña lo que la web enseña (por el nombre del dato) y nada en las fotos limpias;
 * - «sin pérdida» cuando la web lo promete (y entonces los píxeles no cambian) y rehecha
 *   cuando no (HEIC, estructuras raras);
 * - la copia no lleva NADA (la comprobación «restos» de probar_fotos.py, traducida), sale
 *   derecha, conserva la transparencia y no se hace más pequeña sin decirlo;
 * - los archivos que no son fotos dan un error claro.
 * Diferencia con la web: allí una foto de más de 25 MB se rechaza al subirla; aquí el
 * límite es el de la extensión, 100 MB por archivo (docs/PROMPT_EXTENSION.md §4.2).
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import "../server/core/salida-segura.js";
import { abrirFoto, metadatos } from "../server/core/imagenes.js";
import { cerrarLector } from "../server/core/lector.js";
import { limpiarFoto } from "../server/core/proceso-foto.js";
import { prepararCarpetas } from "../server/core/rutas.js";

const RAIZ = fileURLToPath(new URL("..", import.meta.url));
const WEB = path.resolve(process.env.DOCUPRIVADO_WEB || path.join(RAIZ, "..", "WEB A"));
const FOTOS = path.join(WEB, "tests", "fixtures", "fotos");
const META = path.join(FOTOS, "metadatos");
const hayWeb = fs.existsSync(path.join(META, "casos.json"));
// La carpeta temporal, por su nombre real, como trabaja la extensión: en macOS está detrás de
// un enlace (/var → /private/var) y en Windows puede venir con nombres cortos (RUNNER~1).
const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "docuprivado-fotos-")));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
after(() => cerrarLector());
const ctx = prepararCarpetas([tmp]);

// ---------------------------------------------------------------- restos
// Traducción de restos() de WEB A/tools/probar_fotos.py: lo que no debería estar en un
// archivo limpio.
const PNG_VALEN = new Set(["IHDR", "PLTE", "IDAT", "IEND", "tRNS", "cHRM", "gAMA", "iCCP", "sBIT", "sRGB", "cICP", "mDCV", "mDCv", "cLLI", "cLLi", "bKGD", "pHYs", "acTL", "fcTL", "fdAT"]);
const WEBP_VALEN = new Set(["VP8 ", "VP8L", "VP8X", "ALPH", "ANIM", "ANMF", "ICCP"]);
const CHIVATOS = ["prueba", "Prueba", "PRUEBA", "Madrid", "Segovia", "SERIE", "xmpmeta", "8BIM", "Image_UTC", "SEFT", "jumb", "©xyz"];
const ascii = (b, i, n) => Buffer.from(b.subarray(i, i + n)).toString("latin1");

function tiffSoloOrientacion(t, donde) {
  if (t.length < 8) return [donde + " vacío"];
  const le = ascii(t, 0, 2) === "II";
  const v = new DataView(t.buffer, t.byteOffset, t.byteLength);
  const u16 = (o) => v.getUint16(o, le);
  const u32 = (o) => v.getUint32(o, le);
  const o = u32(4);
  const n = u16(o);
  const etiquetas = [];
  for (let k = 0; k < n; k++) etiquetas.push(u16(o + 2 + k * 12));
  const siguiente = u32(o + 2 + 12 * n);
  if (etiquetas.length !== 1 || etiquetas[0] !== 0x0112 || siguiente) return [donde + " con algo más que la orientación: " + etiquetas.map((x) => x.toString(16))];
  return [];
}

function restos(b) {
  const mal = [];
  if (b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 4 <= b.length) {
      if (b[i] !== 0xff) { mal.push("byte raro en la cabecera en " + i); break; }
      const m = b[i + 1];
      if (m === 0xff) { i += 1; continue; }
      if (m === 0xd9) { if (b.length - i - 2 > 0) mal.push((b.length - i - 2) + " bytes después del final de la imagen"); break; }
      if ((m >= 0xd0 && m <= 0xd7) || m === 0x01) { i += 2; continue; }
      const n = (b[i + 2] << 8) | b[i + 3];
      const datos = b.subarray(i + 4, i + 2 + n);
      if (m === 0xda) {
        let j = i + 2 + n;
        for (;;) {
          j = b.indexOf(0xff, j);
          if (j === -1 || j + 1 >= b.length) { j = b.length; break; }
          const s = b[j + 1];
          if (s === 0 || (s >= 0xd0 && s <= 0xd7)) j += 2;
          else if (s === 0xff) j += 1;
          else break;
        }
        i = j;
        continue;
      }
      if (m === 0xe0) {
        if (ascii(datos, 0, 5) !== "JFIF\0" || !["\0\0", ""].includes(ascii(datos, 12, 2))) mal.push("APP0 con miniatura o desconocido");
      } else if (m === 0xe1) {
        if (ascii(datos, 0, 6) !== "Exif\0\0") mal.push("APP1 no EXIF (¿XMP?)");
        else mal.push(...tiffSoloOrientacion(datos.subarray(6), "EXIF del JPEG"));
      } else if (m === 0xe2) {
        if (ascii(datos, 0, 12) !== "ICC_PROFILE\0") mal.push("APP2 que no es el perfil de color");
      } else if (m === 0xee) {
        if (ascii(datos, 0, 5) !== "Adobe") mal.push("APP14 raro");
      } else if (m >= 0xe0 && m <= 0xef) {
        mal.push("APP" + (m - 0xe0));
      } else if (m === 0xfe) {
        mal.push("comentario");
      }
      i += 2 + n;
    }
  } else if (ascii(b, 0, 8) === "\x89PNG\r\n\x1a\n") {
    let i = 8;
    while (i + 12 <= b.length) {
      const n = new DataView(b.buffer, b.byteOffset).getUint32(i);
      const t = ascii(b, i + 4, 4);
      if (t === "eXIf") mal.push(...tiffSoloOrientacion(b.subarray(i + 8, i + 8 + n), "eXIf del PNG"));
      else if (!PNG_VALEN.has(t)) mal.push("bloque PNG " + t);
      i += 12 + n;
      if (t === "IEND") { if (b.length > i) mal.push((b.length - i) + " bytes después de IEND"); break; }
    }
  } else if (ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 4) === "WEBP") {
    const v = new DataView(b.buffer, b.byteOffset);
    let i = 12;
    while (i + 8 <= b.length) {
      const t = ascii(b, i, 4);
      const n = v.getUint32(i + 4, true);
      if (t === "EXIF") mal.push(...tiffSoloOrientacion(b.subarray(i + 8, i + 8 + n), "EXIF del WebP"));
      else if (!WEBP_VALEN.has(t)) mal.push("bloque WebP " + t);
      if (t === "VP8X" && b[i + 8] & 0x04) mal.push("VP8X anuncia XMP");
      i += 8 + n + (n & 1);
    }
    if (v.getUint32(4, true) + 8 !== b.length) mal.push("tamaño RIFF incorrecto");
  } else {
    mal.push("formato desconocido");
  }
  const crudo = Buffer.from(b).toString("latin1");
  for (const c of CHIVATOS) if (crudo.includes(c)) mal.push("contiene «" + c + "»");
  return mal;
}

// Diferencia media por canal entre dos imágenes RGBA del mismo tamaño (como probar_fotos.py).
function diferencia(a, b) {
  if (a.width !== b.width || a.height !== b.height) return null;
  let s = 0;
  for (let i = 0; i < a.data.length; i += 4) s += Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1]) + Math.abs(a.data[i + 2] - b.data[i + 2]);
  return s / (a.width * a.height * 3);
}

function copiar(origen) {
  const n = path.basename(origen);
  const d = path.join(tmp, n);
  fs.copyFileSync(origen, d);
  const st = fs.statSync(d);
  return { ruta: d, nombre: n, bytes: st.size, modificado: st.mtimeMs, tipo: "imagen" };
}

const casos = hayWeb ? JSON.parse(fs.readFileSync(path.join(META, "casos.json"), "utf8")) : [];
// Las fotos de la NASA y los retratos son de personas reales: solo están en este ordenador
// (nunca van a GitHub, WEB A/tests/fixtures/FUENTES.md). Si faltan, esos casos no se hacen.
const nasa = path.join(FOTOS, "nasa");
const reales = hayWeb ? (fs.existsSync(nasa) ? fs.readdirSync(nasa) : []).filter((f) => f.endsWith(".jpg")).map((f) => ({ archivo: "../nasa/" + f, sinPerdida: true, campos: [] }))
  .concat([{ archivo: "../../foto-exif-rotada.jpg", sinPerdida: true, campos: [] }, { archivo: "../../foto.heic", sinPerdida: false, campos: [] }, { archivo: "../../retrato-prueba-1.jpg", sinPerdida: true, campos: [] }])
  .filter((c) => fs.existsSync(path.join(META, c.archivo))) : [];
let referencia = null;

for (const c of casos.concat(reales)) {
  // Las fotos de más de 20 MB no van a GitHub (scripts/fixtures-para-github.mjs).
  const falta = hayWeb && !fs.existsSync(path.join(META, c.archivo));
  test("foto: " + c.archivo, { skip: (!hayWeb && "no encuentro las fotos de prueba de la web") || (falta && "esta foto no está aquí") }, async () => {
    const origen = path.join(META, c.archivo);
    const a = copiar(origen);
    const antes = fs.readFileSync(a.ruta);
    if (c.error) {
      // danado (no es una foto, vacía), formato (GIF, PDF con nombre de foto) y tamaño.
      if (c.error === "tamano") {
        const r = await limpiarFoto(ctx, a, {});
        assert.ok(fs.existsSync(r.copia), "aquí el límite es de 100 MB: se procesa");
        return;
      }
      await assert.rejects(limpiarFoto(ctx, a, {}), (e) => e.name === "ErrorUsuario" && (e.codigo === c.error || (c.archivo === "pdf-renombrado.jpg" && e.codigo === "formato")) && e.message.includes(a.nombre));
      return;
    }
    const r = await limpiarFoto(ctx, a, {});
    const salida = new Uint8Array(fs.readFileSync(r.copia));
    assert.deepEqual(fs.readFileSync(a.ruta), antes, "el original no cambia");
    for (const x of c.campos || []) assert.ok(r.datos.some((et) => et.includes(x)), "no dice «" + x + "» (dice: " + r.datos.join(", ") + ")");
    if (c.vacia) assert.deepEqual(r.datos, [], "dice datos en una foto limpia");
    if (typeof c.sinPerdida === "boolean") assert.equal(r.sinPerdida, c.sinPerdida, "sin pérdida");
    assert.deepEqual(restos(salida), [], "la copia lleva restos");
    assert.equal(metadatos(salida).hay, false);
    if (/gps/i.test(c.archivo) || (c.campos || []).some((x) => /GPS/.test(x))) assert.equal(r.ubicacion, true, "llevaba la ubicación");
    // La copia se ve igual que el original (derecha y sin cambios), salvo si estaba cortada.
    if (c.cortada) return;
    const o = await abrirFoto(new Uint8Array(antes), a.nombre, 1e9);
    const s = await abrirFoto(salida, a.nombre, 1e9);
    if (c.derecha) {
      if (!referencia) referencia = await abrirFoto(new Uint8Array(fs.readFileSync(path.join(META, "referencia-derecha.png"))), "ref", 1e9);
      const d = diferencia(s.img, referencia.img);
      assert.ok(d !== null && d <= 6, "no sale derecha (diferencia " + d + ")");
    }
    if (r.sinPerdida) {
      assert.equal(diferencia(o.img, s.img), 0, "dice sin pérdida pero los píxeles cambian");
    } else {
      assert.ok(Math.abs(o.img.width / o.img.height - s.img.width / s.img.height) < 0.02, "otra forma");
    }
    if (c.transparente) assert.ok(s.alfa, "pierde la transparencia");
    if (c.ancho) assert.ok((s.img.width === c.ancho && s.img.height === c.alto) || r.reducida, "más pequeña sin avisar");
  });
}

test("la foto enorme (48 Mpx) sale entera, sin volver a comprimirla", { skip: !hayWeb || !fs.existsSync(path.join(META, "enorme-48mpx.jpg")) }, async () => {
  const r = await limpiarFoto(ctx, copiar(path.join(META, "enorme-48mpx.jpg")), {});
  assert.equal(r.sinPerdida, true);
  assert.equal(r.reducida, null);
});
