/*
 * docuprivado.es · Comparador: el motor (docs/PROMPT_INICIAL.md §10)
 *
 * No toca la pantalla: recibe párrafos y devuelve los cambios. Así funciona
 * igual en la página, en el trabajador en segundo plano (js/workers/comparar.js)
 * y en las pruebas (tests/comparador/). Necesita diff_match_patch
 * (lib/vendor/diff_match_patch.js) para comparar.
 *
 * Pasos:
 * 1. Texto → párrafos (texto pegado, Word o PDF, con cabeceras, pies y números
 *    de página quitados y las palabras partidas a final de línea unidas).
 * 2. Alinear los párrafos de las dos versiones sin tener en cuenta la numeración
 *    inicial («CUARTA.», «4.», «Cláusula 4.ª»): renumerar no es un cambio.
 * 3. Los párrafos quitados y añadidos que se parecen (coeficiente de Dice > 0,5)
 *    son modificaciones, y se comparan palabra a palabra.
 * 4. Cambios importantes: importes, fechas y plazos, cláusulas nuevas y palabras
 *    delicadas añadidas.
 * 5. (Hito de actualización 15) Un párrafo quitado en un sitio y añadido en otro que
 *    dice lo mismo es un párrafo «movido». Y si uno de los documentos es un escaneo, los
 *    párrafos cuyos cambios son solo de lectura (espacios, letras que se confunden, un
 *    signo por otro) se marcan como posibles errores de lectura y se cuentan aparte.
 * 6. (Hito de actualización 17) Las cantidades sin «€» con formato de dinero (1.500,00) y
 *    los cambios de cuenta bancaria también son importantes; un dato que está en un párrafo
 *    quitado y en uno añadido no cuenta como cambio; y en un texto con una frase o una
 *    cláusula por línea, cada línea es un párrafo, como en el PDF.
 */
