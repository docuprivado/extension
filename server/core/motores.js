/*
 * Motores pesados: se cargan la primera vez que hacen falta y se reutilizan mientras la
 * extensión esté abierta. Todos van dentro del paquete; ninguno descarga nada.
 *
 * - PDFium (@embedpdf/pdfium): dibuja las páginas, da la caja de cada carácter y
 *   comprueba el resultado.
 * - pdf.js 6.1.200 (edición para navegadores anteriores, la misma que la web): lee el
 *   texto, que se monta con las reglas de la web para que el detector encuentre lo mismo.
 * - pdf-lib: crea el PDF final y la capa de etiquetas.
 * - libheif (LGPL, archivo aparte y sin modificar, CLAUDE.md §4.8): abre las fotos HEIC.
 * - OpenCV.js 4.7.0 y el buscador de bordes del Kit DNI, copiados de la web: enderezan el
 *   DNI de una foto.
 * - El detector, las reglas del tachador y el motor de las fotos, copiados de la web
 *   (server/shared/).
 * El lector de escaneados va aparte (server/core/lector.js), en su propio hilo.
 */
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import vm from "node:vm";
import { registrar } from "./registro.js";

const require = createRequire(import.meta.url);

let pdfiumPromesa = null;
export function pdfium() {
  if (!pdfiumPromesa) {
    pdfiumPromesa = (async () => {
      const t0 = Date.now();
      const { init } = await import("@embedpdf/pdfium");
      // El motor se le entrega ya leído del disco: así no intenta descargarlo.
      const wasmBinary = fs.readFileSync(require.resolve("@embedpdf/pdfium/pdfium.wasm"));
      const mod = await init({ wasmBinary });
      mod.PDFiumExt_Init();
      registrar("motor PDFium listo en " + (Date.now() - t0) + " ms");
      return mod;
    })();
    pdfiumPromesa.catch(() => { pdfiumPromesa = null; });
  }
  return pdfiumPromesa;
}

let pdfjsPromesa = null;
export function pdfjs() {
  if (!pdfjsPromesa) {
    pdfjsPromesa = (async () => {
      const t0 = Date.now();
      // pdf.js crea un DOMMatrix al cargarse; en Node no existe y aquí no se usa para dibujar
      // (lo hace PDFium). Basta un sustituto mínimo, sin librerías nativas.
      if (typeof globalThis.DOMMatrix === "undefined") {
        globalThis.DOMMatrix = class DOMMatrix {
          constructor(m) { [this.a, this.b, this.c, this.d, this.e, this.f] = Array.isArray(m) ? m : [1, 0, 0, 1, 0, 0]; }
        };
      }
      const lib = await import("pdfjs-dist/legacy/build/pdf.min.mjs");
      lib.GlobalWorkerOptions.workerSrc = pathToFileURL(require.resolve("pdfjs-dist/legacy/build/pdf.worker.min.mjs")).href;
      registrar("motor pdf.js listo en " + (Date.now() - t0) + " ms");
      return lib;
    })();
    pdfjsPromesa.catch(() => { pdfjsPromesa = null; });
  }
  return pdfjsPromesa;
}

let PDFLib = null;
export function pdfLib() {
  if (!PDFLib) PDFLib = require("pdf-lib/dist/pdf-lib.min.js");
  return PDFLib;
}

let jpegJs = null;
export function jpeg() {
  if (!jpegJs) jpegJs = require("jpeg-js");
  return jpegJs;
}

let pngJs = null;
export function png() {
  if (!pngJs) pngJs = require("pngjs").PNG;
  return pngJs;
}

