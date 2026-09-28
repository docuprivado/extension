#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
paridad_web.py — SOLO PARA DESARROLLO (mejora 1 de docs/SUGERENCIAS.md, aprobada por el titular).

Pasa los PDF y las fotos de prueba de la web por el tachador de la web (el de verdad, en un Edge
invisible, con las herramientas de ../WEB A/tools/capturas_edge.py) y guarda qué datos
encuentra en cada página: tipo, valor, confianza y si viene marcado. También el texto de prueba
por el anonimizador (web-anonimizador.json) y las fotos del DNI por el buscador de bordes del
Kit DNI (web-bordes.json). La prueba
tests/paridad.test.mjs de la extensión compara esa lista con lo que encuentra la extensión
con los mismos documentos: tienen que coincidir uno a uno.

Hay que volver a ejecutarlo cuando cambie el detector o las reglas del tachador de la web
(lo avisa la prueba de sincronización). Necesita la vista previa de la web en marcha:
    (en ../WEB A)  python tools/servidor.py 8137
    (aquí)         python scripts/paridad_web.py
De la web solo se leen archivos; no se escribe nada en ella.
"""
import hashlib
import json
import os
import subprocess
import sys
import urllib.request
from datetime import date

RAIZ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WEB = os.path.abspath(os.environ.get("DOCUPRIVADO_WEB") or os.path.join(RAIZ, "..", "WEB A"))
sys.path.insert(0, os.path.join(WEB, "tools"))
import capturas_edge as ce  # noqa: E402  (herramienta de la web, solo se usa)

SALIDA = os.path.join(RAIZ, "tests", "paridad", "web-tachador.json")

# PDF con texto, escaneados y fotos de tests/fixtures de la web.
ARCHIVOS = [
    "nomina-ficticia.pdf", "contrato-ficticio.pdf", "contrato-cortes.pdf", "contrato-letra-pequena.pdf",
    "contrato-v1.pdf", "contrato-v2.pdf", "contrato-cabeceras-v1.pdf", "contrato-cabeceras-v2.pdf",
    "debajo/1-nomina-bloque.pdf", "debajo/2-carta.pdf", "debajo/3-tabla.pdf", "debajo/4-objeto-texto.pdf",
    "debajo/5-trozos.pdf", "debajo/6-apretado.pdf", "debajo/7-firma.pdf",
    "formulario-ficticio.pdf",   # campos de formulario rellenables (hito de actualización 10 de la web)
    # Hito 3 de la extensión: se leen con el lector de escaneados.
    "contrato-escaneado.pdf", "captura-ficticia.png", "fotos/foto-textos.png", "dni-facil-anverso.jpg", "dni-facil-reverso.jpg",
    "dni-dificil.jpg", "pasaporte-prueba.jpg", "foto-exif-rotada.jpg",
]
TIPO_MIME = {".pdf": "application/pdf", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".heic": "image/heic",
             ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document", ".txt": "text/plain"}

# Comparador (hito 6 de la extensión): los pares de versiones de tests/fixtures por el
# comparador de la web. Se guardan los párrafos que lee de cada versión y los cambios
# (tipo, dónde e importantes): la extensión tiene que leer y comparar igual.
SALIDA_CMP = os.path.join(RAIZ, "tests", "paridad", "web-comparador.json")
PARES_CMP = [["contrato-v1.docx", "contrato-v2.docx"], ["contrato-v1.pdf", "contrato-v2.pdf"], ["contrato-v1.docx", "contrato-v2.pdf"],
             ["contrato-cabeceras-v1.pdf", "contrato-cabeceras-v2.pdf"]]
# Sin escaneos: en este Edge invisible el comparador de la web leyó contrato-escaneado.pdf en
# 24 párrafos, y en un navegador normal en 35, como la extensión (28/09/2026). El escaneo se
# prueba en la extensión contra el texto del mismo contrato (tests/comparar.test.mjs).
RECETA_CMP = r"""
const card = document.getElementById("comparador");
info.resultados = {};
for (const [a, b] of PARES) {
  DP.reset(card); await espera(300);
  await subir(card.querySelector('[data-dropzone="a"] input[type=file]'), "/tests/fixtures/" + a, MIME[a]);
  await subir(card.querySelector('[data-dropzone="b"] input[type=file]'), "/tests/fixtures/" + b, MIME[b]);
  await espera(600);
  card.querySelector("[data-cmp-comparar]").click();
  await hasta(() => ["review", "error"].includes(estadoDe(card)), 300000);
  await espera(300);
  const r = card.__cmp && card.__cmp.resultado;
  info.resultados[a + " → " + b] = r ? {
    a: r.a, b: r.b, resumen: r.resumen,
    cambios: r.cambios.map((c) => ({ tipo: c.tipo, donde: c.donde, importantes: c.importantes })),
  } : { estado: estadoDe(card), mensaje: mensajeDe(card) };
}
"""

RECETA = r"""
const card = document.getElementById("tachador");
info.tipos = [...card.querySelectorAll("[data-tipo]")].filter((c) => c.checked !== false).map((c) => c.getAttribute("data-tipo") || c.value);
info.resultados = {};
for (const ruta of ARCHIVOS) {
  DP.reset(card); await espera(300);
  await subir(card.querySelector("input[type=file]"), "/tests/fixtures/" + ruta, MIME[ruta]);
  await hasta(() => ["review", "error"].includes(estadoDe(card)), 300000);
  await espera(300);
  const est = card.__tachador;
  info.resultados[ruta] = est ? est.paginas.flatMap((pg) => pg.marcas.map((m) => ({
    pagina: pg.num, tipo: m.tipo, valor: m.valor, confianza: m.confianza, activa: m.activa !== false, campo: m.campo || null,
    siguePagina: m.extra ? m.extra.map((e) => e.pagina) : [],
  }))) : { estado: estadoDe(card), mensaje: mensajeDe(card) };
}
"""

# Anonimizador (hito 4 de la extensión): el texto de prueba, las casillas de la página y
# lo que sale: cada etiqueta con su tipo, su valor y cuántas veces, y el texto anónimo.
SALIDA_ANON = os.path.join(RAIZ, "tests", "paridad", "web-anonimizador.json")
TEXTOS_ANON = ["texto-anonimizar.txt"]
RECETA_ANON = r"""
const card = document.querySelector(".tool-card");
info.tipos = [...card.querySelectorAll("[data-tipo]")].filter((c) => c.checked).map((c) => c.getAttribute("data-tipo"));
info.resultados = {};
for (const ruta of TEXTOS) {
  DP.reset(card); await espera(300);
  const entrada = card.querySelector("[data-anon-entrada]");
  entrada.value = await (await fetch("/tests/fixtures/" + ruta)).text();
  entrada.dispatchEvent(new Event("input", { bubbles: true }));
  card.querySelector("[data-anon-anonimizar]").click();
  await hasta(() => ["review", "error"].includes(estadoDe(card)), 120000);
  await espera(300);
  const est = card.__anonimizador;
  info.resultados[ruta] = {
    grupos: est.grupos.map((g) => ({ etiqueta: g.etiqueta, tipo: g.tipo, valor: g.valor, confianza: g.confianza, veces: g.ocurrencias.length })),
    texto: card.querySelector("[data-anon-resultado]").textContent,
  };
}
"""

# Kit DNI (hito 5 de la extensión): el buscador de bordes de la web con las fotos de prueba,
# abiertas como las abre el Kit DNI (DP.loadImage, 2500 px de lado como mucho). Se guardan
# las esquinas, la confianza y la nota: la extensión tiene que recortar igual.
SALIDA_BORDES = os.path.join(RAIZ, "tests", "paridad", "web-bordes.json")
FOTOS_BORDES = [["bordes/escena-%02d.jpg" % n, "id1"] for n in range(1, 25)] + [
    ["dni-facil-anverso.jpg", "id1"], ["dni-facil-reverso.jpg", "id1"], ["dni-dificil.jpg", "id1"], ["pasaporte-prueba.jpg", "id3"],
    ["_tarjeta-anverso-plana.png", "id1"],
]
# Las dos caras en la misma imagen (hito de actualización 14 de la web, mejora 1 del hito 5):
# lo que encuentra detectarVarias en cada escena.
FOTOS_DOS = ["bordes/dos-caras-%02d.jpg" % n for n in range(1, 8)]
RECETA_BORDES = r"""
await hasta(() => window.__BORDES_DOS__ && window.DP && DP.tools.kitBordes, 240000);
info.dos = {};
for (const ruta of FOTOS_DOS) {
  const blob = await (await fetch("/tests/fixtures/" + ruta)).blob();
  const canvas = await DP.loadImage(new File([blob], ruta.split("/").pop(), { type: blob.type }), { maxSide: 2500 });
  info.dos[ruta] = DP.tools.kitBordes.detectarVarias(canvas, "id1", 2).map((r) => ({
    confianza: r.confianza, nota: r.nota, esquinas: r.esquinas ? r.esquinas.map((p) => [Math.round(p.x * 10) / 10, Math.round(p.y * 10) / 10]) : null,
  }));
}
info.resultados = {};
for (const [ruta, formato] of FOTOS) {
  const blob = await (await fetch("/tests/fixtures/" + ruta)).blob();
  const canvas = await DP.loadImage(new File([blob], ruta.split("/").pop(), { type: blob.type }), { maxSide: 2500 });
  const r = DP.tools.kitBordes.detectar(canvas, formato);
  info.resultados[ruta] = {
    formato, ancho: canvas.width, alto: canvas.height, confianza: r.confianza, nota: r.nota, origen: r.origen || null,
    esquinas: r.esquinas ? r.esquinas.map((p) => [Math.round(p.x * 10) / 10, Math.round(p.y * 10) / 10]) : null,
  };
}
"""

CAPTURA = r"""
const estadoDe = (card) => card.getAttribute("data-state");
const mensajeDe = (card) => ((card.querySelector("[data-error-message]") || {}).textContent || "").trim();
"""


def huella(ruta):
    with open(ruta, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


def main():
    try:
        urllib.request.urlopen(ce.BASE + "/", timeout=3).close()
    except OSError:
        print("[ERROR] La vista previa de la web no responde en %s: arráncala en WEB A con python tools/servidor.py 8137" % ce.BASE)
        return 2
    commit = subprocess.run(["git", "-C", WEB, "rev-parse", "--short", "HEAD"], capture_output=True, text=True).stdout.strip()
    e = ce.Edge()
    try:
        e.abrir("/tachar-documento/")
        mime = {r: TIPO_MIME[os.path.splitext(r)[1].lower()] for r in ARCHIVOS}
        info = e.ejecutar("const ARCHIVOS = %s;\nconst MIME = %s;\n" % (json.dumps(ARCHIVOS), json.dumps(mime)) + CAPTURA + RECETA)["info"]
        e.abrir("/anonimizar-texto-chatgpt/")
        anon = e.ejecutar("const TEXTOS = %s;\n" % json.dumps(TEXTOS_ANON) + CAPTURA + RECETA_ANON)["info"]
        e.abrir("/comparar-documentos/")
        mime_cmp = {r: TIPO_MIME[os.path.splitext(r)[1].lower()] for par in PARES_CMP for r in par}
        cmp = e.ejecutar("const PARES = %s;\nconst MIME = %s;\n" % (json.dumps(PARES_CMP), json.dumps(mime_cmp)) + CAPTURA + RECETA_CMP)["info"]
        e.abrir("/tests/bordes/")
        bordes = e.ejecutar("const FOTOS = %s;\nconst FOTOS_DOS = %s;\n" % (json.dumps(FOTOS_BORDES), json.dumps(FOTOS_DOS)) + CAPTURA + RECETA_BORDES)["info"]
    finally:
        e.cerrar()
    with open(SALIDA_CMP, "w", encoding="utf-8", newline="\n") as f:
        f.write(json.dumps({
            "aviso": "Generado con scripts/paridad_web.py a partir del comparador de la web. No editar a mano.",
            "fecha": date.today().isoformat(), "webCommit": commit, "pagina": "/comparar-documentos/",
            "huellas": {r: huella(os.path.join(WEB, "tests", "fixtures", r)) for par in PARES_CMP for r in par},
            "pares": cmp["resultados"],
        }, ensure_ascii=False, indent=1) + "\n")
    for k, v in cmp["resultados"].items():
        print("Comparador: %s · %s" % (k, v.get("resumen") or v))
    with open(SALIDA_BORDES, "w", encoding="utf-8", newline="\n") as f:
        f.write(json.dumps({
            "aviso": "Generado con scripts/paridad_web.py a partir del buscador de bordes del Kit DNI de la web. No editar a mano.",
            "fecha": date.today().isoformat(), "webCommit": commit, "pagina": "/tests/bordes/",
            "archivos": {r: dict(sha256=huella(os.path.join(WEB, "tests", "fixtures", r)), **bordes["resultados"][r]) for r, _ in FOTOS_BORDES},
            "dosCaras": {r: {"sha256": huella(os.path.join(WEB, "tests", "fixtures", r)), "tarjetas": bordes["dos"][r]} for r in FOTOS_DOS},
        }, ensure_ascii=False, indent=1) + "\n")
    confianzas = [bordes["resultados"][r]["confianza"] for r, _ in FOTOS_BORDES]
    print("Kit DNI: %d fotos · %s" % (len(FOTOS_BORDES), ", ".join("%s %d" % (c, confianzas.count(c)) for c in ("alta", "media", "baja"))))
    with open(SALIDA_ANON, "w", encoding="utf-8", newline="\n") as f:
        f.write(json.dumps({
            "aviso": "Generado con scripts/paridad_web.py a partir del anonimizador de la web. No editar a mano.",
            "fecha": date.today().isoformat(), "webCommit": commit, "pagina": "/anonimizar-texto-chatgpt/", "tipos": anon["tipos"],
            "archivos": {r: dict(sha256=huella(os.path.join(WEB, "tests", "fixtures", r)), **anon["resultados"][r]) for r in TEXTOS_ANON},
        }, ensure_ascii=False, indent=1) + "\n")
    for r in TEXTOS_ANON:
        print("Anonimizador: %s · %d etiquetas" % (r, len(anon["resultados"][r]["grupos"])))
    datos = {
        "aviso": "Generado con scripts/paridad_web.py a partir del tachador de la web. No editar a mano.",
        "fecha": date.today().isoformat(),
        "webCommit": commit,
        "pagina": "/tachar-documento/",
        "tipos": info["tipos"],
        "archivos": {r: {"sha256": huella(os.path.join(WEB, "tests", "fixtures", r)), "marcas": info["resultados"][r]} for r in ARCHIVOS},
    }
    os.makedirs(os.path.dirname(SALIDA), exist_ok=True)
    with open(SALIDA, "w", encoding="utf-8", newline="\n") as f:
        f.write(json.dumps(datos, ensure_ascii=False, indent=1) + "\n")
    total = sum(len(v["marcas"]) if isinstance(v["marcas"], list) else 0 for v in datos["archivos"].values())
    print("Guardado %s: %d documentos, %d datos (web %s)" % (os.path.relpath(SALIDA, RAIZ), len(ARCHIVOS), total, commit))
    for r, v in datos["archivos"].items():
        print("  %-30s %s" % (r, len(v["marcas"]) if isinstance(v["marcas"], list) else v["marcas"]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
