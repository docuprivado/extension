/*
 * Prueba con el MCP Inspector oficial (CLAUDE.md §8.3), en su modo de línea de órdenes:
 * cada herramienta con parámetros válidos, inválidos, vacíos y rutas fuera de las
 * carpetas permitidas. Es una segunda opinión, con un cliente que no es el nuestro.
 * Trabaja con copias de los documentos de prueba de la web en una carpeta temporal (la
 * web solo se lee: el tachado escribe sus copias en la carpeta temporal).
 *
 *   node scripts/probar-inspector.mjs
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RAIZ = fileURLToPath(new URL("..", import.meta.url));
const LANZADOR = path.join(RAIZ, "node_modules", "@modelcontextprotocol", "inspector", "clients", "launcher", "build", "index.js");
const WEB = path.resolve(process.env.DOCUPRIVADO_WEB || path.join(RAIZ, "..", "WEB A"));
const FIXTURES = path.join(WEB, "tests", "fixtures");
// La carpeta temporal, por su nombre real, como trabaja la extensión: en macOS está detrás de
// un enlace (/var → /private/var) y en Windows puede venir con nombres cortos (RUNNER~1).
const CARPETA = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "docuprivado-inspector-")));
for (const f of ["nomina-ficticia.pdf", "contrato-ficticio.pdf", "contrato-v1.pdf", "contrato-escaneado.pdf", "captura-ficticia.png", "fotos/foto-gps.jpg", "fotos/metadatos/iphone-gps.heic",
  "texto-anonimizar.txt", "contrato-v1.docx", "contrato-v2.docx", "dni-facil-anverso.jpg", "dni-facil-reverso.jpg"]) {
  fs.copyFileSync(path.join(FIXTURES, f), path.join(CARPETA, path.basename(f)));
}
fs.cpSync(path.join(FIXTURES, "debajo"), path.join(CARPETA, "debajo"), { recursive: true });
process.on("exit", () => fs.rmSync(CARPETA, { recursive: true, force: true }));

// [descripción, argumentos del Inspector, ¿debe dar error?]
const herramienta = (nombre, ...args) => ["--method", "tools/call", "--tool-name", nombre, ...args.flatMap((a) => ["--tool-arg", a])];
const CASOS = [
  ["lista de herramientas", ["--method", "tools/list"], false],
  // Plantillas de peticiones (hito 7).
  ["lista de plantillas", ["--method", "prompts/list"], false],
  ["plantilla: comparar", ["--method", "prompts/get", "--prompt-name", "comparar_contrato", "--prompt-args", "original=contrato-v1.docx", "nuevo=contrato-v2.docx"], false],
  ["plantilla: DNI sin fotos", ["--method", "prompts/get", "--prompt-name", "preparar_dni", "--prompt-args", "finalidad=Alquiler de vivienda"], false],
  ["plantilla: falta un dato", ["--method", "prompts/get", "--prompt-name", "comparar_contrato", "--prompt-args", "original=contrato-v1.docx"], true],
  ["plantilla que no existe", ["--method", "prompts/get", "--prompt-name", "borrar_todo"], true],
  ["ayuda", herramienta("ayuda_docuprivado"), false],
  ["listar: contratos en PDF", herramienta("listar_documentos", "buscar=contrato", 'tipos=["pdf"]'), false],
  ["listar: vacío", herramienta("listar_documentos"), false],
  ["listar: subcarpeta por nombre", herramienta("listar_documentos", "carpeta=debajo"), false],
  ["listar: fuera, C:\\Windows", herramienta("listar_documentos", "carpeta=C:\\Windows"), true],
  ["listar: fuera, con ..", herramienta("listar_documentos", "carpeta=..\\.."), true],
  ["listar: fuera, ruta de red", herramienta("listar_documentos", "carpeta=\\\\servidor\\compartida"), true],
  ["listar: tipo inválido", herramienta("listar_documentos", 'tipos=["exe"]'), true],
  ["listar: fecha inválida", herramienta("listar_documentos", "modificados_desde=mañana"), true],
  ["analizar: nómina", herramienta("analizar_datos_personales", 'rutas=["nomina-ficticia.pdf"]'), false],
  ["analizar: vacío", herramienta("analizar_datos_personales"), true],
  ["analizar: tipo inválido", herramienta("analizar_datos_personales", 'rutas=["nomina-ficticia.pdf"]', 'tipos=["pasaporte"]'), true],
  ["tachar: estilo inválido", herramienta("tachar_documentos", 'rutas=["nomina-ficticia.pdf"]', "estilo=borroso"), true],
  ["tachar: vacío", herramienta("tachar_documentos"), true],
  ["tachar: nómina", herramienta("tachar_documentos", 'rutas=["nomina-ficticia.pdf"]'), false],
  ["tachar: salida en C:\\Windows", herramienta("tachar_documentos", 'rutas=["nomina-ficticia.pdf"]', "carpeta_salida=C:\\Windows"), true],
  ["tachar: escaneado y captura", herramienta("tachar_documentos", 'rutas=["contrato-escaneado.pdf","captura-ficticia.png"]'), false],
  ["tachar: foto pixelada", herramienta("tachar_documentos", 'rutas=["captura-ficticia.png"]', "estilo=pixelado"), false],
  ["analizar: captura", herramienta("analizar_datos_personales", 'rutas=["captura-ficticia.png"]'), false],
  ["limpiar: dos fotos con ubicación", herramienta("limpiar_metadatos_imagen", 'rutas=["foto-gps.jpg","iphone-gps.heic"]'), false],
  ["limpiar: vacío", herramienta("limpiar_metadatos_imagen"), true],
  ["limpiar: salida en C:\\Windows", herramienta("limpiar_metadatos_imagen", 'rutas=["foto-gps.jpg"]', "carpeta_salida=C:\\Windows"), true],
  ["anonimizar: texto", herramienta("anonimizar_archivo", "ruta=texto-anonimizar.txt"), false],
  ["anonimizar: Word", herramienta("anonimizar_archivo", "ruta=contrato-v1.docx"), false],
  ["anonimizar: dos con una tabla", herramienta("anonimizar_archivo", 'rutas=["texto-anonimizar.txt","contrato-v1.docx"]'), false],
  ["anonimizar: PDF", herramienta("anonimizar_archivo", "ruta=nomina-ficticia.pdf"), true],
  ["anonimizar: vacío", herramienta("anonimizar_archivo"), true],
  ["restaurar: con la tabla", herramienta("restaurar_archivo", "ruta=texto-anonimizar-anonimo.txt", "tabla=texto-anonimizar-tabla.json"), false],
  ["restaurar: sin tabla", herramienta("restaurar_archivo", "ruta=texto-anonimizar.txt"), true],
  ["restaurar: tabla en C:\\Windows", herramienta("restaurar_archivo", "ruta=texto-anonimizar.txt", "tabla=C:\\Windows\\win.ini"), true],
  ["DNI: dos caras en PDF", herramienta("proteger_copia_dni", "delantera=dni-facil-anverso.jpg", "trasera=dni-facil-reverso.jpg", "texto_marca=Solo para alquiler de vivienda"), false],
  ["DNI: en imágenes, girada", herramienta("proteger_copia_dni", "delantera=dni-facil-anverso.jpg", "texto_marca=Solo para el banco", "salida=imagenes", "girar_delantera=180"), false],
  ["DNI: dos trámites a la vez", herramienta("proteger_copia_dni", "delantera=dni-facil-anverso.jpg", "trasera=dni-facil-reverso.jpg",
    'texto_marca=["Solo para la inmobiliaria","Solo para el banco"]'), false],
  ["DNI: sin finalidad", herramienta("proteger_copia_dni", "delantera=dni-facil-anverso.jpg"), true],
  ["DNI: vacío", herramienta("proteger_copia_dni"), true],
  ["DNI: giro inválido", herramienta("proteger_copia_dni", "delantera=dni-facil-anverso.jpg", "texto_marca=x", "girar_delantera=45"), true],
  ["DNI: foto en C:\\Windows", herramienta("proteger_copia_dni", "delantera=C:\\Windows\\win.ini", "texto_marca=x"), true],
  ["comparar: dos contratos", herramienta("comparar_documentos", "original=contrato-v1.docx", "nuevo=contrato-v2.docx"), false],
  ["comparar: Word contra PDF", herramienta("comparar_documentos", "original=contrato-v1.pdf", "nuevo=contrato-v2.docx"), false],
  ["comparar: vacío", herramienta("comparar_documentos"), true],
  ["comparar: en C:\\Windows", herramienta("comparar_documentos", "original=C:\\Windows\\win.ini", "nuevo=contrato-v1.docx"), true],
];

let fallos = 0;
for (const [desc, args, debeFallar] of CASOS) {
  let salida;
  try {
    salida = execFileSync(process.execPath, [LANZADOR, "--cli", process.execPath, path.join(RAIZ, "server", "index.js"), CARPETA, ...args],
      { cwd: RAIZ, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch (err) {
    salida = err.stdout;           // el Inspector sale con código distinto de 0 cuando la herramienta da error
  }
  let j;
  try {
    // Un error del protocolo (una plantilla que falta o sin un dato obligatorio) no deja
    // nada en la salida: el Inspector lo cuenta por la de errores y sale con código 1.
    j = !String(salida || "").trim() && debeFallar ? { error: "sin respuesta" } : JSON.parse(salida);
  } catch {
    console.error("✗ " + desc + ": respuesta que no es JSON: " + String(salida).slice(0, 200));
    fallos++;
    continue;
  }
  // Una plantilla que falla sale como error del protocolo, no como «isError».
  const esError = !!j.isError || !!j.error || (!j.tools && !j.prompts && !j.messages && !j.content);
  const primera = (t) => t.split("\n")[0].slice(0, 150);
  const texto = j.tools ? j.tools.map((t) => t.name).join(", ") : j.prompts ? j.prompts.map((x) => x.name).join(", ") :
    j.messages ? primera(j.messages[0].content.text) : j.content ? primera(j.content[0].text) : JSON.stringify(j).slice(0, 150);
  const ok = esError === debeFallar;
  if (!ok) fallos++;
  console.error((ok ? "✓ " : "✗ ") + desc.padEnd(32) + (esError ? "error controlado: " : "bien: ") + texto);
}
console.error(fallos ? "Inspector: " + fallos + " fallo(s)" : "Inspector: todo correcto");
process.exit(fallos ? 1 : 0);
