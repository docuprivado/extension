/*
 * Detección común a analizar y tachar (docs/PROMPT_EXTENSION.md §4.5): los mismos
 * tipos y perfiles que las páginas del tachador de la web, las palabras que el usuario
 * quiere tachar además (personalizados) o dejar visibles (no_tachar), y cómo se enseñan
 * los datos cuando el usuario pide verlos: siempre tapados en parte (CLAUDE.md §4.4).
 */
import { ErrorUsuario } from "./errores.js";
import { reglas } from "./motores.js";

// Las casillas del tachador de la web (tachar-documento/index.html). Con cada una van
// sus tipos acompañantes (con el DNI el NIE…), igual que en la web: reglas.tiposDeCasillas.
export const CASILLAS = ["dni", "nombre", "fecha_nac", "empresa", "telefono", "email", "direccion", "iban", "tarjeta", "importe", "nss", "matricula"];

// Tipos que se pueden pedir sueltos (los de las casillas y sus acompañantes).
export const TIPOS = ["dni", "nie", "iban", "cuenta", "tarjeta", "telefono", "email", "nss", "matricula", "direccion", "cp", "fecha_nac", "nombre", "empresa", "cif", "importe"];

// Perfiles por tipo de documento, iguales a las variantes de la web.
export const PERFILES = {
  general: CASILLAS,
  contrato: CASILLAS,                                         // /tachar-documento/contrato/: todo marcado
  captura: CASILLAS,                                          // /tachar-documento/imagen/
  nomina: CASILLAS.filter((t) => !["tarjeta", "matricula", "importe", "empresa"].includes(t)),   // /tachar-documento/nomina/
};

export const NOMBRE_TIPO = {
  dni: "DNI", nie: "NIE", iban: "IBAN", cuenta: "cuenta bancaria", tarjeta: "tarjeta", telefono: "teléfono", email: "correo electrónico",
  nss: "número de la Seguridad Social", matricula: "matrícula", direccion: "dirección", cp: "código postal", fecha_nac: "fecha de nacimiento",
  nombre: "nombre", empresa: "empresa", cif: "NIF de empresa", importe: "cantidad de dinero", personalizado: "palabra que pediste",
};
const PLURAL = {
  dni: "DNI", nie: "NIE", iban: "IBAN", cuenta: "cuentas bancarias", tarjeta: "tarjetas", telefono: "teléfonos", email: "correos electrónicos",
  nss: "números de la Seguridad Social", matricula: "matrículas", direccion: "direcciones", cp: "códigos postales", fecha_nac: "fechas de nacimiento",
  nombre: "nombres", empresa: "empresas", cif: "NIF de empresa", importe: "cantidades de dinero", personalizado: "palabras que pediste",
};
// Rótulo corto para el estilo «etiqueta» (va dentro de la barra negra).
export const ROTULO = {
  dni: "DNI", nie: "NIE", iban: "IBAN", cuenta: "CUENTA", tarjeta: "TARJETA", telefono: "TELÉFONO", email: "CORREO", nss: "N.º SS",
  matricula: "MATRÍCULA", direccion: "DIRECCIÓN", cp: "CP", fecha_nac: "FECHA", nombre: "NOMBRE", empresa: "EMPRESA", cif: "NIF",
  importe: "IMPORTE", personalizado: "OCULTO",
};

/**
 * Opciones del detector a partir de los parámetros de la herramienta.
 * «tipos» manda sobre «preset»; sin ninguno, el perfil general (todo, como la web).
 */
export function opcionesDeteccion(params) {
  let casillas;
  if (params.tipos && params.tipos.length) {
    const malos = params.tipos.filter((t) => !TIPOS.includes(t));
    if (malos.length) throw new ErrorUsuario("No conozco estos tipos de dato: " + malos.join(", ") + ". Los que hay son: " + TIPOS.join(", ") + ".", "tipos");
    casillas = params.tipos;
  } else {
    const perfil = params.preset || "general";
    if (!PERFILES[perfil]) throw new ErrorUsuario("No conozco el perfil «" + perfil + "». Los que hay son: " + Object.keys(PERFILES).join(", ") + ".", "preset");
    casillas = PERFILES[perfil];
  }
  const tipos = [...new Set(reglas().tiposDeCasillas(casillas))];
  const limpiar = (lista) => (lista || []).map((p) => String(p).trim()).filter((p) => p.length >= 2);
  return { tipos, personalizados: limpiar(params.personalizados), noTachar: limpiar(params.no_tachar) };
}