(function (global) {
  "use strict";

  const DP = global.DP || (global.DP = {});
  DP.tools = DP.tools || {};

  // ------------------------------------------------------------------ texto

  function quitarTildes(s) {
    return String(s).normalize("NFD").replace(/[̀-ͯ]/g, "");
  }

  // Lo que se ve: espacios seguidos, espacios duros y saltos, como un espacio.
  function limpiar(s) {
    return String(s == null ? "" : s).replace(/[  -​  　\t\r\n ]+/g, " ").trim();
  }

  // Lo que se compara: además, comillas, apóstrofos y guiones de un solo tipo.
  function normalizar(s) {
    return limpiar(s)
      .replace(/[“”„«»]/g, "\"")
      .replace(/[‘’‚´`]/g, "'")
      .replace(/[‐-―−]/g, "-")
      .replace(/…/g, "...");
  }

  // ------------------------------------------------------------ numeración

  const ORDINALES = "(?:primer|segund|tercer|cuart|quint|sext|s[eé]ptim|setim|octav|noven|d[eé]cim|und[eé]cim|" +
    "duod[eé]cim|decimo\\s?(?:primer|segund|tercer|cuart|quint|sext|s[eé]ptim|octav|noven)|" +
    "vig[eé]sim|trig[eé]sim|cuadrag[eé]sim)(?:[oa]s?|o?\\s?(?:primer|segund|tercer|cuart|quint|sext|s[eé]ptim|octav|noven)[oa])?";
  const ROMANOS = "(?=[IVXLC]{1,6}\\b)M{0,1}(?:C[MD]|D?C{0,3})(?:X[CL]|L?X{0,3})(?:I[XV]|V?I{0,3})";
  const NUMERO = "\\d{1,3}(?:\\s?[.,]\\s?\\d{1,3}){0,3}\\s?(?:[ºª°]|\\.[ºª°])?";
  const PALABRA_CLAUSULA = "(?:cl[aá]usula|art[ií]culo|art\\.|estipulaci[oó]n|apartado|ep[ií]grafe|punto|anexo|secci[oó]n|cap[ií]tulo)";
  // «3.ª», «4.º»: el indicador ordinal ya cierra la marca, aunque no lleve más signos.
  const NUM_ORDINAL = "\\d{1,3}\\s?\\.?\\s?[ºª°]\\.?";
  // Una marca de numeración al principio del párrafo y su puntuación (sin
  // confundir «1.250 euros» con «1.» seguido de texto).
  const RE_NUMERACION = new RegExp("^\\s*(?:(?:(?:" + PALABRA_CLAUSULA + ")\\s+)?" + NUM_ORDINAL + "\\s*(?:[.:)\\-–—]\\s*-?)?(?=\\s)|" +
    "(?:(?:" + PALABRA_CLAUSULA + ")\\s+(?:" + NUMERO + "|" + ORDINALES + "|" + ROMANOS + ")|" + ORDINALES + "|" + ROMANOS + "|" + NUMERO +
    "|[a-zñ])\\s*(?:[.:)\\-–—]\\s*-?|\\s+-\\s+)(?!\\d))\\s*", "i");
  // Para saber si un párrafo empieza una cláusula (no vale una letra suelta).
  const RE_CLAUSULA = new RegExp("^\\s*(?:(?:" + PALABRA_CLAUSULA + ")\\s+(?:" + NUMERO + "|" + ORDINALES + "|" + ROMANOS +
    ")|" + ORDINALES + "|" + ROMANOS + "|" + NUMERO + ")\\s*(?:[.:)\\-–—]|\\s+-\\s+)", "i");

  function quitarNumeracion(s) {
    const m = RE_NUMERACION.exec(s);
    if (!m) return s;
    const resto = s.slice(m[0].length);
    // «I. Que el…» sí; «A la firma…» no: una sola letra solo con punto o paréntesis.
    if (/^\s*[a-zñ]\s*[.:)]/i.test(m[0]) && !/^\s*[a-zñ]\s*[.)]\s/i.test(m[0])) return s;
    return resto.length ? resto : s;
  }

  // Clave para alinear: sin numeración, en minúsculas y sin puntuación al final.
  function clave(s) {
    return normalizar(quitarNumeracion(normalizar(s))).toLowerCase().replace(/[\s.;:,]+$/, "");
  }

  // «TERCERA. Renta» a partir del principio de una cláusula.
  function titulo(s) {
    const texto = limpiar(s);
    const m = RE_CLAUSULA.exec(texto);
    if (!m) return "";
    const tras = texto.slice(m[0].length).trim();
    const t = /^([^.:]{2,60})[.:]\s/.exec(tras + " ");
    const marca = m[0].replace(/[\s.:)\-–—]+$/, "");
    return t && t[1].split(/\s+/).length <= 7 ? marca + ". " + t[1] : marca;
  }

  // -------------------------------------------------------- texto a párrafos

  // Texto pegado o de un .txt: párrafos separados por líneas en blanco o, si no
  // hay ninguna, uno por línea. Dentro de un bloque, si casi todas sus líneas acaban
  // la frase (una cláusula o una frase por línea, no un párrafo partido en varias
  // líneas), cada línea que acaba en punto cierra su párrafo; y una cláusula
  // («SEGUNDA.», «3.») empieza párrafo si la línea anterior acaba en punto. Antes el
  // mismo contrato en .txt y en PDF salía con 7 cambios (hito de actualización 17).
  const FIN_FRASE = /[.:;!?»"”]\s*$/;
  function parrafosDeTexto(texto) {
    const t = String(texto || "").replace(/\r\n?/g, "\n").replace(/­/g, "");
    const bloques = /\n[ \t ]*\n/.test(t) ? t.split(/\n[ \t ]*\n+/) : t.split("\n");
    const out = [];
    bloques.forEach((b) => {
      const lineas = b.split("\n").filter((l) => limpiar(l));
      const acabadas = lineas.slice(0, -1).filter((l) => FIN_FRASE.test(l)).length;
      const porLinea = lineas.length > 1 && acabadas >= (lineas.length - 1) * 0.5;
      let actual = [];
      lineas.forEach((l, i) => {
        const nuevo = i > 0 && FIN_FRASE.test(lineas[i - 1]) && (porLinea || RE_CLAUSULA.test(limpiar(l)));
        if (nuevo) {
          out.push(unirLineas(actual));
          actual = [];
        }
        actual.push(l);
      });
      out.push(unirLineas(actual));
    });
    return out.filter((p) => p);
  }

  // Une las líneas de un párrafo: «indepen-» + «dencia» → «independencia».
  function unirLineas(lineas) {
    let out = "";
    lineas.forEach((l) => {
      const linea = limpiar(l);
      if (!linea) return;
      if (!out) out = linea;
      else if (/[a-záéíóúüñ]-$/i.test(out) && /^[a-záéíóúüñ]/.test(linea)) out = out.slice(0, -1) + linea;
      else out += " " + linea;
    });
    return out;
  }

  // Número de página suelto: «3», «- 3 -», «Página 3», «3 de 10», «3/10».
  const RE_NUM_PAGINA = /^[-–—\s]*(?:p[aá]g(?:ina)?\.?\s*)?\d{1,4}(?:\s*(?:de|\/|of)\s*\d{1,4})?[-–—\s]*$/i;

  // PDF: cada página trae sus trozos de texto {str, x, y, w, h, eol} con la y
  // medida desde abajo, como en el PDF. Se agrupan en líneas por su altura y en
  // párrafos por la separación entre líneas; se quitan cabeceras y pies
  // repetidos y los números de página. Con { ocr: true } (texto leído de un
  // escaneo), el alto de cada línea depende de sus letras y no del tamaño de
  // la letra, así que solo cuenta la separación entre líneas.
  function parrafosDePdf(paginas, opciones) {
    const ocr = !!(opciones && opciones.ocr);
    const lineasPorPagina = paginas.map(lineasDePagina);
    // Cabeceras y pies: líneas iguales (cambiando los números por #) en más de la
    // mitad de las páginas, arriba o abajo del todo.
    const repetidas = new Map();
    if (lineasPorPagina.length >= 2) {
      lineasPorPagina.forEach((lineas) => {
        const vistas = new Set();
        lineas.slice(0, 3).concat(lineas.slice(-3)).forEach((l) => {
          const k = l.texto.replace(/\d+/g, "#").toLowerCase();
          if (!vistas.has(k)) {
            vistas.add(k);
            repetidas.set(k, (repetidas.get(k) || 0) + 1);
          }
        });
      });
    }
    const mitad = lineasPorPagina.length / 2;
    const parrafos = [];
    let actual = [];
    let anterior = null;
    const cerrar = () => {
      const p = unirLineas(actual.map((l) => l.texto));
      if (p) parrafos.push(p);
      actual = [];
    };
    lineasPorPagina.forEach((lineas) => {
      const extremo = new Set(lineas.slice(0, 3).concat(lineas.slice(-3)));
      const limpias = lineas.filter((l) => {
        if (RE_NUM_PAGINA.test(l.texto) && extremo.has(l)) return false;
        const k = l.texto.replace(/\d+/g, "#").toLowerCase();
        return !(extremo.has(l) && lineasPorPagina.length >= 2 && (repetidas.get(k) || 0) > mitad);
      });
      const limite = limiteParrafo(limpias);
      limpias.forEach((l, i) => {
        let nuevo = false;
        if (!anterior) nuevo = true;
        else if (i === 0) {
          // Cambio de página: sigue el párrafo si la línea anterior no acababa en
          // punto (una frase partida entre páginas), aunque esta empiece con
          // mayúscula, salvo que empiece una cláusula.
          nuevo = /[.:;!?»"]$/.test(anterior.texto) || RE_CLAUSULA.test(l.texto);
        } else {
          const hueco = anterior.y - l.y;
          nuevo = hueco > limite || hueco < -2 ||
            (!ocr && (l.alto > anterior.alto * 1.25 || anterior.alto > l.alto * 1.25));
          // Documentos sin espacio entre párrafos: una cláusula («SEGUNDA.», «3.»…)
          // empieza párrafo si la línea anterior acaba en punto, dos puntos o punto y
          // coma, o si es mucho más corta que el ancho (un título). Antes hacían falta
          // las dos cosas, y un PDF con una cláusula por línea salía en un solo párrafo.
          if (!nuevo && RE_CLAUSULA.test(l.texto) &&
            (/[.:;]$/.test(anterior.texto) || anterior.fin < l.anchoTexto * 0.8)) nuevo = true;
        }
        if (nuevo) cerrar();
        actual.push(l);
        anterior = l;
      });
    });
    cerrar();
    return parrafos;
  }

  // A partir de qué separación entre dos líneas empieza otro párrafo. Se
  // ordenan las separaciones de la página y se busca el primer salto claro
  // (un 18 % o más): por debajo quedan las líneas de un mismo párrafo y por
  // encima los huecos entre párrafos. Si no hay salto, no se parte por hueco.
  function limiteParrafo(lineas) {
    const saltos = [];
    for (let i = 1; i < lineas.length; i++) {
      const d = lineas[i - 1].y - lineas[i].y;
      if (d > 0.5) saltos.push(d);
    }
    if (!saltos.length) return Infinity;
    saltos.sort((a, b) => a - b);
    for (let i = 1; i < saltos.length; i++) {
      if (saltos[i] >= saltos[i - 1] * 1.18 && saltos[i] - saltos[i - 1] >= 2) return (saltos[i - 1] + saltos[i]) / 2;
    }
    // Todas parecidas: o es un solo párrafo o los párrafos no dejan hueco.
    // Por si acaso, un hueco de más de dos líneas sí separa.
    return saltos[0] * 2;
  }

  function lineasDePagina(items) {
    const trozos = (items || []).filter((it) => it && it.str && /\S/.test(it.str))
      .map((it) => ({ str: it.str, x: it.x, y: it.y, w: it.w || 0, h: it.h || 10 }));
    trozos.sort((a, b) => b.y - a.y || a.x - b.x);
    const lineas = [];
    trozos.forEach((t) => {
      const l = lineas.length ? lineas[lineas.length - 1] : null;
      if (l && Math.abs(l.y - t.y) <= Math.max(2, Math.min(l.alto, t.h) * 0.5)) l.trozos.push(t);
      else lineas.push({ y: t.y, alto: t.h, trozos: [t] });
    });
    let derecha = 0;
    lineas.forEach((l) => {
      l.trozos.sort((a, b) => a.x - b.x);
      let texto = "";
      let fin = null;
      l.trozos.forEach((t) => {
        if (fin !== null) {
          const hueco = t.x - fin;
          if (hueco > l.alto * 0.12 && !/\s$/.test(texto) && !/^\s/.test(t.str)) texto += " ";
        }
        texto += t.str;
        fin = t.x + t.w;
      });
      l.texto = limpiar(texto);
      l.inicio = l.trozos[0].x;
      l.fin = fin;
      l.alto = Math.max.apply(null, l.trozos.map((t) => t.h));
      derecha = Math.max(derecha, fin);
    });
    lineas.forEach((l) => { l.anchoTexto = derecha; });
    return lineas.filter((l) => l.texto);
  }

  // --------------------------------------------------------- similitud (Dice)

  function palabrasDe(s) {
    return quitarTildes(normalizar(s).toLowerCase()).match(/[a-z0-9ñ]{3,}/g) || [];
  }

  function dice(a, b) {
    const pa = palabrasDe(a);
    const pb = palabrasDe(b);
    if (!pa.length || !pb.length) return 0;
    const cuenta = new Map();
    pa.forEach((p) => cuenta.set(p, (cuenta.get(p) || 0) + 1));
    let comunes = 0;
    pb.forEach((p) => {
      const n = cuenta.get(p) || 0;
      if (n > 0) {
        comunes++;
        cuenta.set(p, n - 1);
      }
    });
    return (2 * comunes) / (pa.length + pb.length);
  }

  // ---------------------------------------------------------------- diff

  function nuevoDmp() {
    const Dmp = global.diff_match_patch;
    if (typeof Dmp !== "function") throw new Error("Falta diff_match_patch");
    const dmp = new Dmp();
    dmp.Diff_Timeout = 2;
    return dmp;
  }

  // Cada elemento distinto pasa a ser un carácter, para comparar listas con
  // diff-match-patch (como su diff_linesToChars).
  function aCaracteres(listas) {
    const mapa = new Map();
    let siguiente = 0x100;
    return listas.map((lista) => lista.map((el) => {
      let c = mapa.get(el);
      if (c === undefined) {
        if (siguiente === 0xd800) siguiente = 0xe000;   // sin mitades de pares sustitutos
        c = String.fromCharCode(siguiente++);
        mapa.set(el, c);
      }
      return c;
    }).join(""));
  }

  // Palabras, números («1.250,50») y signos, con los espacios aparte, para
  // comparar palabra a palabra sin perder cómo se escribía.
  function trozos(s) {
    return String(s).match(/\s+|[\p{L}\p{N}]+(?:[.,'’/-][\p{L}\p{N}]+)*|[^\s\p{L}\p{N}]/gu) || [];
  }

  // Diferencias palabra a palabra: [[op, texto], …] con op -1 quitado, 1 añadido, 0 igual.
  function difPalabras(dmp, a, b) {
    const ta = trozos(a);
    const tb = trozos(b);
    const clavesA = ta.map((t) => (/^\s+$/.test(t) ? " " : normalizar(t)));
    const clavesB = tb.map((t) => (/^\s+$/.test(t) ? " " : normalizar(t)));
    const [ca, cb] = aCaracteres([clavesA, clavesB]);
    const difs = dmp.diff_main(ca, cb, false);
    dmp.diff_cleanupSemantic(difs);
    const out = [];
    let ia = 0;
    let ib = 0;
    difs.forEach((d) => {
      const n = d[1].length;
      let texto;
      if (d[0] === 0) {
        texto = tb.slice(ib, ib + n).join("");
        ia += n;
        ib += n;
      } else if (d[0] === -1) {
        texto = ta.slice(ia, ia + n).join("");
        ia += n;
      } else {
        texto = tb.slice(ib, ib + n).join("");
        ib += n;
      }
      const ultimo = out[out.length - 1];
      if (ultimo && ultimo[0] === d[0]) ultimo[1] += texto;
      else if (texto) out.push([d[0], texto]);
    });
    return out;
  }

  // ------------------------------------------------------ cambios importantes

  const NUM_LETRA = ["un", "uno", "una", "dos", "tres", "cuatro", "cinco", "seis", "siete", "ocho", "nueve", "diez",
    "once", "doce", "trece", "catorce", "quince", "dieciseis", "diecisiete", "dieciocho", "diecinueve", "veinte",
    "veintiun", "veintiuno", "veintiuna", "veintidos", "veintitres", "veinticuatro", "veinticinco", "veintiseis",
    "veintisiete", "veintiocho", "veintinueve", "treinta", "cuarenta", "cincuenta", "sesenta", "setenta", "ochenta",
    "noventa", "cien", "ciento", "doscientos", "doscientas", "trescientos", "trescientas", "cuatrocientos",
    "cuatrocientas", "quinientos", "quinientas", "seiscientos", "seiscientas", "setecientos", "setecientas",
    "ochocientos", "ochocientas", "novecientos", "novecientas", "mil", "millon", "millones"];
  const PAL_NUM = "(?:" + NUM_LETRA.join("|") + ")";
  const EN_LETRA = PAL_NUM + "(?:\\s+(?:y\\s+)?" + PAL_NUM + ")*";
  const CIFRA = "\\d{1,3}(?:[.\\s]\\d{3})+(?:,\\d{1,2})?|\\d+(?:[.,]\\d{1,2})?";
  // También las cantidades con formato de dinero aunque no lleven «€» («1.500,00», como en
  // las nóminas y los recibos), salvo si son un porcentaje (hito de actualización 17).
  const RE_IMPORTE = new RegExp("(?:(?:" + CIFRA + ")(?:\\s*(?:mil|millones?))?\\s*(?:€|eur\\b|euros?\\b)|(?:€|eur\\b)\\s*(?:" + CIFRA + ")|" +
    "\\b" + EN_LETRA + "\\s+(?:de\\s+)?euros?\\b|\\b\\d{1,3}(?:\\.\\d{3})*,\\d{2}\\b(?!\\s*(?:%|por\\s*ciento)))", "gi");
  // Cuentas bancarias: un IBAN (de cualquier país) o el número de cuenta antiguo. Un cambio
  // de cuenta es el engaño típico de una factura o un contrato falsos (hito de actualización 17).
  const RE_CUENTA = /\b(?:[a-z]{2}\d{2}[ -]?[a-z0-9]{4}(?:[ -]?\d{4}){3,6}(?:[ -]?\d{1,4})?|\d{4}[ -]?\d{4}[ -]?\d{2}[ -]?\d{10})(?![\w])/gi;
  const RE_PORCENTAJE = new RegExp("(?:(?:" + CIFRA + ")\\s*(?:%|por\\s*ciento\\b)|\\b" + EN_LETRA + "\\s+por\\s*ciento\\b)", "gi");
  const RE_PLAZO = new RegExp("\\b(?:\\d{1,4}|" + EN_LETRA + ")\\s+(?:dias?|semanas?|mes(?:es)?|anos?|anualidades?|mensualidades?|horas?)" +
    "(?:\\s+(?:habiles|naturales|laborables))?\\b", "gi");
  const MESES = "enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre";
  const RE_FECHA = new RegExp("\\b(?:\\d{1,2}[/.-]\\d{1,2}[/.-]\\d{2,4}|\\d{1,2}\\s+de\\s+(?:" + MESES + ")(?:\\s+de(?:l)?\\s+\\d{4})?|(?:" +
    MESES + ")\\s+de\\s+\\d{4})\\b", "gi");

  // Palabras delicadas de un contrato (PROMPT §10.4): se buscan con sus plurales.
  const SENSIBLES = ["penalización", "penalidad", "indemnización", "renuncia", "prórroga", "tácita", "automática",
    "exclusiva", "fianza", "garantía", "aval", "intereses", "recargo", "rescisión", "desistimiento", "responsabilidad",
    "subrogación", "cesión", "confidencialidad", "no competencia", "permanencia", "preaviso", "IPC", "actualización",
    "gastos", "comunidad", "IBI", "seguro"];
  const RE_SENSIBLES = SENSIBLES.map((p) => {
    const base = quitarTildes(p).toLowerCase().replace(/ /g, "\\s+");
    const plural = /[aeiou]$/.test(base) ? "s?" : /[nlrzd]$/.test(base) ? "(?:es)?" : "";
    return { palabra: p, re: new RegExp("\\b" + base + plural + "\\b", "g") };
  });

  function lista(re, texto) {
    const plano = quitarTildes(normalizar(texto));
    const orig = normalizar(texto);
    const out = [];
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(plano)) !== null) {
      out.push(orig.slice(m.index, m.index + m[0].length).trim());
      if (m.index === re.lastIndex) re.lastIndex++;
    }
    return out;
  }

  function entidades(texto) {
    const importes = lista(RE_IMPORTE, texto).concat(lista(RE_PORCENTAJE, texto));
    const plazos = lista(RE_PLAZO, texto);
    const fechas = lista(RE_FECHA, texto);
    // Las cuentas, sin espacios ni guiones y en mayúsculas: la misma escrita de otra forma
    // no es un cambio.
    const cuentas = lista(RE_CUENTA, texto).map((c) => c.replace(/[ -]/g, "").toUpperCase());
    return { importes: importes, fechas: fechas.concat(plazos), cuentas: cuentas };
  }

  function contarSensibles(texto) {
    const plano = quitarTildes(normalizar(texto)).toLowerCase();
    const out = new Map();
    RE_SENSIBLES.forEach((s) => {
      s.re.lastIndex = 0;
      const n = (plano.match(s.re) || []).length;
      if (n) out.set(s.palabra, n);
    });
    return out;
  }

  // Lo que está en una lista y no en la otra (contando repeticiones).
  function resta(a, b) {
    const quedan = new Map();
    b.forEach((x) => {
      const k = quitarTildes(x).toLowerCase().replace(/\s+/g, " ");
      quedan.set(k, (quedan.get(k) || 0) + 1);
    });
    return a.filter((x) => {
      const k = quitarTildes(x).toLowerCase().replace(/\s+/g, " ");
      const n = quedan.get(k) || 0;
      if (n > 0) {
        quedan.set(k, n - 1);
        return false;
      }
      return true;
    });
  }

  const unir = (l) => l.join(", ");

  // «excluir» (opcional): los datos que no cuentan como cambio en un párrafo quitado o
  // añadido porque también están en otro añadido o quitado (ver comparar).
  const claveDato = (x) => quitarTildes(x).toLowerCase().replace(/\s+/g, "");
  function importantes(tipo, a, b, excluir) {
    const out = [];
    const ea = entidades(a || "");
    const eb = entidades(b || "");
    const vale = (campo) => (x) => !(excluir && excluir[campo] && excluir[campo].has(claveDato(x)));
    [["importe", "importes"], ["plazo", "fechas"], ["cuenta", "cuentas"]].forEach(([etiqueta, campo]) => {
      const antes = resta(ea[campo], eb[campo]).filter(vale(campo));
      const despues = resta(eb[campo], ea[campo]).filter(vale(campo));
      if (antes.length || despues.length) out.push({ etiqueta: etiqueta, antes: unir(antes), despues: unir(despues) });
    });
    if (tipo === "anadido" && (RE_CLAUSULA.test(limpiar(b)) || palabrasDe(b).length >= 25)) {
      out.push({ etiqueta: "clausula", antes: "", despues: titulo(b) || recorte(b, 80) });
    }
    if (tipo !== "eliminado") {
      const sa = contarSensibles(a || "");
      const nuevas = [];
      contarSensibles(b || "").forEach((n, palabra) => { if (n > (sa.get(palabra) || 0)) nuevas.push(palabra); });
      if (nuevas.length) out.push({ etiqueta: "sensible", antes: "", despues: unir(nuevas) });
    }
    return out;
  }

  function recorte(s, n) {
    const t = limpiar(s);
    return t.length > n ? t.slice(0, n - 1).replace(/\s+\S*$/, "") + "…" : t;
  }

  // ------------------------------------------------- errores de lectura

  function levenshtein(a, b) {
    if (a === b) return 0;
    let fila = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
      const nueva = [i];
      for (let j = 1; j <= b.length; j++) {
        nueva[j] = Math.min(fila[j] + 1, nueva[j - 1] + 1, fila[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
      fila = nueva;
    }
    return fila[b.length];
  }

  // Letras y cifras que se confunden al leer una imagen: l, I, |, 1; O, 0, Q; S, 5; Z, 2; B, 8.
  function parecido(s) {
    return quitarTildes(s).toLowerCase().replace(/[l|!1iíì]/g, "1").replace(/[o0q]/g, "0").replace(/[s5]/g, "5").replace(/[z2]/g, "2").replace(/[b8]/g, "8");
  }

  // ¿Es este trozo cambiado un error al leer un escaneo? Solo espacios, letras que se
  // confunden, un signo cambiado por otro, una mancha suelta o una letra leída como cifra.
  // Nunca si cambia una cifra por otra (850 → 950, 30 → 15): un importe o un plazo no se
  // puede esconder.
  function tramoDeLectura(quitado, puesto) {
    const r = quitado.replace(/\s+/g, "");
    const a = puesto.replace(/\s+/g, "");
    if (r === a) return true;
    if (!r || !a) return /^[^\p{L}\p{N}]{1,2}$/u.test(r || a);
    if (parecido(r) === parecido(a)) return true;
    const n = Math.max(r.length, a.length);
    if (n > 40) return false;
    const dr = r.replace(/\D/g, "");
    const da = a.replace(/\D/g, "");
    if (dr !== da) {
      // Solo vale una cifra de más o de menos donde el otro lado tiene una letra de más
      // (12345678Z → 123456787).
      const letras = (s) => s.replace(/[^\p{L}]/gu, "").length;
      if (Math.abs(dr.length - da.length) !== 1 || levenshtein(dr, da) !== 1 || Math.abs(letras(r) - letras(a)) !== 1) return false;
    }
    const d = levenshtein(r, a);
    if (d > 2 || d > Math.max(2, n * 0.34)) return false;
    return /[^\p{L}\p{N}]/u.test(r + a) || (/\p{N}/u.test(r + a) && /\p{L}/u.test(r + a));
  }

  // Un párrafo modificado cuyos cambios son todos de lectura (hito de actualización 15).
  function errorDeLectura(ops) {
    const tramos = [];
    let quitado = "";
    let puesto = "";
    (ops || []).concat([[0, ""]]).forEach(([op, t]) => {
      if (op === 0) {
        if (quitado || puesto) tramos.push([quitado, puesto]);
        quitado = "";
        puesto = "";
      } else if (op === -1) quitado += t;
      else puesto += t;
    });
    return tramos.length > 0 && tramos.every(([q, p]) => tramoDeLectura(q, p));
  }

  // ------------------------------------------------------------ comparar

  // Empareja los quitados con los añadidos que se parecen, sin cruzarlos
  // (programación dinámica: la mayor suma de parecidos por encima de 0,5).
  function emparejar(quitados, anadidos, A, B) {
    const n = quitados.length;
    const m = anadidos.length;
    if (!n || !m) return [];
    if (n * m > 40000) return emparejarRapido(quitados, anadidos, A, B);
    const sim = quitados.map((i) => anadidos.map((j) => {
      const d = dice(A[i], B[j]);
      return d > 0.5 ? d : 0;
    }));
    const t = [];
    for (let i = 0; i <= n; i++) t.push(new Float64Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        t[i][j] = Math.max(t[i + 1][j], t[i][j + 1], sim[i][j] ? sim[i][j] + t[i + 1][j + 1] : 0);
      }
    }
    const pares = [];
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (sim[i][j] && t[i][j] === sim[i][j] + t[i + 1][j + 1]) {
        pares.push([quitados[i], anadidos[j]]);
        i++;
        j++;
      } else if (t[i][j] === t[i + 1][j]) i++;
      else j++;
    }
    return pares;
  }

  // Con muchísimos párrafos seguidos: cada quitado con el primer añadido
  // parecido que venga detrás del último emparejado.
  function emparejarRapido(quitados, anadidos, A, B) {
    const pares = [];
    let desde = 0;
    quitados.forEach((i) => {
      for (let k = desde; k < Math.min(anadidos.length, desde + 50); k++) {
        if (dice(A[i], B[anadidos[k]]) > 0.5) {
          pares.push([i, anadidos[k]]);
          desde = k + 1;
          break;
        }
      }
    });
    return pares;
  }

  // Dónde está un párrafo: la cláusula a la que pertenece o su número.
  function ubicaciones(P) {
    let actual = "";
    let dentro = 0;
    return P.map((p, i) => {
      const t = titulo(p);
      if (t) {
        actual = t;
        dentro = 0;
        return t;
      }
      dentro++;
      return actual ? actual + " (párrafo " + (dentro + 1) + ")" : "Párrafo " + (i + 1);
    });
  }

  // opciones.escaneado: alguno de los dos documentos es un escaneo leído automáticamente;
  // entonces los párrafos cuyos cambios son solo de lectura se marcan aparte (lectura: true).
  function comparar(A, B, opciones) {
    const escaneado = !!(opciones && opciones.escaneado);
    A = (A || []).map(limpiar).filter(Boolean);
    B = (B || []).map(limpiar).filter(Boolean);
    const dmp = nuevoDmp();
    const [ca, cb] = aCaracteres([A.map(clave), B.map(clave)]);
    const difs = dmp.diff_main(ca, cb, false);

    // Filas en orden, con los tramos de quitados y añadidos entre iguales.
    const filas = [];
    let ia = 0;
    let ib = 0;
    let quitados = [];
    let anadidos = [];
    const vaciar = () => {
      const pares = emparejar(quitados, anadidos, A, B);
      const conPar = new Map(pares.map((p) => [p[0], p[1]]));
      const usados = new Set(pares.map((p) => p[1]));
      // Se intercalan para que cada modificación quede en su sitio.
      let j = 0;
      quitados.forEach((i) => {
        const par = conPar.get(i);
        if (par !== undefined) {
          while (j < anadidos.length && anadidos[j] !== par) {
            if (!usados.has(anadidos[j])) filas.push({ tipo: "anadido", a: null, b: anadidos[j] });
            j++;
          }
          filas.push({ tipo: "modificado", a: i, b: par });
          j++;
        } else {
          filas.push({ tipo: "eliminado", a: i, b: null });
        }
      });
      for (; j < anadidos.length; j++) if (!usados.has(anadidos[j])) filas.push({ tipo: "anadido", a: null, b: anadidos[j] });
      quitados = [];
      anadidos = [];
    };
    difs.forEach((d) => {
      const n = d[1].length;
      for (let k = 0; k < n; k++) {
        if (d[0] === 0) {
          vaciar();
          // Mismo contenido: solo es un cambio si varía algo más que la numeración.
          const igual = normalizar(quitarNumeracion(normalizar(A[ia]))) === normalizar(quitarNumeracion(normalizar(B[ib])));
          filas.push({ tipo: igual ? "igual" : "modificado", a: ia, b: ib });
          ia++;
          ib++;
        } else if (d[0] === -1) {
          quitados.push(ia++);
        } else {
          anadidos.push(ib++);
        }
      }
    });
    vaciar();

    // Párrafos movidos (hito de actualización 15): uno quitado en un sitio y añadido en otro
    // que dice lo mismo, o casi (parecido de 0,65 o más sin contar la numeración), es el mismo
    // párrafo cambiado de sitio. Donde estaba queda la fila quitada, marcada («movidoA»);
    // donde está ahora, el cambio.
    const sueltosA = filas.filter((f) => f.tipo === "eliminado");
    const sueltosB = filas.filter((f) => f.tipo === "anadido");
    const colocados = new Set();
    sueltosA.forEach((fa) => {
      let mejor = null;
      let nota = 0.65;
      sueltosB.forEach((fb) => {
        if (colocados.has(fb)) return;
        const d = dice(quitarNumeracion(A[fa.a]), quitarNumeracion(B[fb.b]));
        if (d >= nota) {
          nota = d;
          mejor = fb;
        }
      });
      if (!mejor) return;
      colocados.add(mejor);
      mejor.tipo = "movido";
      mejor.a = fa.a;
      fa.destino = mejor;
    });

    const dondeA = ubicaciones(A);
    const dondeB = ubicaciones(B);
    const cambios = [];
    filas.forEach((f) => {
      if (f.tipo === "igual" || f.destino) return;
      const ta = f.a !== null ? A[f.a] : "";
      const tb = f.b !== null ? B[f.b] : "";
      const mismo = f.tipo === "movido" && clave(ta) === clave(tb);
      const c = {
        id: cambios.length,
        tipo: f.tipo,
        a: f.a,
        b: f.b,
        donde: f.b !== null ? dondeB[f.b] : dondeA[f.a],
        importantes: mismo ? [] : importantes(f.tipo === "movido" ? "modificado" : f.tipo, ta, tb),
      };
      if (f.tipo === "modificado" || f.tipo === "movido") c.palabras = difPalabras(dmp, ta, tb);
      if (f.tipo === "movido") c.desde = dondeA[f.a];
      if (escaneado && f.tipo === "modificado" && errorDeLectura(c.palabras)) {
        c.lectura = true;
        c.importantes = [];
      }
      f.cambio = c.id;
      cambios.push(c);
    });
    filas.forEach((f) => {
      if (!f.destino) return;
      f.movidoA = f.destino.cambio;
      delete f.destino;
    });
    // Un dato (importe, fecha o cuenta) que está en un párrafo quitado y también en uno
    // añadido no ha cambiado: entre dos nóminas con otro teléfono, la línea de la antigüedad
    // sale como quitada y añadida, y su fecha, la misma, salía dos veces como cambio
    // importante (hito de actualización 17).
    const enQuitados = { importes: new Set(), fechas: new Set(), cuentas: new Set() };
    const enAnadidos = { importes: new Set(), fechas: new Set(), cuentas: new Set() };
    cambios.forEach((c) => {
      const destino = c.tipo === "eliminado" ? enQuitados : c.tipo === "anadido" ? enAnadidos : null;
      if (!destino) return;
      const e = entidades(c.tipo === "eliminado" ? A[c.a] : B[c.b]);
      Object.keys(destino).forEach((campo) => e[campo].forEach((x) => destino[campo].add(claveDato(x))));
    });
    const comunes = {};
    let hayComunes = false;
    Object.keys(enQuitados).forEach((campo) => {
      comunes[campo] = new Set([...enQuitados[campo]].filter((k) => enAnadidos[campo].has(k)));
      if (comunes[campo].size) hayComunes = true;
    });
    if (hayComunes) {
      cambios.forEach((c) => {
        if (c.tipo === "eliminado") c.importantes = importantes("eliminado", A[c.a], "", comunes);
        else if (c.tipo === "anadido") c.importantes = importantes("anadido", "", B[c.b], comunes);
      });
    }
    // Los errores de lectura se cuentan aparte: no son cambios de verdad.
    const reales = cambios.filter((c) => !c.lectura);
    const cuenta = (t) => reales.filter((c) => c.tipo === t).length;
    return {
      a: A,
      b: B,
      filas: filas,
      cambios: cambios,
      resumen: {
        total: reales.length,
        anadidos: cuenta("anadido"),
        eliminados: cuenta("eliminado"),
        modificados: cuenta("modificado"),
        movidos: cuenta("movido"),
        importantes: reales.filter((c) => c.importantes.length).length,
        lectura: cambios.length - reales.length,
      },
    };
  }

  DP.tools.comparadorMotor = {
    version: "1.2",
    limpiar: limpiar,
    normalizar: normalizar,
    quitarNumeracion: quitarNumeracion,
    clave: clave,
    titulo: titulo,
    parrafosDeTexto: parrafosDeTexto,
    parrafosDePdf: parrafosDePdf,
    unirLineas: unirLineas,
    dice: dice,
    errorDeLectura: errorDeLectura,
    tramoDeLectura: tramoDeLectura,
    entidades: entidades,
    importantes: importantes,
    comparar: comparar,
    SENSIBLES: SENSIBLES,
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
