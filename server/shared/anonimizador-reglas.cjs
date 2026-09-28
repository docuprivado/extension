/*
 * docuprivado.es · Anonimizador: reglas sin pantalla.
 *
 * Cómo se reparten los datos encontrados en etiquetas ([PERSONA_1], [DNI_1]…), qué
 * apariciones van con la misma etiqueta («Sr. Pérez» con «Juan Pérez García»), cómo queda
 * el texto anónimo, la tabla de equivalencias que se descarga y cómo se devuelven los datos
 * reales a un texto con etiquetas (restaurar). Las usa el anonimizador de la web
 * (js/anonimizador.js) y la extensión para Claude Desktop, que copia este archivo tal cual
 * (../docuprivado-claude, docs/PROGRESO.md, «Proyecto hermano»); por eso no toca el DOM y
 * también funciona en Node. Necesita el detector (js/detectores.js, DP_DETECT) ya cargado.
 *
 * Se descarga al anonimizar o restaurar por primera vez, no al abrir la página.
 */
(function (global) {
  "use strict";

  const INSTRUCCION = "El texto contiene etiquetas entre corchetes como [PERSONA_1] que sustituyen " +
    "datos personales. Mantenlas exactamente igual en tu respuesta.";

  // Cada tipo de dato tiene su etiqueta, en mayúsculas y sin tildes.
  const BASES = {
    nombre: "PERSONA", dni: "DNI", nie: "NIE", iban: "IBAN", cuenta: "CUENTA",
    tarjeta: "TARJETA", telefono: "TELEFONO", email: "EMAIL", direccion: "DIRECCION",
    cp: "CP", nss: "NSS", matricula: "MATRICULA", fecha_nac: "FECHA_NAC", empresa: "EMPRESA",
    cif: "NIF_EMPRESA", importe: "IMPORTE", personalizado: "OTRO",
  };
  // En estos tipos, dos valores son el mismo aunque cambien espacios o guiones.
  const SOLO_ALFANUM = ["dni", "nie", "iban", "cuenta", "tarjeta", "telefono", "nss", "matricula", "cp", "cif"];
  const PARTICULAS = ["DE", "DEL", "LA", "LAS", "LOS", "Y", "I", "E", "DA", "DAS", "DO",
    "DOS", "DI", "DU", "VAN", "VON", "DER", "DEN", "LE", "SAN", "SANTA"];

  // Las casillas del anonimizador que vienen marcadas en la web.
  const CASILLAS = ["dni", "nombre", "fecha_nac", "empresa", "telefono", "email", "direccion", "iban", "tarjeta", "nss", "matricula"];

  const D = () => global.DP_DETECT;

  // Las casillas agrupan tipos: "DNI y NIE" son dos, con las direcciones van
  // los códigos postales, con el IBAN las cuentas viejas y con las empresas su NIF.
  function tiposConAcompanantes(tipos) {
    const extra = { direccion: "cp", dni: "nie", iban: "cuenta", empresa: "cif" };
    const conExtra = tipos.slice();
    Object.keys(extra).forEach((t) => { if (tipos.indexOf(t) !== -1) conExtra.push(extra[t]); });
    return conExtra;
  }

  const normal = (s) => D().normalizar(String(s));

  function claveDe(tipo, valor) {
    // «ACME Ibérica, S.L.» y «ACME Ibérica» son la misma empresa.
    if (tipo === "empresa") return D().claveEmpresa(valor, true);
    const n = normal(valor);
    if (SOLO_ALFANUM.indexOf(tipo) !== -1) return n.replace(/[^A-Z0-9]+/g, "");
    return n.replace(/\s+/g, " ").trim();
  }

  function tokensDe(valor) {
    return normal(valor).replace(/[^A-ZÑ\s]+/g, " ").split(/\s+/)
      .filter((t) => t && PARTICULAS.indexOf(t) === -1);
  }

  const contieneTodos = (grandes, pequenos) => pequenos.every((t) => grandes.indexOf(t) !== -1);

  // "Sr. Pérez" tiene que recibir la misma etiqueta que "Juan Pérez García".
  // Solo se agrupan si no hay duda: si encaja con dos personas, va aparte.
  function personaParcial(personas, valor) {
    const t = tokensDe(valor);
    if (!t.length) return null;
    const candidatos = personas.filter((p) => contieneTodos(p.tokens, t) || contieneTodos(t, p.tokens));
    if (candidatos.length !== 1) return null;
    const p = candidatos[0];
    if (t.length > p.tokens.length) {   // el grupo se queda con el nombre más completo
      p.tokens = t;
      p.grupo.valor = valor;
    }
    return p.grupo;
  }

  // Igual con las empresas: «Zafiro» (el nombre corto que le da el documento)
  // va con «Zafiro Digital Solutions SL» si no puede ser de otra.
  function empresaParcial(empresas, valor) {
    const t = D().claveEmpresa(valor, true).split(" ").filter(Boolean);
    if (!t.length) return null;
    const candidatas = empresas.filter((e) => contieneTodos(e.tokens, t) || contieneTodos(t, e.tokens));
    if (candidatas.length !== 1) return null;
    const e = candidatas[0];
    if (t.length > e.tokens.length) {
      e.tokens = t;
      e.grupo.valor = valor;
    }
    return e.grupo;
  }

  // Reparte los hallazgos del detector en grupos: un grupo por etiqueta, con sus
  // apariciones. Devuelve { grupos, ocurrencias }:
  // grupos: [{ etiqueta, base, num, tipo, valor, confianza, activa, ocurrencias }]
  // ocurrencias: [{ inicio, fin, valor, grupo }], en el orden del texto.
  function construir(texto, hallazgos) {
    const grupos = [];
    const ocurrencias = [];
    const porClave = Object.create(null);
    const contadores = Object.create(null);
    const personas = [];
    const empresas = [];

    hallazgos.slice().sort((a, b) => a.inicio - b.inicio).forEach((h) => {
      // Algunos hallazgos arrastran el espacio de delante ("Tel. 911…"): se
      // recorta para que la etiqueta no se pegue a la palabra anterior.
      let ini = h.inicio;
      let fin = h.fin;
      while (ini < fin && /\s/.test(texto.charAt(ini))) ini++;
      while (fin > ini && /\s/.test(texto.charAt(fin - 1))) fin--;
      if (ini >= fin) return;
      const valor = texto.slice(ini, fin);
      const base = BASES[h.tipo] || "OTRO";
      const clave = base + "|" + claveDe(h.tipo, valor);
      let grupo = porClave[clave];
      if (!grupo && h.tipo === "nombre") grupo = personaParcial(personas, valor);
      if (!grupo && h.tipo === "empresa") grupo = empresaParcial(empresas, valor);
      if (!grupo) {
        contadores[base] = (contadores[base] || 0) + 1;
        grupo = {
          etiqueta: "[" + base + "_" + contadores[base] + "]",
          base: base,
          num: contadores[base],
          tipo: h.tipo,
          valor: valor,
          confianza: h.confianza,
          activa: true,
          ocurrencias: [],
        };
        grupos.push(grupo);
        if (h.tipo === "nombre") personas.push({ grupo: grupo, tokens: tokensDe(valor) });
        if (h.tipo === "empresa") empresas.push({ grupo: grupo, tokens: D().claveEmpresa(valor, true).split(" ").filter(Boolean) });
      }
      porClave[clave] = grupo;
      const oc = { inicio: ini, fin: fin, valor: valor, grupo: grupo };
      grupo.ocurrencias.push(oc);
      ocurrencias.push(oc);
    });
    completarRepetidos(texto, ocurrencias);
    ocurrencias.sort((a, b) => a.inicio - b.inicio);
    grupos.forEach((g) => g.ocurrencias.sort((a, b) => a.inicio - b.inicio));
    return { grupos: grupos, ocurrencias: ocurrencias };
  }

  // Segunda pasada (hito de actualización 12): un dato ya encontrado que vuelve a aparecer
  // donde el detector no lo reconoció («juan pérez garcía» en minúsculas, «dni_12345678Z.pdf»,
  // una tabla sin rótulos…) también se cambia, con la misma etiqueta. Se busca como palabra
  // entera; los de varias palabras, sin distinguir mayúsculas, y los de una sola, tal cual
  // (para no confundir «Rosa» con «rosa»). Los muy cortos no se buscan: «Ana» o «2026»
  // podrían ser otra cosa. Las apariciones añadidas llevan «repetida: true».
  const escapar = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  function sirveParaRepetir(v) {
    if (/^\d[\d\s./-]*$/.test(v)) return v.replace(/\D/g, "").length >= 5;   // solo cifras: al menos 5
    return v.length >= 4;
  }
  function completarRepetidos(texto, ocurrencias) {
    const formas = [];
    const vistas = Object.create(null);
    ocurrencias.forEach((oc) => {
      if (vistas[oc.valor] || !sirveParaRepetir(oc.valor)) return;
      vistas[oc.valor] = true;
      formas.push({ valor: oc.valor, grupo: oc.grupo });
    });
    formas.sort((a, b) => b.valor.length - a.valor.length);
    const ocupado = ocurrencias.map((oc) => [oc.inicio, oc.fin]);
    const libre = (i, f) => ocupado.every((x) => f <= x[0] || i >= x[1]);
    formas.forEach((f) => {
      // (^|no letra ni cifra) delante, en vez de mirar hacia atrás, que los iPhone antiguos no entienden.
      const re = new RegExp("(^|[^\\p{L}\\p{N}])(" + escapar(f.valor) + ")(?![\\p{L}\\p{N}])", /\s/.test(f.valor) ? "giu" : "gu");
      let m;
      while ((m = re.exec(texto))) {
        const ini = m.index + m[1].length;
        const fin = ini + m[2].length;
        re.lastIndex = fin;
        if (!libre(ini, fin)) continue;
        const oc = { inicio: ini, fin: fin, valor: texto.slice(ini, fin), grupo: f.grupo, repetida: true };
        f.grupo.ocurrencias.push(oc);
        ocurrencias.push(oc);
        ocupado.push([ini, fin]);
      }
    });
  }

  // El texto con cada aparición de un grupo activo cambiada por su etiqueta.
  function textoAnonimo(texto, ocurrencias) {
    let salida = "";
    let pos = 0;
    ocurrencias.forEach((oc) => {
      if (!oc.grupo.activa || oc.inicio < pos) return;
      salida += texto.slice(pos, oc.inicio) + oc.grupo.etiqueta;
      pos = oc.fin;
    });
    return salida + texto.slice(pos);
  }

  // ------------------------------------------------------- tabla de equivalencias
  // Etiqueta sin corchetes → valor real, de los grupos activos.
  function tablaDeGrupos(grupos) {
    const tabla = Object.create(null);
    grupos.filter((g) => g.activa).forEach((g) => {
      tabla[g.etiqueta.replace(/[[\]]/g, "")] = g.valor;
    });
    return tabla;
  }

  // El archivo .json de la tabla (el que se descarga). fecha: AAAA-MM-DD.
  function archivoTabla(grupos, fecha) {
    return {
      herramienta: "docuprivado.es",
      formato: "tabla-de-equivalencias",
      version: 1,
      creado: fecha,
      aviso: "Este archivo contiene datos personales reales. Guárdalo en un sitio seguro y no lo compartas.",
      sustituciones: grupos.filter((g) => g.activa).map((g) => ({
        etiqueta: g.etiqueta, tipo: g.tipo, valor: g.valor,
      })),
    };
  }

  // De un archivo de tabla ya leído (JSON) a etiqueta → valor, o null si no es una tabla.
  function leerTabla(datos) {
    const lista = datos && datos.sustituciones;
    if (!Array.isArray(lista) || !lista.length) return null;
    const tabla = Object.create(null);
    lista.forEach((s) => {
      if (!s || typeof s.etiqueta !== "string" || typeof s.valor !== "string") return;
      tabla[s.etiqueta.replace(/[[\]]/g, "").toUpperCase()] = s.valor;
    });
    return Object.keys(tabla).length ? tabla : null;
  }

  // -------------------------------------------------------------- restaurar
  // Se reconocen las etiquetas aunque la IA las haya cambiado: con o sin
  // corchetes, en minúsculas, con guion bajo o con espacio. Solo se sustituyen
  // las que están en la tabla, para no tocar un "persona 1" normal del texto.
  const BASES_TODAS = Object.keys(BASES).map((t) => BASES[t]).filter((v, i, a) => a.indexOf(v) === i);
  const LISTA = BASES_TODAS.join("|");
  // Dos formas: entre corchetes (ahí se admiten espacios dentro) o suelta. Sin
  // corchetes no se tocan los espacios de alrededor, que son del texto.
  const FUENTE_ETIQUETA = "\\[\\s*(" + LISTA + ")[ _\\-]?(\\d{1,4})(?!\\d)\\s*\\]" +
    "|\\b(" + LISTA + ")[ _\\-]?(\\d{1,4})(?!\\d)";

  // Cada etiqueta reconocida en el texto: { inicio, fin, clave (PERSONA_1), trozo }.
  function etiquetasEn(texto) {
    const re = new RegExp(FUENTE_ETIQUETA, "gi");
    const salida = [];
    let m;
    while ((m = re.exec(texto))) {
      const base = m[1] || m[3];
      const num = m[2] || m[4];
      salida.push({ inicio: m.index, fin: m.index + m[0].length, clave: base.toUpperCase() + "_" + num, trozo: m[0] });
    }
    return salida;
  }

  // Si una etiqueta que no está en la tabla parece puesta por nosotros (con corchetes o
  // guion), se avisa; un "persona 1" normal del texto, no.
  const parecePuesta = (trozo) => /[[\]]/.test(trozo) || /[_-]/.test(trozo);

  function restaurar(texto, tabla) {
    let restauradas = 0;
    const desconocidas = [];
    let salida = "";
    let pos = 0;
    etiquetasEn(texto).forEach((e) => {
      if (Object.prototype.hasOwnProperty.call(tabla, e.clave)) {
        restauradas++;
        salida += texto.slice(pos, e.inicio) + tabla[e.clave];
        pos = e.fin;
        return;
      }
      if (parecePuesta(e.trozo) && desconocidas.indexOf(e.clave) === -1) desconocidas.push(e.clave);
    });
    return { texto: salida + texto.slice(pos), restauradas: restauradas, desconocidas: desconocidas };
  }

  const API = {
    INSTRUCCION: INSTRUCCION,
    BASES: BASES,
    CASILLAS: CASILLAS,
    tiposConAcompanantes: tiposConAcompanantes,
    construir: construir,
    textoAnonimo: textoAnonimo,
    tablaDeGrupos: tablaDeGrupos,
    archivoTabla: archivoTabla,
    leerTabla: leerTabla,
    etiquetasEn: etiquetasEn,
    parecePuesta: parecePuesta,
    restaurar: restaurar,
  };
  global.DP_ANON_REGLAS = API;
  if (typeof module !== "undefined" && module.exports) module.exports = API;
})(typeof globalThis !== "undefined" ? globalThis : this);
