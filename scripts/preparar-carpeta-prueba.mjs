/*
 * Prepara «carpeta-de-prueba/», la carpeta que el titular autoriza al instalar la extensión
 * en su Claude Desktop para las frases de prueba (docs/PROMPT_EXTENSION.md §8.2).
 * Solo lleva copias de los documentos FICTICIOS de la web (tests/fixtures), repartidos
 * como los tendría una persona: Alquiler, Contratos, Viaje y DNI. Nunca documentos reales.
 * Para la versión 1.0 lleva además «Medicion» (10 nóminas ficticias para cronometrar) y
 * «Pruebas negativas» (una orden escondida en un contrato y un archivo de 150 MB); y
 * «Revision», con lo que encontró la revisión con otro chat de Claude.
 * La carpeta no se guarda en el historial (.gitignore) y se puede rehacer cuando se quiera:
 *
 *   node scripts/preparar-carpeta-prueba.mjs
 *
 * Si ya existe, solo añade lo que falte (no borra ni sobrescribe nada de lo que haya).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RESPUESTA_IA, crearCartaRevision, crearCorreoCliente } from "./crear-word-prueba.mjs";
import { CONTRATO_TRAMPA, crearContratoTrampa, crearDatosEscondidos, crearNominasMedicion } from "./crear-pruebas-finales.mjs";

const RAIZ = fileURLToPath(new URL("..", import.meta.url));
const WEB = path.resolve(process.env.DOCUPRIVADO_WEB || path.join(RAIZ, "..", "WEB A"));
const F = path.join(WEB, "tests", "fixtures");
// Otra carpeta con DOCUPRIVADO_CARPETA_PRUEBA (el ensayo de las frases usa una temporal).
const DESTINO = path.resolve(process.env.DOCUPRIVADO_CARPETA_PRUEBA || path.join(RAIZ, "carpeta-de-prueba"));

// [origen en tests/fixtures de la web, destino en la carpeta de prueba]
const COPIAS = [
  ["nomina-ficticia.pdf", "Alquiler/nomina-septiembre-2026.pdf"],
  ["nomina-ficticia.pdf", "Alquiler/nomina-agosto-2026.pdf"],
  ["debajo/1-nomina-bloque.pdf", "Alquiler/nomina-julio-2026.pdf"],
  ["captura-ficticia.png", "Alquiler/captura-whatsapp-casero.png"],
  ["contrato-ficticio.pdf", "Contratos/contrato-alquiler.pdf"],
  ["contrato-letra-pequena.pdf", "Contratos/contrato-letra-pequena.pdf"],
  ["contrato-cortes.pdf", "Contratos/contrato-datos-partidos.pdf"],
  ["contrato-escaneado.pdf", "Contratos/contrato-escaneado.pdf"],
  ["contrato-v1.docx", "Contratos/contrato-v1.docx"],
  ["contrato-v2.docx", "Contratos/contrato-v2.docx"],
  ["protegido.pdf", "Contratos/contrato-con-contrasena.pdf"],
  ["fotos/foto-gps.jpg", "Viaje/playa.jpg"],
  ["fotos/metadatos/iphone-gps.heic", "Viaje/atardecer.heic"],
  ["fotos/metadatos/orientacion-6.jpg", "Viaje/catedral.jpg"],
  ["fotos/metadatos/sin-datos.jpg", "Viaje/sin-ubicacion.jpg"],
  ["fotos/metadatos/foto-en-movimiento.jpg", "Viaje/foto-en-movimiento.jpg"],
  ["dni-facil-anverso.jpg", "DNI/dni-frente.jpg"],
  ["dni-facil-reverso.jpg", "DNI/dni-detras.jpg"],
  ["pasaporte-prueba.jpg", "DNI/pasaporte.jpg"],          // hito 5: la copia del pasaporte
  ["bordes/escena-08.jpg", "DNI/dni-foto-dificil.jpg"],   // hito 5: bordes que no se ven claros
  ["bordes/dos-caras-01.jpg", "DNI/dni-escaneado-dos-caras.jpg"],   // mejoras del hito 5: las dos caras en una hoja
  ["bordes/dos-caras-05.jpg", "DNI/dni-dos-caras-trasera-arriba.jpg"],   // y con la trasera arriba
  ["texto-anonimizar.txt", "correo-cliente.txt"],
];

let copiados = 0;
for (const [origen, destino] of COPIAS) {
  const de = path.join(F, origen);
  const a = path.join(DESTINO, destino);
  if (!fs.existsSync(de)) {
    console.error("Falta en la web: " + origen);
    continue;
  }
  if (fs.existsSync(a)) continue;
  fs.mkdirSync(path.dirname(a), { recursive: true });
  fs.copyFileSync(de, a);
  copiados++;
}
// Hito 4: un Word ficticio para anonimizar y la «respuesta de una IA» con sus etiquetas.
for (const [nombre, datos] of [["correo-cliente.docx", crearCorreoCliente()], ["respuesta-ia.txt", RESPUESTA_IA]]) {
  const a = path.join(DESTINO, nombre);
  if (fs.existsSync(a)) continue;
  fs.mkdirSync(DESTINO, { recursive: true });
  fs.writeFileSync(a, datos);
  copiados++;
}
// Hito 7: las 10 nóminas para medir el tiempo (docs/MEDICIONES.md) y las pruebas negativas:
// un contrato con una orden escondida (en PDF para tachar y en texto para anonimizar) y un
// archivo de 150 MB, que pasa del máximo (100 MB). El grande se crea vacío y al momento.
const finales = [
  ...(await crearNominasMedicion()).map((n) => ["Medicion/Nominas/" + n.archivo, n.datos]),
  ["Pruebas negativas/contrato-con-instrucciones.pdf", await crearContratoTrampa()],
  ["Pruebas negativas/nota-con-instrucciones.txt", CONTRATO_TRAMPA + "\n"],
  // Lo que encontró la revisión con otro chat de Claude (hitos de actualización 17 y 18 de la web).
  ["Revision/carta-cliente.docx", crearCartaRevision()],
  ["Revision/datos-escondidos.pdf", await crearDatosEscondidos()],
];
for (const [nombre, datos] of finales) {
  const a = path.join(DESTINO, nombre);
  if (fs.existsSync(a)) continue;
  fs.mkdirSync(path.dirname(a), { recursive: true });
  fs.writeFileSync(a, datos);
  copiados++;
}
const grande = path.join(DESTINO, "Pruebas negativas", "escaneo-enorme.pdf");
if (!fs.existsSync(grande)) {
  fs.writeFileSync(grande, "%PDF-1.4\n");
  fs.truncateSync(grande, 150 * 1024 * 1024);
  copiados++;
}
const leeme = path.join(DESTINO, "LEEME.txt");
if (!fs.existsSync(leeme)) fs.writeFileSync(leeme, "Carpeta de prueba de la extensión docuprivado.\nTodos los documentos son FICTICIOS (copias de WEB A/tests/fixtures).\nSe puede borrar y rehacer con: node scripts/preparar-carpeta-prueba.mjs\n");
console.error("Carpeta de prueba lista: " + DESTINO + " (" + copiados + " archivos nuevos)");
