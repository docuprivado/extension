/*
 * Ejecuta los casos de tests/casos-detectores.js contra el motor DP_DETECT.
 * Lo usan tests/detectores.html (navegador) y tests/run-node.js (Node).
 */
(function (global) {
  "use strict";

  function comprobarCaso(DP_DETECT, caso) {
    const opciones = caso.opciones || {};
    const encontrados = DP_DETECT.detect(caso.texto, opciones);

    // Las posiciones siempre tienen que apuntar exactamente al valor.
    for (const e of encontrados) {
      const trozo = caso.texto.slice(e.inicio, e.fin);
      if (trozo !== e.valor) {
        return "posiciones mal: dice " + JSON.stringify(e.valor) + " pero en el texto hay " + JSON.stringify(trozo);
      }
    }

    if (caso.tipo === "varios") {
      const tipos = encontrados.map((e) => e.tipo);
      const faltan = (caso.esperados || []).filter((t) => tipos.indexOf(t) === -1);
      if (faltan.length) return "no encuentra: " + faltan.join(", ") + " (encontró: " + (tipos.join(", ") || "nada") + ")";
      if (!(caso.esperados || []).length && tipos.length) return "no debía encontrar nada y encontró: " + tipos.join(", ");
      return null;
    }

    const delTipo = encontrados.filter((e) => e.tipo === caso.tipo);
    if (caso.valor === "ninguno") {
      return delTipo.length ? "no debía encontrar nada y encontró " + JSON.stringify(delTipo[0].valor) : null;
    }
    const acierto = delTipo.find((e) => (caso.contiene ? e.valor.indexOf(caso.valor) !== -1 : e.valor === caso.valor));
    if (!acierto) {
      return "esperaba " + JSON.stringify(caso.valor) + " y encontró " +
        (delTipo.length ? delTipo.map((e) => JSON.stringify(e.valor)).join(", ") : "nada");
    }
    if (caso.confianza && acierto.confianza !== caso.confianza) {
      return "confianza " + acierto.confianza + ", esperaba " + caso.confianza;
    }
    return null;
  }

  function ejecutar(DP_DETECT, casos) {
    const resultados = [];
    casos.forEach((caso, i) => {
      let error = null;
      try {
        error = comprobarCaso(DP_DETECT, caso);
      } catch (e) {
        error = "excepción: " + ((e && e.message) || e);
      }
      resultados.push({
        n: i + 1,
        nombre: (caso.tipo + " · " + caso.texto).slice(0, 110),
        ok: !error,
        error: error,
      });
    });
    const fallan = resultados.filter((r) => !r.ok);
    return { total: resultados.length, pasan: resultados.length - fallan.length, fallan: fallan.length, resultados: resultados };
  }

  const API = { ejecutar: ejecutar, comprobarCaso: comprobarCaso };
  global.RUNNER_DETECTORES = API;
  if (typeof module !== "undefined" && module.exports) module.exports = API;
})(typeof globalThis !== "undefined" ? globalThis : this);