let DP_DETECT = null;
export function detector() {
  if (!DP_DETECT) {
    const t0 = Date.now();
    DP_DETECT = require("../shared/detectores.cjs");
    const leer = (n) => JSON.parse(fs.readFileSync(new URL("../shared/datos/" + n, import.meta.url), "utf8"));
    DP_DETECT.setData({ nombres: leer("nombres.json"), apellidos: leer("apellidos.json"), excluir: leer("excluir.json") });
    const bin = fs.readFileSync(new URL("../shared/datos/empresas.bin", import.meta.url));
    DP_DETECT.setData({ empresas: bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength) });
    registrar("detector listo en " + (Date.now() - t0) + " ms");
  }
  return DP_DETECT;
}

export function reglas() {
  return require("../shared/tachador-reglas.cjs");
}

// Reglas del anonimizador de la web (etiquetas, grupos, tabla y restaurar). Usan el
// detector, que tiene que estar cargado antes.
export function reglasAnonimizador() {
  detector();
  return require("../shared/anonimizador-reglas.cjs");
}

// Motor de las fotos de la web (js/fotos-motor.js, copiado sin cambios): lee y quita los
// datos ocultos (EXIF, XMP, GPS, vídeo de las fotos en movimiento…) trabajando sobre los
// bytes. Es un script de navegador que se cuelga de window.DP; se ejecuta con una
// «window» propia para no crear variables globales que confundirían a pdf.js.
let fotosMotorApi = null;
export function fotosMotor() {
  if (!fotosMotorApi) {
    const url = new URL("../shared/fotos-motor.web.js", import.meta.url);
    const codigo = fs.readFileSync(url, "utf8");
    const ventana = { DP: { tools: {} } };
    vm.compileFunction(codigo, ["window"], { filename: "fotos-motor.web.js" })(ventana);
    fotosMotorApi = ventana.DP.tools.fotosMotor;
    if (!fotosMotorApi || typeof fotosMotorApi.leerMetadatos !== "function") throw new Error("motor de fotos incompleto");
  }
  return fotosMotorApi;
}

// OpenCV.js 4.7.0, el mismo archivo que sirve la web (copiado sin cambios a
// server/shared/opencv/): endereza el DNI. Lleva el motor dentro, así que no lee ni descarga
// nada más. Es un script de los de antes (no un módulo) que, si no lo encuentra, crea una
// variable global «Module» con todo el motor: se ejecuta con su propio «module» y su propio
// «Module», sin tocar nada global. Además, al cargarse en Node se engancha a los errores de
// todo el proceso («si algo falla en cualquier parte, abortar»): se le quitan esos enganches
// en cuanto termina de cargar, para que un fallo en otra herramienta no tumbe la extensión.
let opencvPromesa = null;
export function opencv() {
  if (!opencvPromesa) {
    opencvPromesa = (async () => {
      const t0 = Date.now();
      const EVENTOS = ["uncaughtException", "unhandledRejection"];
      const antes = new Map(EVENTOS.map((e) => [e, process.listeners(e)]));
      const quitarEnganches = () => {
        for (const e of EVENTOS) for (const l of process.listeners(e)) if (!antes.get(e).includes(l)) process.removeListener(e, l);
      };
      try {
        const archivo = new URL("../shared/opencv/opencv.js", import.meta.url);
        const codigo = fs.readFileSync(archivo, "utf8");
        const modulo = { exports: {} };
        const ruta = fileURLToPath(archivo);
        vm.compileFunction(codigo, ["module", "exports", "Module", "require", "__filename", "__dirname"], { filename: "opencv.js" })
          .call(modulo.exports, modulo, modulo.exports, undefined, createRequire(ruta), ruta, path.dirname(ruta));
        const cv = modulo.exports;
        // Su «then» se resuelve consigo mismo: con await (o resolviendo una promesa con él) no
        // terminaría nunca. Se espera a que el motor esté listo (onRuntimeInitialized) y
        // siempre viaja dentro de un objeto.
        const listo = await new Promise((ok, mal) => {
          if (cv.Mat) return ok({ cv });
          const espera = setTimeout(() => mal(new Error("OpenCV no arranca")), 30000);
          cv.onRuntimeInitialized = () => { clearTimeout(espera); ok({ cv }); };
        });
        registrar("motor OpenCV listo en " + (Date.now() - t0) + " ms");
        return listo;
      } finally {
        quitarEnganches();
      }
    })();
    opencvPromesa.catch(() => { opencvPromesa = null; });
  }
  return opencvPromesa;   // { cv }: nunca el motor suelto (ver arriba)
}

