/*
 * proteger_copia_dni (docs/PROMPT_EXTENSION.md §5.8): prepara la copia del DNI, NIE o TIE,
 * carnet de conducir o pasaporte que se entrega en un trámite, igual que el Kit DNI de la web
 * (/dni/): recorta y endereza cada cara a su tamaño real, le funde una marca de agua que dice
 * para qué es la copia y la guarda en un PDF A4 para imprimir, en dos imágenes o en una sola
 * (server/core/copia-dni.js). Nunca modifica las fotos originales y nunca devuelve lo que
 * pone en el documento.
 * Mejoras del hito 5 (aprobadas por el titular): las dos caras en una sola foto o una sola hoja
 * escaneada; cada cara derecha y en su sitio sin pedirlo (con el lector de escaneados); y
 * varias copias de una vez, una por trámite.
 */
import path from "node:path";
import * as z from "zod/v4";
import {
  DOCUMENTOS, FORMATOS, LARGO_MAX_MARCA, abrirCaras, buscarDosCaras, comprobarImagen, comprobarPdf, crearPdf, fundirMarca, guardarJuntos,
  imagenJpg, nombreDeMarca, prepararCara, reconocerCara, textoDeMarca, unirCaras,
} from "../core/copia-dni.js";
import { ErrorUsuario } from "../core/errores.js";
import { respuesta } from "../core/respuestas.js";
import { carpetaDeSalida, resolver } from "../core/rutas.js";
import { tipoDeArchivo } from "../core/tipos-archivo.js";

const GIROS = z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]);
const NOMBRE_CARA = { delantera: "parte delantera", trasera: "parte trasera", datos: "página de datos" };
const MAX_MARCAS = 10;
// Documentos cuya trasera lleva las líneas «<<<<» de abajo (la delantera no): así se sabe
// qué cara es cuál. El carnet de conducir no las lleva.
const CON_LINEAS_DETRAS = new Set(["dni", "nie_tie"]);

const hoyIso = (d = new Date()) => d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");

// Un archivo de las caras: tiene que estar en las carpetas autorizadas y ser una foto o un PDF.
function archivoDeCara(ctx, entrada) {
  const r = resolver(ctx, entrada);
  const nombre = path.basename(r.ruta);
  const tipo = tipoDeArchivo(r.ruta);
  if (tipo !== "imagen" && tipo !== "pdf") {
    throw new ErrorUsuario("«" + nombre + "» no es una foto (JPG, PNG, WebP o HEIC) ni un PDF: dime la foto del documento.", "formato");
  }
  return { ruta: r.ruta, nombre };
}

// Las finalidades pedidas, limpias, sin repetir y comprobadas (como la casilla de la web).
function finalidades(params) {
  const lista = (Array.isArray(params.texto_marca) ? params.texto_marca : [params.texto_marca])
    .map((t) => String(t == null ? "" : t).replace(/\s+/g, " ").trim()).filter(Boolean);
  const unicas = [];
  for (const t of lista) if (!unicas.some((u) => u.toLowerCase() === t.toLowerCase())) unicas.push(t);
  if (!unicas.length && !params.sin_marca) {
    throw new ErrorUsuario("Antes de preparar la copia necesito saber para qué es, para escribirlo en la marca de agua (por ejemplo, «Solo para alquiler de vivienda»). " +
      "Pregúntaselo al usuario y vuelve a pedírmelo con texto_marca. Solo si dice expresamente que no quiere marca, usa sin_marca.", "sinMarca");
  }
  if (unicas.length > MAX_MARCAS) throw new ErrorUsuario("Como mucho " + MAX_MARCAS + " copias de una vez (me has pedido " + unicas.length + ").", "demasiadasMarcas");
  for (const base of unicas) {
    if (base.length > LARGO_MAX_MARCA) {
      throw new ErrorUsuario("El texto de la marca es demasiado largo (" + base.length + " caracteres; como mucho " + LARGO_MAX_MARCA + "): con uno más corto se lee mejor. Por ejemplo, «Solo para alquiler de vivienda».", "marcaLarga");
    }
    const hueco = /\[[^\]]*\]/.exec(base);
    if (hueco) throw new ErrorUsuario("La marca tiene un hueco sin rellenar («" + hueco[0] + "»): cámbialo por el texto de verdad (por ejemplo, el nombre de la empresa).", "marcaHueco");
  }
  return unicas;
}

