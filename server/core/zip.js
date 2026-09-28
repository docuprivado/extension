/*
 * Leer y escribir archivos ZIP (un .docx es un ZIP con XML dentro) con lo que trae Node
 * (zlib), sin librerías. Solo lo que hace falta para un Word:
 * - leer: el índice central, cada entrada guardada tal cual o comprimida («deflate»);
 * - escribir: las entradas que no cambian se copian comprimidas tal como venían, y las
 *   que cambian se vuelven a comprimir.
 * No admite ZIP de más de 4 GB (ZIP64) ni cifrados: un Word nunca los necesita, y si llega
 * uno así se dice con un error claro.
 */
import zlib from "node:zlib";

const FIRMA_FIN = 0x06054b50;
const FIRMA_CENTRAL = 0x02014b50;
const FIRMA_LOCAL = 0x04034b50;

export class ErrorZip extends Error {
  constructor(motivo) {
    super(motivo);
    this.name = "ErrorZip";
    this.motivo = motivo;
  }
}

/** Entradas del ZIP, en su orden: { nombre, metodo, crc, comprimido, tamano, fechaDos, horaDos, flags, datosComprimidos }. */
export function leerZip(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  let fin = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 22 - 65535); i--) {
    if (b.readUInt32LE(i) === FIRMA_FIN) { fin = i; break; }
  }
  if (fin < 0) throw new ErrorZip("no es un zip");
  const total = b.readUInt16LE(fin + 10);
  const tamCentral = b.readUInt32LE(fin + 12);
  const inicioCentral = b.readUInt32LE(fin + 16);
  if (total === 0xffff || inicioCentral === 0xffffffff || tamCentral === 0xffffffff) throw new ErrorZip("zip64");
  const entradas = [];
  let p = inicioCentral;
  for (let n = 0; n < total; n++) {
    if (p + 46 > b.length || b.readUInt32LE(p) !== FIRMA_CENTRAL) throw new ErrorZip("índice dañado");
    const flags = b.readUInt16LE(p + 8);
    const metodo = b.readUInt16LE(p + 10);
    const horaDos = b.readUInt16LE(p + 12);
    const fechaDos = b.readUInt16LE(p + 14);
    const crc = b.readUInt32LE(p + 16);
    const comprimido = b.readUInt32LE(p + 20);
    const tamano = b.readUInt32LE(p + 24);
    const lNombre = b.readUInt16LE(p + 28);
    const lExtra = b.readUInt16LE(p + 30);
    const lComentario = b.readUInt16LE(p + 32);
    const local = b.readUInt32LE(p + 42);
    const nombre = b.subarray(p + 46, p + 46 + lNombre).toString(flags & 0x800 ? "utf8" : "latin1");
    if (flags & 0x1) throw new ErrorZip("cifrado");
    if (comprimido === 0xffffffff || tamano === 0xffffffff || local === 0xffffffff) throw new ErrorZip("zip64");
    if (local + 30 > b.length || b.readUInt32LE(local) !== FIRMA_LOCAL) throw new ErrorZip("entrada dañada");
    const inicioDatos = local + 30 + b.readUInt16LE(local + 26) + b.readUInt16LE(local + 28);
    if (inicioDatos + comprimido > b.length) throw new ErrorZip("entrada cortada");
    entradas.push({ nombre, metodo, crc, comprimido, tamano, fechaDos, horaDos, flags, datosComprimidos: b.subarray(inicioDatos, inicioDatos + comprimido) });
    p += 46 + lNombre + lExtra + lComentario;
  }
  return entradas;
}

/** Los datos de una entrada, descomprimidos. */
export function datosDe(entrada) {
  if (entrada.metodo === 0) return Buffer.from(entrada.datosComprimidos);
  if (entrada.metodo === 8) {
    const datos = zlib.inflateRawSync(entrada.datosComprimidos);
    if (datos.length !== entrada.tamano) throw new ErrorZip("tamaño distinto");
    return datos;
  }
  throw new ErrorZip("compresión desconocida");
}

/**
 * Escribe un ZIP. entradas: las de leerZip (se copian tal cual) o, si traen «datos»
 * (Buffer), se comprimen de nuevo. Mismo orden que se recibe.
 */
export function escribirZip(entradas) {
  const partes = [];
  const central = [];
  let pos = 0;
  for (const e of entradas) {
    let metodo = e.metodo;
    let crc = e.crc;
    let tamano = e.tamano;
    let comprimidos = e.datosComprimidos;
    if (e.datos) {
      const datos = Buffer.isBuffer(e.datos) ? e.datos : Buffer.from(e.datos);
      metodo = 8;
      crc = zlib.crc32(datos) >>> 0;
      tamano = datos.length;
      comprimidos = zlib.deflateRawSync(datos, { level: 6 });
    }
    const nombre = Buffer.from(e.nombre, "utf8");
    const flags = (/[^\x20-\x7e]/.test(e.nombre) ? 0x800 : 0);   // sin «descriptor de datos»: los tamaños van delante
    const fecha = e.fechaDos || 0x5b21;
    const hora = e.horaDos || 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(FIRMA_LOCAL, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(metodo, 8);
    local.writeUInt16LE(hora, 10);
    local.writeUInt16LE(fecha, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comprimidos.length, 18);
    local.writeUInt32LE(tamano, 22);
    local.writeUInt16LE(nombre.length, 26);
    local.writeUInt16LE(0, 28);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(FIRMA_CENTRAL, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(flags, 8);
    cen.writeUInt16LE(metodo, 10);
    cen.writeUInt16LE(hora, 12);
    cen.writeUInt16LE(fecha, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(comprimidos.length, 20);
    cen.writeUInt32LE(tamano, 24);
    cen.writeUInt16LE(nombre.length, 28);
    cen.writeUInt32LE(pos, 42);
    central.push(cen, nombre);
    partes.push(local, nombre, comprimidos);
    pos += 30 + nombre.length + comprimidos.length;
  }
  const tamCentral = central.reduce((s, x) => s + x.length, 0);
  const fin = Buffer.alloc(22);
  fin.writeUInt32LE(FIRMA_FIN, 0);
  fin.writeUInt16LE(entradas.length, 8);
  fin.writeUInt16LE(entradas.length, 10);
  fin.writeUInt32LE(tamCentral, 12);
  fin.writeUInt32LE(pos, 16);
  return Buffer.concat([...partes, ...central, fin]);
}
