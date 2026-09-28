/*
 * Plantillas de peticiones (los «prompts» de MCP, docs/PROMPT_EXTENSION.md §5.10): cuatro
 * peticiones preparadas que Claude Desktop ofrece para empezar sin escribir. Cada una pide
 * lo mínimo (la carpeta, la finalidad o los archivos) y le dice a Claude qué herramientas
 * encadenar.
 *
 * El texto usa ${arguments.<nombre>}, igual que el campo «prompts» de manifest.json, que
 * se copia de aquí (tests/plantillas.test.mjs comprueba que coinciden). Por eso un dato
 * opcional que llega vacío tiene que leerse bien: «(si no pone nada, …)».
 *
 * Las plantillas no leen ningún documento: solo devuelven el texto de la petición.
 */
export const PLANTILLAS = [
  {
    nombre: "tachar_carpeta",
    titulo: "Tachar todos los documentos de una carpeta",
    descripcion: "Crea copias tachadas de todos los PDF y fotos de una carpeta, sin tocar los originales, y una hoja para revisarlas.",
    argumentos: [
      { nombre: "carpeta", descripcion: "La carpeta con los documentos (por ejemplo, Alquiler o Documentos/Nóminas).", obligatorio: true },
      { nombre: "dejar_visible", descripcion: "Nombres o datos que deben quedar sin tachar, separados por comas (por ejemplo, el nombre de tu empresa). Déjalo vacío si no hay ninguno.", obligatorio: false },
    ],
    texto: "Quiero tachar los datos personales de todos los documentos de la carpeta «${arguments.carpeta}» con la extensión docuprivado.\n" +
      "Nombres o datos que deben quedar visibles (si no pone nada, ninguno): ${arguments.dejar_visible}\n\n" +
      "Hazlo así:\n" +
      "1. Mira con listar_documentos qué hay en esa carpeta, sin abrir nada. Si no la encuentras o hay varias con ese nombre, pregúntame cuál es.\n" +
      "2. Tacha con tachar_documentos todos los PDF (también escaneados) y fotos de la carpeta, dejando visible lo que he dicho arriba. Si todos son del mismo tipo (nóminas, contratos, capturas), usa ese perfil.\n" +
      "3. Dime cuántas copias has creado y dónde, qué no se ha podido tachar y por qué, y recuérdame revisar las copias con la hoja de revisión antes de enviarlas.\n" +
      "Los Word y los textos no se tachan: si hay alguno, dímelo y ofréceme anonimizarlo. No me enseñes los datos que encuentres salvo que te lo pida.",
  },
  {
    nombre: "preparar_dni",
    titulo: "Preparar mi DNI para entregarlo",
    descripcion: "Copia protegida del DNI, NIE, carnet de conducir o pasaporte: recortada a su tamaño real y con una marca de agua que dice para qué es.",
    argumentos: [
      { nombre: "finalidad", descripcion: "Para qué es la copia (por ejemplo, alquiler de vivienda, abrir una cuenta en el banco, el hotel). Si son varios trámites, sepáralos con comas.", obligatorio: true },
      { nombre: "fotos", descripcion: "Las fotos o el escaneo del documento (sus nombres o la carpeta donde están). Déjalo vacío para que Claude las busque.", obligatorio: false },
    ],
    texto: "Prepárame una copia protegida de mi documento de identidad con la extensión docuprivado.\n" +
      "Para qué es: ${arguments.finalidad}\n" +
      "Fotos o escaneo (si no pone nada, búscalos tú): ${arguments.fotos}\n\n" +
      "Hazlo así:\n" +
      "1. Si no te he dicho las fotos, búscalas con listar_documentos (imágenes o PDF con «dni», «nie», «pasaporte» o «carnet» en el nombre). Si hay varias posibles, pregúntame cuáles son.\n" +
      "2. Haz la copia con proteger_copia_dni, con la marca de agua de la finalidad de arriba, en PDF A4 para imprimir o entregar. Si hay varios trámites, una copia para cada uno.\n" +
      "3. Dime dónde está la copia y recuérdame abrirla para comprobar que las dos caras se ven bien antes de entregarla.",
  },
  {
    nombre: "anonimizar_para_ia",
    titulo: "Anonimizar un documento antes de pasárselo a una IA",
    descripcion: "Crea una copia de tus Word o textos con los datos personales cambiados por etiquetas, para pasársela a ChatGPT u otra IA, y la tabla para devolverle después los datos reales.",
    argumentos: [
      { nombre: "archivos", descripcion: "El archivo o los archivos (Word o texto) que quieres pasar a la IA, o la carpeta donde están.", obligatorio: true },
    ],
    texto: "Quiero pasarle a una IA (ChatGPT u otra) estos documentos sin sus datos personales: ${arguments.archivos}\n\n" +
      "Hazlo así con la extensión docuprivado:\n" +
      "1. Anonimízalos con anonimizar_archivo. Si son varios, juntos, con una sola tabla, para que la misma persona lleve la misma etiqueta en todos.\n" +
      "2. Dime dónde están las copias anónimas y la tabla, y dame la instrucción que tengo que pegarle a la IA para que respete las etiquetas.\n" +
      "3. Recuérdame que guarde la tabla y que, cuando tenga la respuesta de la IA en un archivo, te pida devolverle los datos reales (con restaurar_archivo).\n" +
      "Si alguno es un PDF o una foto, no se puede anonimizar: dímelo y ofréceme tacharlo. No me enseñes el texto ni los datos salvo que te lo pida.",
  },
  {
    nombre: "comparar_contrato",
    titulo: "Ver qué ha cambiado en un contrato",
    descripcion: "Compara la versión que conoces de un contrato con la nueva y te dice qué ha cambiado, con los cambios importantes primero.",
    argumentos: [
      { nombre: "original", descripcion: "La versión anterior, la que conoces o firmaste (Word, PDF o texto).", obligatorio: true },
      { nombre: "nuevo", descripcion: "La versión nueva, la que te mandan ahora (Word, PDF o texto).", obligatorio: true },
    ],
    texto: "Quiero saber qué ha cambiado en un contrato.\n" +
      "Versión anterior (la que conozco o firmé): ${arguments.original}\n" +
      "Versión nueva (la que me mandan ahora): ${arguments.nuevo}\n\n" +
      "Hazlo así con la extensión docuprivado:\n" +
      "1. Compáralas con comparar_documentos. Si no encuentras alguno de los dos archivos, búscalo con listar_documentos y pregúntame si hay dudas.\n" +
      "2. Resúmeme primero los cambios importantes (importes, fechas y plazos, cláusulas nuevas o quitadas, palabras delicadas como penalización o renuncia), con su antes y después, y luego el resto en pocas frases.\n" +
      "3. Dime dónde están el informe y el Word con control de cambios, y recuérdame que la comparación es orientativa.",
  },
];

// Pone los datos en el texto. Lo que no llega (o llega vacío) se queda en blanco.
export function rellenar(plantilla, datos = {}) {
  return plantilla.texto.replace(/\$\{arguments\.([a-z_]+)\}/g, (_, nombre) => String(datos[nombre] ?? "").trim());
}

// Lo que va en el campo «prompts» de manifest.json.
export function paraManifiesto() {
  return PLANTILLAS.map((p) => ({ name: p.nombre, description: p.descripcion, arguments: p.argumentos.map((a) => a.nombre), text: p.texto }));
}
