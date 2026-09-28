/*
 * Qué sabe hacer la extensión y cómo pedírselo. La ayuda (ayuda_docuprivado) enseña
 * solo lo que ya está disponible en esta versión y anuncia lo que está en preparación,
 * para no prometer nada que todavía no funciona (CLAUDE.md §4.6).
 */
export const ENLACE = "https://docuprivado.es/claude/";

// Una fila por capacidad: la herramienta que la hace, si ya está disponible y una frase
// de ejemplo (las 8 frases de la versión 1.0 salen de aquí).
export const CAPACIDADES = [
  { herramienta: "listar_documentos", disponible: true, que: "Buscar y listar tus documentos (PDF, imágenes, Word y texto) en las carpetas autorizadas.",
    ejemplos: ["Busca las nóminas que tengo en Documentos.", "¿Qué PDF he guardado en Descargas esta semana?"] },
  { herramienta: "analizar_datos_personales", disponible: true, que: "Contar los datos personales de un PDF o una foto sin modificarlo (sin enseñártelos, salvo que lo pidas).",
    ejemplos: ["¿Qué datos personales hay en nomina-septiembre.pdf?", "Enséñame los DNI que aparecen en ese documento."] },
  { herramienta: "tachar_documentos", disponible: true, que: "Tachar los datos personales de PDF (también escaneados) y de fotos o capturas, de uno en uno o de una carpeta entera, con copias nuevas y una hoja para revisarlas.",
    ejemplos: ["Tacha los datos personales de todas las nóminas de la carpeta Alquiler.", "Tacha los PDF de Contratos, pero deja visible el nombre de mi empresa.", "Este contrato está escaneado: tápale el DNI y la dirección."] },
  { herramienta: "limpiar_metadatos_imagen", disponible: true, que: "Quitar la ubicación y los datos ocultos de tus fotos (también las HEIC del iPhone), sin tocar los originales.",
    ejemplos: ["Quita la ubicación de todas las fotos de la carpeta Viaje."] },
  { herramienta: "anonimizar_archivo", disponible: true, que: "Anonimizar archivos de texto y Word (conservando su formato), uno o un expediente entero con una sola tabla, antes de pasárselos a una IA, y devolverles los datos reales después.",
    ejemplos: ["Anonimiza correo-cliente.docx para pasárselo a ChatGPT.", "Devuelve los datos reales a respuesta-ia.txt con la tabla de antes."] },
  { herramienta: "proteger_copia_dni", disponible: true, que: "Preparar la copia del DNI (también NIE o TIE, carnet de conducir o pasaporte): recortada a su tamaño real y con una marca de agua que dice para qué es, en PDF para imprimir o en imágenes.",
    ejemplos: ["Prepara mi DNI para alquilar un piso: las fotos son dni-frente.jpg y dni-detras.jpg.", "Hazme una copia de mi pasaporte solo para el hotel, en una imagen para mandarla por WhatsApp.", "Tengo el DNI escaneado por las dos caras en dni-escaneado.pdf: prepárame una copia para la inmobiliaria y otra para el banco."] },
  { herramienta: "comparar_documentos", disponible: true, que: "Comparar dos versiones de un contrato (Word, PDF, también escaneado, o texto) y decirte qué ha cambiado, con los cambios importantes primero, un informe con todo y la versión nueva en Word con control de cambios.",
    ejemplos: ["¿Qué ha cambiado entre contrato-v1.docx y contrato-v2.docx?"] },
];

export function capacidadesDisponibles() {
  return CAPACIDADES.filter((c) => c.disponible);
}
