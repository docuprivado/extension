/*
 * Mismo resultado que la web (mejora 1 de docs/SUGERENCIAS.md): con cada PDF y cada foto
 * de prueba, la extensión tiene que encontrar exactamente los mismos datos que el tachador
 * de la web (tipo, valor, confianza, página y si sigue en la página siguiente), también en
 * los escaneados y las fotos, que se leen con el lector.
 * La lista de la web está en tests/paridad/web-tachador.json (scripts/paridad_web.py).
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import "../server/core/salida-segura.js";
import { abrir, detectar, leerTextos } from "../server/core/documento-pdf.js";
import { CASILLAS, opcionesDeteccion } from "../server/core/deteccion.js";
import { cerrarLector } from "../server/core/lector.js";
import { analizarImagen } from "../server/core/proceso-imagen.js";

after(() => cerrarLector());

const RAIZ = fileURLToPath(new URL("..", import.meta.url));
const WEB = path.resolve(process.env.DOCUPRIVADO_WEB || path.join(RAIZ, "..", "WEB A"));
const web = JSON.parse(fs.readFileSync(new URL("paridad/web-tachador.json", import.meta.url), "utf8"));
const hayWeb = fs.existsSync(path.join(WEB, "tests", "fixtures"));

test("el perfil general de la extensión usa las mismas casillas que la página de la web", () => {
  assert.deepEqual([...web.tipos].sort(), [...CASILLAS].sort());
});

// En los escaneados y las fotos, la imagen que lee el lector la dibuja otro motor (PDFium
// en vez del navegador) o la abre otro decodificador de JPG, y el lector puede leer alguna
// letra distinta. Ahí se exige que todo dato que encuentra la web lo encuentre también la
// extensión (el mismo tipo en la misma página, con el valor igual sin contar los signos o
// el de la web dentro del nuestro), que al menos el 80 % sea idéntico y se permiten datos
// de más (tapar de más es seguro). Un valor nuestro más corto que el de la web no vale: es
// tapar menos. Así se escapó «Calle del Ejemplo 12» frente a «Calle del Ejemplo 12, 3. B,
// 28013 Madrid» (hito de actualización 19 de la web: el lector de la extensión leía «3.? B»).
const plano = (v) => String(v).replace(/\s+/g, " ").trim().toLowerCase();
const sinSignos = (v) => plano(v).replace(/[^\p{L}\p{N}]+/gu, " ").trim();
function comparable(nuestro, suyo) {
  const x = sinSignos(nuestro);
  const y = sinSignos(suyo);
  return x === y || (y.length >= 4 && x.includes(y));
}
function compararLeidos(nuestras, suyas) {
  const libres = nuestras.slice();
  let identicas = 0;
  const faltan = [];
  for (const m of suyas) {
    let k = libres.findIndex((n) => n.pagina === m.pagina && n.tipo === m.tipo && plano(n.valor) === plano(m.valor));
    if (k >= 0) identicas++;
    else k = libres.findIndex((n) => n.pagina === m.pagina && n.tipo === m.tipo && comparable(n.valor, m.valor));
    if (k >= 0) libres.splice(k, 1); else faltan.push(m.pagina + " | " + m.tipo + " | " + m.valor);
  }
  assert.deepEqual(faltan, [], "Datos que encuentra la web y la extensión no");
  assert.ok(!suyas.length || identicas / suyas.length >= 0.8, "Solo " + identicas + " de " + suyas.length + " datos idénticos a la web");
}

for (const [archivo, datos] of Object.entries(web.archivos)) {
  test("mismo resultado que la web: " + archivo, { skip: !hayWeb && "no encuentro los documentos de prueba de la web" }, async () => {
    const ruta = path.join(WEB, "tests", "fixtures", archivo);
    const huella = createHash("sha256").update(fs.readFileSync(ruta)).digest("hex");
    assert.equal(huella, datos.sha256, "El documento de prueba ha cambiado en la web: vuelve a ejecutar python scripts/paridad_web.py");
    const suyas = datos.marcas.map((m) => [m.pagina, m.tipo, m.valor, m.confianza, m.siguePagina[0] || 0, m.campo || ""].join(" | ")).sort();
    if (!/\.pdf$/i.test(archivo)) {
      const st = fs.statSync(ruta);
      const r = await analizarImagen({ ruta, nombre: path.basename(ruta), bytes: st.size, modificado: st.mtimeMs, tipo: "imagen" }, opcionesDeteccion({}));
      compararLeidos(r.marcas.map((m) => ({ pagina: 1, tipo: m.tipo, valor: m.valor })), datos.marcas);
      return;
    }
    const d = await abrir(ruta, archivo);
    try {
      const paginas = await leerTextos(d);
      detectar(paginas, opcionesDeteccion({}));
      if (paginas.some((p) => p.ocr)) {
        compararLeidos(paginas.flatMap((p) => p.marcas.map((m) => ({ pagina: p.num, tipo: m.tipo, valor: m.valor }))), datos.marcas);
        return;
      }
      // PDF con texto: exactamente lo mismo.
      // Los datos del texto y los de los campos de formulario (una marca por campo).
      const nuestras = paginas.flatMap((p) => p.marcas.map((m) => [p.num, m.tipo, m.valor, m.confianza, m.sigue ? m.sigue.pagina : 0, ""].join(" | "))
        .concat((p.marcasCampo || []).map((m) => [p.num, m.tipo, m.valor, m.confianza, 0, m.campo].join(" | ")))).sort();
      assert.deepEqual(nuestras, suyas);
    } finally {
      await d.cerrar();
    }
  });
}
