// Bloqueo de red para las pruebas: se carga antes que nada (node --import ./scripts/bloquear-red.mjs …)
// y convierte cualquier intento de conexión en un fallo: sockets, DNS, http/https/http2,
// fetch, WebSocket y UDP. También se carga en los hilos de trabajo. Al terminar, si hubo
// algún intento, el proceso sale con código 99 (CLAUDE.md §4.1 y §8.2).
import net from "node:net";
import tls from "node:tls";
import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import http2 from "node:http2";
import dgram from "node:dgram";
import { isMainThread, threadId } from "node:worker_threads";

const intentos = [];
function bloquear(que) {
  return function () {
    const e = new Error("Conexión bloqueada por la prueba sin red: " + que);
    intentos.push(que);
    process.stderr.write("[SIN RED] intento de conexión: " + que + " (hilo " + threadId + ")\n" + e.stack.split("\n").slice(2, 6).join("\n") + "\n");
    process.exitCode = 99;
    throw e;
  };
}
net.Socket.prototype.connect = bloquear("net.Socket.connect");
net.connect = net.createConnection = bloquear("net.connect");
tls.connect = bloquear("tls.connect");
for (const f of ["lookup", "resolve", "resolve4", "resolve6", "resolveAny", "resolveTxt", "resolveSrv"]) {
  if (dns[f]) dns[f] = bloquear("dns." + f);
  if (dns.promises[f]) dns.promises[f] = bloquear("dns.promises." + f);
}
http.request = http.get = bloquear("http.request");
https.request = https.get = bloquear("https.request");
http2.connect = bloquear("http2.connect");
dgram.createSocket = bloquear("dgram.createSocket");
globalThis.fetch = bloquear("fetch");
if (globalThis.WebSocket) globalThis.WebSocket = bloquear("WebSocket");
if (globalThis.EventSource) globalThis.EventSource = bloquear("EventSource");

process.stderr.write("[SIN RED] red bloqueada en el hilo " + (isMainThread ? "principal" : threadId) + "\n");
process.on("exit", () => {
  if (isMainThread) process.stderr.write(intentos.length ? "[SIN RED] ✗ " + intentos.length + " intento(s) de conexión\n" : "[SIN RED] ✓ ningún intento de conexión\n");
});
