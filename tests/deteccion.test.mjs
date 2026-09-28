/*
 * Detección común: datos tapados en parte, palabras que se dejan visibles, perfiles y
 * tipos (docs/PROMPT_EXTENSION.md §4.3 y §4.5).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { PERFILES, dejarVisible, enmascarar, opcionesDeteccion, textoPorTipo } from "../server/core/deteccion.js";

test("datos tapados en parte, como pide el prompt", () => {
  assert.equal(enmascarar("dni", "12345678Z"), "***4567**");   // cifras 4.ª a 7.ª, como la AEPD
  assert.equal(enmascarar("dni", "12.345.678-Z"), "***4567**");
  assert.equal(enmascarar("nie", "X1234567L"), "****4567*");
  assert.equal(enmascarar("iban", "ES91 2100 0418 4502 0005 1332"), "ES91 **** **** **** **** 1332");
  assert.equal(enmascarar("nombre", "Juan Pérez García"), "J*** P**** G*****");
  assert.equal(enmascarar("telefono", "612 345 678"), "*** *** 678");
  assert.equal(enmascarar("email", "juan.perez@example.com"), "j***@e***.com");
  assert.equal(enmascarar("tarjeta", "4111 1111 1111 1111"), "**** **** **** 1111");
  assert.equal(enmascarar("fecha_nac", "15/03/1985"), "**/**/1985");
  assert.equal(enmascarar("cp", "28013"), "28***");
});

test("un dato tapado nunca lleva el valor entero", () => {
  const casos = [["dni", "12345678Z"], ["nie", "Y2345678Z"], ["iban", "ES9121000418450200051332"], ["nombre", "María López Sánchez"], ["direccion", "Calle del Ejemplo 12, 3.º B"],
    ["telefono", "912345678"], ["email", "ana.ejemplo@example.com"], ["nss", "28/12345678/40"], ["cif", "B00000000"], ["matricula", "1234 BCD"], ["importe", "1.650,00 €"], ["cuenta", "2100 0418 45 0200051332"]];
  for (const [tipo, valor] of casos) {
    const t = enmascarar(tipo, valor);
    assert.notEqual(t, valor, tipo);
    assert.ok(!t.replace(/\s/g, "").includes(valor.replace(/\s/g, "")), tipo);
    assert.ok((t.match(/\*/g) || []).length >= Math.floor(valor.replace(/\W/g, "").length / 3), tipo + ": " + t);
  }
});

test("no_tachar: el nombre de la empresa (completo o corto) queda a la vista", () => {
  const nt = ["Inmobiliaria Ejemplo"];
  assert.equal(dejarVisible("INMOBILIARIA EJEMPLO, S.L.", nt), true);
  assert.equal(dejarVisible("Inmobiliaria Ejemplo", nt), true);
  assert.equal(dejarVisible("Ejemplo", nt), true);
  assert.equal(dejarVisible("Juan Pérez", nt), false);
  assert.equal(dejarVisible("S.L", nt), false);
  assert.equal(dejarVisible("Inmobiliaria Ejemplar", nt), false);
  assert.equal(dejarVisible("cualquier cosa", []), false);
});

test("perfiles y tipos: como las páginas de la web", () => {
  const general = opcionesDeteccion({});
  for (const t of ["dni", "nie", "iban", "cuenta", "direccion", "cp", "empresa", "cif", "importe", "nombre"]) assert.ok(general.tipos.includes(t), t);
  const nomina = opcionesDeteccion({ preset: "nomina" });
  for (const t of ["importe", "empresa", "cif", "tarjeta", "matricula"]) assert.ok(!nomina.tipos.includes(t), t);
  assert.deepEqual(opcionesDeteccion({ tipos: ["dni"] }).tipos.sort(), ["dni", "nie"]);
  assert.throws(() => opcionesDeteccion({ tipos: ["pasaporte"] }), (e) => e.codigo === "tipos");
  assert.throws(() => opcionesDeteccion({ preset: "factura" }), (e) => e.codigo === "preset");
  assert.deepEqual(Object.keys(PERFILES).sort(), ["captura", "contrato", "general", "nomina"]);
});

test("palabras personalizadas y a dejar visibles: se limpian", () => {
  const o = opcionesDeteccion({ personalizados: ["  Expediente 123 ", "x", ""], no_tachar: ["Mi Empresa"] });
  assert.deepEqual(o.personalizados, ["Expediente 123"]);
  assert.deepEqual(o.noTachar, ["Mi Empresa"]);
});

test("recuento por tipo en español", () => {
  assert.equal(textoPorTipo({ dni: 2, nombre: 7, iban: 1 }), "7 nombres, 2 DNI, 1 IBAN");
});
