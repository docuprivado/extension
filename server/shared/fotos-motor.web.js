/*
 * docuprivado.es · Fotos: el motor (se descarga al subir la primera foto).
 *
 * - Lee los datos ocultos de una foto sin librerías: EXIF (GPS, fecha, móvil, números de
 *   serie, miniatura), XMP, IPTC, comentarios, C2PA, textos de PNG y lo que algunos móviles
 *   pegan detrás de la imagen (el vídeo de una «foto en movimiento», otras imágenes…).
 * - Los quita sin volver a comprimir la imagen en JPEG, PNG y WebP (dejando, si hace falta,
 *   solo la orientación) y, si no se puede, rehaciendo la imagen.
 * - Dibuja la marca de agua y tapa zonas (negro, pixelado o difuminado).
 * El buscador de matrículas va aparte (js/fotos-matriculas.js). Nada sale del navegador.
 */
(function () {
  "use strict";
  const DP = window.DP;
  DP.tools = DP.tools || {};

  /* ------------------------------------------------------------------
     Datos ocultos: lectura
     ------------------------------------------------------------------ */
  // Bytes a texto con TextDecoder, que no tiene límite de tamaño. Los textos de la
  // cámara suelen ir en UTF-8; si no lo son, se leen como latin-1.
  const latin1 = new TextDecoder("latin1");
  const ascii = (b, i, n) => latin1.decode(b.subarray(i, Math.min(b.length, i + n)));
  function texto(b) {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(b);
    } catch (e) {
      return latin1.decode(b);
    }
  }
  const limpio = (s) => String(s == null ? "" : s).replace(/\0/g, " ").replace(/\s+/g, " ").trim();
  const corto = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

  // Posición de una secuencia de bytes (escrita como texto latin-1), o -1.
  function buscar(b, patron, desde, hasta) {
    const n = patron.length;
    const c0 = patron.charCodeAt(0);
    const fin = Math.min(b.length, hasta || b.length) - n;
    for (let i = b.indexOf(c0, desde || 0); i !== -1 && i <= fin; i = b.indexOf(c0, i + 1)) {
      let k = 1;
      while (k < n && b[i + k] === patron.charCodeAt(k)) k++;
      if (k === n) return i;
    }
    return -1;
  }

  function formato(b) {
    if (b[0] === 0xFF && b[1] === 0xD8) return "jpeg";
    if (b[0] === 0x89 && ascii(b, 1, 3) === "PNG") return "png";
    if (ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 4) === "WEBP") return "webp";
    if (ascii(b, 4, 4) === "ftyp") return "heic";
    return "otro";
  }

  // Cabecera TIFF del EXIF: «II*\0» o «MM\0*».
  const esTiff = (b, i) => (b[i] === 0x49 && b[i + 1] === 0x49 && b[i + 2] === 0x2a && b[i + 3] === 0) ||
    (b[i] === 0x4d && b[i + 1] === 0x4d && b[i + 2] === 0 && b[i + 3] === 0x2a);

  function buscarTiff(b, desde, hasta) {
    for (let i = buscar(b, "Exif\0\0", desde, hasta); i !== -1; i = buscar(b, "Exif\0\0", i + 1, hasta)) {
      if (esTiff(b, i + 6)) return i + 6;
    }
    return -1;
  }

  // En HEIC, el EXIF va precedido de 4 bytes con la distancia hasta la cabecera TIFF:
  // normalmente 6 («Exif\0\0» en medio, lo encuentra buscarTiff) y a veces 0.
  function buscarTiffHeif(b) {
    for (const p of ["MM\0*\0\0\0\b", "II*\0\b\0\0\0"]) {
      for (let i = buscar(b, p, 4); i !== -1; i = buscar(b, p, i + 1)) {
        if (!b[i - 1] && !b[i - 2] && !b[i - 3] && !b[i - 4]) return i;
      }
    }
    return -1;
  }

  function leerTiff(b, t0) {
    const le = b[t0] === 0x49;
    const u16 = (o) => (le ? b[t0 + o] | (b[t0 + o + 1] << 8) : (b[t0 + o] << 8) | b[t0 + o + 1]);
    const u32 = (o) => (le
      ? (b[t0 + o] | (b[t0 + o + 1] << 8) | (b[t0 + o + 2] << 16)) + b[t0 + o + 3] * 16777216
      : ((b[t0 + o] << 16) | (b[t0 + o + 1] << 8) | b[t0 + o + 2]) * 256 + b[t0 + o + 3]);
    const TAM = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };
    let siguiente = 0;
    const ifd = (o) => {
      const out = {};
      siguiente = 0;
      if (!o || o < 8 || t0 + o + 2 > b.length) return out;
      const n = u16(o);
      if (n > 1000) return out;
      for (let k = 0; k < n; k++) {
        const e = o + 2 + k * 12;
        if (t0 + e + 12 > b.length) return out;
        const tag = u16(e);
        const tipo = u16(e + 2);
        const cuenta = u32(e + 4);
        const tam = (TAM[tipo] || 1) * cuenta;
        const pos = tam <= 4 ? e + 8 : u32(e + 8);
        if (t0 + pos + tam > b.length) continue;
        let v;
        if (tipo === 2) v = limpio(texto(b.subarray(t0 + pos, t0 + pos + cuenta)));
        else if (tipo === 3) v = cuenta === 1 ? u16(pos) : Array.from({ length: Math.min(cuenta, 8) }, (_, i) => u16(pos + i * 2));
        else if (tipo === 4 || tipo === 9) v = cuenta === 1 ? u32(pos) : null;
        else if (tipo === 5 || tipo === 10) v = Array.from({ length: Math.min(cuenta, 4) }, (_, i) => u32(pos + i * 8) / Math.max(1, u32(pos + i * 8 + 4)));
        else v = b.subarray(t0 + pos, t0 + pos + cuenta);
        out[tag] = v;
      }
      if (t0 + o + 2 + n * 12 + 4 <= b.length) siguiente = u32(o + 2 + n * 12);
      return out;
    };
    const ifd0 = ifd(u32(4));
    const ifd1 = siguiente ? ifd(siguiente) : {};
    return {
      ifd0: ifd0,
      ifd1: ifd1,
      exif: typeof ifd0[0x8769] === "number" ? ifd(ifd0[0x8769]) : {},
      gps: typeof ifd0[0x8825] === "number" ? ifd(ifd0[0x8825]) : {},
    };
  }

  function* trozosPng(b) {
    for (let i = 8; i + 12 <= b.length;) {
      const n = ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
      const tipo = ascii(b, i + 4, 4);
      yield { tipo: tipo, inicio: i, datos: i + 8, largo: n, fin: Math.min(b.length, i + 12 + n) };
      if (tipo === "IEND") return;
      i += 12 + n;
    }
  }

  function* trozosWebp(b) {
    for (let i = 12; i + 8 <= b.length;) {
      const n = (b[i + 4] | (b[i + 5] << 8) | (b[i + 6] << 16)) + b[i + 7] * 16777216;
      const fin = i + 8 + n + (n & 1);
      yield { tipo: ascii(b, i, 4), inicio: i, datos: i + 8, largo: n, fin: fin };
      i = fin;
    }
  }

  // Recorre un JPEG: los bloques de la cabecera y de la imagen hasta su final (EOI), y
  // cuántos bytes hay pegados detrás (el vídeo de una «foto en movimiento», otras
  // imágenes, datos del móvil…). Devuelve null si la estructura es rara.
  function trozosJpeg(b) {
    const segs = [];
    let i = 2;
    let finImagen = -1;
    while (i + 2 <= b.length) {
      if (b[i] !== 0xFF) return null;
      const m = b[i + 1];
      if (m === 0xFF) { i++; continue; }
      if (m === 0xD9) { finImagen = i + 2; break; }
      if ((m >= 0xD0 && m <= 0xD7) || m === 0x01) { segs.push({ m: m, inicio: i, datos: i + 2, fin: i + 2 }); i += 2; continue; }
      if (i + 4 > b.length) break;
      const n = (b[i + 2] << 8) | b[i + 3];
      if (n < 2 || i + 2 + n > b.length) return null;
      let fin = i + 2 + n;
      if (m === 0xDA) {
        // Datos de la imagen: hasta el siguiente marcador de verdad (FF00 y los RST no cuentan).
        let j = fin;
        for (;;) {
          j = b.indexOf(0xFF, j);
          if (j === -1 || j + 1 >= b.length) { j = b.length; break; }
          const s = b[j + 1];
          if (s === 0x00 || (s >= 0xD0 && s <= 0xD7)) j += 2;
          else if (s === 0xFF) j += 1;
          else break;
        }
        fin = j;
      }
      segs.push({ m: m, inicio: i, datos: i + 4, fin: fin });
      i = fin;
    }
    if (finImagen === -1) finImagen = b.length;           // foto cortada: se deja tal cual
    return { segs: segs, finImagen: finImagen, cola: b.length - finImagen };
  }

  const grados = (v, ref) => {
    if (!Array.isArray(v) || v.length < 3 || v.some((x) => !isFinite(x))) return null;
    const d = v[0] + v[1] / 60 + v[2] / 3600;
    return (ref === "S" || ref === "W") ? -d : d;
  };
  const dos = (n) => (n < 10 ? "0" : "") + n;
  const fechaExif = (s) => {
    const m = /^(\d{4})[:-](\d{2})[:-](\d{2})(?:[ T](\d{2}):(\d{2}))?/.exec(s || "");
    if (!m) return s;
    return m[3] + "/" + m[2] + "/" + m[1] + (m[4] ? ", " + m[4] + ":" + m[5] : "");
  };

  // El resultado que se va llenando al leer. «unico»: esa etiqueta solo sale una vez.
  function nuevoResultado() {
    const r = { campos: [], gps: null, orientacion: 1, otros: new Set(), movimiento: false };
    r.add = (etiqueta, valor, delicado, unico) => {
      if (valor === undefined || valor === null) return;
      valor = limpio(valor);
      if (!valor) return;
      if (r.campos.some((c) => c.etiqueta === etiqueta && (unico || c.valor === valor))) return;
      r.campos.push({ etiqueta: etiqueta, valor: valor, delicado: !!delicado });
    };
    r.ponerGps = (lat, lon) => {
      if (r.gps || lat === null || lon === null || (lat === 0 && lon === 0) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return;
      r.gps = { lat: lat, lon: lon };
      const f = (x, pos, neg) => Math.abs(x).toFixed(4).replace(".", ",") + "° " + (x >= 0 ? pos : neg);
      r.campos.unshift({ etiqueta: "Ubicación exacta (GPS)", valor: f(lat, "N", "S") + ", " + f(lon, "E", "O"), delicado: true });
    };
    return r;
  }

  function camposTiff(b, t0, r) {
    const t = leerTiff(b, t0);
    const antes = r.campos.length;
    r.ponerGps(grados(t.gps[2], t.gps[1]), grados(t.gps[4], t.gps[3]));
    r.add("Fecha en que se hizo", fechaExif(t.exif[0x9003] || t.exif[0x9004] || t.ifd0[0x0132]), true, true);
    const marca = limpio(t.ifd0[0x010F]);
    const modelo = limpio(t.ifd0[0x0110]);
    r.add("Móvil o cámara", modelo.toLowerCase().indexOf(marca.toLowerCase()) === 0 ? modelo : [marca, modelo].filter(Boolean).join(" "), false, true);
    r.add("Programa", t.ifd0[0x0131], false, true);
    r.add("Autor", t.ifd0[0x013B], true);
    r.add("Derechos de autor", t.ifd0[0x8298], true);
    r.add("Propietario de la cámara", t.exif[0xA430], true);
    r.add("Número de serie de la cámara", t.exif[0xA431], true);
    r.add("Número de serie del objetivo", t.exif[0xA435], true);
    r.add("Descripción", typeof t.ifd0[0x010E] === "string" ? corto(t.ifd0[0x010E], 140) : null, true);
    const nota = t.exif[0x9286];
    if (nota && nota.length > 8) r.add("Comentario", corto(limpio(texto(nota.subarray(8))), 140), true);
    r.add("Objetivo", t.exif[0xA434]);
    if (t.ifd1[0x0201]) r.add("Miniatura escondida", "Sí: una copia pequeña de la foto, que puede ser de antes de recortarla o retocarla", true, true);
    if (typeof t.ifd0[0x0112] === "number" && t.ifd0[0x0112] >= 1 && t.ifd0[0x0112] <= 8) r.orientacion = t.ifd0[0x0112];
    // Un EXIF que solo lleva la orientación (el que dejamos al limpiar) no cuenta como dato.
    const hayMas = Object.keys(t.ifd0).some((k) => +k !== 0x0112) || Object.keys(t.exif).length ||
      Object.keys(t.gps).length || Object.keys(t.ifd1).length;
    if (hayMas && r.campos.length === antes) r.add("Datos técnicos de la foto (EXIF)", "Sí");
  }

  // Valor de una propiedad XMP, como atributo (nombre="…") o como elemento (con rdf:li).
  function xmpValor(x, nombre) {
    const des = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&apos;/g, "'")
      .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/&amp;/g, "&");
    let m = new RegExp("\\s" + nombre + "=\"([^\"]*)\"").exec(x);
    if (m && m[1].trim()) return des(m[1]);
    m = new RegExp("<" + nombre + "(?:\\s[^>]*)?>([\\s\\S]*?)</" + nombre + ">").exec(x);
    if (!m) return "";
    const li = /<rdf:li[^>]*>([\s\S]*?)<\/rdf:li>/.exec(m[1]);
    return des((li ? li[1] : m[1]).replace(/<[^>]+>/g, " "));
  }
  function gpsXmp(s, r) {
    const m = /^(\d+(?:\.\d+)?),(\d+(?:\.\d+)?)(?:,(\d+(?:\.\d+)?))?([NSEW])$/.exec((s || "").trim());
    if (!m) return null;
    const g = +m[1] + (+m[2]) / 60 + (m[3] ? +m[3] / 3600 : 0);
    return m[4] === "S" || m[4] === "W" ? -g : g;
  }
  function camposXmp(x, r) {
    const v = (n) => xmpValor(x, n);
    r.ponerGps(gpsXmp(v("exif:GPSLatitude")), gpsXmp(v("exif:GPSLongitude")));
    r.add("Autor", v("dc:creator"), true);
    r.add("Derechos de autor", v("dc:rights"), true);
    const lugar = [];
    ["Iptc4xmpCore:Location", "photoshop:City", "photoshop:State", "photoshop:Country"].forEach((n) => {
      const s = limpio(v(n));
      if (s && lugar.indexOf(s) === -1) lugar.push(s);
    });
    r.add("Lugar", lugar.join(", "), true);
    r.add("Descripción", corto(limpio(v("dc:description")), 140), true);
    r.add("Título", corto(limpio(v("dc:title")), 100));
    r.add("Fecha en que se hizo", fechaExif(v("photoshop:DateCreated") || v("exif:DateTimeOriginal") || v("xmp:CreateDate")), true, true);
    r.add("Programa", v("xmp:CreatorTool"), false, true);
    if (/MotionPhoto="1"|MicroVideo="1"|<(?:G?Camera):MotionPhoto>1</.test(x)) r.movimiento = true;
    r.add("Datos de edición (XMP)", "Sí", false, true);
  }
  function leerXmp(b, r, desde, hasta) {
    const i = buscar(b, "<x:xmpmeta", desde, hasta);
    if (i === -1) {
      if (buscar(b, "http://ns.adobe.com/xap/1.0/", desde, hasta) !== -1) r.add("Datos de edición (XMP)", "Sí", false, true);
      return;
    }
    const f = buscar(b, "</x:xmpmeta>", i, hasta);
    camposXmp(texto(b.subarray(i, f === -1 ? Math.min(b.length, i + 262144) : f)), r);
  }

  // IPTC (bloque «Photoshop 3.0» de los JPEG): autor, lugar, pie de foto…
  function leerPhotoshop(b, ini, fin, r) {
    let i = ini;
    while (i + 12 <= fin && ascii(b, i, 4) === "8BIM") {
      const id = (b[i + 4] << 8) | b[i + 5];
      let p = i + 6;
      const nl = b[p];
      p += 1 + nl + ((1 + nl) & 1);
      const tam = ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0;
      p += 4;
      if (p + tam > fin) break;
      if (id === 0x0404) leerIptc(b, p, p + tam, r);
      else if (id === 0x0409 || id === 0x040C) r.add("Miniatura escondida", "Sí: una copia pequeña de la foto, que puede ser de antes de recortarla o retocarla", true, true);
      i = p + tam + (tam & 1);
    }
  }
  function leerIptc(b, ini, fin, r) {
    const d = {};
    for (let i = ini; i + 5 <= fin && b[i] === 0x1C;) {
      const rec = b[i + 1];
      const ds = b[i + 2];
      const n = (b[i + 3] << 8) | b[i + 4];
      if (n & 0x8000) break;                                // tamaño extendido: no se usa en fotos
      if (rec === 2) (d[ds] = d[ds] || []).push(limpio(texto(b.subarray(i + 5, Math.min(fin, i + 5 + n)))));
      i += 5 + n;
    }
    const un = (ds) => (d[ds] || [])[0];
    r.add("Autor", un(80), true);
    r.add("Derechos de autor", un(116), true);
    const lugar = [];
    [92, 90, 95, 101].forEach((ds) => { const s = un(ds); if (s && lugar.indexOf(s) === -1) lugar.push(s); });
    r.add("Lugar", lugar.join(", "), true);
    r.add("Descripción", un(120) ? corto(un(120), 140) : null, true);
    r.add("Título", un(5));
    r.add("Palabras clave", d[25] ? corto(d[25].join(", "), 100) : null);
    if (Object.keys(d).length) r.add("Datos de agencia o de edición (IPTC)", "Sí", false, true);
  }

  // ¿Hay un vídeo (MP4/MOV) a partir de «desde»? Se busca «ftyp» seguido de una marca legible.
  function hayVideo(b, desde) {
    for (let i = buscar(b, "ftyp", desde); i !== -1; i = buscar(b, "ftyp", i + 1)) {
      if (/^[a-z0-9 ]{4}$/i.test(ascii(b, i + 4, 4))) return true;
    }
    return false;
  }

  const C2PA = "Sí: pueden decir quién hizo la foto y con qué programas se ha editado";
  // Bloques de un PNG que solo dicen cómo dibujar la imagen: son los únicos que se quedan.
  const PNG_QUEDAN = ["IHDR", "PLTE", "IDAT", "IEND", "tRNS", "cHRM", "gAMA", "iCCP", "sBIT", "sRGB", "cICP",
    "mDCV", "mDCv", "cLLI", "cLLi", "bKGD", "pHYs", "acTL", "fcTL", "fdAT"];
  const WEBP_QUEDAN = ["VP8 ", "VP8L", "VP8X", "ALPH", "ANIM", "ANMF", "ICCP"];
  const PNG_DELICADOS = /^(author|copyright|comment|description|title|source|disclaimer|location)$/i;

  // Devuelve { campos: [{etiqueta, valor, delicado}], gps, orientacion, formato, alfa,
  // sinPerdida (si se puede limpiar sin volver a comprimir), hay }.
  function leerMetadatos(b) {
    const r = nuevoResultado();
    const tipo = formato(b);
    let alfa = false;
    let sinPerdida = false;
    if (tipo === "jpeg") {
      const j = trozosJpeg(b);
      if (!j) {
        const t0 = buscarTiff(b, 0);
        if (t0 >= 0) camposTiff(b, t0, r);
        leerXmp(b, r, 0);
      } else {
        sinPerdida = true;
        let exif = false;
        j.segs.forEach((s) => {
          const m = s.m;
          if (m === 0xE1 && ascii(b, s.datos, 6) === "Exif\0\0" && esTiff(b, s.datos + 6)) {
            if (!exif) camposTiff(b, s.datos + 6, r);
            exif = true;
          } else if (m === 0xE1) {
            // XMP: se lee después, de toda la cabecera
          } else if (m === 0xED) {
            if (ascii(b, s.datos, 14) === "Photoshop 3.0\0") leerPhotoshop(b, s.datos + 14, s.fin, r);
            else r.otros.add("APP13");
          } else if (m === 0xFE) {
            r.add("Comentario", corto(limpio(texto(b.subarray(s.datos, s.fin))), 140), true);
          } else if (m === 0xE0) {
            const jfif = ascii(b, s.datos, 5) === "JFIF\0";
            if ((jfif && (b[s.datos + 12] || b[s.datos + 13])) || ascii(b, s.datos, 5) === "JFXX\0") {
              r.add("Miniatura escondida", "Sí: una copia pequeña de la foto, que puede ser de antes de recortarla o retocarla", true, true);
            } else if (!jfif) r.otros.add("APP0");
          } else if (m === 0xEB) {
            if (ascii(b, s.datos, 2) === "JP") r.add("Credenciales de contenido (C2PA)", C2PA, false, true);
            else r.otros.add("APP11");
          } else if (m === 0xE2) {
            if (ascii(b, s.datos, 12) !== "ICC_PROFILE\0" && ascii(b, s.datos, 4) !== "MPF\0") r.otros.add("APP2");
          } else if (m === 0xEE) {
            if (ascii(b, s.datos, 5) !== "Adobe") r.otros.add("APP14");
          } else if (m >= 0xE3 && m <= 0xEF) {
            r.otros.add("APP" + (m - 0xE0));
          }
        });
        const sos = j.segs.find((s) => s.m === 0xDA);
        leerXmp(b, r, 0, sos ? sos.inicio : j.finImagen);
        if (j.cola > 0 && b.subarray(j.finImagen).some((x) => x !== 0)) {
          if (hayVideo(b, j.finImagen)) {
            r.add("Vídeo escondido en la foto", "Sí: unos segundos de vídeo (una «foto en movimiento»), que pueden llevar su propia ubicación", true, true);
          } else if (buscar(b, "\xFF\xD8\xFF", j.finImagen) !== -1) {
            r.add("Otras imágenes dentro del archivo", "Sí: copias o versiones de la foto (vista previa, HDR…) que pueden llevar sus propios datos", false, true);
          } else {
            r.add("Datos pegados al final del archivo", "Sí: información que añaden algunos móviles", false, true);
          }
        }
      }
    } else if (tipo === "png") {
      let fin = false;
      for (const c of trozosPng(b)) {
        if (c.tipo === "IHDR") alfa = b[c.datos + 9] === 4 || b[c.datos + 9] === 6;
        if (c.tipo === "tRNS") alfa = true;
        if (c.tipo === "IEND") fin = true;
        if (PNG_QUEDAN.indexOf(c.tipo) !== -1) continue;
        if (c.tipo === "eXIf") {
          if (esTiff(b, c.datos)) camposTiff(b, c.datos, r);
        } else if (c.tipo === "tEXt" || c.tipo === "iTXt" || c.tipo === "zTXt") {
          const datos = b.subarray(c.datos, c.fin - 4);
          const cero = datos.indexOf(0);
          const clave = limpio(ascii(datos, 0, cero === -1 ? Math.min(79, datos.length) : cero));
          let valor = "";
          if (c.tipo === "tEXt" && cero !== -1) valor = limpio(latin1.decode(datos.subarray(cero + 1)));
          if (c.tipo === "iTXt" && cero !== -1 && datos[cero + 1] === 0) {
            // sin comprimir: clave\0 comp método idioma\0 traducida\0 texto
            let k = datos.indexOf(0, cero + 3);
            if (k !== -1) k = datos.indexOf(0, k + 1);
            if (k !== -1) valor = texto(datos.subarray(k + 1));
          }
          if (clave === "XML:com.adobe.xmp") {
            if (valor.indexOf("<x:xmpmeta") !== -1) camposXmp(valor, r);
            else r.add("Datos de edición (XMP)", "Sí", false, true);
          } else if (/^Raw profile type (exif|APP1)$/i.test(clave)) {
            r.add("Datos de la cámara guardados como texto (EXIF)", "Sí: pueden incluir la ubicación, la fecha y el móvil", true, true);
          } else if (/^Raw profile type /i.test(clave)) {
            r.add("Datos de agencia o de edición (IPTC)", "Sí", false, true);
          } else if (clave) {
            r.add("Texto guardado en el PNG", valor ? clave + ": " + corto(limpio(valor), 100) : clave, PNG_DELICADOS.test(clave));
          }
        } else if (c.tipo === "tIME") {
          const d = b.subarray(c.datos, c.datos + 7);
          r.add("Fecha de modificación (PNG)", d.length === 7 ? dos(d[3]) + "/" + dos(d[2]) + "/" + ((d[0] << 8) | d[1]) + ", " + dos(d[4]) + ":" + dos(d[5]) : "Sí");
        } else if (c.tipo === "caBX") {
          r.add("Credenciales de contenido (C2PA)", C2PA, false, true);
        } else {
          r.otros.add(c.tipo);
        }
      }
      sinPerdida = fin;
    } else if (tipo === "webp") {
      let bien = true;
      for (const c of trozosWebp(b)) {
        if (c.fin > b.length || c.largo < 0) { bien = false; break; }
        if (c.tipo === "VP8X") alfa = alfa || !!(b[c.datos] & 0x10);
        else if (c.tipo === "ALPH") alfa = true;
        else if (c.tipo === "VP8L") alfa = alfa || !!(b[c.datos + 4] & 0x10);
        else if (c.tipo === "EXIF") {
          const t0 = ascii(b, c.datos, 6) === "Exif\0\0" ? c.datos + 6 : c.datos;
          if (esTiff(b, t0)) camposTiff(b, t0, r);
        } else if (c.tipo === "XMP ") {
          const x = texto(b.subarray(c.datos, c.datos + c.largo));
          if (x.indexOf("<x:xmpmeta") !== -1) camposXmp(x, r);
          else r.add("Datos de edición (XMP)", "Sí", false, true);
        } else if (WEBP_QUEDAN.indexOf(c.tipo) === -1) r.otros.add(c.tipo.trim());
      }
      sinPerdida = bien;
    } else {
      // HEIC y cualquier otro: se busca en todo el archivo (se rehace siempre)
      let t0 = buscarTiff(b, 0);
      if (t0 < 0 && tipo === "heic") t0 = buscarTiffHeif(b);
      if (t0 >= 0) camposTiff(b, t0, r);
      leerXmp(b, r, 0);
    }
    if (r.otros.size) r.add("Otros datos del programa o de la cámara", Array.from(r.otros).join(", "));
    return {
      campos: r.campos, gps: r.gps, orientacion: r.orientacion, formato: tipo, alfa: alfa,
      sinPerdida: sinPerdida, hay: r.campos.length > 0,
    };
  }

  /* ------------------------------------------------------------------
     Datos ocultos: limpieza sin volver a comprimir
     ------------------------------------------------------------------ */
  // EXIF mínimo que solo dice cómo girar la foto (sin él, las fotos del móvil saldrían de
  // lado): una cabecera TIFF con una sola entrada, la orientación.
  const tiffOrientacion = (o) => Uint8Array.of(0x4D, 0x4D, 0x00, 0x2A, 0x00, 0x00, 0x00, 0x08,
    0x00, 0x01, 0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, o, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00);
  const conGiro = (o) => o > 1 && o <= 8;
  function exifOrientacion(o) {                  // bloque APP1 de un JPEG
    const t = tiffOrientacion(o);
    const s = new Uint8Array(10 + t.length);
    s.set([0xFF, 0xE1, 0x00, 8 + t.length, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00]);
    s.set(t, 10);
    return s;
  }

  let tablaCrc = null;
  function crc32(bytes) {
    if (!tablaCrc) {
      tablaCrc = new Uint32Array(256);
      for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
        tablaCrc[n] = c >>> 0;
      }
    }
    let c = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) c = tablaCrc[(c ^ bytes[i]) & 255] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }
  const u32be = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  function trozoPng(tipo, datos) {
    const out = new Uint8Array(12 + datos.length);
    out.set(u32be(datos.length));
    for (let k = 0; k < 4; k++) out[4 + k] = tipo.charCodeAt(k);
    out.set(datos, 8);
    out.set(u32be(crc32(out.subarray(4, 8 + datos.length))), 8 + datos.length);
    return out;
  }

  // JPEG: fuera todos los bloques APP (EXIF, XMP, IPTC, C2PA…), los comentarios y todo lo
  // que haya pegado detrás de la imagen. Se quedan el JFIF (sin su miniatura), el perfil de
  // color (APP2 «ICC_PROFILE»), el APP14 «Adobe» (hace falta para ver bien algunos colores)
  // y, si la foto lo necesita, un EXIF con solo la orientación. La imagen no se toca.
  function limpiarJpeg(b, orientacion) {
    const j = trozosJpeg(b);
    if (!j) return null;
    const jfif = [];
    const color = [];
    const resto = [];
    j.segs.forEach((s) => {
      const m = s.m;
      if (m === 0xE0) {
        if (ascii(b, s.datos, 5) === "JFIF\0" && s.fin - s.datos >= 12 && !jfif.length) {
          const nuevo = new Uint8Array(18);
          nuevo.set([0xFF, 0xE0, 0x00, 0x10]);
          nuevo.set(b.subarray(s.datos, s.datos + 12), 4);   // «JFIF\0», versión, unidades y densidad
          jfif.push(nuevo);                                     // miniatura: 0 × 0
        }
      } else if (m === 0xE2) {
        if (ascii(b, s.datos, 12) === "ICC_PROFILE\0") color.push(b.subarray(s.inicio, s.fin));
      } else if (m === 0xEE) {
        if (ascii(b, s.datos, 5) === "Adobe") color.push(b.subarray(s.inicio, s.fin));
      } else if (!(m >= 0xE1 && m <= 0xEF) && m !== 0xFE) {
        resto.push(b.subarray(s.inicio, s.fin));
      }
    });
    const partes = [b.subarray(0, 2)].concat(jfif, conGiro(orientacion) ? [exifOrientacion(orientacion)] : [], color, resto);
    partes.push(Uint8Array.of(0xFF, 0xD9));
    return new Blob(partes, { type: "image/jpeg" });
  }

  // PNG: solo se quedan los bloques que dicen cómo dibujar la imagen (y la orientación).
  function limpiarPng(b, orientacion) {
    const partes = [b.subarray(0, 8)];
    for (const c of trozosPng(b)) {
      if (PNG_QUEDAN.indexOf(c.tipo) !== -1) partes.push(b.subarray(c.inicio, c.fin));
      if (c.tipo === "IHDR" && conGiro(orientacion)) partes.push(trozoPng("eXIf", tiffOrientacion(orientacion)));
    }
    return new Blob(partes, { type: "image/png" });
  }

  // WebP: fuera EXIF, XMP y cualquier bloque desconocido (con la orientación, si hace falta,
  // en un EXIF mínimo); se corrigen las marcas del VP8X y el tamaño.
  function limpiarWebp(b, orientacion) {
    const partes = [];
    let total = 4;
    const giro = conGiro(orientacion);
    for (const c of trozosWebp(b)) {
      if (WEBP_QUEDAN.indexOf(c.tipo) === -1) continue;
      const trozo = b.slice(c.inicio, c.fin);
      if (c.tipo === "VP8X") trozo[8] = (trozo[8] & ~0x0C) | (giro ? 0x08 : 0);   // EXIF 0x08, XMP 0x04
      partes.push(trozo);
      total += trozo.length;
    }
    if (giro) {
      const t = tiffOrientacion(orientacion);
      const trozo = new Uint8Array(8 + t.length);
      trozo.set([0x45, 0x58, 0x49, 0x46, t.length, 0, 0, 0]);          // «EXIF» y su tamaño
      trozo.set(t, 8);
      partes.push(trozo);
      total += trozo.length;
    }
    const cab = new Uint8Array(12);
    cab.set(b.subarray(0, 12));
    cab[4] = total & 255;
    cab[5] = (total >> 8) & 255;
    cab[6] = (total >> 16) & 255;
    cab[7] = (total >>> 24) & 255;
    return new Blob([cab].concat(partes), { type: "image/webp" });
  }

  // Devuelve un Blob limpio sin volver a comprimir la imagen, o null si hay que rehacerla.
  function limpiarSinPerdida(b, info) {
    if (!info.sinPerdida) return null;
    if (info.formato === "jpeg") return limpiarJpeg(b, info.orientacion);
    if (info.formato === "png") return limpiarPng(b, info.orientacion);
    if (info.formato === "webp") return limpiarWebp(b, info.orientacion);
    return null;
  }

  /* ------------------------------------------------------------------
     Marca de agua (texto repetido en diagonal, sobre toda la foto)
     ------------------------------------------------------------------ */
  function marca(ctx, w, h, cfg) {
    const texto = (cfg.texto || "").trim();
    if (!texto) return;
    const tam = Math.max(12, Math.round(Math.min(w, h) * (cfg.tamano || 5) / 100));
    ctx.save();
    ctx.font = "600 " + tam + "px Inter, Arial, sans-serif";
    ctx.textBaseline = "middle";
    ctx.lineJoin = "round";
    const ancho = ctx.measureText(texto).width + tam * 2.5;
    const paso = tam * 3.2;
    const diag = Math.sqrt(w * w + h * h);
    ctx.translate(w / 2, h / 2);
    ctx.rotate(-Math.PI / 6);
    const a = (cfg.opacidad || 40) / 100;
    ctx.lineWidth = Math.max(1, tam / 9);
    ctx.strokeStyle = "rgba(0,0,0," + (a * 0.55).toFixed(3) + ")";
    ctx.fillStyle = "rgba(255,255,255," + a.toFixed(3) + ")";
    let fila = 0;
    for (let y = -diag / 2; y < diag / 2; y += paso, fila++) {
      const desfase = (fila % 2) * ancho / 2;
      for (let x = -diag / 2 - desfase; x < diag / 2; x += ancho) {
        ctx.strokeText(texto, x, y);
        ctx.fillText(texto, x, y);
      }
    }
    ctx.restore();
  }

  /* ------------------------------------------------------------------
     Zonas: pixelar, difuminar o tapar
     ------------------------------------------------------------------ */
  function efecto(ctx, r, estilo) {
    const x = Math.max(0, Math.round(r.x)), y = Math.max(0, Math.round(r.y));
    const w = Math.min(ctx.canvas.width - x, Math.round(r.w)), h = Math.min(ctx.canvas.height - y, Math.round(r.h));
    if (w < 2 || h < 2) return;
    if (estilo === "negro") {
      ctx.fillStyle = "#000";
      ctx.fillRect(x, y, w, h);
      return;
    }
    // Pixelado: unas 7 celdas en el lado largo. Difuminado: se reduce muchísimo y se
    // vuelve a ampliar suavizando, dos veces (queda una mancha de color, sin rasgos).
    const lado = estilo === "difuminar" ? 5 : 7;
    const esc = lado / Math.max(w, h);
    const pw = Math.max(1, Math.round(w * esc)), ph = Math.max(1, Math.round(h * esc));
    const peq = DP.makeCanvas(pw, ph);
    const pc = peq.getContext("2d");
    pc.imageSmoothingEnabled = true;
    pc.imageSmoothingQuality = "high";
    pc.drawImage(ctx.canvas, x, y, w, h, 0, 0, pw, ph);
    ctx.save();
    ctx.beginPath();
    if (estilo === "difuminar") ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
    else ctx.rect(x, y, w, h);
    ctx.clip();
    if (estilo === "difuminar") {
      const med = DP.makeCanvas(Math.max(2, pw * 4), Math.max(2, ph * 4));
      const mc = med.getContext("2d");
      mc.imageSmoothingEnabled = true;
      mc.imageSmoothingQuality = "high";
      mc.drawImage(peq, 0, 0, med.width, med.height);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(med, x, y, w, h);
      med.width = med.height = 0;
    } else {
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(peq, x, y, w, h);
    }
    ctx.restore();
    peq.width = peq.height = 0;
  }

  DP.tools.fotosMotor = {
    leerMetadatos: leerMetadatos,
    limpiarSinPerdida: limpiarSinPerdida,
    marca: marca,
    efecto: efecto,
  };
})();