// Buscador de bordes del Kit DNI de la web (js/kit-dni-bordes.js, copiado sin cambios). Es
// un script de navegador que usa window.cv y se cuelga de DP.tools: se ejecuta con una
// «window» propia. En el navegador lee la foto de un lienzo con cv.imread; aquí la foto ya
// viene abierta ({ data: RGBA, width, height }) y ese cv.imread la toma tal cual.
let bordesPromesa = null;
export function bordesDni() {
  if (!bordesPromesa) {
    bordesPromesa = (async () => {
      const { cv } = await opencv();
      const vista = Object.create(cv);
      vista.imread = (img) => cv.matFromImageData({ data: img.data, width: img.width, height: img.height });
      const codigo = fs.readFileSync(new URL("../shared/kit-dni-bordes.web.js", import.meta.url), "utf8");
      const DP = { tools: {} };
      vm.compileFunction(codigo, ["window", "DP"], { filename: "kit-dni-bordes.web.js" })({ cv: vista, DP }, DP);
      if (!DP.tools.kitBordes || typeof DP.tools.kitBordes.detectar !== "function") throw new Error("buscador de bordes incompleto");
      // «cv» dentro de un objeto, como opencv(). detectarVarias: las dos caras en la misma
      // imagen (hito de actualización 14 de la web).
      return { cv: vista, detectar: DP.tools.kitBordes.detectar, detectarVarias: DP.tools.kitBordes.detectarVarias };
    })();
    bordesPromesa.catch(() => { bordesPromesa = null; });
  }
  return bordesPromesa;
}

// Motor del comparador de la web (js/comparador-motor.js, copiado sin cambios) con la
// librería con la que compara, diff-match-patch (la edición de Google que usa la web). Los
// dos son scripts de navegador: diff-match-patch se cuelga de «this» y el motor, de
// globalThis.DP. Se ejecutan con objetos propios, sin tocar nada global.
let comparador = null;
export function comparadorMotor() {
  if (!comparador) {
    const leer = (n) => fs.readFileSync(new URL("../shared/" + n, import.meta.url), "utf8");
    const dmp = {};
    vm.compileFunction(leer("diff_match_patch.web.js"), [], { filename: "diff_match_patch.web.js" }).call(dmp);
    if (typeof dmp.diff_match_patch !== "function") throw new Error("diff-match-patch incompleto");
    const global = { diff_match_patch: dmp.diff_match_patch };
    vm.compileFunction(leer("comparador-motor.web.js"), ["globalThis"], { filename: "comparador-motor.web.js" })(global);
    comparador = global.DP && global.DP.tools && global.DP.tools.comparadorMotor;
    if (!comparador || typeof comparador.comparar !== "function") throw new Error("motor del comparador incompleto");
  }
  return comparador;
}

// libheif en WebAssembly, con el motor leído del disco (así no intenta descargarlo).
let heifPromesa = null;
export function libheif() {
  if (!heifPromesa) {
    heifPromesa = (async () => {
      const t0 = Date.now();
      const wasmBinary = fs.readFileSync(require.resolve("libheif-js/libheif-wasm/libheif.wasm"));
      const mod = require("libheif-js/libheif-wasm/libheif.js")({ wasmBinary });
      if (mod.ready) await mod.ready;
      registrar("motor HEIC listo en " + (Date.now() - t0) + " ms");
      return mod;
    })();
    heifPromesa.catch(() => { heifPromesa = null; });
  }
  return heifPromesa;
}
