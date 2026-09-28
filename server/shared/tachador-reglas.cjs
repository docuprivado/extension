/*
 * docuprivado.es · Tachador: reglas para montar el texto de una página, sin pantalla.
 *
 * Deciden dónde van los espacios, los tabuladores y los saltos de línea al leer un PDF
 * (con pdf.js) o un escaneo (con el lector de texto), y de ellas depende que el detector
 * encuentre bien los datos. También dicen dónde van los tachados en los escaneos y las
 * fotos, leen lo escrito en los campos de los formularios rellenables y dicen qué campos
 * hay que tapar. Se usan en el tachador (js/tachador-texto.js y
 * js/tachador-ocr.js), en el comparador (escaneados) y en la extensión para Claude
 * Desktop, que copia este archivo tal cual (../docuprivado-claude, docs/PROGRESO.md,
 * «Proyecto hermano»). Por eso no toca el DOM y también funciona en Node.
 *
 * Se descarga junto con el primer documento, como el resto del motor del tachador.
 */
(function (global) {
  "use strict";

  // Una página con menos caracteres visibles que esto se trata como escaneada.
  const MINIMO_TEXTO = 20;

  // Muchos PDF no guardan los espacios entre trozos de texto: los colocan a su
  // sitio y ya. Sin esta separación, «Fdo.: Tomás Herrero» y «Fdo.: Marta Gil»
  // (a los dos lados de la misma línea) se leían pegados y fallaban la búsqueda
  // y el detector. Se deduce de la posición: otra línea, otra columna o un espacio.
  function separador(a, b) {
    const ta = a.transform;
    const tb = b.transform;
    if (!ta || !tb) return " ";
    const girado = Math.abs(ta[1]) > 0.01 || Math.abs(ta[2]) > 0.01 || Math.abs(tb[1]) > 0.01 || Math.abs(tb[2]) > 0.01;
    if (girado) return " ";
    const alto = Math.max(Math.abs(ta[3]) || 0, Math.abs(tb[3]) || 0, 1);
    if (Math.abs(ta[5] - tb[5]) > alto * 0.5) return "\n";
    const hueco = tb[4] - (ta[4] + (a.width || 0));
    if (hueco > alto * 2.5) return "\t";
    if (hueco > alto * 0.15) return " ";
    if (hueco < -alto) return "\n";
    return "";
  }

  // Texto de una página de PDF a partir de los trozos de pdf.js (getTextContent).
  // Devuelve el texto y, por cada trozo con texto, dónde empieza y acaba en él.
  function montarTextoPdf(trozos) {
    let texto = "";
    const items = [];
    let previo = null;        // el último trozo con texto de esta línea
    let huboEspacio = false;  // entre medias había un trozo que solo era un espacio
    (trozos || []).forEach((it) => {
      if (typeof it.str !== "string") return;
      if (/\S/.test(it.str)) {
        if (previo) {
          let sep = separador(previo, it);
          if (sep === " " && (/\s$/.test(texto) || /^\s/.test(it.str))) sep = "";
          if (!sep && huboEspacio && !/\s$/.test(texto)) sep = " ";
          texto += sep;
        }
        const inicio = texto.length;
        texto += it.str;
        items.push({ inicio: inicio, fin: texto.length, it: it });
        previo = it;
        huboEspacio = false;
      } else if (it.str) {
        huboEspacio = true;   // la separación la decide la posición del trozo siguiente
      }
      if (it.hasEOL) {
        texto += "\n";
        previo = null;
        huboEspacio = false;
      }
    });
    return { texto: texto, items: items };
  }

  // ¿Tiene la página texto de verdad, o es una imagen escaneada?
  function tieneTexto(texto) {
    return String(texto || "").replace(/\s/g, "").length >= MINIMO_TEXTO;
  }

  // ¿Dibuja la página alguna imagen? (con su lista de operaciones de pdf.js: fnArray y OPS)
  // Una página con poco texto y sin ninguna imagen no es un escaneo: está casi en blanco
  // («Página 1 de 3»). Antes se leía con el lector de escaneados, que no encontraba nada, y
  // se avisaba de que no se podía leer (hito de actualización 17).
  function dibujaImagen(fnArray, OPS) {
    if (!fnArray || !OPS) return true;   // sin poder mirarlo, como antes: se lee
    const imagenes = ["paintImageXObject", "paintInlineImageXObject", "paintImageMaskXObject", "paintImageXObjectRepeat",
      "paintImageMaskXObjectRepeat", "paintImageMaskXObjectGroup", "paintInlineImageXObjectGroup", "paintSolidColorImageMask"]
      .map((n) => OPS[n]).filter((n) => n !== undefined);
    return fnArray.some((f) => imagenes.indexOf(f) !== -1);
  }

  // ------------------------------------------------------------ datos escondidos
  // «Tachado falso» (hito de actualización 18): un dato que está en el texto del PDF pero no
  // se ve en la página dibujada, así que cualquiera puede copiarlo aunque parezca tapado.
  // Se mira la franja central de su rectángulo (sin el margen del tachado): si es toda del
  // mismo tono, ahí no hay ninguna letra a la vista. Oscura: hay un recuadro encima
  // («tapado»); clara o de otro color: la letra es del color del fondo o invisible
  // («invisible»). Y una letra de menos de 3 puntos no se lee («diminuto»).
  // px: { datos (4 bytes por píxel, RGBA o BGRA), ancho, alto, fila (bytes por fila;
  // ancho × 4 si no se da), inicio (primer byte; 0) }. rect: en píxeles de esa imagen.
  // tam: tamaño de la letra en puntos, si se sabe. Devuelve el motivo o null (se ve).
  const LETRA_MINIMA = 3;
  function escondido(px, rect, tam) {
    if (tam != null && tam > 0 && tam < LETRA_MINIMA) return "diminuto";
    const x0 = Math.max(0, Math.round(rect.x + rect.w * 0.12));
    const x1 = Math.min(px.ancho, Math.round(rect.x + rect.w * 0.88));
    const y0 = Math.max(0, Math.round(rect.y + rect.h * 0.3));
    const y1 = Math.min(px.alto, Math.round(rect.y + rect.h * 0.7));
    if (x1 - x0 < 3 || y1 - y0 < 1) return null;   // demasiado pequeño para saberlo
    const fila = px.fila || px.ancho * 4;
    const base = px.inicio || 0;
    const d = px.datos;
    let min = 765;
    let max = 0;
    let suma = 0;
    for (let y = y0; y < y1; y++) {
      for (let x = x0, i = base + y * fila + x0 * 4; x < x1; x++, i += 4) {
        const l = d[i] + d[i + 1] + d[i + 2];
        if (l < min) min = l;
        if (l > max) max = l;
        suma += l;
      }
    }
    if (max - min >= 120) return null;   // hay letras (o algo) a la vista
    return suma / ((x1 - x0) * (y1 - y0)) < 300 ? "tapado" : "invisible";
  }

  // Cada casilla puede buscar más de un tipo: con las direcciones van los
  // códigos postales, con el DNI el NIE, con el IBAN las cuentas antiguas y con
  // las empresas su NIF.
  function tiposDeCasillas(tipos) {
    const extra = { direccion: "cp", dni: "nie", iban: "cuenta", empresa: "cif" };
    const out = tipos.slice();
    Object.keys(extra).forEach((t) => { if (tipos.indexOf(t) !== -1) out.push(extra[t]); });
    return out;
  }

  // ------------------------------------------------------------ escaneos
  // Entre dos palabras de una línea, un espacio; si hay mucho hueco, un tabulador:
  // son dos columnas que el lector ha leído como una sola línea («PÉREZ GARCÍA, JUAN»
  // y a su lado «EMPRESA FICTICIA, S.L.»), igual que en los PDF con texto.
  function separacion(a, b, alto) {
    if (!a.bbox || !b.bbox) return " ";
    return b.bbox.x0 - a.bbox.x1 > 2.5 * Math.max(1, alto.y1 - alto.y0) ? "\t" : " ";
  }

  // El lector de escaneados devuelve las palabras agrupadas en bloques, párrafos
  // y líneas; otras versiones las daban en una lista plana. Valen las dos.
  function lineasDeOcr(datos) {
    if (!datos) return [];
    const lineas = [];
    (datos.blocks || []).forEach((bloque) => {
      (bloque.paragraphs || []).forEach((parrafo) => {
        (parrafo.lines || []).forEach((linea) => {
          const palabras = (linea.words || []).filter((w) => w && w.text);
          if (palabras.length) lineas.push({ palabras: palabras, bbox: linea.bbox });
        });
      });
    });
    if (lineas.length) return lineas;
    let actual = null;
    let anterior = null;
    (datos.words || []).forEach((palabra) => {
      if (!palabra || !palabra.text) return;
      if (!actual || palabra.line !== anterior) {
        actual = { palabras: [], bbox: null };
        lineas.push(actual);
      }
      anterior = palabra.line;
      actual.palabras.push(palabra);
    });
    return lineas;
  }

  // Alto de una línea leída: el de su caja o, si no viene, el de sus palabras.
  function altoDeLinea(linea) {
    if (linea.bbox && linea.bbox.y1 > linea.bbox.y0) return { y0: linea.bbox.y0, y1: linea.bbox.y1 };
    let y0 = Infinity;
    let y1 = -Infinity;
    linea.palabras.forEach((p) => {
      if (!p.bbox) return;
      y0 = Math.min(y0, p.bbox.y0);
      y1 = Math.max(y1, p.bbox.y1);
    });
    return isFinite(y0) ? { y0: y0, y1: y1 } : { y0: 0, y1: 0 };
  }

  // Texto de un escaneo a partir de lo que devuelve el lector ({ blocks } o { words }).
  // «escala»: píxeles de la imagen leída por unidad de página. Devuelve el texto y, por
  // palabra, dónde empieza y acaba en él y su rectángulo en la página.
  function montarTextoOcr(datos, escala) {
    const lineas = lineasDeOcr(datos);
    let texto = "";
    const items = [];
    lineas.forEach((linea, iLinea) => {
      if (iLinea) texto += "\n";
      // El alto del tachado es el de la línea (letras con rabitos y tildes
      // incluidas), no el de cada palabra: así todas las barras de una línea
      // miden lo mismo y ninguna invade la línea de arriba ni la de abajo.
      const alto = altoDeLinea(linea);
      linea.palabras.forEach((palabra, iPalabra) => {
        if (iPalabra) texto += separacion(linea.palabras[iPalabra - 1], palabra, alto);
        const inicio = texto.length;
        texto += palabra.text || "";
        const caja = palabra.bbox;
        if (!caja) return;
        const y0 = Math.min(caja.y0, alto.y0);
        const y1 = Math.max(caja.y1, alto.y1);
        items.push({
          inicio: inicio, fin: texto.length,
          rect: {
            x: caja.x0 / escala, y: y0 / escala,
            w: (caja.x1 - caja.x0) / escala, h: (y1 - y0) / escala,
          },
        });
      });
    });
    return { texto: texto, items: items };
  }

  // ------------------------------------------------------ dónde van los tachados
  // Un poco de margen alrededor, proporcional a la letra (nunca más de «margen»).
  function ensanchar(r, margen) {
    const tam = r.tam || r.h;
    const mx = Math.min(margen, Math.max(0.4, tam * 0.12));
    const my = Math.min(margen, tam * 0.04);
    return { x: r.x - mx, y: r.y - my, w: r.w + mx * 2, h: r.h + my * 2 };
  }

  // Une rectángulos contiguos de la misma línea para que el tachado sea uno solo.
  function unir(rects) {
    if (rects.length < 2) return rects;
    const out = [];
    rects.slice().sort((a, b) => a.y - b.y || a.x - b.x).forEach((r) => {
      const ultimo = out[out.length - 1];
      if (ultimo && Math.abs(ultimo.y - r.y) < 3 && r.x - (ultimo.x + ultimo.w) < 6) {
        const derecha = Math.max(ultimo.x + ultimo.w, r.x + r.w);
        ultimo.x = Math.min(ultimo.x, r.x);
        ultimo.w = derecha - ultimo.x;
        ultimo.h = Math.max(ultimo.h, r.h);
      } else {
        out.push({ x: r.x, y: r.y, w: r.w, h: r.h });
      }
    });
    return out;
  }

  // Tachados de un trozo del texto leído de un escaneo o una foto (montarTextoOcr), en
  // unidades de la página. El lector da una caja por palabra, no por letra: la parte de
  // la caja se calcula por el número de letras, y como no todas miden lo mismo, un dato que
  // acaba o empieza dentro de una palabra podía dejar asomar media letra («12345678Z.»
  // dejaba ver media Z). Por eso (hito de actualización 11):
  // - si lo que queda de la palabra son solo signos (el punto, la coma, un paréntesis),
  //   se tapa la palabra entera;
  // - si el corte cae entre letras, se ensancha media letra hacia fuera.
  const LETRA = /[0-9A-Za-zÀ-ÿ]/;
  function rectangulosLeidos(pagina, inicio, fin, margen) {
    const texto = String(pagina.texto || "");
    const salida = [];
    (pagina.items || []).forEach((e) => {
      if (!e.rect || e.fin <= inicio || e.inicio >= fin) return;
      const largo = e.fin - e.inicio;
      if (!largo) return;
      const palabra = texto.slice(e.inicio, e.fin);
      let desde = Math.max(0, inicio - e.inicio);
      let hasta = Math.min(largo, fin - e.inicio);
      if (desde > 0 && !LETRA.test(palabra.slice(0, desde))) desde = 0;
      if (hasta < largo && !LETRA.test(palabra.slice(hasta))) hasta = largo;
      const a = desde > 0 ? Math.max(0, desde - 0.5) : 0;
      const b = hasta < largo ? Math.min(largo, hasta + 0.5) : largo;
      const r = e.rect;
      const rect = { x: r.x + (a / largo) * r.w, y: r.y, w: ((b - a) / largo) * r.w, h: r.h };
      if (rect.w > 0 && rect.h > 0) salida.push(ensanchar(rect, margen));
    });
    return unir(salida);
  }

  // ------------------------------------------------------ formularios rellenables
  // Lo escrito en los campos de un formulario no forma parte del texto de la página, pero
  // sí se ve en ella (y en la copia tachada). Estas reglas lo leen, lo pasan por el
  // detector y dicen qué campos hay que tapar enteros.

  // Campos de texto y de lista rellenos (no casillas ni firmas), a partir de las
  // anotaciones de pdf.js (page.getAnnotations()): nombre, ayuda, valor y rectángulo en
  // coordenadas del PDF.
  function camposDeFormulario(anotaciones) {
    const campos = [];
    (anotaciones || []).forEach((a) => {
      if (!a || a.subtype !== "Widget" || (a.fieldType !== "Tx" && a.fieldType !== "Ch") || !a.rect) return;
      const bruto = Array.isArray(a.fieldValue) ? a.fieldValue.join(", ") : (a.fieldValue == null ? "" : String(a.fieldValue));
      const valor = bruto.trim();
      if (!valor) return;
      campos.push({ nombre: String(a.fieldName || ""), ayuda: String(a.alternativeText || ""), valor: valor, rect: a.rect });
    });
    return campos;
  }

  // Por el nombre de un campo («nombre_solicitante», «dni», «cuentaIban»…), qué dato suele
  // llevar: sirve de rótulo para el detector y, si el detector no reconoce el valor, para
  // taparlo igualmente como dudoso («revisa»).
  const ROTULOS_CAMPO = [
    [/\b(dni|nif|nie|pasaporte|documento)\b/, "DNI", "dni"],
    [/\b(iban|ccc|cuenta|bancari[oa])\b/, "IBAN", "iban"],
    [/\b(telefono|tfno|tlf|movil|fijo)\b/, "Teléfono", "telefono"],
    [/\b(e ?mail|correo)\b/, "Correo electrónico", "email"],
    [/\b(nombre|apellidos?|titular|solicitante|firmante|interesad[oa]|representante|arrendatari[oa]|arrendadora?|trabajadora?)\b/, "Nombre", "nombre"],
    [/\b(domicilio|direccion|calle|via|residencia)\b/, "Domicilio", "direccion"],
    [/\b(cp|codigo postal|postal)\b/, "Código postal", "cp"],
    [/\b(nacimiento|f ?nac)\b/, "Fecha de nacimiento", "fecha_nac"],
    [/\b(matricula)\b/, "Matrícula", "matricula"],
    [/\b(tarjeta)\b/, "Tarjeta", "tarjeta"],
    [/\b(afiliacion|seguridad social|nss|naf)\b/, "N.º afiliación S.S.", "nss"],
  ];
  function rotuloDeCampo(campo) {
    const n = (campo.nombre + " " + campo.ayuda).replace(/([a-z])([A-Z])/g, "$1 $2")   // «nombreHijo» → «nombre Hijo»
      .normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ");
    for (let i = 0; i < ROTULOS_CAMPO.length; i++) {
      if (ROTULOS_CAMPO[i][0].test(n)) return { rotulo: ROTULOS_CAMPO[i][1], tipo: ROTULOS_CAMPO[i][2] };
    }
    return null;
  }

  // Los campos que hay que tapar: el detector sobre lo escrito (con el rótulo delante,
  // «DNI: …», si el nombre del campo lo sugiere) y, si el nombre del campo dice que es un
  // dato personal y el detector no lo reconoce («nombre_hijo: Xiana»), también, como dudoso.
  // detect: DP_DETECT.detect. opciones: { tipos, personalizados }.
  // Devuelve [{ tipo, valor, confianza, campo (su nombre), rect }].
  function detectarEnCampos(detect, campos, opciones) {
    const salida = [];
    (campos || []).forEach((c) => {
      const r = rotuloDeCampo(c);
      const prefijo = r ? r.rotulo + ": " : "";
      const encontrados = detect(prefijo + c.valor, { tipos: opciones.tipos, personalizados: opciones.personalizados || [], ocr: false })
        .filter((m) => m.fin > prefijo.length);
      let marca = null;
      if (encontrados.length) {
        const alta = encontrados.filter((m) => m.confianza === "alta");
        const m = alta[0] || encontrados[0];
        marca = { tipo: m.tipo, confianza: alta.length ? "alta" : m.confianza };
      } else if (r && opciones.tipos.indexOf(r.tipo) !== -1 && /[0-9A-Za-zÀ-ÿ]{2}/.test(c.valor)) {
        marca = { tipo: r.tipo, confianza: "media" };
      }
      if (marca) salida.push({ tipo: marca.tipo, valor: c.valor, confianza: marca.confianza, campo: c.nombre || "(sin nombre)", rect: c.rect });
    });
    return salida;
  }

  const API = {
    MINIMO_TEXTO: MINIMO_TEXTO,
    camposDeFormulario: camposDeFormulario,
    rotuloDeCampo: rotuloDeCampo,
    detectarEnCampos: detectarEnCampos,
    separador: separador,
    montarTextoPdf: montarTextoPdf,
    tieneTexto: tieneTexto,
    dibujaImagen: dibujaImagen,
    escondido: escondido,
    tiposDeCasillas: tiposDeCasillas,
    separacion: separacion,
    lineasDeOcr: lineasDeOcr,
    altoDeLinea: altoDeLinea,
    montarTextoOcr: montarTextoOcr,
    ensanchar: ensanchar,
    unir: unir,
    rectangulosLeidos: rectangulosLeidos,
  };
  global.DP_TACHADOR_REGLAS = API;
  if (typeof module !== "undefined" && module.exports) module.exports = API;
})(typeof globalThis !== "undefined" ? globalThis : this);
