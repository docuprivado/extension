/*
 * Prueba sin red (CLAUDE.md §8.2): arranca la extensión con la red bloqueada
 * (scripts/bloquear-red.mjs) y llama a TODAS sus herramientas con parámetros válidos,
 * inválidos, vacíos y con rutas fuera de las carpetas permitidas. Cualquier intento de
 * conexión es un fallo. Si aparece una herramienta nueva sin casos aquí, también falla:
 * así ninguna se queda sin comprobar.
 *
 *   node scripts/comprobar-sin-red.mjs [--servidor <carpeta del paquete>]
 *
 * Trabaja con copias de los documentos de prueba de la web en una carpeta temporal
 * (la web solo se lee).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { arrancar } from "../tests/cliente-mcp.mjs";
import { crearCorreoCliente } from "./crear-word-prueba.mjs";

const RAIZ = fileURLToPath(new URL("..", import.meta.url));
const WEB = path.resolve(process.env.DOCUPRIVADO_WEB || path.join(RAIZ, "..", "WEB A"));
const FIXTURES = path.join(WEB, "tests", "fixtures");
const i = process.argv.indexOf("--servidor");
const paquete = i > 0 ? path.resolve(process.argv[i + 1]) : RAIZ;

// Documentos de prueba (ficticios) que se copian a la carpeta temporal.
const COPIAR = ["nomina-ficticia.pdf", "contrato-ficticio.pdf", "contrato-escaneado.pdf", "captura-ficticia.png", "protegido.pdf", "danado.pdf",
  "contrato-v1.docx", "contrato-v2.docx", "texto-anonimizar.txt", "dni-facil-anverso.jpg", "dni-facil-reverso.jpg", "foto.heic", "formulario-ficticio.pdf",
  "fotos/foto-gps.jpg", "fotos/metadatos/webp-datos.webp", "fotos/metadatos/foto-en-movimiento.jpg", "fotos/metadatos/no-es-una-foto.jpg", "pasaporte-prueba.jpg", "bordes/dos-caras-05.jpg"];

const base = fs.mkdtempSync(path.join(os.tmpdir(), "docuprivado-sinred-"));
const docs = path.join(base, "Documentos de prueba");
const fuera = path.join(base, "fuera");
fs.mkdirSync(path.join(docs, "Subcarpeta"), { recursive: true });
fs.mkdirSync(fuera);
for (const f of COPIAR) {
  const origen = path.join(FIXTURES, f);
  if (fs.existsSync(origen)) fs.copyFileSync(origen, path.join(docs, path.basename(f)));
}
fs.copyFileSync(path.join(FIXTURES, "nomina-ficticia.pdf"), path.join(docs, "Subcarpeta", "nomina-octubre.pdf"));
fs.writeFileSync(path.join(docs, "correo-cliente.docx"), crearCorreoCliente());   // Word ficticio (hito 4)
fs.copyFileSync(path.join(FIXTURES, "nomina-ficticia.pdf"), path.join(fuera, "nomina-fuera.pdf"));

// Casos por herramienta: [descripción, argumentos, ¿debe dar error?, comprobación del resultado]
// La comprobación mira que el trabajo se haya hecho de verdad (copias creadas, documentos
// leídos): una herramienta que falla con todos los archivos no da error, los lista, y así
// se escapó en la 0.3.0 un archivo que faltaba en el paquete.
const CASOS = {
  ayuda_docuprivado: [
    ["válido", {}, false],
    ["con un parámetro que no existe", { extra: 1 }, null],
  ],
  listar_documentos: [
    ["todo", {}, false],
    ["buscar", { buscar: "nomina" }, false],
    ["tipos y fecha", { tipos: ["pdf", "imagen"], modificados_desde: "2020-01-01", recursivo: true }, false],
    ["carpeta por nombre", { carpeta: "Subcarpeta" }, false],
    ["vacío", { buscar: "", carpeta: "" }, false],
    ["tipo inválido", { tipos: ["exe"] }, true],
    ["fecha inválida", { modificados_desde: "mañana" }, true],
    ["carpeta fuera", { carpeta: fuera }, true],
    ["carpeta con ..", { carpeta: ".." }, true],
    ["ruta de red", { carpeta: "\\\\servidor\\compartida" }, true],
  ],
  analizar_datos_personales: [
    ["un PDF", { rutas: ["nomina-ficticia.pdf"] }, false, (d) => d.archivos.length === 1 && d.total === 25],
    ["con valores tapados", { rutas: ["nomina-ficticia.pdf"], mostrar_valores: true }, false],
    ["carpeta entera, perfil nómina", { rutas: ["."], preset: "nomina" }, false],
    ["con contraseña, dañado y escaneado", { rutas: ["protegido.pdf", "danado.pdf", "contrato-escaneado.pdf"] }, false,
      (d) => d.archivos.length === 1 && d.archivos[0].paginasEscaneadas.length === 3 && d.archivos[0].datos >= 10 && d.noAnalizados.length === 2],
    ["fotos (captura, WebP, HEIC)", { rutas: ["captura-ficticia.png", "webp-datos.webp", "foto.heic"] }, false,
      (d) => d.archivos.length === 3 && !d.noAnalizados.length && d.archivos[0].datos >= 3],
    ["vacío", {}, true],
    ["tipo inválido", { rutas: ["nomina-ficticia.pdf"], tipos: ["pasaporte"] }, true],
    ["fuera", { rutas: [path.join(fuera, "nomina-fuera.pdf")] }, false],
    ["ruta de red", { rutas: ["\\\\servidor\\compartida\\x.pdf"] }, false],
  ],
  tachar_documentos: [
    ["un PDF", { rutas: ["nomina-ficticia.pdf"] }, false, (d) => d.copias.length === 1 && d.total === 25],
    ["carpeta entera con etiquetas y calidad alta", { rutas: ["."], recursivo: true, estilo: "etiqueta", calidad: "alta" }, false],
    ["dejando a la vista la empresa", { rutas: ["contrato-ficticio.pdf"], no_tachar: ["Empresa Ficticia"] }, false],
    ["formulario rellenable", { rutas: ["formulario-ficticio.pdf"] }, false],
    ["la carpeta otra vez (salta lo tachado)", { rutas: ["."] }, false],
    ["la carpeta otra vez, repitiendo", { rutas: ["."], repetir: true }, false],
    ["vacío", {}, true],
    ["escaneado y fotos, pixelado", { rutas: ["contrato-escaneado.pdf", "captura-ficticia.png", "dni-facil-anverso.jpg", "foto.heic"], estilo: "pixelado" }, false,
      (d) => d.copias.length === 4 && !d.noTachados.length && d.copias[0].paginasLeidas === 3 && d.total >= 15],
    ["estilo inválido", { rutas: ["nomina-ficticia.pdf"], estilo: "borroso" }, true],
    ["fuera", { rutas: [path.join(fuera, "nomina-fuera.pdf")] }, false],
    ["carpeta de resultados fuera", { rutas: ["nomina-ficticia.pdf"], carpeta_salida: fuera }, true],
  ],
  limpiar_metadatos_imagen: [
    ["unas fotos", { rutas: ["foto-gps.jpg", "foto.heic", "webp-datos.webp", "foto-en-movimiento.jpg"] }, false,
      (d) => d.copias.length === 4 && d.conUbicacion === 3 && !d.noLimpiadas.length],
    ["carpeta entera, con subcarpetas", { rutas: ["."], recursivo: true }, false],
    ["la carpeta otra vez (salta lo hecho)", { rutas: ["."] }, false],
    ["la carpeta otra vez, repitiendo", { rutas: ["."], repetir: true }, false],
    ["no es una foto y un PDF", { rutas: ["no-es-una-foto.jpg", "nomina-ficticia.pdf"] }, false],
    ["vacío", {}, true],
    ["fuera", { rutas: [path.join(fuera, "nomina-fuera.pdf")] }, false],
    ["carpeta de resultados fuera", { rutas: ["foto-gps.jpg"], carpeta_salida: fuera }, true],
  ],
  anonimizar_archivo: [
    ["texto", { ruta: "texto-anonimizar.txt" }, false, (d) => d.datos === 17 && !!d.copia && !!d.tabla],
    ["Word, enseñando el texto", { ruta: "contrato-v1.docx", mostrar_texto: true }, false, (d) => d.datos >= 8 && /\[PERSONA_1\]/.test(d.texto)],
    ["Word con de todo (ficticio)", { ruta: "correo-cliente.docx", no_tachar: ["Carmen Ruiz Ortega"] }, false, (d) => d.datos >= 8 && d.visibles === 1],
    ["la carpeta entera, con una sola tabla", { rutas: ["."] }, false, (d) => d.copias.length >= 3 && !!d.tabla && /documentos de prueba-tabla\.json$/i.test(d.tabla)],
    ["PDF (se explica qué usar)", { ruta: "nomina-ficticia.pdf" }, true],
    ["vacío", {}, true],
    ["fuera", { ruta: path.join(fuera, "nomina-fuera.pdf") }, true],
  ],
  restaurar_archivo: [
    ["con la tabla de antes", { ruta: "texto-anonimizar-anonimo.txt", tabla: "texto-anonimizar-tabla.json" }, false, (d) => d.restauradas === 19 && !!d.copia],
    ["Word con su tabla", { ruta: "correo-cliente-anonimo.docx", tabla: "correo-cliente-tabla.json" }, false, (d) => d.restauradas >= 10 && !!d.copia],
    ["tabla que no es una tabla", { ruta: "texto-anonimizar.txt", tabla: "danado.pdf" }, true],
    ["sin tabla", { ruta: "texto-anonimizar.txt" }, true],
    ["tabla fuera", { ruta: "texto-anonimizar.txt", tabla: path.join(fuera, "x.json") }, true],
  ],
  proteger_copia_dni: [
    ["DNI por las dos caras, en PDF", { delantera: "dni-facil-anverso.jpg", trasera: "dni-facil-reverso.jpg", texto_marca: "Solo para alquiler de vivienda" }, false,
      (d) => d.archivos.length === 1 && /\.pdf$/.test(d.archivos[0]) && d.caras.every((c) => c.recorte === "automatico")],
    ["en dos imágenes, con franja", { delantera: "dni-facil-anverso.jpg", trasera: "dni-facil-reverso.jpg", texto_marca: "Solo para el banco", salida: "imagenes", estilo: "franja" }, false,
      (d) => d.archivos.length === 2],
    ["pasaporte en una imagen", { delantera: "pasaporte-prueba.jpg", documento: "pasaporte", texto_marca: "Solo para el hotel", salida: "imagen_unica" }, false, (d) => d.archivos.length === 1],
    ["las dos caras en una foto, la trasera arriba, dos trámites", { delantera: "dos-caras-05.jpg", texto_marca: ["Solo para la inmobiliaria", "Solo para el banco"] }, false,
      (d) => d.copias.length === 2 && d.caras.length === 2 && d.caras.every((c) => c.mismaFoto) && d.carasCambiadas],
    ["un PDF de foto (con contraseña)", { delantera: "protegido.pdf", texto_marca: "Solo para el banco" }, true],
    ["sin finalidad", { delantera: "dni-facil-anverso.jpg" }, true],
    ["vacío", {}, true],
    ["documento inválido", { delantera: "dni-facil-anverso.jpg", documento: "tarjeta_sanitaria", texto_marca: "x" }, true],
    ["fuera", { delantera: path.join(fuera, "nomina-fuera.pdf"), texto_marca: "Solo para el banco" }, true],
    ["carpeta de resultados fuera", { delantera: "dni-facil-anverso.jpg", texto_marca: "Solo para el banco", carpeta_salida: fuera }, true],
  ],
  comparar_documentos: [
    ["dos Word", { original: "contrato-v1.docx", nuevo: "contrato-v2.docx" }, false, (d) => d.resumen.total === 4 && d.resumen.importantes === 3 && !!d.informe && !!d.word],
    ["un escaneo contra su versión con texto", { original: "contrato-ficticio.pdf", nuevo: "contrato-escaneado.pdf" }, false, (d) => d.escaneados.length === 1 && d.resumen.total <= 3 && d.resumen.lectura >= 6],
    ["con contraseña", { original: "protegido.pdf", nuevo: "contrato-ficticio.pdf" }, true],
    ["el mismo dos veces", { original: "contrato-v1.docx", nuevo: "contrato-v1.docx" }, true],
    ["vacío", {}, true],
    ["fuera", { original: path.join(fuera, "nomina-fuera.pdf"), nuevo: "contrato-v1.docx" }, true],
  ],
};

let fallos = 0;
const s = arrancar({ carpetas: [docs], servidor: path.join(paquete, "server", "index.js"), cwd: paquete });
try {
  await s.iniciar();
  const lista = await s.pedir("tools/list", {});
  const nombres = lista.result.tools.map((t) => t.name);
  for (const n of nombres) {
    if (!CASOS[n]) {
      console.error("✗ La herramienta «" + n + "» no tiene casos en scripts/comprobar-sin-red.mjs");
      fallos++;
      continue;
    }
    for (const [desc, args, error, comprobar] of CASOS[n]) {
      const r = await s.llamar(n, args);
      const esError = !!(r.error || (r.result && r.result.isError));
      let ok = error === null || esError === error;
      if (ok && comprobar && !esError && !comprobar(r.result.structuredContent)) {
        ok = false;
        console.error("  el resultado no es el esperado: " + r.result.content[0].text.split("\n").filter((l) => /^No (tachado|analizado|limpiada)/.test(l)).join(" | ").slice(0, 400));
      }
      if (!ok) fallos++;
      console.error((ok ? "✓ " : "✗ ") + n + " · " + desc + (esError ? " → error controlado" : " → bien"));
    }
  }
} finally {
  const fin = await s.cerrar();
  if (fin.lineasMalas.length) {
    console.error("✗ Salida estándar con líneas que no son del protocolo: " + fin.lineasMalas.length);
    fallos++;
  }
  const intentos = /intento de conexión: /.test(fin.stderr);
  if (intentos || !/ningún intento de conexión/.test(fin.stderr)) {
    console.error("✗ Intentos de conexión:\n" + fin.stderr.split("\n").filter((l) => /SIN RED/.test(l)).join("\n"));
    fallos++;
  } else {
    console.error("✓ Ningún intento de conexión en todas las llamadas");
  }
  // Nada se ha escrito fuera ni se ha tocado ningún original.
  if (fs.readdirSync(fuera).length !== 1) {
    console.error("✗ Ha aparecido algo en la carpeta de fuera");
    fallos++;
  }
  fs.rmSync(base, { recursive: true, force: true });
}
console.error(fallos ? "Prueba sin red: " + fallos + " fallo(s)" : "Prueba sin red superada");
process.exit(fallos ? 1 : 0);
