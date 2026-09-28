/*
 * docuprivado.es · Kit DNI: búsqueda automática de los bordes del documento
 * (hito de actualización 1).
 *
 * Se descarga junto con OpenCV, solo cuando hace falta. Busca en la foto
 * cuadriláteros con forma de tarjeta (o de página de pasaporte) de varias
 * maneras —bordes con distintas sensibilidades, color y zonas claras u
 * oscuras—, puntúa cada uno según lo bien que coincide con los bordes de la
 * foto, su proporción y sus ángulos, y ajusta las esquinas buscando el borde
 * exacto a lo largo de cada lado (así también acierta con las esquinas
 * redondeadas del DNI). Devuelve las esquinas y lo segura que está.
 * Desde el hito de actualización 14 también encuentra las dos caras en la misma imagen
 * (detectarVarias): una hoja escaneada por delante y por detrás o una foto de las dos.
 */
(function () {
  "use strict";

  const LADO_TRABAJO = 900;      // la foto se analiza reducida a este lado mayor
  const LADO_AJUSTE = 1600;      // y las esquinas se afinan a este
  const PROPORCION = { id1: 85.6 / 53.98, id3: 125 / 88 };

  // --------------------------------------------------------- geometría
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

  function areaQuad(q) {
    let s = 0;
    for (let i = 0; i < 4; i++) {
      const a = q[i];
      const b = q[(i + 1) % 4];
      s += a.x * b.y - b.x * a.y;
    }
    return Math.abs(s) / 2;
  }

  // Ordena las esquinas: arriba-izquierda, arriba-derecha, abajo-derecha, abajo-izquierda.
  function ordenar(puntos) {
    const c = puntos.reduce((acc, p) => ({ x: acc.x + p.x / 4, y: acc.y + p.y / 4 }), { x: 0, y: 0 });
    const q = puntos.slice().sort((a, b) => Math.atan2(a.y - c.y, a.x - c.x) - Math.atan2(b.y - c.y, b.x - c.x));
    let inicio = 0;
    q.forEach((p, i) => { if (p.x + p.y < q[inicio].x + q[inicio].y) inicio = i; });
    return q.slice(inicio).concat(q.slice(0, inicio));
  }

  function angulos(q) {
    const out = [];
    for (let i = 0; i < 4; i++) {
      const p = q[(i + 3) % 4];
      const c = q[i];
      const n = q[(i + 1) % 4];
      const a1 = Math.atan2(p.y - c.y, p.x - c.x);
      const a2 = Math.atan2(n.y - c.y, n.x - c.x);
      let d = Math.abs(a1 - a2) * 180 / Math.PI;
      if (d > 180) d = 360 - d;
      out.push(d);
    }
    return out;
  }

  function esConvexo(q) {
    let signo = 0;
    for (let i = 0; i < 4; i++) {
      const a = q[i];
      const b = q[(i + 1) % 4];
      const c = q[(i + 2) % 4];
      const z = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
      if (Math.abs(z) < 1e-6) return false;
      const s = z > 0 ? 1 : -1;
      if (signo && s !== signo) return false;
      signo = s;
    }
    return true;
  }

  // Puntos de un contorno de OpenCV.
  function puntosDe(mat) {
    const d = mat.data32S;
    const out = [];
    for (let i = 0; i + 1 < d.length; i += 2) out.push({ x: d[i], y: d[i + 1] });
    return out;
  }

  function rectanguloGirado(rr) {
    const a = rr.angle * Math.PI / 180;
    const c = Math.cos(a);
    const s = Math.sin(a);
    const w = rr.size.width / 2;
    const h = rr.size.height / 2;
    return [[-w, -h], [w, -h], [w, h], [-w, h]].map(([x, y]) => ({ x: rr.center.x + x * c - y * s, y: rr.center.y + x * s + y * c }));
  }

  // ------------------------------------------------------- candidatos
  // De un mapa en blanco y negro saca los contornos grandes y los convierte en
  // cuadriláteros (aproximando el contorno o, si no sale, con su rectángulo).
  function candidatosDe(cv, mapa, area, lista, origen) {
    const contornos = new cv.MatVector();
    const jerarquia = new cv.Mat();
    cv.findContours(mapa, contornos, jerarquia, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);
    const n = contornos.size();
    for (let i = 0; i < n; i++) {
      const c = contornos.get(i);
      const caja = cv.boundingRect(c);
      if (caja.width * caja.height < area * 0.06) { c.delete(); continue; }
      const envolvente = new cv.Mat();
      cv.convexHull(c, envolvente, false, true);
      const a = cv.contourArea(envolvente);
      if (a >= area * 0.06 && a <= area * 0.995) {
        const perimetro = cv.arcLength(envolvente, true);
        let cuatro = null;
        for (const eps of [0.015, 0.025, 0.035, 0.05, 0.07]) {
          const aprox = new cv.Mat();
          cv.approxPolyDP(envolvente, aprox, eps * perimetro, true);
          if (aprox.rows === 4) cuatro = puntosDe(aprox);
          aprox.delete();
          if (cuatro) break;
        }
        if (cuatro) lista.push({ q: ordenar(cuatro), origen: origen });
        lista.push({ q: ordenar(rectanguloGirado(cv.minAreaRect(envolvente))), origen: origen + "-rect" });
      }
      envolvente.delete();
      c.delete();
    }
    contornos.delete();
    jerarquia.delete();
  }

  // Líneas rectas largas de la foto (como hacen los escáneres de documentos):
  // se juntan los trozos de una misma recta y, con dos pares de rectas, se forman
  // cuadriláteros. Así se encuentra la tarjeta aunque un dedo tape una esquina o
  // un lado apenas se distinga del fondo.
  function candidatosDeLineas(cv, bordes, ancho, alto, lista) {
    const lineas = new cv.Mat();
    const menor = Math.min(ancho, alto);
    cv.HoughLinesP(bordes, lineas, 1, Math.PI / 180, 30, menor * 0.1, menor * 0.025);
    const rectas = [];
    const d = lineas.data32S;
    for (let i = 0; i + 3 < d.length; i += 4) {
      const x1 = d[i];
      const y1 = d[i + 1];
      const x2 = d[i + 2];
      const y2 = d[i + 3];
      const largo = Math.hypot(x2 - x1, y2 - y1);
      let theta = Math.atan2(y2 - y1, x2 - x1);
      if (theta < 0) theta += Math.PI;
      if (theta >= Math.PI) theta -= Math.PI;
      const nx = -Math.sin(theta);
      const ny = Math.cos(theta);
      const rho = x1 * nx + y1 * ny;
      // ¿Es la misma recta que otra ya vista?
      const igual = rectas.find((r) => {
        let dt = Math.abs(r.theta - theta);
        dt = Math.min(dt, Math.PI - dt);
        const rr = dt === Math.abs(r.theta - theta) ? rho : -rho;
        return dt < 0.05 && Math.abs(r.rho - rr) < menor * 0.015;
      });
      if (igual) igual.largo += largo;
      else rectas.push({ theta: theta, rho: rho, nx: nx, ny: ny, largo: largo });
    }
    lineas.delete();
    rectas.sort((a, b) => b.largo - a.largo);
    const top = rectas.slice(0, 14);
    const corte2 = (a, b) => {
      const det = a.nx * b.ny - a.ny * b.nx;
      if (Math.abs(det) < 1e-6) return null;
      return { x: (a.rho * b.ny - a.ny * b.rho) / det, y: (a.nx * b.rho - a.rho * b.nx) / det };
    };
    const casiParalelas = (a, b) => {
      const dt = Math.abs(a.theta - b.theta);
      return Math.min(dt, Math.PI - dt) < 0.35;
    };
    const margen = menor * 0.03;
    for (let i = 0; i < top.length; i++) {
      for (let j = i + 1; j < top.length; j++) {
        if (!casiParalelas(top[i], top[j])) continue;
        for (let k = 0; k < top.length; k++) {
          if (k === i || k === j || casiParalelas(top[i], top[k])) continue;
          for (let l = k + 1; l < top.length; l++) {
            if (l === i || l === j || !casiParalelas(top[k], top[l])) continue;
            const q = [corte2(top[i], top[k]), corte2(top[k], top[j]), corte2(top[j], top[l]), corte2(top[l], top[i])];
            if (q.some((p) => !p || p.x < -margen || p.y < -margen || p.x > ancho + margen || p.y > alto + margen)) continue;
            lista.push({ q: ordenar(q), origen: "lineas" });
          }
        }
      }
    }
  }

  function mediana(datos) {
    const hist = new Uint32Array(256);
    for (let i = 0; i < datos.length; i++) hist[datos[i]]++;
    let acc = 0;
    for (let v = 0; v < 256; v++) {
      acc += hist[v];
      if (acc >= datos.length / 2) return v;
    }
    return 128;
  }

  // ----------------------------------------------------- puntuación
  // ¿Cuánto de cada lado coincide con un borde de verdad? (0–1 por lado). Un
  // punto cuenta si muy cerca la luz cambia bruscamente y de través al lado,
  // como en el canto de una tarjeta; las vetas o los cuadros del fondo que
  // cruzan el lado en otra dirección no cuentan.
  function apoyoEnBordes(grad, ancho, alto, q) {
    const gx = grad.gx;
    const gy = grad.gy;
    const lados = [];
    for (let i = 0; i < 4; i++) {
      const a = q[i];
      const b = q[(i + 1) % 4];
      const largo = dist(a, b) || 1;
      const nx = -(b.y - a.y) / largo;
      const ny = (b.x - a.x) / largo;
      let dentro = 0;
      let total = 0;
      for (let k = 0; k <= 40; k++) {
        const t = 0.1 + 0.8 * (k / 40);   // sin las esquinas (pueden ser redondeadas o estar tapadas)
        const px = a.x + (b.x - a.x) * t;
        const py = a.y + (b.y - a.y) * t;
        if (px < 1 || py < 1 || px >= ancho - 1 || py >= alto - 1) continue;
        total++;
        for (let s = -2; s <= 2; s++) {
          const x = Math.round(px + nx * s);
          const y = Math.round(py + ny * s);
          if (x < 0 || y < 0 || x >= ancho || y >= alto) continue;
          const j = y * ancho + x;
          const m = Math.hypot(gx[j], gy[j]);
          if (m > grad.umbral && Math.abs(gx[j] * nx + gy[j] * ny) > 0.85 * m) {
            dentro++;
            break;
          }
        }
      }
      lados.push(total ? dentro / total : 0);
    }
    return lados;
  }

  function puntuar(c, cerca, ancho, alto, proporcion) {
    const q = c.q;
    if (!esConvexo(q)) return null;
    const area = areaQuad(q) / (ancho * alto);
    if (area < 0.06 || area > 0.995) return null;
    const ang = angulos(q);
    if (ang.some((a) => a < 55 || a > 125)) return null;
    const l1 = (dist(q[0], q[1]) + dist(q[3], q[2])) / 2;
    const l2 = (dist(q[1], q[2]) + dist(q[0], q[3])) / 2;
    const r = Math.max(l1, l2) / Math.max(1, Math.min(l1, l2));
    const aspecto = Math.exp(-Math.pow((r - proporcion) / 0.18, 2));
    const lados = apoyoEnBordes(cerca, ancho, alto, q);
    const apoyo = lados.reduce((s, v) => s + v, 0) / 4;
    const peor = Math.min.apply(null, lados);
    const rectos = 1 - ang.reduce((s, a) => s + Math.abs(a - 90), 0) / (4 * 35);
    // Un cuadrilátero que toca el borde de la foto casi siempre es la propia foto.
    const margen = Math.min(ancho, alto) * 0.01;
    const tocaBorde = q.filter((p) => p.x <= margen || p.y <= margen || p.x >= ancho - margen || p.y >= alto - margen).length;
    const tamano = Math.min(1, area / 0.3);
    let nota = 0.45 * apoyo + 0.15 * peor + 0.25 * aspecto + 0.05 * rectos + 0.1 * tamano;
    if (tocaBorde >= 2) nota -= 0.15;
    return { q: q, nota: nota, apoyo: apoyo, peor: peor, aspecto: aspecto, area: area, origen: c.origen, lados: lados };
  }

  // ------------------------------------------------- ajuste fino de lados
  // Para cada lado, busca a lo largo de la perpendicular dónde cambia más la
  // luz (el borde real), ajusta una recta a esos puntos y corta las rectas
  // vecinas: salen las esquinas exactas, aunque la tarjeta las tenga redondeadas.
  function ajustar(gris, ancho, alto, q) {
    const muestra = (x, y) => {
      if (x < 0 || y < 0 || x >= ancho - 1 || y >= alto - 1) return -1;
      const x0 = Math.floor(x);
      const y0 = Math.floor(y);
      const fx = x - x0;
      const fy = y - y0;
      const i = y0 * ancho + x0;
      return (gris[i] * (1 - fx) + gris[i + 1] * fx) * (1 - fy) + (gris[i + ancho] * (1 - fx) + gris[i + ancho + 1] * fx) * fy;
    };
    const radio = Math.max(4, Math.round(Math.min(ancho, alto) * 0.012));
    const rectas = [];
    for (let i = 0; i < 4; i++) {
      const a = q[i];
      const b = q[(i + 1) % 4];
      const largo = dist(a, b);
      const ux = (b.x - a.x) / largo;
      const uy = (b.y - a.y) / largo;
      const nx = -uy;
      const ny = ux;
      const puntos = [];
      for (let k = 0; k <= 36; k++) {
        const t = 0.12 + 0.76 * (k / 36);
        const px = a.x + (b.x - a.x) * t;
        const py = a.y + (b.y - a.y) * t;
        let mejor = 0;
        let donde = null;
        for (let s = -radio; s <= radio; s += 0.5) {
          const v1 = muestra(px + nx * (s - 1), py + ny * (s - 1));
          const v2 = muestra(px + nx * (s + 1), py + ny * (s + 1));
          if (v1 < 0 || v2 < 0) continue;
          const g = Math.abs(v2 - v1);
          if (g > mejor) {
            mejor = g;
            donde = s;
          }
        }
        if (donde !== null && mejor > 12) puntos.push({ x: px + nx * donde, y: py + ny * donde });
      }
      rectas.push(puntos.length >= 10 ? recta(puntos) : recta([a, b]));
    }
    const out = [];
    for (let i = 0; i < 4; i++) {
      const p = corte(rectas[(i + 3) % 4], rectas[i]);
      out.push(p && dist(p, q[i]) < Math.min(ancho, alto) * 0.08 ? p : q[i]);
    }
    return out;
  }

  // Recta por mínimos cuadrados (punto y dirección principal).
  function recta(puntos) {
    const n = puntos.length;
    const mx = puntos.reduce((s, p) => s + p.x, 0) / n;
    const my = puntos.reduce((s, p) => s + p.y, 0) / n;
    let sxx = 0;
    let syy = 0;
    let sxy = 0;
    puntos.forEach((p) => {
      sxx += (p.x - mx) * (p.x - mx);
      syy += (p.y - my) * (p.y - my);
      sxy += (p.x - mx) * (p.y - my);
    });
    const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    return { x: mx, y: my, dx: Math.cos(ang), dy: Math.sin(ang) };
  }

  function corte(r1, r2) {
    const det = r1.dx * r2.dy - r1.dy * r2.dx;
    if (Math.abs(det) < 1e-6) return null;
    const t = ((r2.x - r1.x) * r2.dy - (r2.y - r1.y) * r2.dx) / det;
    return { x: r1.x + r1.dx * t, y: r1.y + r1.dy * t };
  }

  // --------------------------------------- dos tarjetas en la misma foto
  function areaPoligono(pts) {
    let s = 0;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      s += a.x * b.y - b.x * a.y;
    }
    return s / 2;
  }

  // Parte común de dos cuadriláteros convexos (recorte de Sutherland-Hodgman), en
  // proporción del menor de los dos: 0 si no se tocan, 1 si uno está dentro del otro.
  function solape(a, b) {
    const sentido = Math.sign(areaPoligono(b)) || 1;
    let poli = a.slice();
    for (let i = 0; i < 4 && poli.length; i++) {
      const p = b[i];
      const q = b[(i + 1) % 4];
      const dentro = (c) => sentido * ((q.x - p.x) * (c.y - p.y) - (q.y - p.y) * (c.x - p.x)) >= 0;
      const cruce = (c, d) => {
        const a1 = q.y - p.y;
        const b1 = p.x - q.x;
        const c1 = a1 * p.x + b1 * p.y;
        const a2 = d.y - c.y;
        const b2 = c.x - d.x;
        const c2 = a2 * c.x + b2 * c.y;
        const det = a1 * b2 - a2 * b1 || 1e-9;
        return { x: (b2 * c1 - b1 * c2) / det, y: (a1 * c2 - a2 * c1) / det };
      };
      const entrada = poli;
      poli = [];
      for (let j = 0; j < entrada.length; j++) {
        const c = entrada[j];
        const d = entrada[(j + 1) % entrada.length];
        if (dentro(d)) {
          if (!dentro(c)) poli.push(cruce(c, d));
          poli.push(d);
        } else if (dentro(c)) {
          poli.push(cruce(c, d));
        }
      }
    }
    const comun = poli.length >= 3 ? Math.abs(areaPoligono(poli)) : 0;
    return comun / Math.max(1e-9, Math.min(areaQuad(a), areaQuad(b)));
  }

  // Orden de lectura: primero la de arriba; si están a la misma altura (comparten más de
  // la mitad de su alto), la de la izquierda.
  function ordenLectura(lista) {
    const caja = (r) => {
      const ys = r.esquinas.map((p) => p.y);
      return { x: r.esquinas.reduce((s, p) => s + p.x, 0) / 4, y: ys.reduce((s, y) => s + y, 0) / 4, y0: Math.min.apply(null, ys), y1: Math.max.apply(null, ys) };
    };
    return lista.sort((r1, r2) => {
      const a = caja(r1);
      const b = caja(r2);
      const comun = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
      return comun > 0.5 * Math.min(a.y1 - a.y0, b.y1 - b.y0) ? a.x - b.x : a.y - b.y;
    });
  }

  // ------------------------------------------------------------ principal
  // canvas: la foto. formato: "id1" (DNI, NIE, carnet) o "id3" (pasaporte).
  // Devuelve { esquinas: [4 puntos en px de la foto] | null, confianza: "alta"|"media"|"baja", nota }.
  function detectar(canvas, formato) {
    return buscar(canvas, formato, 1)[0];
  }

  // Hito de actualización 14: las dos caras en la misma imagen (una hoja escaneada con el
  // documento por delante y por detrás, o una foto de las dos caras sobre la mesa).
  // Devuelve una lista con hasta «cuantas» tarjetas en orden de lectura. La mejor es la
  // misma que da detectar(); las demás solo cuentan si no se solapan con otra, miden lo
  // mismo (entre 0,6 y 1,65 veces su superficie) y su confianza no es baja.
  function detectarVarias(canvas, formato, cuantas) {
    return buscar(canvas, formato, Math.max(1, cuantas || 2));
  }

  function buscar(canvas, formato, cuantas) {
    const cv = window.cv;
    const proporcion = PROPORCION[formato] || PROPORCION.id1;
    const escala = Math.min(1, LADO_TRABAJO / Math.max(canvas.width, canvas.height));
    const ancho = Math.max(1, Math.round(canvas.width * escala));
    const alto = Math.max(1, Math.round(canvas.height * escala));
    const liberar = [];
    const mat = (m) => { liberar.push(m); return m; };
    try {
      const src = mat(cv.imread(canvas));
      const peq = mat(new cv.Mat());
      cv.resize(src, peq, new cv.Size(ancho, alto), 0, 0, cv.INTER_AREA);
      const gris = mat(new cv.Mat());
      cv.cvtColor(peq, gris, cv.COLOR_RGBA2GRAY);
      const suave = mat(new cv.Mat());
      cv.GaussianBlur(gris, suave, new cv.Size(5, 5), 0);
      // Saturación: separa una tarjeta clara de un fondo de color parecido en brillo.
      const rgb = mat(new cv.Mat());
      cv.cvtColor(peq, rgb, cv.COLOR_RGBA2RGB);
      const hsv = mat(new cv.Mat());
      cv.cvtColor(rgb, hsv, cv.COLOR_RGB2HSV);
      const canales = new cv.MatVector();
      cv.split(hsv, canales);
      const sat = mat(canales.get(1));
      canales.get(0).delete();
      canales.get(2).delete();
      canales.delete();
      const satSuave = mat(new cv.Mat());
      cv.GaussianBlur(sat, satSuave, new cv.Size(5, 5), 0);

      const area = ancho * alto;
      const kernel = mat(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3)));
      const todos = mat(cv.Mat.zeros(alto, ancho, cv.CV_8UC1));
      const candidatos = [];
      // Contraste local realzado: separa una tarjeta blanca de una mesa blanca.
      const realzado = mat(new cv.Mat());
      let clahe = null;
      try {
        clahe = new cv.CLAHE(3, new cv.Size(8, 8));
        clahe.apply(suave, realzado);
      } catch (e) {
        suave.copyTo(realzado);
      } finally {
        if (clahe) clahe.delete();
      }
      const med = mediana(suave.data);
      const pasadas = [
        [suave, Math.max(10, 0.66 * med), Math.min(255, 1.33 * med)],
        [suave, 20, 60],
        [suave, 50, 150],
        [realzado, 25, 75],
        [suave, 8, 24],
      ];
      pasadas.forEach(([canal, lo, hi], i) => {
        const bordes = mat(new cv.Mat());
        cv.Canny(canal, bordes, lo, hi);
        if (i < 3) {
          const bordesSat = mat(new cv.Mat());
          cv.Canny(satSuave, bordesSat, lo, hi);
          cv.bitwise_or(bordes, bordesSat, bordes);
        }
        if (i < 4) cv.bitwise_or(todos, bordes, todos);
        const cerrado = mat(new cv.Mat());
        cv.morphologyEx(bordes, cerrado, cv.MORPH_CLOSE, kernel, new cv.Point(-1, -1), 2);
        candidatosDe(cv, cerrado, area, candidatos, "bordes" + i);
        if (i === 1 || i === 3) candidatosDeLineas(cv, bordes, ancho, alto, candidatos);
      });
      // Zonas claras u oscuras (la tarjeta suele ser más clara o más oscura que el fondo).
      [suave, satSuave].forEach((canal, i) => {
        const bn = mat(new cv.Mat());
        cv.threshold(canal, bn, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
        const abierto = mat(new cv.Mat());
        cv.morphologyEx(bn, abierto, cv.MORPH_OPEN, kernel, new cv.Point(-1, -1), 2);
        candidatosDe(cv, abierto, area, candidatos, "zonas" + i);
        const inverso = mat(new cv.Mat());
        cv.bitwise_not(abierto, inverso);
        candidatosDe(cv, inverso, area, candidatos, "zonas-inv" + i);
      });

      // Cambios de luz en horizontal y en vertical (para saber si un lado va
      // de verdad por el canto de la tarjeta). Se miden en la imagen realzada.
      const gx = mat(new cv.Mat());
      const gy = mat(new cv.Mat());
      cv.Sobel(realzado, gx, cv.CV_16S, 1, 0, 3);
      cv.Sobel(realzado, gy, cv.CV_16S, 0, 1, 3);
      const grad = { gx: gx.data16S, gy: gy.data16S, umbral: 40 };
      let mejor = null;
      const puntuados = [];
      candidatos.forEach((c) => {
        const p = puntuar(c, grad, ancho, alto, proporcion);
        if (!p) return;
        puntuados.push(p);
        if (!mejor || p.nota > mejor.nota) mejor = p;
      });
      // ¿Llegan otros métodos (bordes, zonas, rectas) al mismo cuadrilátero?
      // Si solo lo ve uno, la confianza baja un escalón.
      const familia = (o) => o.replace(/[-\d].*$/, "");
      const menor = Math.min(ancho, alto);
      const acuerdosDe = (elegido) => {
        const propia = familia(elegido.origen);
        const vistas = new Set();
        puntuados.forEach((p) => {
          const f = familia(p.origen);
          if (f === propia || vistas.has(f) || p.nota < elegido.nota - 0.25) return;
          let d = 0;
          for (let i = 0; i < 4; i++) d += dist(p.q[i], elegido.q[i]) / 4;
          if (d / menor < 0.015) vistas.add(f);
        });
        return vistas.size;
      };
      const acuerdos = mejor ? acuerdosDe(mejor) : 0;

      // La foto entera ya es el documento (un escaneo recortado, una captura).
      const r = Math.max(canvas.width, canvas.height) / Math.min(canvas.width, canvas.height);
      if ((!mejor || mejor.nota < 0.55) && Math.abs(r - proporcion) / proporcion < 0.06) {
        const w = canvas.width;
        const h = canvas.height;
        return [{ esquinas: [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }], confianza: "media", nota: 0.55, origen: "foto-entera" }];
      }
      if (!mejor) return [{ esquinas: null, confianza: "baja", nota: 0 }];

      // Ajuste fino en una versión más grande de la foto.
      const escala2 = Math.min(1, LADO_AJUSTE / Math.max(canvas.width, canvas.height));
      const ancho2 = Math.max(1, Math.round(canvas.width * escala2));
      const alto2 = Math.max(1, Math.round(canvas.height * escala2));
      const med2 = mat(new cv.Mat());
      cv.resize(src, med2, new cv.Size(ancho2, alto2), 0, 0, cv.INTER_AREA);
      const gris2 = mat(new cv.Mat());
      cv.cvtColor(med2, gris2, cv.COLOR_RGBA2GRAY);
      const f = escala2 / escala;
      const niveles = ["baja", "media", "alta"];
      const terminar = (elegido, acu) => {
        const ajustadas = ajustar(gris2.data, ancho2, alto2, elegido.q.map((p) => ({ x: p.x * f, y: p.y * f })));
        const esquinas = ordenar(ajustadas.map((p) => ({ x: p.x / escala2, y: p.y / escala2 })));
        let nivel = elegido.nota >= 0.72 && elegido.peor >= 0.45 ? 2 : elegido.nota >= 0.6 ? 1 : 0;
        if (!acu && nivel > 0) nivel--;
        return {
          esquinas: esquinas, confianza: niveles[nivel], nota: Math.round(elegido.nota * 100) / 100,
          origen: elegido.origen + (acu ? " +" + acu : ""), lados: elegido.lados,
        };
      };
      const resultados = [terminar(mejor, acuerdos)];
      if (cuantas > 1) {
        // Otras tarjetas: de mejor a peor nota, sin pisar a ninguna ya elegida.
        const elegidos = [mejor];
        const orden = puntuados.slice().sort((a, b) => b.nota - a.nota);
        for (const p of orden) {
          if (resultados.length >= cuantas || p.nota < 0.6) break;
          const tam = p.area / mejor.area;
          if (tam < 0.6 || tam > 1.65) continue;
          if (elegidos.some((e) => solape(e.q, p.q) > 0.1)) continue;
          const res = terminar(p, acuerdosDe(p));
          if (res.confianza === "baja") continue;
          elegidos.push(p);
          resultados.push(res);
        }
        ordenLectura(resultados);
      }
      return resultados;
    } finally {
      liberar.forEach((m) => { try { m.delete(); } catch (e) { /* ya liberada */ } });
    }
  }

  DP.tools.kitBordes = { detectar: detectar, detectarVarias: detectarVarias };
})();
