/*
 * Hoja de revisión (mejora 2 de docs/SUGERENCIAS.md, aprobada por el titular): un archivo
 * HTML que se abre en el navegador con la miniatura de cada página YA TACHADA, un borde
 * de color alrededor de cada tachado, el recuento por tipo y los avisos. Sirve para
 * revisar un lote entero en una pantalla. Las miniaturas salen de las copias tachadas, no
 * de los originales. Arriba, «Revisa primero»: los datos dudosos (confianza no alta, el
 * «revisa» de la web), recuadrados en amarillo y listados solo tapados en parte (mejora
 * aprobada por el titular). Sin scripts ni nada que se descargue.
 */
import { NOMBRE_TIPO, textoPorTipo } from "./deteccion.js";
import { COLOR_DUDOSO, COLOR_OTROS, colorDe } from "./documento-pdf.js";
import { pathToFileURL } from "node:url";

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export function hojaDeRevision(archivos, fecha = new Date()) {
  const dos = (n) => String(n).padStart(2, "0");
  const cuando = dos(fecha.getDate()) + "/" + dos(fecha.getMonth() + 1) + "/" + fecha.getFullYear() + " a las " + dos(fecha.getHours()) + ":" + dos(fecha.getMinutes());
  const leyenda = [["nombre", "Nombres"], ["dni", "DNI y NIE"], ["iban", "Cuentas"], ["direccion", "Direcciones"], ["otros", "Otros datos"], ["dudoso", "Dudosos: revísalos primero"]]
    .map(([t, n]) => '<span class="l"><i style="border-color:rgb(' + (t === "otros" ? COLOR_OTROS : t === "dudoso" ? COLOR_DUDOSO : colorDe(t)).join(",") + ')' +
      (t === "dudoso" ? ";border-width:4px" : "") + '"></i>' + esc(n) + "</span>").join("");
  // «Revisa primero»: los datos dudosos de todos los documentos, con su página.
  // Los del mismo tipo en la misma página, juntos si son más de tres (las cantidades de una
  // tabla, por ejemplo), para que la lista se lea de un vistazo.
  let total = 0;
  const lineas = [];
  for (const a of archivos) for (const p of a.paginas) {
    const porTipo = new Map();
    for (const d of p.dudosos || []) {
      if (!porTipo.has(d.tipo)) porTipo.set(d.tipo, []);
      porTipo.get(d.tipo).push(d);
      total++;
    }
    for (const [tipo, lista] of porTipo) {
      const donde = "<b>" + esc(a.nombre) + "</b>, página " + p.num + ": ";
      if (lista.length > 3) {
        lineas.push("<li>" + donde + lista.length + " × " + esc(NOMBRE_TIPO[tipo] || tipo) + " (" + lista.slice(0, 2).map((d) => esc(d.valor)).join(", ") + "…)</li>");
      } else {
        lista.forEach((d) => lineas.push("<li>" + donde + esc(NOMBRE_TIPO[tipo] || tipo) + " " + esc(d.valor) + (d.campo ? " (campo de formulario)" : "") + "</li>"));
      }
    }
  }
  const revisaPrimero = total
    ? '<section class="rp"><h2>Revisa primero: ' + total + (total === 1 ? " dato dudoso" : " datos dudosos") + "</h2>" +
      "<p>La detección está menos segura de estos datos (recuadros amarillos en las miniaturas). Comprueba que lo tapado es lo que debía taparse y que no se ha quedado nada al lado.</p><ul>" +
      lineas.slice(0, 200).join("") + (lineas.length > 200 ? "<li>… y " + (lineas.length - 200) + " líneas más</li>" : "") + "</ul></section>"
    : "";
  const bloques = archivos.map((a) => {
    const paginas = a.paginas.map((p) => '<figure><img alt="Página ' + p.num + ' tachada" src="data:image/jpeg;base64,' + p.miniatura + '"><figcaption>Página ' + p.num +
      " · " + p.datos + (p.datos === 1 ? " dato" : " datos") + (p.trozos ? " y " + p.trozos + (p.trozos === 1 ? " trozo" : " trozos") + " de la página anterior" : "") +
      (p.sinSitio ? ' · <b class="av">' + p.sinSitio + " sin situar: revísala</b>" : "") + "</figcaption></figure>").join("");
    const avisos = a.avisos.length ? '<ul class="av">' + a.avisos.map((x) => "<li>" + esc(x) + "</li>").join("") + "</ul>" : "";
    return '<section><h2>' + esc(a.nombre) + '</h2><p>' + a.datos + (a.datos === 1 ? " dato oculto" : " datos ocultos") + (a.datos ? ": " + esc(textoPorTipo(a.porTipo)) : "") +
      (a.dudosos ? ' (<b class="du">' + a.dudosos + (a.dudosos === 1 ? " dudoso" : " dudosos") + "</b>)" : "") +
      '. Copia: <a href="' + esc(pathToFileURL(a.copia).href) + '">' + esc(a.copia) + "</a></p>" + avisos + '<div class="g">' + paginas + "</div></section>";
  }).join("\n");
  return `<!doctype html>
<html lang="es-ES"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Revisión del tachado · docuprivado</title>
<style>
body{font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;margin:0;padding:24px;background:#f4f6f7;color:#1c2226}
h1{font-size:22px;margin:0 0 4px}h2{font-size:17px;margin:0 0 4px}p{margin:4px 0}
.cab{max-width:1100px;margin:0 auto 20px}.aviso{background:#fff7e0;border:1px solid #e8c766;padding:10px 14px;border-radius:8px}
section{max-width:1100px;margin:0 auto 22px;background:#fff;border-radius:10px;padding:16px 18px;box-shadow:0 1px 3px rgba(0,0,0,.08)}
.g{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:14px;margin-top:10px}
figure{margin:0}img{width:100%;border:1px solid #cfd6da;border-radius:4px;background:#fff}figcaption{font-size:13px;color:#4a555c}
.l{display:inline-flex;align-items:center;gap:6px;margin-right:14px;font-size:13px}.l i{width:14px;height:10px;border:3px solid;display:inline-block}
.av{color:#9a3412}a{color:#0f5c6e;word-break:break-all}
.rp{border:2px solid rgb(234,179,8)}.rp ul{margin:8px 0 0;padding-left:20px}.du{color:#854d0e}
</style></head><body>
<div class="cab"><h1>Revisión del tachado</h1>
<p>${archivos.length} ${archivos.length === 1 ? "documento tachado" : "documentos tachados"} el ${cuando} con la extensión de docuprivado. Cada recuadro de color rodea un tachado de la copia.</p>
<p>${leyenda}</p>
<p class="aviso"><b>Revisa las copias antes de enviarlas:</b> la detección automática ayuda, pero puede no encontrarlo todo. Busca en las miniaturas datos que sigan a la vista (por ejemplo, en firmas, sellos o tablas) y, si hace falta, táchalos en docuprivado.es/tachar-documento/.</p>
<p>Esta hoja no lleva tus datos: las miniaturas son de las copias ya tachadas y, en «Revisa primero», los datos dudosos solo aparecen tapados en parte. Aun así, no hace falta enviarla a nadie: es para ti.</p></div>
${revisaPrimero}
${bloques}
</body></html>
`;
}

