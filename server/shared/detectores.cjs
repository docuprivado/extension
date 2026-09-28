/*
 * docuprivado.es · motor de detección de datos personales (docs/PROMPT_INICIAL.md §6)
 *
 * No toca la pantalla: recibe texto y devuelve coincidencias
 * { tipo, valor, inicio, fin, confianza, valido }. Así se puede probar solo
 * (tests/detectores/ y tests/run-node.js) y lo reutilizan el tachador,
 * el anonimizador y el comparador.
 *
 * Los nombres y apellidos vienen de assets/data/*.json y la lista de empresas de
 * assets/data/empresas.bin; se cargan con DP_DETECT.setData(...): quien use el
 * motor decide cómo leerlos.
 */
(function (global) {
  "use strict";

  const TIPOS = ["dni", "nie", "iban", "cuenta", "tarjeta", "telefono", "email", "nss",
    "matricula", "direccion", "cp", "fecha_nac", "nombre", "empresa", "cif", "importe"];

  // Agrupación para las casillas de la interfaz (PROMPT §7.1).
  const GRUPOS = {
    identidad: ["dni", "nie", "nombre", "fecha_nac", "empresa", "cif"],
    contacto: ["telefono", "email", "direccion", "cp"],
    dinero: ["iban", "cuenta", "tarjeta", "importe"],
    otros: ["nss", "matricula"],
  };

  const ETIQUETAS = {
    dni: "DNI", nie: "NIE", iban: "IBAN", cuenta: "Cuenta bancaria", tarjeta: "Tarjeta",
    telefono: "Teléfono", email: "Correo electrónico", nss: "Seguridad Social",
    matricula: "Matrícula", direccion: "Dirección", cp: "Código postal",
    fecha_nac: "Fecha de nacimiento", nombre: "Nombre", empresa: "Empresa", cif: "NIF de empresa",
    importe: "Cantidad de dinero", personalizado: "Palabra propia",
  };

  const LETRAS_DNI = "TRWAGMYFPDXBNJZSQVHLCKE";
  const PARTICULAS = ["DE", "DEL", "LA", "LAS", "LOS", "Y", "I", "E", "DA", "DAS", "DO",
    "DOS", "DI", "DU", "VAN", "VON", "DER", "DEN", "LE", "SAN", "SANTA"];
  const MESES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto",
    "septiembre", "setiembre", "octubre", "noviembre", "diciembre"];
  // Palabras que, cerca de un número de cinco cifras, indican que es un código postal.
  const VIAS_PISTA = ["calle", "c/", "avda", "avenida", "plaza", "pza", "paseo", "pº", "camino", "carretera",
    "ctra", "ronda", "travesía", "travesia", "urbanización", "urbanizacion", "urb", "glorieta", "rambla",
    "bulevar", "domicilio", "dirección", "direccion"];
  const DISPARADORES = ["d\\.", "dª", "dña\\.", "dna\\.", "doña", "dona", "don", "sr\\.", "sra\\.",
    "sres\\.", "srta\\.", "nombre:", "nombre y apellidos:", "arrendador", "arrendadora",
    "arrendatario", "arrendataria", "trabajador", "trabajadora", "empleado", "empleada",
    "paciente", "cliente", "clienta", "titular:", "fdo\\.", "fdo:", "firmado", "a favor de",
    "propietario", "propietaria", "inquilino", "inquilina"];
  const TRATAMIENTOS = ["d.", "dª", "dña.", "dna.", "doña", "dona", "don", "sr.", "sra.", "sres.", "srta."];
  const PISTAS_NSS = ["seguridad social", "nss", "n.s.s", "afiliación", "afiliacion", "naf", "n.a.f"];
  const PISTAS_NACIMIENTO = ["nacimiento", "nacido", "nacida", "f. nac", "f.nac", "fec. nac",
    "fecha de nac", "fecha nac", "nac.:", "born"];
  const PISTAS_CP = ["cp", "c.p.", "código postal", "codigo postal"];
  const PISTAS_CIF = ["cif", "c.i.f", "nif", "n.i.f", "vat", "nif-iva"];

  // ------------------------------------------------------------------ texto

  function quitarTildes(s) {
    return String(s == null ? "" : s).normalize("NFD").replace(/[̀-ͯ]/g, "");
  }
  function normalizar(s) {
    return quitarTildes(s).toUpperCase();
  }
  function soloDigitos(s) {
    return String(s).replace(/\D+/g, "");
  }
  // Signos que se escriben de varias formas y deben buscarse como iguales
  // (siempre un carácter por otro, para no mover las posiciones).
  const EQUIVALENTES = { "°": "º", "–": "-", "—": "-", "‐": "-", "‑": "-", "’": "'", "‘": "'", "´": "'", "“": "\"", "”": "\"", "«": "\"", "»": "\"" };
  // Texto sin tildes junto con un mapa posición→posición en el texto original
  // (quitar tildes cambia la longitud, y las posiciones tienen que seguir siendo válidas).
  function planoConMapa(texto) {
    let plano = "";
    const mapa = [];
    for (let i = 0; i < texto.length; i++) {
      const c = texto.charAt(i);
      const trozo = quitarTildes(EQUIVALENTES[c] || c);
      for (let k = 0; k < trozo.length; k++) {
        plano += trozo.charAt(k);
        mapa.push(i);
      }
    }
    mapa.push(texto.length);
    return { plano: plano, mapa: mapa };
  }

  // Como planoConMapa, y además une las palabras partidas al final de una línea
  // («cincuen-\nta» → «cincuenta») y quita los guiones de corte invisibles (U+00AD).
  // Solo se une un guion entre dos minúsculas: «Cano-\nGarcía» sigue separado.
  // Sirve para buscar las cantidades en letra aunque el PDF traiga las tildes
  // descompuestas (la letra y el acento como dos caracteres) o una palabra cortada.
  const CORTE_PALABRA = /-[ \t ]*\n[ \t ]*/y;
  const MINUSCULA = /[a-zñáéíóúü]/;
  function planoUnido(texto) {
    let plano = "";
    const mapa = [];
    for (let i = 0; i < texto.length; i++) {
      const c = texto.charAt(i);
      if (c === "­") continue;
      if (c === "-" && i > 0 && MINUSCULA.test(texto.charAt(i - 1))) {
        CORTE_PALABRA.lastIndex = i;
        const m = CORTE_PALABRA.exec(texto);
        if (m && MINUSCULA.test(texto.charAt(i + m[0].length))) {
          i += m[0].length - 1;   // se salta el guion, el salto y los espacios
          continue;
        }
      }
      const trozo = quitarTildes(EQUIVALENTES[c] || c);
      for (let k = 0; k < trozo.length; k++) {
        plano += trozo.charAt(k);
        mapa.push(i);
      }
    }
    mapa.push(texto.length);
    return { plano: plano, mapa: mapa };
  }
  // Posiciones de un trozo del texto plano en el texto original. El final se toma
  // del último carácter encontrado (más los acentos descompuestos que lo sigan).
  function aOriginal(texto, p, desde, hasta) {
    const inicio = p.mapa[desde];
    let fin = p.mapa[hasta - 1] + 1;
    while (fin < texto.length && /[̀-ͯ]/.test(texto.charAt(fin))) fin++;
    return { inicio: inicio, fin: fin };
  }

  // Piezas de los patrones. Los nombres propios se reconocen por la mayúscula, así
  // que estos patrones distinguen mayúsculas; las palabras clave («calle», «bajo»,
  // «euros»…) se escriben con ci(), que admite cualquier combinación.
  const LET = "A-Za-zÁÉÍÓÚÜÑáéíóúüñÀÈÌÒÙàèìòùÇçÏï";
  const MAY = "A-ZÁÉÍÓÚÜÑÀÈÌÒÙÇÏ";
  const SP = "[ \\t\\u00a0]*";
  const WS1 = "[ \\t\\u00a0]+";
  const WS = "(?:[ \\t\\u00a0]+|[ \\t\\u00a0]*\\n[ \\t\\u00a0]*)";   // espacio o un salto de línea
  const NO_LETRA = "(?![" + LET + "0-9])";
  const ESPECIALES = /[.*+?^${}()|[\]\\/]/;

  function ci(palabra) {
    let out = "";
    for (const c of palabra) {
      const lo = c.toLowerCase();
      const up = c.toUpperCase();
      if (c === " ") out += WS;
      else if (lo !== up && lo.length === 1 && up.length === 1) out += "[" + lo + up + "]";
      else out += ESPECIALES.test(c) ? "\\" + c : c;
    }
    return out;
  }
  const alternativas = (lista) => lista.slice().sort((a, b) => b.length - a.length).map(ci).join("|");

  // --------------------------------------------------------- comprobaciones

  function letraDni(numero) {
    return LETRAS_DNI.charAt(Number(numero) % 23);
  }
  function validarDni(valor) {
    const limpio = normalizar(valor).replace(/[^0-9A-Z]/g, "");
    if (!/^\d{8}[A-Z]$/.test(limpio)) return false;
    return letraDni(limpio.slice(0, 8)) === limpio.charAt(8);
  }
  function validarNie(valor) {
    const limpio = normalizar(valor).replace(/[^0-9A-Z]/g, "");
    if (!/^[XYZ]\d{7}[A-Z]$/.test(limpio)) return false;
    const numero = "XYZ".indexOf(limpio.charAt(0)) + limpio.slice(1, 8);
    return letraDni(numero) === limpio.charAt(8);
  }
  // IBAN: se mueven los cuatro primeros caracteres al final, las letras pasan a
  // números (A=10 … Z=35) y el resultado tiene que dar resto 1 al dividir entre 97.
  function validarIban(valor) {
    const limpio = normalizar(valor).replace(/[^0-9A-Z]/g, "");
    if (!/^[A-Z]{2}\d{2}[0-9A-Z]{10,30}$/.test(limpio)) return false;
    const movido = limpio.slice(4) + limpio.slice(0, 4);
    let resto = 0;
    for (let i = 0; i < movido.length; i++) {
      const c = movido.charAt(i);
      const trozo = c >= "A" && c <= "Z" ? String(c.charCodeAt(0) - 55) : c;
      for (let j = 0; j < trozo.length; j++) resto = (resto * 10 + Number(trozo.charAt(j))) % 97;
    }
    return resto === 1;
  }
  // Número de cuenta antiguo (CCC: entidad, oficina, dos dígitos de control y
  // cuenta): cada dígito de control sale de sumar las cifras por unos pesos fijos.
  // Solo se usa para aceptar una cuenta partida entre dos líneas.
  function validarCcc(valor) {
    const d = soloDigitos(valor);
    if (d.length !== 20) return false;
    const pesos = [1, 2, 4, 8, 5, 10, 9, 7, 3, 6];
    const dc = (s) => {
      let suma = 0;
      for (let i = 0; i < 10; i++) suma += Number(s.charAt(i)) * pesos[i];
      const r = 11 - (suma % 11);
      return r === 11 ? 0 : r === 10 ? 1 : r;
    };
    return dc("00" + d.slice(0, 8)) === Number(d.charAt(8)) && dc(d.slice(10)) === Number(d.charAt(9));
  }
  function validarTarjeta(valor) {
    const d = soloDigitos(valor);
    if (d.length < 13 || d.length > 19) return false;
    let suma = 0;
    let doble = false;
    for (let i = d.length - 1; i >= 0; i--) {
      let n = Number(d.charAt(i));
      if (doble) {
        n *= 2;
        if (n > 9) n -= 9;
      }
      suma += n;
      doble = !doble;
    }
    return suma % 10 === 0;
  }
  // Número de la Seguridad Social. Los dos últimos dígitos parecen un control
  // calculado sobre los diez primeros (el resto de dividir entre 97), pero la
  // Seguridad Social no publica el algoritmo, así que aquí solo se usa como
  // PISTA para encontrar números sueltos sin texto alrededor: nunca para decir
  // que un número es válido ni para descartar uno que no cuadre. Todo lo que se
  // encuentra se marca con confianza media para que lo revise la persona.
  function controlNssCuadra(valor) {
    const d = soloDigitos(valor);
    if (d.length !== 12) return false;
    let resto = 0;
    for (let i = 0; i < 10; i++) resto = (resto * 10 + Number(d.charAt(i))) % 97;
    return resto === Number(d.slice(10));
  }
  // NIF de empresa (antes CIF): letra de la forma jurídica, siete cifras y un
  // carácter de control (Orden EHA/451/2008). La orden no publica cómo se calcula
  // el control, así que el cálculo habitual (el de la AEAT que recogen los manuales)
  // solo sirve de PISTA, como con la Seguridad Social: nunca para descartar.
  function controlCifCuadra(valor) {
    const limpio = normalizar(valor).replace(/[^0-9A-Z]/g, "").replace(/^ES(?=[A-Z]\d)/, "");
    if (!/^[ABCDEFGHJNPQRSUVW]\d{7}[0-9A-J]$/.test(limpio)) return false;
    let suma = 0;
    for (let i = 0; i < 7; i++) {
      let n = Number(limpio.charAt(i + 1));
      if (i % 2 === 0) {
        n *= 2;
        if (n > 9) n = Math.floor(n / 10) + (n % 10);
      }
      suma += n;
    }
    const digito = (10 - (suma % 10)) % 10;
    const c = limpio.charAt(8);
    return c === String(digito) || c === "JABCDEFGHI".charAt(digito);
  }
  function fechaValida(dia, mes, anio) {
    if (mes < 1 || mes > 12 || dia < 1 || anio < 1900 || anio > 2100) return false;
    const dias = [31, (anio % 4 === 0 && anio % 100 !== 0) || anio % 400 === 0 ? 29 : 28,
      31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    return dia <= dias[mes - 1];
  }

  // ------------------------------------------------------ datos de nombres

  let NOMBRES = null;
  let APELLIDOS = null;
  let EXCLUIR = null;
  let DUDOSOS = null;
  // Dónde está la lista de empresas y cuánto ocupa (para la barra de progreso).
  // La línea la reescribe tools/borme_lista.py cada vez que regenera la lista.
  const LISTA_EMPRESAS = { ruta: "/assets/data/empresas.bin?v=20260922", bytes: 3751900, mb: 3.8, total: 625089, desde: "23/09/2024", hasta: "21/09/2026" }; // @lista-empresas
  let EMPRESAS = null;     // huellas ordenadas de los nombres de empresa (BORME y marcas conocidas)
  let MARCAS = null;       // marcas muy conocidas: valen aunque sean una sola palabra corta

  function setData(datos) {
    datos = datos || {};
    const aSet = (lista) => {
      const s = new Set();
      (lista || []).forEach((p) => s.add(normalizar(p)));
      return s;
    };
    if (datos.nombres) NOMBRES = aSet(datos.nombres.lista || datos.nombres);
    if (datos.apellidos) APELLIDOS = aSet(datos.apellidos.lista || datos.apellidos);
    if (datos.excluir) {
      const ex = datos.excluir;
      EXCLUIR = aSet(ex.excluir || ex);
      DUDOSOS = aSet(ex.dudosos || []);
    }
    if (datos.empresas) cargarEmpresas(datos.empresas);
    return hasData();
  }
  function hasData() {
    return !!(NOMBRES && NOMBRES.size && APELLIDOS && APELLIDOS.size);
  }
  function hasEmpresas() {
    return !!(EMPRESAS && EMPRESAS.n);
  }

  // La lista de empresas no viaja como texto sino como «huellas»: 48 bits por
  // nombre (FNV-1a de 32 bits y la suma de Bernstein sobre el texto), ordenadas.
  // Así ocupa unos pocos MB y el navegador la usa al instante, sin leer 13 MB de
  // texto. tools/borme_lista.py calcula exactamente lo mismo al prepararla.
  function huella(s) {
    let a = 0x811c9dc5 | 0;
    let b = 5381;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      a = Math.imul(a ^ c, 0x01000193);
      b = (Math.imul(b, 33) + c) | 0;
    }
    return { hi: a >>> 16, lo: (((a & 0xffff) << 16) | (b & 0xffff)) >>> 0 };
  }

  function enTabla(t, h) {
    if (!t || !t.n) return false;
    let lo = 0;
    let hi = t.n - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const a = t.hi[mid];
      const b = t.lo[mid];
      if (a === h.hi && b === h.lo) return true;
      if (a < h.hi || (a === h.hi && b < h.lo)) lo = mid + 1;
      else hi = mid - 1;
    }
    return false;
  }

  function tieneEmpresa(clave) {
    return hasEmpresas() && enTabla(EMPRESAS, huella(clave));
  }

  // Tabla de huellas: n números de 16 bits (con relleno hasta múltiplo de 4
  // bytes) y n de 32 bits.
  function leerTabla(buf, desde, n) {
    const hi = new Uint16Array(buf, desde, n);
    const alto = Math.ceil(n * 2 / 4) * 4;
    return { n: n, hi: hi, lo: new Uint32Array(buf, desde + alto, n), fin: desde + alto + n * 4 };
  }

  // assets/data/empresas.bin: «DPE1», número de empresas, número de marcas
  // conocidas, 0; la tabla de todas y la de las marcas conocidas (las que valen
  // aunque sean una sola palabra corta, como «BBVA»).
  function cargarEmpresas(buf) {
    const cab = new Uint32Array(buf, 0, 4);
    if (String.fromCharCode.apply(null, new Uint8Array(buf, 0, 4)) !== "DPE1") throw new Error("Lista de empresas no válida");
    EMPRESAS = leerTabla(buf, 16, cab[1]);
    MARCAS = leerTabla(buf, EMPRESAS.fin, cab[2]);
  }

  // ------------------------------------------------------------- buscadores

  // Recorre el texto con un patrón cuyo grupo 1 es el prefijo (para no cortar
  // números más largos) y el grupo 2 es el valor.
  function recorrer(texto, patron, fn) {
    const re = new RegExp(patron.source, patron.flags.indexOf("g") === -1 ? patron.flags + "g" : patron.flags);
    let m;
    while ((m = re.exec(texto)) !== null) {
      const valor = m[2];
      if (valor) {
        const inicio = m.index + (m[1] ? m[1].length : 0);
        fn(valor, inicio, inicio + valor.length, m);
      }
      if (m.index === re.lastIndex) re.lastIndex++;
    }
  }

  // ¿Hay alguna de estas pistas justo antes? Se comparan como palabras sueltas:
  // si no, "importe" valdría como pista de "Pº" y colaría códigos postales falsos.
  function cerca(texto, inicio, pistas, ventana) {
    const desde = Math.max(0, inicio - (ventana || 40));
    const trozo = quitarTildes(texto.slice(desde, inicio)).toLowerCase();
    return pistas.some((p) => {
      const patron = quitarTildes(p).toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp("(^|[^a-z0-9])" + patron + "([^a-z0-9]|$)").test(trozo);
    });
  }

  // Separación dentro de un dato (DNI, NIE, IBAN, teléfono…): un espacio o un guion,
  // o un salto de línea con espacios y, como mucho, un guion, punto o barra a cada
  // lado. En un PDF, cuando un dato no cabe al final de la línea, su última parte
  // pasa a la siguiente («12345678-» y «Z» debajo): antes esos datos no se
  // encontraban (hito de actualización 4). Un dato partido solo se acepta si su
  // control cuadra (letra del DNI, IBAN…) o si hay una pista cerca.
  const CORTE = "[ \\t\\u00a0]*[-/.]?[ \\t\\u00a0]*\\n[ \\t\\u00a0]*[-/.]?[ \\t\\u00a0]*";
  const SEP = "(?:" + CORTE + "|[ -])?";
  const SEP_TEL = "(?:" + CORTE + "|[ .-])?";     // los teléfonos también se escriben con puntos
  const SEP_NSS = "(?:" + CORTE + "|[ /.-])?";    // y la Seguridad Social, con barras
  const corte = (v) => v.indexOf("\n") !== -1;

  const RE = {
    // 12345678Z · 12345678-Z · 12.345.678-Z · 12345678 y la Z en la línea siguiente
    dni: new RegExp("(^|[^\\w@.\\-/])((?:\\d{8}|\\d{2}\\.\\d{3}\\.\\d{3})" + SEP + "[A-Za-z])(?![\\w-])", "g"),
    nie: new RegExp("(^|[^\\w@.\\-/])([XYZxyz]" + SEP + "\\d{7}" + SEP + "[A-Za-z])(?![\\w-])", "g"),
    cif: new RegExp("(^|[^\\w@.\\-/])((?:ES" + SEP + ")?[ABCDEFGHJNPQRSUVW]" + SEP + "\\d{7}" + SEP + "[0-9A-J])(?![\\w-])", "g"),
    // Cualquier agrupación de las 22 cifras (de 4 en 4, como el antiguo número de
    // cuenta…): lo que decide es el control del IBAN.
    ibanEs: new RegExp("(^|[^\\w])(ES(?:" + SEP + "\\d){22})(?![\\w])", "gi"),
    ibanOtro: new RegExp("(^|[^\\w])([A-Z]{2}\\d{2}(?:" + SEP + "[0-9A-Z]{2,4}){2,8})(?![\\w])", "g"),
    cuenta: new RegExp("(^|[^\\w])(\\d{4}" + SEP + "\\d{4}" + SEP + "\\d{2}" + SEP + "\\d{10})(?![\\d])", "g"),
    tarjeta: new RegExp("(^|[^\\w])(\\d{4}(?:" + SEP + "\\d{4}){2,4}|\\d{13,19})(?![\\d])", "g"),
    // 612 345 678 · 91 234 56 78 · +34 612345678: cualquier agrupación de las 9 cifras
    telefonoEs: new RegExp("(^|[^\\w+])((?:(?:\\+34|0034)" + SEP + ")?[6-9](?:" + SEP_TEL + "\\d){8})(?![\\d])", "g"),
    telefonoInt: new RegExp("(^|[^\\w])(\\+\\d{1,3}" + SEP + "(?:\\d" + SEP_TEL + "){7,12}\\d)(?![\\d])", "g"),
    email: /(^|[^\w.+-])([A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})(?![\w-])/g,
    nss: new RegExp("(^|[^\\w])(\\d{2}" + SEP_NSS + "\\d{8}" + SEP_NSS + "\\d{2})(?![\\d])", "g"),
    matricula: new RegExp("(^|[^\\w])(\\d{4}" + SEP + "[BCDFGHJKLMNPRSTVWXYZbcdfghjklmnprstvwxyz]{3})(?![\\w])", "g"),
    matriculaVieja: /(^|[^\w])([A-Za-z]{1,2}[ -]?\d{4}[ -]?[A-Za-z]{1,2})(?![\w])/g,
    cp: /(^|[^\d\w])(\d{5})(?![\d])/g,
    fechaNumero: /(^|[^\d\w])(\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4})(?![\d])/g,
  };

  // Texto leído de un escaneo (detect con { ocr: true }): el lector confunde a veces
  // la letra del DNI con una cifra parecida («12345678Z» sale «123456787») y la @ de
  // un correo con una Q («maria.lopezQexample.com»). Qué letras puede ser cada cifra:
  const CIFRA_LETRA = { "0": "DOQ", "1": "ILT", "2": "Z", "4": "A", "5": "S", "6": "G", "7": "ZT", "8": "B" };
  // Y al revés, letras leídas en medio de las cifras («I2345678Z», «ES91 21OO…»).
  const LETRA_CIFRA = { O: "0", o: "0", I: "1", l: "1", S: "5", B: "8", Z: "2" };
  const aCifras = (s) => s.replace(/[OoIlSBZ]/g, (c) => LETRA_CIFRA[c]);
  const PISTAS_DNI = ["dni", "d.n.i", "nif", "n.i.f", "documento"];
  const PISTAS_NIE = ["nie", "n.i.e", "tie", "extranjero", "nif", "n.i.f", "documento"];
  const PISTAS_EMAIL = ["correo", "email", "e-mail", "mail", "electrónico", "electronico"];
  const CIFRA_OCR = "[0-9OoIlSBZ]";
  const RE_OCR = {
    dni: new RegExp("(^|[^\\w@.\\-/])(" + CIFRA_OCR + "{8}" + SEP + "[0-9A-Za-z])(?![\\w-])", "g"),
    nie: new RegExp("(^|[^\\w@.\\-/])([XYZxyz]" + SEP + CIFRA_OCR + "{7}" + SEP + "[0-9A-Za-z])(?![\\w-])", "g"),
    iban: new RegExp("(^|[^\\w])([EF][S5](?:" + SEP + CIFRA_OCR + "){22})(?![\\w])", "g"),
    cuenta: new RegExp("(^|[^\\w])(" + CIFRA_OCR + "{4}" + SEP + CIFRA_OCR + "{4}" + SEP + CIFRA_OCR + "{2}" + SEP + CIFRA_OCR + "{10})(?![\\w])", "g"),
    // El lector también mete a veces un espacio junto a un punto («maria .lopezQexample.com»):
    // la palabra de delante, en minúsculas, es parte del correo (hito de actualización 19).
    email: /(^|[^\w.+-])((?:[a-z0-9_%+-]+(?: \. ?|\. ))?[A-Za-z0-9._%+-]+[@Q©&(][A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})(?![\w-])/g,
    // La @ leída como una letra más («andres.castilloGexample.com», «juaneexample.com»):
    // una palabra acabada en dominio. Solo vale justo detrás de «Email:» o «correo», en la
    // misma línea (hito de actualización 17).
    emailSinArroba: /(^|[^\w.+-])([A-Za-z0-9._%+-]{3,}[A-Za-z0-9-]\.[A-Za-z]{2,6})(?![\w-])/g,
  };

  // Pegados a la palabra de delante: dos líneas de un PDF que se leen juntas
  // («García12345678Z»). Solo cuentan si su control cuadra.
  const RE_PEGADO = {
    dni: /([A-Za-zÁÉÍÓÚÜÑáéíóúüñ])(\d{8}[A-Z])(?![\w-])/g,
    nie: /([A-Za-zÁÉÍÓÚÜÑáéíóúüñ])([XYZ]\d{7}[A-Z])(?![\w-])/g,
    iban: new RegExp("([a-záéíóúüñ])(ES(?:" + SEP + "\\d){22})(?![\\w])", "g"),
  };

  // Al principio de una línea o de una columna (tras un tabulador): donde va un
  // documento o una cuenta debajo del nombre, sin rótulo delante.
  // La palabra pegada delante tiene que ser una palabra de verdad (un apellido,
  // «García12345678Z»), no el prefijo de un código («AB12345678Z»).
  function pegadoAPalabra(texto, i) {
    return /[A-Za-zÁÉÍÓÚÜÑáéíóúüñ]{4,}$/.test(texto.slice(Math.max(0, i - 30), i));
  }

  function alInicioDeLinea(texto, i) {
    const desde = Math.max(texto.lastIndexOf("\n", i - 1), texto.lastIndexOf("\t", i - 1)) + 1;
    return /^\s*$/.test(texto.slice(desde, i));
  }

  function reFechaLetras() {
    return new RegExp("(^|[^\\w])(\\d{1,2}\\s+de\\s+(?:" + MESES.join("|") + ")\\s+de\\s+\\d{4})(?![\\w])", "gi");
  }

  // ------------------------------------------------------------- direcciones
  //
  // Una dirección se reconoce de cuatro maneras, porque en los documentos no
  // siempre va detrás de «Domicilio:»:
  //   1. por el tipo de vía: «Calle», «Avda.», «C/», «Pº», «CL» (el código de los
  //      formularios oficiales)… seguido de un nombre y, casi siempre, un número;
  //   2. por lo que la anuncia: «con domicilio en», «sita en», «vive en»…;
  //   3. del revés: «en el número 9 de la calle Olivo»;
  //   4. por el código postal: «Almendros 14, 3º A\n28045 Madrid».
  // El nombre puede partirse en dos líneas y llevar comas antes del número.

  const VIAS_PALABRA = ["calle", "avenida", "avinguda", "plaza", "plaça", "praza", "paseo", "passeig", "camino",
    "camí", "carretera", "ronda", "travesía", "travesia", "travessera", "urbanización", "urbanizacion", "glorieta",
    "rambla", "bulevar", "pasaje", "passatge", "callejón", "callejon", "cuesta", "costanilla", "alameda", "carrer",
    "rúa", "rua", "barrio", "barriada", "polígono", "poligono", "vía", "via"];
  const VIAS_ABREV = ["avda", "avd", "av", "avgda", "pza", "plza", "pl", "pº", "p.º", "pso", "pg", "cno", "cmno",
    "ctra", "crta", "rda", "trav", "urb", "glta", "rbla", "pje", "psje", "ptge", "cjón", "cjon", "bº", "bda", "pol", "cl"];
  // Para no alargar un nombre sobre una dirección que empieza en la línea siguiente
  // («Laura Gómez Ferrer» y debajo «Ronda de Atocha 30»: «Ronda» también es apellido).
  const VIAS_SET = new Set(VIAS_PALABRA.concat(VIAS_ABREV).map((v) => quitarTildes(v).toLowerCase()));
  // Códigos de tipo de vía de los formularios oficiales, siempre en mayúsculas.
  const VIAS_CODIGO = ["CL", "AV", "PZ", "PS", "CR", "CM", "TR", "UR", "RD", "GL", "PJ", "PG"];
  // Con estas se admite el nombre en minúsculas («calle mayor 3»).
  const VIAS_BASICAS = ["CALLE", "C/", "AVENIDA", "AVDA", "PLAZA", "PASEO"];

  const PARTIC_VIA = alternativas(["de", "del", "la", "las", "los", "el", "d'", "l'", "dels", "des", "y", "i", "e",
    "a", "al", "da", "do", "dos", "das", "en"]);
  const NO_PARTIC = "(?!(?:" + PARTIC_VIA + ")(?![" + LET + "'’]))";
  const PAL_VIA = "(?:\\d{1,2}" + WS1 + ci("de") + WS1 + "[" + MAY + "][" + LET + "]+|" + NO_PARTIC +
    "[" + MAY + "][" + LET + "0-9'’·\\-]*\\.?)";
  const NOMBRE_VIA = PAL_VIA + "(?:" + WS + "(?:(?:" + PARTIC_VIA + ")" + WS + ")*" + PAL_VIA + "){0,6}";
  const NOMBRE_VIA_LINEA = PAL_VIA + "(?:" + WS1 + "(?:(?:" + PARTIC_VIA + ")" + WS1 + ")*" + PAL_VIA + "){0,6}";
  const NOMBRE_MIN = "[a-zñáéíóúü]{3,20}(?![" + LET + "])";
  const NUM_PREF = alternativas(["nº", "n.º", "n°", "n.°", "no.", "núm.", "núm", "num.", "número", "numero", "nro.", "nro"]);
  const NUMERO_CASA = "(?:(?:" + NUM_PREF + ")" + SP + ")?(?:\\d{1,4}(?![0-9])(?:" + SP + "[-–]" + SP + "\\d{1,4}(?![0-9])(?!" + SP + "\\.?" + SP + "[º°ª]))?" +
    "(?:[-–]?[A-Z](?![" + LET + "0-9]))?(?:" + WS1 + ci("bis") + NO_LETRA + ")?|(?:" +
    alternativas(["s/n", "s/nº", "s/n.º", "sin número", "sin numero"]) + ")" + NO_LETRA + "|" +
    ci("km") + "\\.?" + SP + "\\d{1,3}(?:[.,]\\d{1,3})?)";
  const PRE = "(?:" + SP + "[,–\\-])?(?:" + WS + ")?";
  const ORDINAL = "[º°ª]";
  // El º o la ª leídos como otro signo al leer un escaneo: «3.? B», «3.* B», «3.” B»
  // (hito de actualización 19).
  const ORDINAL_OCR = "[?*'’\"”“´`˚^]";
  const LADO = "(?:" + alternativas(["izquierda", "izqda", "izda", "izq", "derecha", "dcha", "drcha", "dcho", "dch",
    "centro", "ctro", "interior", "exterior"]) + ")\\.?" + NO_LETRA;
  const LETRA_SUELTA = "[A-Z](?![" + LET + "0-9])";
  const PUERTA = "(?:" + LADO + "|" + LETRA_SUELTA + ")";
  // Cuando no es seguro que sea la puerta, detrás tiene que venir una coma, un punto, el
  // código postal o el final de la línea: así no se lleva la «A» de «A la firma…».
  const TRAS_PUERTA = "(?=" + SP + "(?:[,.;:)]|\\n|$|[0-9]{5}(?![0-9])))";
  // La puerta detrás del piso, en la misma línea o en la siguiente («3.º» al final de una
  // línea y «B, 28013 Madrid» debajo; hito de actualización 19).
  const PUERTA_DETRAS = "(?:" + SP + "[-–]?" + SP + PUERTA + "|" + SP + "\\n" + SP + PUERTA + TRAS_PUERTA + ")";
  const COMP = PRE + "(?:" + [
    "(?:" + alternativas(["piso", "planta", "pl"]) + ")\\.?" + SP + "\\d{1,2}(?:" + SP + "\\.?" + SP + ORDINAL + "|\\." + SP + ORDINAL_OCR + ")?\\.?",
    "\\d{1,2}" + SP + "\\.?" + SP + ORDINAL + "\\.?" + PUERTA_DETRAS + "?",
    "\\d{1,2}" + SP + "\\.?" + SP + "[-–]?" + SP + LETRA_SUELTA,   // «3 B», «3-B» y «3. B» (el º perdido al leer un escaneo)
    // «4.9 C» o «4.2 C»: el º leído como una cifra al leer un escaneo (hito de actualización 17)
    "\\d{1,2}\\.[0-9oO]" + PUERTA_DETRAS,
    // «3.? B» o «3.*»: el º leído como otro signo, siempre detrás del punto; sin el punto
    // («3? B»), solo con la puerta y lo que la cierra (hito de actualización 19)
    "\\d{1,2}\\." + SP + ORDINAL_OCR + "\\.?" + PUERTA_DETRAS + "?",
    "\\d{1,2}" + ORDINAL_OCR + SP + "[-–]?" + SP + PUERTA + TRAS_PUERTA,
    "(?:" + alternativas(["bajo", "bj", "entlo", "entresuelo", "entreplanta", "principal", "pral", "ático", "atico",
      "sobreático", "sobreatico", "semisótano", "semisotano", "sótano", "sotano"]) + ")\\.?" + NO_LETRA +
      "(?:" + SP + "[-–]?" + SP + "(?:" + LADO + "|" + LETRA_SUELTA + "))?",
    "(?:" + alternativas(["escalera", "esc", "portal", "bloque", "blq", "bl", "puerta", "pta", "pt", "local", "nave",
      "parcela", "casa", "apartamento", "apto", "dpto", "departamento", "letra", "edificio", "edif", "módulo",
      "modulo", "oficina", "ofic", "of"]) + ")\\.?" + SP + "(?:(?:" + NUM_PREF + ")" + SP + ")?(?:\\d{1,4}[A-Za-z]?|[A-Z]{1,2})" + NO_LETRA,
    LADO,
  ].join("|") + ")";
  const PAL_CIUDAD = NO_PARTIC + "[" + MAY + "][" + LET + "'’\\-]*";
  const CIUDAD = PAL_CIUDAD + "(?:" + WS1 + "(?:(?:" + PARTIC_VIA + ")" + WS1 + ")*" + PAL_CIUDAD + "){0,4}" +
    "(?:" + SP + "\\(" + SP + "[" + MAY + "][" + LET + " '’\\-]{1,30}\\))?";
  const CP5 = "(?:0[1-9]|[1-4][0-9]|5[0-2])[0-9]{3}(?![0-9])";
  // La ciudad puede pasar a la línea siguiente cuando la dirección no cabe («28080» al final
  // de una línea y «Madrid.» en la siguiente): solo si empieza con mayúscula y minúsculas y
  // acaba la frase o la línea, para no llevarse «SEGUNDA.» (hito de actualización 17).
  const CIUDAD_ABAJO = "(?:\\n" + SP + "(?=[" + MAY + "][a-záéíóúüñàèìòùçï]" + ")(?=" + CIUDAD + SP + "(?:[.,;)]|\\n|$)))?";
  const CP_CIUDAD = PRE + "(?:\\(" + SP + ")?(?:(?:" + alternativas(["c.p.", "c.p", "cp", "código postal", "codigo postal"]) +
    ")" + SP + ":?" + SP + ")?" + CP5 + "(?:" + SP + "[-–,]?" + SP + CIUDAD_ABAJO + CIUDAD + ")?(?:" + SP + "\\))?";
  const DE_CIUDAD = SP + ",?" + WS + "(?:" + alternativas(["de", "en"]) + ")" + WS + CIUDAD;
  const SEP_NUM = "(?:" + SP + ",)?(?:" + WS + ")?";
  const VIA = "(?:(?:" + alternativas(VIAS_PALABRA) + ")(?=[\\s.,])\\.?|(?:" + alternativas(VIAS_ABREV) +
    ")(?:\\.|(?=\\s))|" + ci("c/") + "\\.?|(?:" + VIAS_CODIGO.join("|") + ")(?=[ \\t]+[" + MAY + "0-9]))";
  const CABEZA = SP + "(?:\\n" + SP + ")?(?:(?:" + PARTIC_VIA + ")" + WS + ")*";
  const RESTO = "(?:" + SEP_NUM + "(?<num>" + NUMERO_CASA + "))?(?<comp>(?:" + COMP + "){0,4})(?<cp>" + CP_CIUDAD + "|" + DE_CIUDAD + ")?";

  const TRIG_DIR = "(?:" + ci("con") + WS + ")?(?:" + [
    ci("domicilio") + "(?:" + WS + "(?:" + alternativas(["social", "fiscal", "habitual", "actual", "postal",
      "a efectos de notificaciones", "a efectos de notificación", "a efectos de notificacion"]) + "))?",
    ci("domiciliad") + "[oaOA][sS]?", ci("residente") + "[sS]?", ci("reside") + "[nN]?",
    ci("residencia") + "(?:" + WS + ci("habitual") + ")?", ci("viv") + "[eE][nN]?",
    ci("sit") + "[oaOA][sS]?", ci("situad") + "[oaOA][sS]?", ci("ubicad") + "[oaOA][sS]?", ci("radicad") + "[oaOA][sS]?",
    ci("sede") + "(?:" + WS + ci("social") + ")?",
    "(?:" + ci("dirección") + "|" + ci("direccion") + ")(?:" + WS + "(?:" + alternativas(["postal", "de suministro",
      "del suministro", "del inmueble", "de envío", "de envio", "de facturación", "de facturacion", "de la vivienda",
      "del domicilio"]) + "))?",
    ci("notificaciones"),
  ].join("|") + ")" + SP + "(?:" + ci("en") + "|:)" + SP + "(?:\\n" + SP + ")?(?:(?:" + alternativas(["la", "el", "los", "las"]) + ")" + WS + ")?";

  const RE_DIR = [
    // 1. Tipo de vía + nombre (+ número, piso, código postal y ciudad)
    new RegExp("(^|[^" + LET + "0-9])(?<valor>(?<via>" + VIA + ")" + CABEZA + "(?<nombre>" + NOMBRE_VIA + "|" + NOMBRE_MIN + ")" + RESTO + ")", "g"),
    // «Gran Vía 32», sin más nombre
    new RegExp("(^|[^" + LET + "0-9])(?<valor>(?<via>" + alternativas(["gran vía", "gran via"]) + ")" + SEP_NUM +
      "(?<num>" + NUMERO_CASA + ")(?<comp>(?:" + COMP + "){0,4})(?<cp>" + CP_CIUDAD + "|" + DE_CIUDAD + ")?)", "g"),
    // 2. «con domicilio en …», «sita en …» (aquí el número es obligatorio)
    new RegExp("((?:^|[^" + LET + "0-9])" + TRIG_DIR + ")(?<valor>(?:(?<via>" + VIA + ")" + CABEZA + ")?(?<nombre>" + NOMBRE_VIA + ")" +
      SEP_NUM + "(?<num>" + NUMERO_CASA + ")(?<comp>(?:" + COMP + "){0,4})(?<cp>" + CP_CIUDAD + "|" + DE_CIUDAD + ")?)", "g"),
    // 3. «el número 9 de la calle Olivo»
    new RegExp("(^|[^" + LET + "0-9])(?<valor>(?:" + NUM_PREF + ")" + SP + "(?<num>\\d{1,4})(?![0-9])(?:" + COMP + "){0,2}" + WS +
      ci("de") + WS + "(?:" + alternativas(["la", "el"]) + ")" + WS + "(?<via>" + VIA + ")" + CABEZA + "(?<nombre>" + NOMBRE_VIA + ")(?<cp>" + DE_CIUDAD + ")?)", "g"),
    // 4. Nombre + número al empezar una línea o tras una coma, y el código postal con la ciudad
    new RegExp("((?:^|[\\n,:;])" + SP + ")(?<valor>(?<nombre>" + NOMBRE_VIA_LINEA + ")" + SEP_NUM + "(?<num>" + NUMERO_CASA + ")" +
      "(?<comp>(?:" + COMP + "){0,4})" + SP + "[,\\n\\-–]?" + SP + "(?:\\n" + SP + ")?(?<cp>" + CP5 + SP + "[-–,]?" + SP + CIUDAD + "))", "g"),
  ];

  // «plaza de garaje número 27» o «vía de pago» no son direcciones.
  const NOMBRES_NO_VIA = /^(?:(?:DE|DEL|LA|EL)\s+)*(?:GARAJE|APARCAMIENTO|PARKING|TRASTERO|VACANTES?|LIBRES?|DOCENTES?|FIJAS?|TOROS|PAGO|ACCESO|EMERGENCIA|EVACUACION|SALIDA|ENTRADA|SERVICIO|RECURSO|APREMIO|NOTIFICACION|COMUNICACION|APLICACION|MERCADO|PERSONAL|TRABAJO|OFICIO|COTIZACION|CONTRATO|CONTRATACION|ARTICULO|CLAUSULA)\b/;

  function direccionValida(g) {
    const via = normalizar(g.via || "").replace(/\.$/, "").replace(/\s+/g, " ");
    const nombre = g.nombre || "";
    const nNombre = normalizar(nombre).replace(/\s+/g, " ").trim();
    if (NOMBRES_NO_VIA.test(nNombre)) return false;
    const conNumero = !!(g.num || (g.cp && /\d/.test(g.cp)));
    if (!nombre) return conNumero;
    const minusculas = !/[A-ZÁÉÍÓÚÜÑ]/.test(nombre);
    const basica = VIAS_BASICAS.indexOf(via) !== -1;
    if (minusculas) return basica && conNumero;
    if (!conNumero) {
      // Sin número vale un nombre propio («calle Olivo»), pero no en un texto
      // todo en mayúsculas (títulos, cláusulas) salvo con las vías básicas.
      if (VIAS_CODIGO.indexOf(g.via) !== -1 || via === "VIA") return false;
      if (nombre === nombre.toUpperCase() && !basica) return false;
    }
    return true;
  }

  function buscarDirecciones(texto, out) {
    RE_DIR.forEach((re) => {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(texto)) !== null) {
        const inicio = m.index + m[1].length;
        const valor = m.groups.valor.replace(/[\s,;:–\-]+$/, "");
        if (!valor || !direccionValida(m.groups)) {
          re.lastIndex = inicio + 1;   // se prueba otra vez un poco más adelante
          continue;
        }
        out.push({ tipo: "direccion", valor: valor, inicio: inicio, fin: inicio + valor.length, confianza: "media", valido: false });
        if (m.index === re.lastIndex) re.lastIndex++;
      }
    });
  }

  // --------------------------------------------------------- cantidades de dinero

  const NUMERO = "(?:\\d{1,3}(?:[. \\u00a0]\\d{3})+(?:,\\d{1,2})?|\\d{1,3}(?:,\\d{3})+(?:\\.\\d{1,2})?|\\d+(?:[.,]\\d{1,2})?)";
  const MONEDA_PAL = ["euros", "euro", "eur", "usd", "dólares", "dolares", "dólar", "dolar", "céntimos", "centimos",
    "céntimo", "centimo", "libras esterlinas", "gbp", "chf", "pesetas"];
  const MONEDA = "(?:€|£|US\\$|\\$|(?:" + alternativas(MONEDA_PAL) + ")" + NO_LETRA + ")";
  const NUMEROS_LETRA = ["cero", "un", "uno", "una", "dos", "tres", "cuatro", "cinco", "seis", "siete", "ocho", "nueve",
    "diez", "once", "doce", "trece", "catorce", "quince", "dieciséis", "dieciseis", "diecisiete", "dieciocho",
    "diecinueve", "veinte", "veintiún", "veintiun", "veintiuno", "veintiuna", "veintidós", "veintidos", "veintitrés",
    "veintitres", "veinticuatro", "veinticinco", "veintiséis", "veintiseis", "veintisiete", "veintiocho",
    "veintinueve", "treinta", "cuarenta", "cincuenta", "sesenta", "setenta", "ochenta", "noventa", "cien", "ciento",
    "doscientos", "doscientas", "trescientos", "trescientas", "cuatrocientos", "cuatrocientas", "quinientos",
    "quinientas", "seiscientos", "seiscientas", "setecientos", "setecientas", "ochocientos", "ochocientas",
    "novecientos", "novecientas", "mil", "millón", "millon", "millones"];
  const PAL_NUM = "(?:" + alternativas(NUMEROS_LETRA) + ")" + NO_LETRA;
  const EN_LETRA = PAL_NUM + "(?:" + WS + "(?:" + ci("y") + WS + ")?" + PAL_NUM + ")*";
  // Entre la cifra y la moneda puede haber un salto de línea («650» al final de una
  // línea y «euros» en la siguiente).
  const SP_L = SP + "(?:\\n" + SP + ")?";
  const MONEDA_PAR = "(?:€|(?:" + alternativas(["euros", "euro", "eur"]) + ")" + NO_LETRA + ")";
  const PARENTESIS = "(?:" + SP_L + "\\(" + SP_L + NUMERO + SP_L + MONEDA_PAR + "?" + SP_L + "\\))?";
  const PAREN_MONEDA = SP_L + "\\(" + SP_L + NUMERO + SP_L + MONEDA_PAR + SP_L + "\\)";

  const RE_IMPORTE = {
    // 1.250,50 € · 650 euros · 1,5 millones de euros · 30 USD
    cifra: new RegExp("(^|[^\\w.,])(" + NUMERO + "(?:" + WS1 + "(?:" + alternativas(["mil", "millones", "millón", "millon"]) + ")(?:" +
      WS1 + ci("de") + ")?)?" + SP_L + MONEDA + ")", "g"),
    // € 1.250 · EUR 150 · $1,250.00
    antes: new RegExp("(^|[^\\w])((?:€|£|US\\$|\\$|(?:" + alternativas(["eur", "usd", "gbp", "chf"]) + ")" + NO_LETRA + ")" + SP_L + NUMERO + ")(?![0-9])", "g"),
    // seiscientos cincuenta euros (650,00 €) · dos mil euros con cincuenta céntimos ·
    // seiscientos cincuenta (650 €), con la moneda solo dentro del paréntesis
    letra: new RegExp("(^|[^" + LET + "])(" + EN_LETRA + "(?:" + PARENTESIS + WS + "(?:" + ci("de") + WS + ")?" + MONEDA +
      "(?:" + WS + ci("con") + WS + EN_LETRA + WS + "(?:" + alternativas(["céntimos", "centimos", "céntimo", "centimo"]) + ")" +
      NO_LETRA + "(?:" + WS + ci("de euro") + NO_LETRA + ")?)?" + PARENTESIS + "|" + PAREN_MONEDA + "))", "g"),
    // 1.989,99 en una tabla, sin el símbolo (solo si el documento habla de dinero)
    suelto: new RegExp("(^|[^\\w.,])(\\d{1,3}(?:\\.\\d{3})*,\\d{2})(?![0-9]|" + SP + "(?:%|(?:" + alternativas(["por ciento",
      "horas", "hora", "h", "días", "dias", "día", "dia", "kg", "km", "m2", "m²", "metros", "cm", "mm", "años", "meses",
      "litros", "kwh", "kw", "puntos"]) + ")" + NO_LETRA + "))", "g"),
  };
  const PISTA_DINERO = /€|\b(?:eur|euros?|importe|importes|total|l[ií]quido|salario|sueldo|n[óo]mina|precio|renta|devengos?|devengado|deducciones|bruto|neto|factura|cuota|pago|abono|saldo)\b/i;

  // Se busca en el texto sin tildes y con las palabras partidas unidas (planoUnido):
  // si el PDF trae «dieciséis» con el acento descompuesto o «cincuen-» y «ta» en dos
  // líneas, la cantidad en letra se encuentra igual. Las posiciones se devuelven en
  // el texto original.
  function buscarImportes(texto, add) {
    const p = planoUnido(texto);
    const t = p.plano;
    const anotar = (confianza, valido) => (v, i, f) => {
      const o = aOriginal(texto, p, i, f);
      add("importe", texto.slice(o.inicio, o.fin), o.inicio, o.fin, confianza, valido);
    };
    recorrer(t, RE_IMPORTE.cifra, anotar("alta", true));
    recorrer(t, RE_IMPORTE.antes, anotar("alta", true));
    recorrer(t, RE_IMPORTE.letra, anotar("alta", true));
    if (!PISTA_DINERO.test(t)) return;
    recorrer(t, RE_IMPORTE.suelto, (v, i, f) => {
      const antes = t.slice(Math.max(0, i - 20), i).toLowerCase();
      if (/(dias|horas|porcentaje|tipo|coef\w*|jornada|%)\s*:?\s*$/.test(antes)) return;
      anotar("media", false)(v, i, f);
    });
  }

  // ------------------------------------------------------------------ empresas
  //
  // Por ley, el nombre de una sociedad lleva su forma jurídica (S.L., S.A.…), así
  // que casi siempre se reconoce por ella. Además: «la empresa Tal», «Banco Tal»,
  // la lista de sociedades del BORME (assets/data/empresas.bin) y, una vez
  // encontrada, cualquier otra mención de la misma empresa sin la forma jurídica
  // o con el nombre corto que le da el documento («en adelante, ACME»).

  const FORMAS_ABREV = [
    "S\\.?[ ]?L\\.?[ ]?N\\.?[ ]?E\\.?", "S\\.?[ ]?L\\.?[ ]?U\\.?", "S\\.?[ ]?L\\.?[ ]?L\\.?", "S\\.?[ ]?L\\.?[ ]?P\\.?",
    "S\\.?[ ]?R\\.?[ ]?L\\.?", "S\\.?[ ]?A\\.?[ ]?U\\.?", "S\\.?[ ]?A\\.?[ ]?L\\.?", "S\\.?[ ]?A\\.?[ ]?D\\.?",
    "S\\.?[ ]?A\\.?[ ]?T\\.?", "S\\.?[ ]?C\\.?[ ]?P\\.?", "S\\.?[ ]?C\\.?[ ]?A\\.?",
    "S\\.?[ ]?[Cc][Oo][Oo][Pp]\\.?(?:[ ]?(?:And|AND|Andaluza|ANDALUZA|V|Val|VAL|Galega|GALEGA|Ltda|LTDA)\\.?)?",
    "S\\.?[ ]?L\\.?", "S\\.?[ ]?A\\.?", "S\\.[ ]?C\\.", "C\\.[ ]?B\\.", "CB", "A\\.?[ ]?I\\.?[ ]?E\\.?", "U\\.[ ]?T\\.[ ]?E\\.", "UTE",
    "SOCIMI", "SICAV", "SGIIC", "S\\.G\\.I\\.I\\.C\\.", "SGR", "S\\.G\\.R\\.", "E\\.F\\.C\\.", "E\\.P\\.E\\.",
    "GmbH", "GMBH", "Ltd\\.?", "LTD\\.?", "Limited", "LIMITED", "Inc\\.?", "INC\\.?", "LLC", "L\\.L\\.C\\.", "LLP",
    "Corp\\.?", "CORP\\.?", "Corporation", "B\\.V\\.", "BV", "N\\.V\\.", "NV", "AG", "S\\.p\\.A\\.", "SpA", "S\\.r\\.l\\.",
    "Srl", "SRL", "SAS", "S\\.A\\.S\\.", "SARL", "Plc", "PLC", "Lda\\.?", "LDA\\.?"];
  const FORMAS_LARGAS = ["sociedad limitada unipersonal", "sociedad limitada laboral", "sociedad limitada profesional",
    "sociedad limitada nueva empresa", "sociedad limitada", "sociedad de responsabilidad limitada",
    "sociedad anónima unipersonal", "sociedad anonima unipersonal", "sociedad anónima laboral", "sociedad anonima laboral",
    "sociedad anónima deportiva", "sociedad anonima deportiva", "sociedad anónima", "sociedad anonima",
    "sociedad cooperativa andaluza", "sociedad cooperativa valenciana", "sociedad cooperativa gallega",
    "sociedad cooperativa limitada", "sociedad cooperativa", "sociedad civil particular", "sociedad civil profesional",
    "sociedad civil", "comunidad de bienes", "sociedad agraria de transformación", "sociedad agraria de transformacion",
    "sociedad laboral", "unión temporal de empresas", "union temporal de empresas"];
  const RE_FORMA = new RegExp("(,?" + SP + "\\n?" + SP + ")(" + alternativas(FORMAS_LARGAS) + "|" + FORMAS_ABREV.join("|") + ")" + NO_LETRA, "g");
  // La misma lista, sobre una clave ya normalizada, para quitar la forma jurídica al final.
  const RE_FORMA_FINAL = /(?:^|\s)(?:SOCIEDAD LIMITADA(?: UNIPERSONAL| LABORAL| PROFESIONAL| NUEVA EMPRESA)?|SOCIEDAD DE RESPONSABILIDAD LIMITADA|SOCIEDAD ANONIMA(?: UNIPERSONAL| LABORAL| DEPORTIVA)?|SOCIEDAD COOPERATIVA(?: ANDALUZA| VALENCIANA| GALLEGA| LIMITADA)?|SOCIEDAD CIVIL(?: PARTICULAR| PROFESIONAL)?|COMUNIDAD DE BIENES|SOCIEDAD AGRARIA DE TRANSFORMACION|SOCIEDAD LABORAL|UNION TEMPORAL DE EMPRESAS|SOCIEDAD MERCANTIL ESTATAL|S ?M ?E|EN LIQUIDACION|S ?L ?N ?E|S ?L ?U|S ?L ?L|S ?L ?P|S ?R ?L|S ?A ?U|S ?A ?L|S ?A ?D|S ?A ?T|S ?C ?P|S ?C ?A|S ?COOP(?: ?(?:AND|ANDALUZA|V|VAL|GALEGA|LTDA))?|S ?L|S ?A|S ?C|C ?B|A ?I ?E|U ?T ?E|SOCIMI|SICAV|SGIIC|SGR|EFC|EPE|GMBH|LTD|LIMITED|INC|LLC|LLP|CORP|CORPORATION|B ?V|N ?V|AG|S ?P ?A|SAS|SARL|PLC|LDA)$/;

  // Clave para comparar nombres de empresa: mayúsculas, sin tildes ni puntos.
  // tools/borme_lista.py hace exactamente lo mismo al preparar la lista.
  function claveEmpresa(s, sinForma) {
    let k = normalizar(s).replace(/[.,'’"«»()“”]/g, "").replace(/[-/·_]/g, " ").replace(/\s+/g, " ").trim();
    if (sinForma) {
      for (let i = 0; i < 3; i++) {
        const antes = k;
        k = k.replace(RE_FORMA_FINAL, "").trim();
        if (k === antes) break;
      }
    }
    return k;
  }

  const PARTICULAS_EMPRESA = new Set(["DE", "DEL", "LA", "LAS", "LOS", "EL", "Y", "E", "I", "D'", "L'", "DI", "DA", "DO",
    "DOS", "DAS", "OF", "THE", "AND", "UND", "ET", "DU", "DES", "A", "AL", "EN", "&"]);
  // En un texto todo en mayúsculas, estas palabras cortan el nombre hacia atrás.
  const PARADAS_EMPRESA = new Set(["CON", "ENTRE", "POR", "PARA", "EN", "QUE", "SE", "SU", "SUS", "AL", "SEGUN", "MEDIANTE",
    "SOBRE", "ANTE", "DESDE", "HASTA", "SIN", "TRAS", "CONTRA", "FDO", "FIRMADO", "D", "DON", "DONA", "DNA", "SR", "SRA",
    "SRES", "CIF", "NIF", "DNI", "NIE", "OTRA", "PARTE", "COMO", "ES", "SON", "ERA", "FUE"]);
  const ROLES_EMPRESA = new Set(["MERCANTIL", "EMPRESA", "SOCIEDAD", "ENTIDAD", "COMPANIA", "FIRMA"]);
  const ARTICULOS = new Set(["LA", "EL", "LAS", "LOS", "DICHA", "DICHO", "ESTA", "ESTE", "ESA", "ESE", "SU", "UNA", "UN",
    "OTRA", "CITADA", "REFERIDA", "MENCIONADA"]);
  // Nombres cortos que un documento da a una parte y que no identifican a nadie.
  const ALIAS_GENERICOS = /^(?:LA |EL |LOS |LAS )?(?:EMPRESA|SOCIEDAD|MERCANTIL|ENTIDAD|COMPANIA|FIRMA|GESTORA|PARTE|PARTES|CLIENTE|PROVEEDORA?|CONTRATISTA|PRESTADORA?|VENDEDORA?|COMPRADORA?|PROPIETARIA?|PROPIETARIO|INQUILINA?|INQUILINO|TRABAJADORA?|EMPLEADORA?|ARRENDADORA?|ARRENDATARIA?|ARRENDATARIO|PROMOTORA|CONSTRUCTORA|ASEGURADORA|TOMADORA?|SUMINISTRADORA|DISTRIBUIDORA|COMERCIALIZADORA|CEDENTE|CESIONARIA?|CESIONARIO|FIADORA?|AVALISTA|DEUDORA?|ACREEDORA?|BANCO|CAJA|CONTRATO|ACUERDO|SERVICIO|SERVICIOS|PLATAFORMA|APLICACION|WEB|SITIO)$/;

  const RE_TOKEN = /&|[\p{L}\d][\p{L}\d'’.\-&]*/gu;
  const esMayusInicial = (t) => /^[\p{Lu}\d]/u.test(t);
  const esTodoMayus = (t) => t === t.toUpperCase() && t !== t.toLowerCase();
  const finDeFrase = (t) => /\.$/.test(t) && t.length > 3 && /\p{Ll}/u.test(t) && !/^(?:\p{L}\.)+$/u.test(t);

  function tokensDe(texto, desde, hasta) {
    const out = [];
    const re = new RegExp(RE_TOKEN.source, "gu");
    re.lastIndex = desde;
    let m;
    while ((m = re.exec(texto)) !== null && m.index < hasta) {
      const fin = Math.min(m.index + m[0].length, hasta);
      out.push({ t: texto.slice(m.index, fin), i: m.index, f: fin });
    }
    return out;
  }

  // Busca hacia atrás desde la forma jurídica dónde empieza el nombre.
  function inicioNombreEmpresa(texto, fin) {
    const toks = tokensDe(texto, Math.max(0, fin - 160), fin);
    let inicio = -1;
    let n = 0;
    for (let k = toks.length - 1; k >= 0 && n < 10; k--) {
      const tk = toks[k];
      const siguiente = k === toks.length - 1 ? fin : toks[k + 1].i;
      const hueco = texto.slice(tk.f, siguiente);
      if (!/^[  ]*\n?[  ]*$/.test(hueco)) break;   // coma, paréntesis, dos puntos, otra columna…
      if (k < toks.length - 1 && finDeFrase(tk.t)) break;
      const norm = normalizar(tk.t).replace(/\.$/, "");
      // Solo se sigue en la línea de arriba si el nombre continúa claramente
      // («… LOS ALMENDROS DEL⏎TORMES, S.L.»): así no se cuelan títulos ni columnas.
      if (hueco.indexOf("\n") !== -1 && !PARTICULAS_EMPRESA.has(norm)) break;
      if (esTodoMayus(tk.t) && PARADAS_EMPRESA.has(norm)) break;
      if (ROLES_EMPRESA.has(norm) && k > 0 && ARTICULOS.has(normalizar(toks[k - 1].t))) break;
      const particula = PARTICULAS_EMPRESA.has(norm) && !esMayusInicial(tk.t);
      if (!esMayusInicial(tk.t) && !particula && tk.t !== "&") break;
      inicio = k;
      n++;
    }
    if (inicio === -1) return -1;
    // Sin partículas sueltas delante: «en Reformas Ruiz» → «Reformas Ruiz».
    while (inicio < toks.length && !esMayusInicial(toks[inicio].t)) inicio++;
    if (inicio >= toks.length) return -1;
    const letras = toks.slice(inicio).map((t) => t.t).join("").replace(/[^\p{L}]/gu, "");
    // «(S.L., S.A.…)»: si lo de delante es otra forma jurídica, no hay nombre.
    if (!claveEmpresa(texto.slice(toks[inicio].i, fin), true)) return -1;
    return letras.length >= 2 ? toks[inicio].i : -1;
  }

  const TOKCAP = "[" + MAY + "0-9][" + LET + "0-9&'’.\\-]*";
  const NOMBRE_EMPRESA = TOKCAP + "(?:" + WS1 + "(?:(?:" + PARTIC_VIA + "|&)" + WS1 + ")*" + TOKCAP + "){0,6}";
  const RE_EMPRESA_CONTEXTO = new RegExp("((?:^|[^" + LET + "])(?<trig>(?:" + alternativas(["la empresa", "la mercantil",
    "la sociedad", "la entidad", "la compañía", "la compania", "la firma", "empresa usuaria", "nombre de la empresa",
    "razón social", "razon social", "denominación social", "denominacion social"]) + ")" + SP + ":?|(?:" +
    alternativas(["empresa", "empleador", "empleadora", "entidad", "pagador", "compañía", "compania"]) + ")" + SP + ":)" + SP +
    ")(?<nombre>" + NOMBRE_EMPRESA + ")", "g");
  const RE_EMPRESA_PREFIJO = new RegExp("(^|[^" + LET + "])((?:" + ["Fundación", "Fundacion", "FUNDACIÓN", "FUNDACION",
    "Asociación", "Asociacion", "ASOCIACIÓN", "ASOCIACION", "Cooperativa", "COOPERATIVA", "Banco", "BANCO", "Caja Rural",
    "CAJA RURAL", "Mutua", "MUTUA", "Mutualidad", "MUTUALIDAD"].join("|") + ")(?:" + WS1 + "(?:(?:" + PARTIC_VIA + ")" + WS1 +
    ")*" + TOKCAP + "){1,6})", "g");
  const RE_ALIAS = /^\s*,?\s*\(?\s*(?:en\s+)?adelante,?\s*(?:(?:la|el|los|las)\s+)?["“«']?([^"”»'),\n]{2,40}?)["”»']?\s*[),]/i;

  // «Termoclima Salmantina. El contrato…»: el nombre acaba en el punto.
  function cortarEnFrase(valor) {
    const re = /(\S+)\.(?=\s)/g;
    let m;
    while ((m = re.exec(valor)) !== null) {
      if (finDeFrase(m[1] + ".")) return valor.slice(0, m.index + m[1].length);
    }
    return valor.replace(/[\s,;:]+$/, "");
  }

  function buscarEmpresas(texto, out) {
    const nucleos = [];
    // 1. Por la forma jurídica
    RE_FORMA.lastIndex = 0;
    let m;
    while ((m = RE_FORMA.exec(texto)) !== null) {
      if (!m[1]) continue;
      const inicio = inicioNombreEmpresa(texto, m.index);
      if (inicio < 0) continue;
      const fin = m.index + m[0].length;
      out.push({ tipo: "empresa", valor: texto.slice(inicio, fin), inicio: inicio, fin: fin, confianza: "alta", valido: true });
      nucleos.push({ nucleo: texto.slice(inicio, m.index), fin: fin });
    }
    // 2. «la empresa Tal», «Razón social: Tal»
    RE_EMPRESA_CONTEXTO.lastIndex = 0;
    while ((m = RE_EMPRESA_CONTEXTO.exec(texto)) !== null) {
      const trig = m.groups.trig || "";
      const valor = cortarEnFrase(m.groups.nombre);
      // En un texto en mayúsculas, «LA EMPRESA SE COMPROMETE…» no es un nombre: ahí solo vale con dos puntos.
      if (trig && esTodoMayus(trig) && !/:/.test(m[1])) continue;
      if (!valor || !/\p{L}{2}/u.test(valor)) continue;
      const inicio = m.index + m[1].length;
      out.push({ tipo: "empresa", valor: valor, inicio: inicio, fin: inicio + valor.length, confianza: "media", valido: true });
      nucleos.push({ nucleo: valor, fin: inicio + valor.length });
    }
    // 3. «Banco Tal», «Fundación Tal»…
    recorrer(texto, RE_EMPRESA_PREFIJO, (v, i) => {
      const valor = cortarEnFrase(v);
      if (valor.indexOf(" ") === -1) return;
      out.push({ tipo: "empresa", valor: valor, inicio: i, fin: i + valor.length, confianza: "media", valido: true });
    });
    // 4. La lista del BORME y las marcas conocidas
    buscarEmpresasLista(texto, out);
    // 5. Otras menciones de las empresas ya encontradas
    propagarEmpresas(texto, out, nucleos);
  }

  function aceptarClave(clave) {
    if (enTabla(MARCAS, huella(clave))) return true;
    if (clave.indexOf(" ") === -1) {
      if (clave.length < 5 || /^\d+$/.test(clave)) return false;
      if ((NOMBRES && NOMBRES.has(clave)) || (APELLIDOS && APELLIDOS.has(clave)) || (EXCLUIR && EXCLUIR.has(clave))) return false;
    }
    return true;
  }

  function buscarEmpresasLista(texto, out) {
    if (!hasEmpresas()) return;
    const toks = tokensDe(texto, 0, texto.length);
    toks.forEach((tk) => { tk.k = claveEmpresa(tk.t); });
    for (let a = 0; a < toks.length; a++) {
      const primero = toks[a];
      if (!esMayusInicial(primero.t) || /^\d+$/.test(primero.t) || !primero.k) continue;
      let mejor = -1;
      let clave = "";
      for (let b = a; b < toks.length && b - a < 8; b++) {
        const tk = toks[b];
        if (b > a) {
          if (!/^(?:[  ]{1,3}|[  ]*\n[  ]*)$/.test(texto.slice(toks[b - 1].f, tk.i))) break;
          if (finDeFrase(toks[b - 1].t)) break;
        }
        const particula = !esMayusInicial(tk.t) && (tk.t === "&" || PARTICULAS_EMPRESA.has(tk.k));
        if (!esMayusInicial(tk.t) && !particula) break;
        if (tk.k) clave = clave ? clave + " " + tk.k : tk.k;
        if (particula) continue;
        if (tieneEmpresa(clave) && aceptarClave(clave)) mejor = b;
      }
      if (mejor < 0) continue;
      let fin = toks[mejor].f;
      if (finDeFrase(toks[mejor].t)) fin--;
      out.push({ tipo: "empresa", valor: texto.slice(primero.i, fin), inicio: primero.i, fin: fin, confianza: "media", valido: true });
      a = mejor;
    }
  }

  function escaparRe(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  // Busca una frase sin distinguir mayúsculas ni tildes, como palabra completa.
  function buscarFrase(texto, frase, fn, plano) {
    const p = plano || planoConMapa(texto);
    const patron = escaparRe(quitarTildes(frase)).replace(/\s+/g, "\\s+");
    const re = new RegExp("(^|[^A-Za-z0-9])(" + patron + ")(?![A-Za-z0-9])", "gi");
    let m;
    while ((m = re.exec(p.plano)) !== null) {
      const desde = m.index + m[1].length;
      fn(p.mapa[desde], p.mapa[desde + m[2].length]);
      if (m.index === re.lastIndex) re.lastIndex++;
    }
    return p;
  }

  function propagarEmpresas(texto, out, nucleos) {
    if (!nucleos.length) return;
    const vistos = new Set();
    let plano = null;
    const anotar = (frase, confianza) => {
      plano = buscarFrase(texto, frase, (inicio, fin) => {
        if (!esMayusInicial(texto.charAt(inicio))) return;
        out.push({ tipo: "empresa", valor: texto.slice(inicio, fin), inicio: inicio, fin: fin, confianza: confianza, valido: true });
      }, plano);
    };
    nucleos.forEach((n) => {
      const nucleo = n.nucleo.replace(/[\s,]+$/, "");
      const clave = claveEmpresa(nucleo, true);
      if (clave && !vistos.has(clave) && (clave.indexOf(" ") !== -1 || aceptarClave(clave))) {
        vistos.add(clave);
        anotar(nucleo, "media");
      }
      const alias = RE_ALIAS.exec(texto.slice(n.fin, n.fin + 90));
      if (alias) {
        const a = alias[1].trim();
        const ka = claveEmpresa(a);
        if (a.length >= 2 && esMayusInicial(a) && !ALIAS_GENERICOS.test(ka) && !vistos.has(ka)) {
          vistos.add(ka);
          anotar(a, "media");
        }
      }
    });
  }

  // --------------------------------------------------------------- nombres

  // Solo como palabra entera: antes, el «d.» del final de «Madrid.» contaba como «D.» (don)
  // y la palabra que empezaba la línea siguiente («Un saludo…») salía como un nombre
  // (hito de actualización 17).
  function reDisparador() {
    return new RegExp("(?:^|[^\\p{L}\\p{N}])(?:" + DISPARADORES.join("|") + ")[\\s:,]*$", "iu");
  }

  function palabras(texto) {
    const re = /[\p{L}][\p{L}'’\-]*/gu;
    const out = [];
    let m;
    while ((m = re.exec(texto)) !== null) {
      let txt = m[0];
      // Un NIE pegado a la palabra («SánchezX1234567L»): su letra no es de la palabra.
      if (txt.length > 2 && /[XYZ]$/.test(txt) && validarNie(texto.slice(m.index + txt.length - 1, m.index + txt.length + 8))) {
        txt = txt.slice(0, -1);
      }
      out.push({ txt: txt, inicio: m.index, fin: m.index + txt.length });
    }
    return out;
  }

  function esMayuscula(p) {
    const c = p.charAt(0);
    return c === c.toUpperCase() && c !== c.toLowerCase();
  }
  function todoMayusculas(p) {
    return p === p.toUpperCase() && p !== p.toLowerCase() && p.length > 1;
  }

  // Separación entre dos palabras de un nombre: uno o dos espacios, o un salto de
  // línea (el nombre no cabía y su final pasó a la línea siguiente: antes se tachaba
  // solo la primera parte, hito de actualización 4). Tras un salto de línea el nombre
  // solo sigue si la palabra que empieza la línea es un nombre o un apellido conocido,
  // para no llevarse «Madrid» o «Cláusula».
  // Palabras que nunca continúan un nombre (en la firma de un escaneo las columnas se
  // leen juntas: «Juan Pérez García LA ARRENDATARIA: Fdo.: María…»).
  const NO_NOMBRE = new Set(["FDO", "FIRMADO", "FIRMA", "ARRENDADOR", "ARRENDADORA", "ARRENDATARIO", "ARRENDATARIA",
    "TRABAJADOR", "TRABAJADORA", "EMPRESA", "EMPLEADOR", "EMPLEADORA", "DNI", "NIF", "NIE", "CIF", "TELEFONO", "EMAIL",
    "CORREO", "DOMICILIO", "FIADOR", "FIADORA", "AVALISTA", "COMPRADOR", "COMPRADORA", "VENDEDOR", "VENDEDORA",
    "PROPIETARIO", "PROPIETARIA", "INQUILINO", "INQUILINA", "CLIENTE", "TITULAR", "REPRESENTANTE", "TESTIGO"]);
  // Rótulos que, en mayúsculas o en la línea siguiente, no continúan un nombre aunque
  // también lo sean («Juan Pérez García» y debajo «IBAN ES91…»: Iban es un nombre).
  const ROTULOS = new Set(["IBAN", "BIC", "SWIFT", "CCC", "NSS", "NAF", "TEL", "TELF", "TFNO", "MOVIL", "FAX",
    "CUENTA", "FECHA", "PASAPORTE", "REF", "EXPEDIENTE"]);
  const HUECO = /^[  ]{1,2}$/;
  const HUECO_LINEA = /^[  ]{0,2}\n[  ]{0,2}$/;
  // Partículas que son conjunciones: unen apellidos compuestos, pero también a dos personas.
  const CONJUNCIONES = new Set(["Y", "E", "I"]);
  function sigueNombre(hueco, palabra) {
    if (HUECO.test(hueco)) return true;
    if (!HUECO_LINEA.test(hueco)) return false;
    if (VIAS_SET.has(quitarTildes(palabra).toLowerCase())) return false;   // empieza una dirección
    const n = normalizar(palabra);
    return (APELLIDOS.has(n) || NOMBRES.has(n)) && !(EXCLUIR && EXCLUIR.has(n));
  }

  function buscarNombres(texto, encontrados) {
    if (!hasData()) return;
    const tokens = palabras(texto);
    const disparadorRe = reDisparador();
    const usados = [];
    let inicioTrasY = -1;   // primera palabra de la persona que sigue a «y» (ver cortadoPorY)
    let i = 0;
    while (i < tokens.length) {
      const t = tokens[i];
      if (t.txt.length < 2 || !esMayuscula(t.txt)) {
        i++;
        continue;
      }
      // Secuencia de 1 a 5 palabras con mayúscula, admitiendo partículas en medio.
      const secuencia = [t];
      let j = i + 1;
      let ultimo = t;
      let cortadoPorY = false;   // la secuencia acaba en una «y» que empieza otra persona
      while (j < tokens.length && secuencia.length < 5) {
        const sig = tokens[j];
        const hueco = texto.slice(ultimo.fin, sig.inicio);
        const norm = normalizar(sig.txt);
        const esParticula = PARTICULAS.indexOf(norm) !== -1;
        if (!HUECO.test(hueco) && !(HUECO_LINEA.test(hueco) && (esParticula || sigueNombre(hueco, sig.txt)))) break;
        if (esParticula) {
          // Puede haber varias partículas seguidas: "José de la Fuente Martín".
          let k = j;
          const seguidas = [];
          let previo = sig;
          let huboSalto = !HUECO.test(hueco);
          while (k < tokens.length && PARTICULAS.indexOf(normalizar(tokens[k].txt)) !== -1 && seguidas.length < 3) {
            const hueco2 = texto.slice(k === j ? ultimo.fin : tokens[k - 1].fin, tokens[k].inicio);
            if (!HUECO.test(hueco2) && !HUECO_LINEA.test(hueco2)) break;
            if (!HUECO.test(hueco2)) huboSalto = true;
            seguidas.push(tokens[k]);
            previo = tokens[k];
            k++;
          }
          const tras = tokens[k];
          const hueco3 = tras ? texto.slice(previo.fin, tras.inicio) : "";
          if (tras && !HUECO.test(hueco3)) huboSalto = true;
          // Si el nombre cruza de línea, lo que sigue a las partículas tiene que ser un apellido.
          // Tras las partículas tiene que venir un nombre o apellido conocido: «José de
          // la Fuente» sí, «García LA ARRENDATARIA» no.
          const nTras = tras ? normalizar(tras.txt) : "";
          const trasValido = tras && (HUECO.test(hueco3) || HUECO_LINEA.test(hueco3)) &&
            (!huboSalto || sigueNombre("\n", tras.txt)) && !NO_NOMBRE.has(nTras) &&
            (APELLIDOS.has(nTras) || NOMBRES.has(nTras));
          // «y» (o «e», «i») une apellidos compuestos («José Ortega y Gasset»), no a dos
          // personas: si detrás viene un nombre de pila con un apellido o nombre después
          // («Juan Pérez García y María López Sánchez»), ahí empieza otra persona. Antes se
          // tomaba «Juan Pérez García y María» como un solo nombre y «López Sánchez» se
          // quedaba sin tachar (hito de actualización 13).
          if (tras && seguidas.length && seguidas.every((p) => CONJUNCIONES.has(normalizar(p.txt))) && NOMBRES.has(nTras)) {
            const otra = tokens[k + 1];
            const nOtra = otra ? normalizar(otra.txt) : "";
            if (otra && HUECO.test(texto.slice(tras.fin, otra.inicio)) && esMayuscula(otra.txt) && otra.txt.length > 1 &&
              !NO_NOMBRE.has(nOtra) && (APELLIDOS.has(nOtra) || NOMBRES.has(nOtra))) {
              cortadoPorY = true;
              inicioTrasY = k;   // la otra persona empieza ahí
              break;
            }
          }
          if (seguidas.length && trasValido && esMayuscula(tras.txt) && tras.txt.length > 1) {
            seguidas.forEach((p) => secuencia.push(p));
            secuencia.push(tras);
            ultimo = tras;
            j = k + 1;
            continue;
          }
          break;
        }
        if (!esMayuscula(sig.txt) || sig.txt.length < 2 || NO_NOMBRE.has(norm)) break;
        if (ROTULOS.has(norm) && (todoMayusculas(sig.txt) || !HUECO.test(hueco))) break;
        secuencia.push(sig);
        ultimo = sig;
        j++;
      }
      const reales = secuencia.filter((p) => PARTICULAS.indexOf(normalizar(p.txt)) === -1);
      const antes = texto.slice(Math.max(0, t.inicio - 30), t.inicio);
      const conDisparador = disparadorRe.test(quitarTildes(antes));
      let puntos = 0;
      reales.forEach((p, idx) => {
        const n = normalizar(p.txt);
        if (EXCLUIR && EXCLUIR.has(n)) puntos -= 2;
        else if (DUDOSOS && DUDOSOS.has(n)) puntos -= 1;
        if (idx === 0 && NOMBRES.has(n)) puntos += 2;
        if (idx > 0 && APELLIDOS.has(n)) puntos += 1;
      });
      if (conDisparador) puntos += 2;
      const unaSola = reales.length === 1;
      // «Juan y María López García»: «Juan» solo, pero seguido de otra persona con «y», es un
      // nombre de pila (antes iba dentro de «Juan y María López García», que ya no se une).
      const nombreAntesDeY = unaSola && cortadoPorY && NOMBRES.has(normalizar(t.txt)) && !(EXCLUIR && EXCLUIR.has(normalizar(t.txt)));
      if (nombreAntesDeY) puntos += 1;
      // La persona que sigue a esa «y» («… y Rosa Martín») también cuenta con un punto más:
      // un nombre de pila con apellido justo detrás de otra persona es una señal clara.
      if (i === inicioTrasY) puntos += 1;
      if (!(unaSola && !conDisparador && !nombreAntesDeY) && puntos >= 3) {
        const inicio = t.inicio;
        const fin = ultimo.fin;
        encontrados.push({
          tipo: "nombre", valor: texto.slice(inicio, fin), inicio: inicio, fin: fin,
          confianza: puntos >= 4 ? "alta" : "media", valido: true,
        });
        usados.push(reales.map((p) => normalizar(p.txt)));
        i = j;   // el nombre ya está marcado: se sigue después de él
      } else {
        i++;     // si la secuencia no puntúa, se prueba empezando por la palabra siguiente
      }
    }
    buscarApellidosPrimero(texto, tokens, encontrados, usados);
    propagarApellidos(texto, usados, encontrados, tokens);
    repetirNombres(texto, encontrados, tokens);
  }

  // Una persona ya encontrada («Sr. Andrés Castillo») que sale en otro sitio sin nada que la
  // señale («Andrés Castillo Vega», solo en la casilla de una tabla) también es un nombre, con
  // los apellidos conocidos que la sigan. Antes se quedaba a la vista al tachar y, al
  // anonimizar, salía «[PERSONA_1] Vega» (hito de actualización 17). Solo nombres de dos
  // palabras o más, para no marcar «Rosa» o «Pilar» sueltos.
  function repetirNombres(texto, encontrados, tokens) {
    const formas = [];
    const vistas = new Set();
    encontrados.forEach((e) => {
      if (e.tipo !== "nombre" || e.confianza === "baja") return;
      const ps = palabras(e.valor).map((p) => normalizar(p.txt)).filter((n) => PARTICULAS.indexOf(n) === -1);
      if (ps.length < 2 || vistas.has(ps.join(" "))) return;
      vistas.add(ps.join(" "));
      formas.push(ps);
    });
    if (!formas.length) return;
    const ordenadas = encontrados.slice().sort((a, b) => a.inicio - b.inicio);
    const reales = tokens.filter((t) => PARTICULAS.indexOf(normalizar(t.txt)) === -1);
    const seguido = (a, b) => HUECO.test(texto.slice(a.fin, b.inicio));
    for (let i = 0; i < reales.length; i++) {
      if (!esMayuscula(reales[i].txt)) continue;
      for (const ps of formas) {
        if (i + ps.length > reales.length) continue;
        let ok = true;
        for (let k = 0; k < ps.length && ok; k++) {
          const t = reales[i + k];
          ok = normalizar(t.txt) === ps[k] && esMayuscula(t.txt) && (k === 0 || seguido(reales[i + k - 1], t));
        }
        if (!ok) continue;
        // Los apellidos conocidos que vengan detrás (como mucho dos).
        let j = i + ps.length;
        while (j < reales.length && j < i + ps.length + 2 && seguido(reales[j - 1], reales[j]) && esMayuscula(reales[j].txt) &&
          reales[j].txt.length > 1 && APELLIDOS.has(normalizar(reales[j].txt)) && !NO_NOMBRE.has(normalizar(reales[j].txt)) &&
          !ROTULOS.has(normalizar(reales[j].txt))) j++;
        const inicio = reales[i].inicio;
        const fin = reales[j - 1].fin;
        if (solapaCon(ordenadas, inicio, fin)) continue;
        const h = { tipo: "nombre", valor: texto.slice(inicio, fin), inicio: inicio, fin: fin, confianza: "media", valido: true };
        encontrados.push(h);
        ordenadas.push(h);
        ordenadas.sort((a, b) => a.inicio - b.inicio);
        i = j - 1;
        break;
      }
    }
  }

  // «PÉREZ GARCÍA, JUAN» o «Pérez García, Juan»: los apellidos primero, una coma y el
  // nombre, como salen en nóminas y listados. Hacen falta dos apellidos conocidos (o
  // uno con un rótulo delante, «Trabajador:») y un nombre de pila conocido.
  function buscarApellidosPrimero(texto, tokens, encontrados, usados) {
    const disparadorRe = reDisparador();
    const vale = (t) => esMayuscula(t.txt) && t.txt.length > 1 && !NO_NOMBRE.has(normalizar(t.txt)) &&
      !(EXCLUIR && EXCLUIR.has(normalizar(t.txt)));
    for (let i = 0; i < tokens.length; i++) {
      const apellidos = [];
      let j = i;
      while (j < tokens.length && apellidos.length < 3 && vale(tokens[j]) && APELLIDOS.has(normalizar(tokens[j].txt)) &&
        (!apellidos.length || HUECO.test(texto.slice(apellidos[apellidos.length - 1].fin, tokens[j].inicio)))) {
        apellidos.push(tokens[j]);
        j++;
      }
      if (!apellidos.length || j >= tokens.length) continue;
      if (!/^,[  ]{1,2}$/.test(texto.slice(apellidos[apellidos.length - 1].fin, tokens[j].inicio))) continue;
      const nombre = [];
      let k = j;
      while (k < tokens.length && nombre.length < 2 && vale(tokens[k]) && NOMBRES.has(normalizar(tokens[k].txt)) &&
        (!nombre.length || HUECO.test(texto.slice(nombre[nombre.length - 1].fin, tokens[k].inicio)))) {
        nombre.push(tokens[k]);
        k++;
      }
      if (!nombre.length) continue;
      const antes = quitarTildes(texto.slice(Math.max(0, apellidos[0].inicio - 30), apellidos[0].inicio));
      if (apellidos.length < 2 && !disparadorRe.test(antes)) continue;
      const inicio = apellidos[0].inicio;
      const fin = nombre[nombre.length - 1].fin;
      encontrados.push({
        tipo: "nombre", valor: texto.slice(inicio, fin), inicio: inicio, fin: fin,
        confianza: apellidos.length >= 2 ? "alta" : "media", valido: true,
      });
      usados.push([normalizar(nombre[0].txt)].concat(apellidos.map((t) => normalizar(t.txt))));
      i = k - 1;
    }
  }

  // Si "Juan Pérez García" está detectado, "Sr. Pérez" o "PÉREZ GARCÍA" también.
  function propagarApellidos(texto, usados, encontrados, tokens) {
    const apellidos = new Set();
    usados.forEach((lista) => lista.slice(1).forEach((a) => { if (a.length > 2) apellidos.add(a); }));
    if (!apellidos.size) return;
    tokens = tokens || palabras(texto);
    // Las coincidencias ya encontradas, ordenadas, para descartar solapes rápido.
    const ordenadas = encontrados.slice().sort((a, b) => a.inicio - b.inicio);
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      const n = normalizar(t.txt);
      if (!apellidos.has(n)) continue;
      if (solapaCon(ordenadas, t.inicio, t.fin)) continue;
      const antes = quitarTildes(texto.slice(Math.max(0, t.inicio - 12), t.inicio)).toLowerCase().trim();
      const conTratamiento = TRATAMIENTOS.some((tr) => antes.endsWith(quitarTildes(tr)));
      let fin = t.fin;
      let seguidos = 0;
      let j = i + 1;
      while (j < tokens.length && seguidos < 2) {
        const hueco = texto.slice(fin, tokens[j].inicio);
        if (!(/^[  ]$/.test(hueco) || HUECO_LINEA.test(hueco)) || !apellidos.has(normalizar(tokens[j].txt))) break;
        fin = tokens[j].fin;
        seguidos++;
        j++;
      }
      const enMayusculas = todoMayusculas(t.txt) && seguidos > 0;
      if (conTratamiento || enMayusculas) {
        encontrados.push({
          tipo: "nombre", valor: texto.slice(t.inicio, fin), inicio: t.inicio, fin: fin,
          confianza: "media", valido: true,
        });
        i = j - 1;
      }
    }
  }

  // ¿La posición choca con alguna coincidencia ya encontrada? (búsqueda binaria)
  function solapaCon(ordenadas, inicio, fin) {
    let lo = 0;
    let hi = ordenadas.length - 1;
    let pos = ordenadas.length;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (ordenadas[mid].inicio >= inicio) {
        pos = mid;
        hi = mid - 1;
      } else {
        lo = mid + 1;
      }
    }
    for (let k = Math.max(0, pos - 3); k < ordenadas.length && ordenadas[k].inicio < fin; k++) {
      if (ordenadas[k].inicio < fin && ordenadas[k].fin > inicio) return true;
    }
    return false;
  }

  // ------------------------------------------------------------ resolución

  const PESO = { alta: 3, media: 2, baja: 1 };

  // Sin solapes: gana la coincidencia más larga y, a igualdad, la de más confianza.
  // Se trabaja por grupos de coincidencias que se tocan entre sí, para que un
  // documento largo no dispare el número de comparaciones.
  function resolver(lista) {
    if (lista.length < 2) return lista.slice();
    lista.sort((a, b) => a.inicio - b.inicio || b.fin - a.fin);
    const salida = [];
    let grupo = [];
    let finGrupo = -1;

    function cerrarGrupo() {
      if (!grupo.length) return;
      if (grupo.length === 1) {
        salida.push(grupo[0]);
      } else {
        grupo.sort((a, b) => (b.fin - b.inicio) - (a.fin - a.inicio) ||
          PESO[b.confianza] - PESO[a.confianza] || a.inicio - b.inicio);
        const elegidas = [];
        grupo.forEach((c) => {
          if (!elegidas.some((e) => c.inicio < e.fin && c.fin > e.inicio)) elegidas.push(c);
        });
        // Un nombre que se solapa con otro dato más largo (por ejemplo, una dirección
        // que empieza en la línea siguiente) no se pierde entero: se queda la parte de
        // delante del solape, si aún tiene al menos dos palabras. Antes se descartaba
        // y el nombre quedaba sin tachar.
        grupo.forEach((c) => {
          if (c.tipo !== "nombre" || elegidas.indexOf(c) !== -1) return;
          const choque = elegidas.filter((e) => c.inicio < e.fin && c.fin > e.inicio);
          const primero = Math.min.apply(null, choque.map((e) => e.inicio));
          if (!(primero > c.inicio)) return;
          const trozo = c.valor.slice(0, primero - c.inicio).replace(/[\s,;:]+$/, "");
          if ((trozo.match(/\p{L}{2,}/gu) || []).length < 2) return;
          const nuevo = Object.assign({}, c, { valor: trozo, fin: c.inicio + trozo.length });
          if (!elegidas.some((e) => nuevo.inicio < e.fin && nuevo.fin > e.inicio)) elegidas.push(nuevo);
        });
        elegidas.forEach((e) => salida.push(e));
      }
      grupo = [];
      finGrupo = -1;
    }

    lista.forEach((c) => {
      if (grupo.length && c.inicio >= finGrupo) cerrarGrupo();
      grupo.push(c);
      finGrupo = Math.max(finGrupo, c.fin);
    });
    cerrarGrupo();
    salida.sort((a, b) => a.inicio - b.inicio);
    return salida;
  }

  // ------------------------------------------------------- palabras propias

  // Busca lo que escribe la persona sin distinguir mayúsculas, tildes ni la
  // forma de escribir los signos (º/°, guiones, comillas). Los espacios valen
  // por cualquier separación («Mayor 5» encuentra «Mayor, 5» y «Mayor\n5») y
  // una palabra partida al final de una línea («Indepen-\ndencia») también se
  // encuentra. Con parcial: true busca también dentro de otras palabras. En un escaneo
  // (ocr), el º y la ª valen también por los signos con los que se confunden al leerlo
  // («3.º B» encuentra «3.? B»; hito de actualización 19).
  const ORDINAL_LEIDO = "[ºª?*'\"^`˚oO0-9]";
  function buscarPersonalizado(texto, termino, parcial, plano, ocr) {
    const out = [];
    const t = quitarTildes(String(termino || "").trim()).split("").map((c) => EQUIVALENTES[c] || c).join("");
    if (t.length < 2) return out;
    const salto = "(?:-?[ \\t\\u00a0]*\\n[ \\t\\u00a0]*|\\u00ad)?";
    const letra = (c) => (ocr && (c === "º" || c === "ª") ? ORDINAL_LEIDO : escaparRe(c));
    const partes = t.split(/\s+/).map((palabra) => palabra.split("").map(letra).join(salto));
    const patron = partes.join("[\\s,.;:]*");
    const re = parcial
      ? new RegExp("()(" + patron + ")", "gi")
      : new RegExp("(^|[^A-Za-z0-9])(" + patron + ")(?![A-Za-z0-9])", "gi");
    const p = plano || planoConMapa(texto);
    let m;
    while ((m = re.exec(p.plano)) !== null) {
      const desde = m.index + m[1].length;
      const inicio = p.mapa[desde];
      const fin = p.mapa[desde + m[2].length];
      out.push({ tipo: "personalizado", valor: texto.slice(inicio, fin), inicio: inicio, fin: fin, confianza: "alta", valido: true });
      if (m.index === re.lastIndex) re.lastIndex++;
    }
    return out;
  }

  // ---------------------------------------------------------------- detect

  function detect(texto, opciones) {
    texto = String(texto == null ? "" : texto);
    opciones = opciones || {};
    const tipos = opciones.tipos || TIPOS;
    const quiere = (t) => tipos.indexOf(t) !== -1;
    const out = [];
    const add = (tipo, valor, inicio, fin, confianza, valido) => {
      out.push({ tipo: tipo, valor: valor, inicio: inicio, fin: fin, confianza: confianza, valido: !!valido });
    };

    if (quiere("dni")) {
      recorrer(texto, RE.dni, (v, i, f) => {
        const ok = validarDni(v);
        // Partido entre líneas o escrito con puntos (12.345.678-Z): solo si la letra
        // cuadra; si no, «Total 12345678» y una «A» en la línea siguiente serían un DNI.
        if (!ok && (corte(v) || v.indexOf(".") !== -1)) return;
        add("dni", v, i, f, ok ? "alta" : "media", ok);
      });
    }
    // Escaneos: el lector confunde a veces la letra con una cifra («123456787») o una
    // cifra con una letra («I2345678Z»). Solo si la letra cuadra con el número, y con
    // «DNI», «NIF» o «documento» justo antes, o al principio de su línea (debajo del
    // nombre, sin rótulo).
    if (opciones.ocr && quiere("dni")) {
      recorrer(texto, RE_OCR.dni, (v, i, f) => {
        const limpio = v.replace(/[^0-9A-Za-z]/g, "");
        const cuerpo = limpio.slice(0, 8);
        const final = limpio.charAt(8);
        if ((cuerpo.match(/\d/g) || []).length < 6) return;
        if (/^\d{8}$/.test(cuerpo) && /[A-Za-z]/.test(final)) return;   // lo busca el patrón normal
        const posibles = /\d/.test(final) ? CIFRA_LETRA[final] || "" : final.toUpperCase();
        if (posibles.indexOf(letraDni(aCifras(cuerpo))) === -1) return;
        if (cerca(texto, i, PISTAS_DNI, 30)) add("dni", v, i, f, "alta", true);
        else if (alInicioDeLinea(texto, i)) add("dni", v, i, f, "media", true);
      });
    }
    if (opciones.ocr && quiere("nie")) {
      recorrer(texto, RE_OCR.nie, (v, i, f) => {
        const limpio = v.replace(/[^0-9A-Za-z]/g, "");
        const cuerpo = limpio.slice(1, 8);
        const final = limpio.charAt(8);
        if ((cuerpo.match(/\d/g) || []).length < 5) return;
        if (/^\d{7}$/.test(cuerpo) && /[A-Za-z]/.test(final)) return;   // lo busca el patrón normal
        const numero = "XYZ".indexOf(limpio.charAt(0).toUpperCase()) + aCifras(cuerpo);
        const posibles = /\d/.test(final) ? CIFRA_LETRA[final] || "" : final.toUpperCase();
        if (posibles.indexOf(letraDni(numero)) === -1) return;
        add("nie", v, i, f, cerca(texto, i, PISTAS_NIE, 30) ? "alta" : "media", true);
      });
    }
    if (quiere("dni")) {
      recorrer(texto, RE_PEGADO.dni, (v, i, f) => { if (validarDni(v) && pegadoAPalabra(texto, i)) add("dni", v, i, f, "alta", true); });
    }
    if (quiere("nie")) {
      recorrer(texto, RE_PEGADO.nie, (v, i, f) => { if (validarNie(v) && pegadoAPalabra(texto, i)) add("nie", v, i, f, "alta", true); });
    }
    if (quiere("nie")) {
      recorrer(texto, RE.nie, (v, i, f) => {
        const ok = validarNie(v);
        if (!ok && corte(v)) return;
        add("nie", v, i, f, ok ? "alta" : "media", ok);
      });
    }
    if (quiere("cif")) {
      recorrer(texto, RE.cif, (v, i, f) => {
        const cuadra = controlCifCuadra(v);
        const conPista = cerca(texto, i, PISTAS_CIF, 40);
        if (cuadra || conPista) add("cif", v, i, f, cuadra && conPista ? "alta" : "media", false);
      });
    }
    if (quiere("iban")) {
      recorrer(texto, RE.ibanEs, (v, i, f) => {
        if (validarIban(v)) add("iban", v, i, f, "alta", true);
      });
      recorrer(texto, RE.ibanOtro, (v, i, f) => {
        // El patrón puede llevarse un bloque de más (una palabra corta en mayúsculas
        // detrás, o en la línea siguiente): se prueba quitando bloques del final.
        let valor = v;
        while (valor.replace(/[^0-9A-Z]/gi, "").length >= 14) {
          if (validarIban(valor)) {
            add("iban", valor, i, i + valor.length, "alta", true);
            return;
          }
          // Sin el separador que quede al final: en «…1332.» con «CUARTA» en la línea
          // siguiente, el punto de la frase no es del IBAN (hito de actualización 17).
          const corto = valor.replace(/(?:[ \t -]|\s*\n\s*)?[0-9A-Z]{1,4}$/, "").replace(/[\s.\/-]+$/, "");
          if (corto === valor) return;
          valor = corto;
        }
      });
    }
    if (quiere("iban")) {
      recorrer(texto, RE_PEGADO.iban, (v, i, f) => { if (validarIban(v) && pegadoAPalabra(texto, i)) add("iban", v, i, f, "alta", true); });
    }
    // Escaneos: IBAN y cuentas antiguas con cifras leídas como letras («ES91 21OO…»,
    // «E591…»); solo si sus cifras de control cuadran una vez corregidas.
    if (opciones.ocr && quiere("iban")) {
      recorrer(texto, RE_OCR.iban, (v, i, f) => {
        if (validarIban(v)) return;   // lo busca el patrón normal
        const corregido = "ES" + aCifras(v.slice(2));
        if (validarIban(corregido)) add("iban", v, i, f, "alta", true);
      });
    }
    if (quiere("cuenta")) {
      recorrer(texto, RE.cuenta, (v, i, f) => {
        if (corte(v) && !validarCcc(v)) return;
        add("cuenta", v, i, f, "media", false);
      });
      if (opciones.ocr) {
        recorrer(texto, RE_OCR.cuenta, (v, i, f) => {
          if (/^[\d\s-]+$/.test(v)) return;   // lo busca el patrón normal
          if (validarCcc(aCifras(v))) add("cuenta", v, i, f, "media", true);
        });
      }
    }
    if (quiere("tarjeta")) {
      recorrer(texto, RE.tarjeta, (v, i, f) => {
        if (validarTarjeta(v)) add("tarjeta", v, i, f, "alta", true);
      });
    }
    if (quiere("telefono")) {
      // Un teléfono no puede ser un trozo de una serie de números más larga
      // («700 800 900 600 500»), ni partirse en más de dos líneas.
      const suelto = (v, i, f) => !/\d[ .-]?$/.test(texto.slice(Math.max(0, i - 2), i)) &&
        !/^[ .-]?\d/.test(texto.slice(f, f + 2)) && (v.match(/\n/g) || []).length <= 1;
      recorrer(texto, RE.telefonoEs, (v, i, f) => {
        const d = soloDigitos(v);
        const nacional = d.length === 9 || (d.length === 11 && d.indexOf("34") === 0) ||
          (d.length === 13 && d.indexOf("0034") === 0);
        if (nacional && suelto(v, i, f)) add("telefono", v, i, f, "alta", true);
      });
      recorrer(texto, RE.telefonoInt, (v, i, f) => {
        const d = soloDigitos(v);
        if (d.length >= 8 && d.length <= 15 && suelto(v, i, f)) add("telefono", v, i, f, "media", false);
      });
    }
    if (quiere("email")) {
      recorrer(texto, RE.email, (v, i, f) => add("email", v, i, f, "alta", true));
      // Escaneos: la @ leída como Q, © o &, solo con «correo» o «email» cerca.
      if (opciones.ocr) {
        recorrer(texto, RE_OCR.email, (v, i, f) => {
          if (cerca(texto, i, PISTAS_EMAIL, 60)) add("email", v, i, f, "media", false);
        });
        // La @ leída como una letra más: solo con el rótulo justo delante, en la misma línea
        // (hito de actualización 17).
        recorrer(texto, RE_OCR.emailSinArroba, (v, i, f) => {
          if (v.indexOf("@") !== -1) return;   // lo busca el patrón normal
          const linea = texto.slice(Math.max(0, i - 25), i).split("\n").pop();
          if (cerca(linea, linea.length, PISTAS_EMAIL, 25)) add("email", v, i, f, "media", false);
        });
      }
    }
    if (quiere("nss")) {
      // Con sus dígitos de control bien y su rótulo cerca, confianza alta; con solo una de
      // las dos cosas, media (hito de actualización 17: antes siempre media).
      recorrer(texto, RE.nss, (v, i, f) => {
        const cuadra = controlNssCuadra(v);
        const conPista = cerca(texto, i, PISTAS_NSS, 60);
        if (cuadra || conPista) add("nss", v, i, f, cuadra && conPista ? "alta" : "media", cuadra);
      });
    }
    if (quiere("matricula")) {
      recorrer(texto, RE.matricula, (v, i, f) => {
        // Partida entre líneas, solo con «matrícula» cerca («2024» y «BCN» debajo no lo son).
        if (corte(v) && !cerca(texto, i, ["matrícula", "matricula"], 40)) return;
        add("matricula", v, i, f, "alta", true);
      });
      recorrer(texto, RE.matriculaVieja, (v, i, f) => {
        if (cerca(texto, i, ["matrícula", "matricula"], 30)) add("matricula", v, i, f, "baja", false);
      });
    }
    if (quiere("direccion")) buscarDirecciones(texto, out);
    if (quiere("cp")) {
      recorrer(texto, RE.cp, (v, i, f) => {
        const n = Number(v);
        if (n < 1000 || n > 52999) return;
        const tras = texto.slice(f, f + 30);
        const conCiudad = /^[\s,.-]*[A-ZÁÉÍÓÚÑ][\p{L}]{2,}/u.test(tras);
        if (conCiudad || cerca(texto, i, PISTAS_CP, 20) || cerca(texto, i, VIAS_PISTA, 90)) {
          add("cp", v, i, f, "media", false);
        }
      });
    }
    if (quiere("fecha_nac")) {
      const anotar = (v, i, f, dia, mes, anio) => {
        if (!fechaValida(dia, mes, anio)) return;
        if (cerca(texto, i, PISTAS_NACIMIENTO, 45)) add("fecha_nac", v, i, f, "alta", true);
        else if (opciones.todasLasFechas) add("fecha_nac", v, i, f, "media", true);
      };
      recorrer(texto, RE.fechaNumero, (v, i, f) => {
        const p = v.split(/[/.-]/);
        let anio = Number(p[2]);
        if (anio < 100) anio += anio > 40 ? 1900 : 2000;
        anotar(v, i, f, Number(p[0]), Number(p[1]), anio);
      });
      recorrer(texto, reFechaLetras(), (v, i, f) => {
        const p = quitarTildes(v).toLowerCase().split(/\s+de\s+/);
        anotar(v, i, f, Number(p[0]), MESES.indexOf(p[1]) + 1, Number(p[2]));
      });
    }
    if (quiere("importe")) buscarImportes(texto, add);
    if (quiere("empresa")) buscarEmpresas(texto, out);
    if (quiere("nombre")) buscarNombres(texto, out);

    const personalizados = opciones.personalizados || [];
    if (personalizados.length) {
      const plano = planoConMapa(texto);
      personalizados.forEach((termino) => {
        buscarPersonalizado(texto, termino, !!opciones.parcial, plano, !!opciones.ocr).forEach((h) => out.push(h));
      });
    }

    // Si un trozo lleva forma jurídica (S.L., S.A.…), es una empresa aunque
    // también parezca un nombre de persona.
    const sociedades = out.filter((c) => c.tipo === "empresa" && c.confianza === "alta");
    const final = sociedades.length
      ? out.filter((c) => c.tipo !== "nombre" || !sociedades.some((e) => c.inicio < e.fin && c.fin > e.inicio))
      : out;
    return resolver(final);
  }

  // -------------------------------------------------- datos entre dos páginas

  // Un dato puede empezar al final de una página y acabar al principio de la
  // siguiente («12345678» y la «Z» en la otra página). Como cada página se analiza
  // por separado, aquí se busca en la unión del final de cada página con el
  // principio de la siguiente, saltando encabezados, pies y números de página, que
  // quedan en medio. Devuelve lo que cruza la unión con sus posiciones en cada página:
  // [{ pagina (índice de la primera), tipo, valor, confianza, a: {inicio, fin}, b: {inicio, fin} }]
  const TROZO_UNION = 160;
  const RE_NUM_PAGINA = /^[-–—\s]*(?:p[aá]g(?:ina)?\.?\s*)?\d{1,4}(?:\s*(?:de|\/)\s*\d{1,4})?[-–—\s]*$/i;

  function lineasCon(texto) {
    const out = [];
    let ini = 0;
    texto.split("\n").forEach((l) => {
      if (l.trim()) out.push({ ini: ini, fin: ini + l.length, txt: l });
      ini += l.length + 1;
    });
    return out;
  }

  function entrePaginas(textos, opciones) {
    const salida = [];
    const lineas = textos.map((t) => lineasCon(t || ""));
    const clave = (s) => s.trim().replace(/\d+/g, "#").toLowerCase();
    const cuenta = {};
    lineas.forEach((ls) => {
      new Set(ls.slice(0, 3).concat(ls.slice(-3)).map((l) => clave(l.txt))).forEach((k) => { cuenta[k] = (cuenta[k] || 0) + 1; });
    });
    // Encabezado o pie: se repite (cambiando las cifras por #) en varias páginas, o es un número de página.
    const margen = (l) => RE_NUM_PAGINA.test(l.txt) || cuenta[clave(l.txt)] >= 2;
    for (let n = 0; n + 1 < textos.length; n++) {
      if (!textos[n] || !textos[n + 1]) continue;
      const la = lineas[n].slice(-4).reverse().find((l) => !margen(l));
      const lb = lineas[n + 1].slice(0, 4).find((l) => !margen(l));
      if (!la || !lb) continue;
      const desde = Math.max(0, la.fin - TROZO_UNION);
      const cola = textos[n].slice(desde, la.fin);
      const cabeza = textos[n + 1].slice(lb.ini, lb.ini + TROZO_UNION);
      detect(cola + "\n" + cabeza, opciones)
        .filter((h) => h.inicio < cola.length && h.fin > cola.length + 1)
        .forEach((h) => salida.push({
          pagina: n,
          tipo: h.tipo,
          valor: h.valor.replace(/\s*\n\s*/g, " "),
          confianza: h.confianza,
          a: { inicio: desde + h.inicio, fin: la.fin },
          b: { inicio: lb.ini, fin: lb.ini + (h.fin - cola.length - 1) },
        }));
    }
    return salida;
  }

  const DP_DETECT = {
    version: "1.2",
    entrePaginas: entrePaginas,
    TIPOS: TIPOS,
    GRUPOS: GRUPOS,
    ETIQUETAS: ETIQUETAS,
    LISTA_EMPRESAS: LISTA_EMPRESAS,
    detect: detect,
    setData: setData,
    hasData: hasData,
    hasEmpresas: hasEmpresas,
    normalizar: normalizar,
    claveEmpresa: claveEmpresa,
    validarDni: validarDni,
    validarNie: validarNie,
    validarIban: validarIban,
    validarTarjeta: validarTarjeta,
    controlNssCuadra: controlNssCuadra,
    controlCifCuadra: controlCifCuadra,
    letraDni: letraDni,
  };

  global.DP_DETECT = DP_DETECT;
  if (typeof module !== "undefined" && module.exports) module.exports = DP_DETECT;
})(typeof globalThis !== "undefined" ? globalThis : this);