// Sin tildes, sin mayúsculas, sin puntuación y con los espacios juntos.
function normal(s) {
  return String(s).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9ñ]+/g, " ").trim();
}

/**
 * ¿Hay que dejar visible este dato? Sí si contiene alguna de las palabras de «no_tachar»
 * («Inmobiliaria Ejemplo» deja visible «INMOBILIARIA EJEMPLO, S.L.») o si es una parte de
 * ellas de al menos 4 letras (su nombre corto, «Ejemplo»).
 */
export function dejarVisible(valor, noTachar) {
  if (!noTachar.length) return false;
  const v = normal(valor);
  if (!v) return false;
  return noTachar.some((p) => {
    const n = normal(p);
    if (!n) return false;
    return (" " + v + " ").includes(" " + n + " ") || (v.length >= 4 && (" " + n + " ").includes(" " + v + " "));
  });
}

// { dni: 2, nombre: 7 } → «2 DNI, 7 nombres»
export function textoPorTipo(porTipo) {
  return Object.entries(porTipo).sort((a, b) => b[1] - a[1])
    .map(([t, n]) => n + " " + (n === 1 ? NOMBRE_TIPO[t] || t : PLURAL[t] || t)).join(", ");
}

export function sumarPorTipo(destino, origen) {
  for (const [t, n] of Object.entries(origen)) destino[t] = (destino[t] || 0) + n;
  return destino;
}

// --------------------------------------------------------------- enmascarar
const tapar = (s) => s.replace(/[0-9A-Za-zÀ-ÿ]/g, "*");
function soloAlfanum(s) {
  return String(s).replace(/[^0-9A-Za-z]/g, "").toUpperCase();
}

/**
 * Un dato tapado en parte, para cuando el usuario pide ver qué se ha encontrado:
 * DNI ***4567** (como la AEPD), IBAN ES91 **** **** **** **** 1332, nombres con la inicial,
 * teléfonos con las tres últimas cifras (docs/PROMPT_EXTENSION.md §4.3).
 */
export function enmascarar(tipo, valor) {
  const v = String(valor).replace(/\s+/g, " ").trim();
  const a = soloAlfanum(v);
  switch (tipo) {
    // Como recomienda la AEPD (orientación de la disposición adicional séptima de la LOPDGDD):
    // solo las cifras cuarta a séptima, sin la letra. DNI 12345678X → ***4567**; NIE
    // L1234567X → ****4567* (hito de actualización 17; antes 1234****Z).
    case "dni":
      return a.length >= 9 ? "***" + a.slice(3, 7) + "*".repeat(a.length - 7) : tapar(v);
    case "nie":
      return a.length >= 9 ? "****" + a.slice(4, 8) + "*".repeat(a.length - 8) : tapar(v);
    case "iban":
      return a.length >= 8 ? a.slice(0, 4) + " **** **** **** **** " + a.slice(-4) : tapar(v);
    case "cuenta":
    case "tarjeta":
      return a.length >= 8 ? "**** **** **** " + a.slice(-4) : tapar(v);
    case "telefono": {
      const d = v.replace(/\D/g, "");
      return d.length >= 6 ? "*** *** " + d.slice(-3) : tapar(v);
    }
    case "email": {
      const m = v.match(/^([^@\s])[^@\s]*@([^.\s])[^\s]*?(\.[a-z]{2,})$/i);
      return m ? m[1] + "***@" + m[2] + "***" + m[3] : tapar(v);
    }
    case "nombre":
    case "empresa":
    case "direccion":
    case "personalizado":
      return v.split(" ").map((p) => (p.length <= 1 ? p : p[0] + tapar(p.slice(1)))).join(" ");
    case "fecha_nac": {
      const m = v.match(/(\d{4})\s*$/);
      return m ? v.slice(0, -4).replace(/\d/g, "*") + m[1] : tapar(v);
    }
    case "cp":
      return v.length >= 2 ? v.slice(0, 2) + tapar(v.slice(2)) : tapar(v);
    case "importe":
      return v.replace(/\d/g, (c, i) => (i === v.search(/\d/) ? c : "*"));
    default:
      return v.length > 3 ? v.slice(0, 2) + tapar(v.slice(2, -1)) + v.slice(-1) : tapar(v);
  }
}