export function definir(ctx) {
  return {
    nombre: "proteger_copia_dni",
    config: {
      title: "Preparar la copia del DNI con marca de agua",
      description: "Prepara la copia del DNI (también NIE o TIE, carnet de conducir o pasaporte) que se entrega en un trámite, como el Kit DNI de docuprivado.es: " +
        "busca el documento en cada foto, lo recorta y endereza a su tamaño real, lo pone derecho y le funde una marca de agua repetida en diagonal con la finalidad y la fecha " +
        "(«Solo para alquiler de vivienda · 28/09/2026»), para que no sirva para otra cosa. Guarda un PDF A4 con las dos caras a tamaño real para imprimir " +
        "(por defecto), dos imágenes o una sola imagen con las dos caras, en una subcarpeta «docuprivado» junto a la foto (o en la carpeta de resultados). " +
        "Si se piden varias finalidades (texto_marca como lista), hace una copia para cada una. " +
        "Nunca modifica las fotos originales ni devuelve lo que pone en el documento. " +
        "IMPORTANTE: si el usuario no ha dicho para qué es la copia, pregúntaselo antes de llamarla («¿Para qué vas a entregar la copia? Lo escribo en la marca de agua»). " +
        "No inventes la finalidad. Solo si dice expresamente que no quiere marca, usa sin_marca. " +
        "Las caras pueden ser fotos (JPG, PNG, WebP, HEIC) o un PDF (la primera página es la delantera y la segunda, la trasera); " +
        "si las dos caras están en la misma foto o en la misma hoja escaneada, basta con pasarla como delantera: las separa sola. " +
        "No tacha datos (para eso, tachar_documentos).",
      inputSchema: z.object({
        delantera: z.string().min(1).describe("Foto o PDF de la parte delantera (en el pasaporte, la página de datos): ruta completa, relativa a una carpeta autorizada o solo el nombre. " +
          "Si es un PDF de dos páginas, la segunda se usa como trasera; si en la foto o la hoja escaneada están las dos caras, se separan solas."),
        trasera: z.string().optional().describe("Foto o PDF de la parte trasera. No hace falta con el pasaporte ni si las dos caras están en la misma foto."),
        documento: z.enum(Object.keys(DOCUMENTOS)).optional().describe("dni (por defecto), nie_tie, carnet_conducir o pasaporte."),
        texto_marca: z.union([z.string(), z.array(z.string()).min(1).max(MAX_MARCAS)]).optional().describe(
          "Para qué es la copia, tal como debe leerse en la marca (por ejemplo «Solo para alquiler de vivienda», «Solo para apertura de cuenta en Banco Ejemplo»). " +
          "Máximo " + LARGO_MAX_MARCA + " caracteres. Una lista (por ejemplo [\"Solo para la inmobiliaria\", \"Solo para el banco\"]) hace una copia distinta para cada trámite. " +
          "Pregúntaselo al usuario si no lo ha dicho."),
        sin_marca: z.boolean().optional().describe("true solo si el usuario ha dicho expresamente que no quiere marca de agua."),
        anadir_fecha: z.boolean().optional().describe("Añadir la fecha de hoy a la marca (por defecto, sí)."),
        salida: z.enum(["pdf_a4", "imagenes", "imagen_unica"]).optional().describe("pdf_a4 (por defecto): una hoja A4 con las caras a tamaño real, para imprimir o enviar; " +
          "imagenes: un JPG por cara; imagen_unica: las dos caras en un solo JPG (cómodo para enviarlo por WhatsApp o correo)."),
        recorte_automatico: z.boolean().optional().describe("Buscar el documento en la foto y enderezarlo (por defecto, sí). false si la foto ya es el documento recortado, como un escaneo o una captura."),
        girar_delantera: GIROS.optional().describe("Grados que girar la delantera en el sentido de las agujas del reloj, solo si en una copia anterior salió mal (normalmente la pone derecha sola): " +
          "180 si salió del revés, 90 o 270 si salió de lado."),
        girar_trasera: GIROS.optional().describe("Lo mismo para la trasera."),
        estilo: z.enum(["diagonal", "franja"]).optional().describe("diagonal (por defecto): el texto repetido en diagonal por todo el documento; franja: una banda con el texto en el centro."),
        color: z.enum(["gris", "rojo", "azul"]).optional().describe("Color de la marca (por defecto, gris oscuro)."),
        tamano_marca: z.enum(["pequeno", "mediano", "grande"]).optional().describe("Tamaño del texto de la marca (por defecto, mediano)."),
        opacidad: z.number().int().min(25).max(60).optional().describe("Opacidad de la marca en %, de 25 a 60 (por defecto, 40)."),
        linea_finalidad: z.boolean().optional().describe("Solo en el PDF: escribir arriba de la hoja «Copia de DNI · <marca>»."),
        es_copia: z.boolean().optional().describe("Solo en el PDF: añadir debajo «Es copia» y una línea para firmar."),
        carpeta_salida: z.string().optional().describe("Carpeta donde guardar la copia (dentro de las autorizadas). Si no se indica, se usa la elegida al instalar o una subcarpeta «docuprivado» junto a la foto."),
      }),
      outputSchema: z.object({
        archivos: z.array(z.string()),
        copias: z.array(z.object({ marca: z.string().nullable(), archivos: z.array(z.string()) })),
        documento: z.string(),
        salida: z.string(),
        marca: z.string().nullable(),
        caras: z.array(z.object({
          cara: z.string(), origen: z.string(), pagina: z.number().nullable(), mismaFoto: z.boolean(),
          recorte: z.enum(["automatico", "ya_recortada", "sin_bordes", "sin_recortar"]), confianza: z.string().nullable(), borrosa: z.boolean(),
          girada: z.number(), puestaDerecha: z.boolean(),
        })),
        carasCambiadas: z.boolean(),
        medidas: z.string(),
        avisos: z.array(z.string()),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    fn: async (params) => {
      const clave = params.documento || "dni";
      const doc = DOCUMENTOS[clave];
      const salida = params.salida || "pdf_a4";
      const avisos = [];

      // 1. Las marcas: hace falta saber para qué es la copia (salvo que no se quiera marca).
      const bases = finalidades(params);
      const marcas = [];
      for (const base of bases) marcas.push(await textoDeMarca(base, params.anadir_fecha !== false));
      if (!marcas.length) marcas.push("");

      // 2. Las caras: una foto por cara, un PDF con las dos o las dos en la misma foto.
      const delantera = archivoDeCara(ctx, params.delantera);
      let trasera = params.trasera && String(params.trasera).trim() ? archivoDeCara(ctx, params.trasera) : null;
      if (trasera && doc.caras === 1) {
        avisos.push("El pasaporte solo lleva la página de datos: no he usado «" + trasera.nombre + "».");
        trasera = null;
      }
      if (trasera && trasera.ruta.toLowerCase() === delantera.ruta.toLowerCase()) {
        throw new ErrorUsuario("Me has dado el mismo archivo para las dos caras («" + delantera.nombre + "»). Dime cuál es la foto de la trasera o, si las dos caras están en esa misma foto, pásamela solo como delantera.", "mismaFoto");
      }
      const carpeta = carpetaDeSalida(ctx, delantera.ruta, params.carpeta_salida && params.carpeta_salida.trim() ? params.carpeta_salida : null);
      const abiertas = await abrirCaras(delantera, doc.caras === 2 && !trasera ? 2 : 1);
      const automatico = params.recorte_automatico !== false;
      const fuentes = [{ cara: doc.caras === 1 ? "datos" : "delantera", archivo: delantera, ...abiertas[0], girar: params.girar_delantera, mismaFoto: false }];
      if (trasera) {
        const [t] = await abrirCaras(trasera, 1);
        fuentes.push({ cara: "trasera", archivo: trasera, ...t, girar: params.girar_trasera, mismaFoto: false });
      } else if (abiertas[1]) {
        fuentes.push({ cara: "trasera", archivo: delantera, ...abiertas[1], girar: params.girar_trasera, mismaFoto: false });
      } else if (doc.caras === 2 && automatico) {
        // Mejora 1: ¿están las dos caras en esta misma foto u hoja escaneada?
        const dos = await buscarDosCaras(fuentes[0].img, doc.formato);
        if (dos) {
          fuentes[0].deteccion = dos[0];
          fuentes[0].mismaFoto = true;
          fuentes.push({ cara: "trasera", archivo: delantera, img: fuentes[0].img, pagina: fuentes[0].pagina, deteccion: dos[1], girar: params.girar_trasera, mismaFoto: true });
        }
      }

      // 3. Recortar y enderezar cada cara y, si no se ha dicho cómo girarla, ponerla derecha y
      //    ver si es la trasera (mejora 2).
      const caras = [];
      for (const f of fuentes) {
        const r = await prepararCara(f.img, doc.formato, { automatico, girar: f.girar || 0, deteccion: f.deteccion });
        let puestaDerecha = false;
        let lineasDeAbajo = false;
        let pareceDocumento = null;
        if (f.girar == null) {
          const rec = await reconocerCara(r.img);
          r.img = rec.img;
          puestaDerecha = rec.delReves;
          lineasDeAbajo = rec.lineasDeAbajo;
          pareceDocumento = rec.pareceDocumento;
        }
        caras.push({ ...r, cara: f.cara, origen: f.archivo.nombre, pagina: f.pagina, mismaFoto: f.mismaFoto, girada: (f.girar || 0) + (puestaDerecha ? 180 : 0), puestaDerecha, lineasDeAbajo, pareceDocumento });
      }
      fuentes.length = 0;   // las fotos abiertas ya no hacen falta
      // La trasera del DNI y del NIE lleva las líneas «<<<<» de abajo y la delantera no: si
      // vienen al revés, se cambian de sitio; si solo hay una y es la trasera, se dice.
      let carasCambiadas = false;
      if (CON_LINEAS_DETRAS.has(clave)) {
        if (caras.length === 2 && caras[0].lineasDeAbajo && !caras[1].lineasDeAbajo) {
          caras.reverse();
          caras[0].cara = "delantera";
          caras[1].cara = "trasera";
          carasCambiadas = true;
        } else if (caras.length === 1 && caras[0].lineasDeAbajo) {
          caras[0].cara = "trasera";
        }
      }

      // 4. Una copia por finalidad: la marca fundida y el archivo final, comprobado antes de
      //    guardarlo. El recorte es el mismo para todas.
      const formato = FORMATOS[doc.formato];
      const fecha = hoyIso();
      const varias = marcas.length > 1;
      const copias = [];
      for (const marca of marcas) {
        const cfg = { texto: marca, estilo: params.estilo, color: params.color, tamano: params.tamano_marca, opacidad: params.opacidad == null ? 0.4 : params.opacidad / 100 };
        const imagenes = [];
        for (const c of caras) imagenes.push(await fundirMarca({ data: Uint8Array.from(c.img.data), width: c.img.width, height: c.img.height }, cfg));
        const base = doc.archivo + (varias ? "-" + (nombreDeMarca(marca.replace(/ · \d{2}\/\d{2}\/\d{4}$/, "")) || "copia-" + (copias.length + 1)) : "");
        let archivos;
        if (salida === "pdf_a4") {
          const pdf = await crearPdf(imagenes, doc, marca, { linea: !!params.linea_finalidad, esCopia: !!params.es_copia });
          const problemas = await comprobarPdf(pdf.bytes, imagenes.length, doc.formato, pdf.textos);
          if (problemas.length) throw new ErrorUsuario("No he guardado la copia porque no ha pasado la comprobación final (" + problemas.join("; ") + "). Prueba en docuprivado.es/dni/ y avísanos.", "comprobacion");
          archivos = [{ nombre: base + "-" + fecha, ext: ".pdf", datos: pdf.bytes }];
        } else if (salida === "imagen_unica") {
          const unica = unirCaras(imagenes);
          const datos = imagenJpg(unica);
          const problemas = comprobarImagen(datos, unica.width, unica.height);
          if (problemas.length) throw new ErrorUsuario("No he guardado la copia porque no ha pasado la comprobación final (" + problemas.join("; ") + ").", "comprobacion");
          archivos = [{ nombre: base + "-" + fecha, ext: ".jpg", datos }];
        } else {
          archivos = imagenes.map((img, i) => {
            const datos = imagenJpg(img);
            const problemas = comprobarImagen(datos, formato.px[0], formato.px[1]);
            if (problemas.length) throw new ErrorUsuario("No he guardado la copia porque no ha pasado la comprobación final (" + problemas.join("; ") + ").", "comprobacion");
            return { nombre: base + (imagenes.length > 1 ? "-" + caras[i].cara : "") + "-" + fecha, ext: ".jpg", datos };
          });
        }
        copias.push({ marca: marca || null, archivos: guardarJuntos(ctx, carpeta, archivos) });
      }
      const rutas = copias.flatMap((c) => c.archivos);

      // 5. La respuesta: qué se ha hecho con cada cara y qué revisar.
      const l = [];
      const enQue = salida === "pdf_a4" ? " en PDF" : salida === "imagen_unica" && caras.length > 1 ? " (las dos caras en una sola imagen)" : caras.length > 1 ? " en dos imágenes" : "";
      if (varias) {
        l.push("He preparado " + copias.length + " copias protegidas de tu " + doc.nombre + enQue + ", una para cada trámite, en " + carpeta + ":");
        copias.forEach((c) => l.push("- «" + c.marca + "»: " + c.archivos.map((a) => path.basename(a)).join(" y ") + "."));
      } else if (rutas.length === 1) {
        l.push("He preparado la copia protegida de tu " + doc.nombre + enQue + ": " + rutas[0] + ".");
      } else {
        l.push("He preparado la copia protegida de tu " + doc.nombre + enQue + ", en " + path.dirname(rutas[0]) + ": " + rutas.map((r) => path.basename(r)).join(" y ") + ".");
      }
      if (marcas[0]) {
        l.push((varias ? "Cada una lleva su marca de agua" : "Marca de agua: «" + marcas[0] + "»") + ", " + (params.estilo === "franja" ? "en una franja" : "repetida en diagonal") +
          " y fundida en la imagen (no es una capa que se pueda quitar).");
      } else {
        l.push("Sin marca de agua, como has pedido: quien la reciba podría reutilizarla para otra cosa.");
      }
      if (caras.some((c) => c.mismaFoto)) l.push("Las dos caras estaban en la misma " + (caras[0].pagina ? "hoja" : "foto") + " («" + delantera.nombre + "»): las he separado.");
      if (carasCambiadas) l.push("Las caras venían cambiadas (la trasera es la de las líneas «<<<<» de abajo): las he puesto en su sitio.");
      for (const c of caras) {
        const quien = NOMBRE_CARA[c.cara] + (c.mismaFoto ? "" : c.pagina ? " (página " + c.pagina + " de «" + c.origen + "»)" : " («" + c.origen + "»)");
        let texto;
        if (c.recorte === "automatico") texto = c.confianza === "alta" ? "recortada y enderezada automáticamente." : "recortada y enderezada automáticamente; revisa que se ve entera, no estaba del todo seguro de los bordes.";
        else if (c.recorte === "ya_recortada") texto = "la foto ya era el documento entero; revisa que no le falta nada.";
        else if (c.recorte === "sin_recortar") texto = "puesta entera, sin recortar, como has pedido.";
        else {
          texto = "no he encontrado bien los bordes del documento, así que va la foto entera, sin recortar. Para un recorte limpio, hazle otra foto con el documento entero sobre una mesa lisa " +
            "y de otro color, con buena luz y sin reflejos (o prepárala en docuprivado.es/dni/, donde se pueden ajustar las esquinas a mano).";
        }
        if (c.puestaDerecha) texto += " Estaba del revés: la he girado.";
        if (c.borrosa) texto += " Se ve borrosa: puede que no te la acepten; si puedes, hazle otra foto.";
        l.push("- " + quien.charAt(0).toUpperCase() + quien.slice(1) + ": " + texto);
      }
      if (doc.caras === 2 && caras.length === 1) {
        l.push(caras[0].cara === "trasera"
          ? "La cara que me has dado es la trasera (la de las líneas «<<<<»). Si te piden las dos, dime dónde está la foto de la delantera y la preparo con la misma marca."
          : "Solo me has dado una cara. Si te piden las dos, dime dónde está la foto de la trasera y la preparo con la misma marca.");
      }
      // Hito de actualización 17: sin bordes de tarjeta y sin ningún rótulo de un documento de
      // identidad, puede que no sea la foto correcta (una captura, una carta): se avisa claro.
      for (const c of caras) {
        if (c.recorte === "sin_bordes" && c.pareceDocumento === false) {
          avisos.push("Ojo: «" + c.origen + "» no parece " + (clave === "pasaporte" ? "un pasaporte" : "un documento de identidad") + " (no he encontrado los bordes de una tarjeta ni sus rótulos, como «Apellidos» o «Nacionalidad»). " +
            "Comprueba que es la foto correcta antes de entregar la copia; si no lo es, dime cuál es.");
        }
      }
      avisos.forEach((a) => l.push(a));
      if (salida === "pdf_a4") l.push("Al imprimirla, elige «Tamaño real» o «100 %» para que salga con sus medidas exactas (" + formato.mm + ").");
      l.push((rutas.length > 1 ? "Ábrelas y revísalas" : "Ábrela y revísala") + " antes de entregarla. Si alguna cara ha salido girada o del revés, dímelo y la giro.");

      return respuesta(l.join("\n"), {
        archivos: rutas,
        copias,
        documento: clave,
        salida,
        marca: marcas[0] || null,
        caras: caras.map((c) => ({
          cara: c.cara, origen: c.origen, pagina: c.pagina, mismaFoto: c.mismaFoto, recorte: c.recorte, confianza: c.confianza, borrosa: c.borrosa,
          girada: c.girada % 360, puestaDerecha: c.puestaDerecha,
        })),
        carasCambiadas,
        medidas: formato.mm,
        avisos,
      });
    },
  };
}
