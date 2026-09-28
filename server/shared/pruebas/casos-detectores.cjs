/*
 * Casos de prueba del motor de detección (docs/PROMPT_INICIAL.md §6.4).
 * Cada caso: { texto, tipo, valor, confianza?, opciones? }
 *   valor: lo que debe encontrarse, o "ninguno" si ese tipo NO debe aparecer.
 * Se usan en tests/detectores.html (navegador) y en tests/run-node.js (Node).
 */
(function (global) {
  "use strict";

  const CASOS = [
    // ---------------------------------------------------------------- DNI
    { texto: "Con DNI 12345678Z y domicilio conocido", tipo: "dni", valor: "12345678Z", confianza: "alta" },
    { texto: "DNI: 12345678-Z", tipo: "dni", valor: "12345678-Z", confianza: "alta" },
    { texto: "documento 12345678 Z del titular", tipo: "dni", valor: "12345678 Z", confianza: "alta" },
    { texto: "dni 12345678z en minúsculas", tipo: "dni", valor: "12345678z", confianza: "alta" },
    { texto: "El DNI 12345678A tiene una errata", tipo: "dni", valor: "12345678A", confianza: "media" },
    { texto: "Pedido número 87654321 confirmado", tipo: "dni", valor: "ninguno" },
    { texto: "Referencia 123456789012 del banco", tipo: "dni", valor: "ninguno" },
    { texto: "Código AB12345678Z interno", tipo: "dni", valor: "ninguno" },
    { texto: "DNI DEL TITULAR: 12345678Z", tipo: "dni", valor: "12345678Z" },
    { texto: "importe de 12345678 euros", tipo: "dni", valor: "ninguno" },

    // ---------------------------------------------------------------- NIE
    { texto: "NIE X1234567L vigente", tipo: "nie", valor: "X1234567L", confianza: "alta" },
    { texto: "nie y1234567x en minúsculas", tipo: "nie", valor: "y1234567x", confianza: "alta" },
    { texto: "Tarjeta Z1234567R de residencia", tipo: "nie", valor: "Z1234567R", confianza: "alta" },
    { texto: "NIE X-1234567-L con guiones", tipo: "nie", valor: "X-1234567-L", confianza: "alta" },
    { texto: "El NIE X1234567B no valida", tipo: "nie", valor: "X1234567B", confianza: "media" },
    { texto: "Modelo W1234567A de impresora", tipo: "nie", valor: "ninguno" },

    // --------------------------------------------------------------- IBAN
    { texto: "Cuenta ES91 2100 0418 4502 0005 1332 del titular", tipo: "iban", valor: "ES91 2100 0418 4502 0005 1332", confianza: "alta" },
    { texto: "IBAN: ES9121000418450200051332", tipo: "iban", valor: "ES9121000418450200051332", confianza: "alta" },
    { texto: "iban es91 2100 0418 4502 0005 1332 en minúsculas", tipo: "iban", valor: "es91 2100 0418 4502 0005 1332" },
    { texto: "Cuenta ES91 2100 0418 4502 0005 1333 con un dígito cambiado", tipo: "iban", valor: "ninguno" },
    { texto: "Transferencia a DE89370400440532013000 en Alemania", tipo: "iban", valor: "DE89370400440532013000", confianza: "alta" },
    { texto: "Referencia ES00 0000 0000 0000 0000 0000 inventada", tipo: "iban", valor: "ninguno" },

    // ----------------------------------------------------- cuenta antigua
    { texto: "Cuenta antigua 2100 0418 45 0200051332 del cliente", tipo: "cuenta", valor: "2100 0418 45 0200051332", confianza: "media" },
    { texto: "CCC 21000418450200051332 sin espacios", tipo: "cuenta", valor: "21000418450200051332" },
    { texto: "Número de pedido 1234567890123456789 de la web", tipo: "cuenta", valor: "ninguno" },

    // ------------------------------------------------------------ tarjeta
    { texto: "Tarjeta 4111 1111 1111 1111 de prueba", tipo: "tarjeta", valor: "4111 1111 1111 1111", confianza: "alta" },
    { texto: "Visa 4111111111111111 sin espacios", tipo: "tarjeta", valor: "4111111111111111", confianza: "alta" },
    { texto: "Tarjeta 5500 0000 0000 0004 aceptada", tipo: "tarjeta", valor: "5500 0000 0000 0004" },
    { texto: "Tarjeta 4111 1111 1111 1112 con un dígito mal", tipo: "tarjeta", valor: "ninguno" },
    { texto: "Expediente 1234 5678 9012 3456 del archivo", tipo: "tarjeta", valor: "ninguno" },

    // ----------------------------------------------------------- teléfono
    { texto: "Teléfono 612 345 678 para avisos", tipo: "telefono", valor: "612 345 678", confianza: "alta" },
    { texto: "Llama al 612345678 cuando puedas", tipo: "telefono", valor: "612345678", confianza: "alta" },
    { texto: "Fijo 911 234 567 de la oficina", tipo: "telefono", valor: "911 234 567" },
    { texto: "Móvil +34 612 345 678 disponible", tipo: "telefono", valor: "+34 612 345 678", confianza: "alta" },
    { texto: "Contacto 0034 612 345 678 desde el extranjero", tipo: "telefono", valor: "0034 612 345 678" },
    { texto: "Teléfono 612-345-678 con guiones", tipo: "telefono", valor: "612-345-678" },
    { texto: "Teléfono internacional +33 6 12 34 56 78", tipo: "telefono", valor: "+33 6 12 34 56 78", confianza: "media" },
    { texto: "Número de expediente 123456789012 del caso", tipo: "telefono", valor: "ninguno" },
    { texto: "El importe 512345678 no es un teléfono", tipo: "telefono", valor: "ninguno" },
    { texto: "Código postal 28013 de Madrid", tipo: "telefono", valor: "ninguno" },

    // -------------------------------------------------------------- email
    { texto: "Escribe a juan.perez@example.com cuando quieras", tipo: "email", valor: "juan.perez@example.com", confianza: "alta" },
    { texto: "Correo: MARIA.LOPEZ@EXAMPLE.CO.UK", tipo: "email", valor: "MARIA.LOPEZ@EXAMPLE.CO.UK" },
    { texto: "correo con más de un punto a.b.c@sub.example.es aquí", tipo: "email", valor: "a.b.c@sub.example.es" },
    { texto: "Usuario sin arroba example.com no es correo", tipo: "email", valor: "ninguno" },
    { texto: "Texto con arroba suelta @ejemplo suelto", tipo: "email", valor: "ninguno" },

    // ---------------------------------------------------------------- NSS
    { texto: "Número de la Seguridad Social 28/12345678/40", tipo: "nss", valor: "28/12345678/40", confianza: "alta" },
    { texto: "NSS 281234567840 del trabajador", tipo: "nss", valor: "281234567840", confianza: "alta" },
    { texto: "Afiliación 28 12345678 40 en la nómina", tipo: "nss", valor: "28 12345678 40" },
    { texto: "Seguridad Social 28/12345678/99 con control mal", tipo: "nss", valor: "28/12345678/99", confianza: "media" },
    { texto: "Referencia 281234567899 sin contexto", tipo: "nss", valor: "ninguno" },
    { texto: "El pedido 281234567840 no lleva contexto", tipo: "nss", valor: "281234567840", confianza: "media" },

    // ---------------------------------------------------------- matrícula
    { texto: "Vehículo 1234 BCD en el garaje", tipo: "matricula", valor: "1234 BCD", confianza: "alta" },
    { texto: "Matrícula 1234BCD sin espacio", tipo: "matricula", valor: "1234BCD" },
    { texto: "coche 1234-bcd en minúsculas", tipo: "matricula", valor: "1234-bcd" },
    { texto: "El código 1234 ABC no es matrícula (vocales)", tipo: "matricula", valor: "ninguno" },
    { texto: "Matrícula antigua M-1234-AB del coche", tipo: "matricula", valor: "M-1234-AB", confianza: "baja" },
    { texto: "Referencia B-1234-XY sin contexto", tipo: "matricula", valor: "ninguno" },

    // ---------------------------------------------------------- dirección
    { texto: "Vive en Calle del Ejemplo 12, 3.º B y trabaja fuera", tipo: "direccion", valor: "Calle del Ejemplo 12, 3.º B", confianza: "media" },
    { texto: "Domicilio: Avenida de la Prueba 45", tipo: "direccion", valor: "Avenida de la Prueba 45" },
    { texto: "En Avda. de los Álamos 8, 2º izq. está la oficina", tipo: "direccion", valor: "Avda. de los Álamos 8, 2º izq." },
    { texto: "Plaza Mayor 3 de Salamanca", tipo: "direccion", valor: "Plaza Mayor 3 de Salamanca" },
    { texto: "Ctra. de Toledo km 5 dirección sur", tipo: "direccion", valor: "Ctra. de Toledo km 5" },
    { texto: "La calle estaba cortada por obras", tipo: "direccion", valor: "ninguno" },
    { texto: "La plaza de garaje queda asignada al vehículo 1234 BCD", tipo: "direccion", valor: "ninguno" },
    { texto: "La plaza de garaje queda asignada al vehículo 1234 BCD", tipo: "matricula", valor: "1234 BCD" },
    { texto: "Vive en calle mayor 3 desde siempre", tipo: "direccion", valor: "calle mayor 3" },

    // Hito de actualización 1: direcciones sin «Domicilio:» ni «C/», con comas y saltos de línea
    { texto: "con domicilio en Almendros 14, 3.º A, 28045 Madrid, en su propio nombre", tipo: "direccion", valor: "Almendros 14, 3.º A, 28045 Madrid" },
    { texto: "domiciliada en la calle de San Bernardo, número 21, piso 4.º, puerta 2, de Valladolid, y con teléfono", tipo: "direccion", valor: "calle de San Bernardo, número 21, piso 4.º, puerta 2, de Valladolid" },
    { texto: "domicilio social en Avenida de Portugal,\n112, bajo, 37006 Salamanca, representada", tipo: "direccion", valor: "Avenida de Portugal,\n112, bajo, 37006 Salamanca" },
    { texto: "Las notificaciones se harán en Plaza de la Merced s/n, 37008 Salamanca, o en otro sitio", tipo: "direccion", valor: "Plaza de la Merced s/n, 37008 Salamanca" },
    { texto: "en la C/ Pintor Rosales, 7 – 1ºB, de Madrid. La gestora cobra", tipo: "direccion", valor: "C/ Pintor Rosales, 7 – 1ºB, de Madrid" },
    { texto: "que vive en el número 9 de la calle Olivo cuando está aquí", tipo: "direccion", valor: "número 9 de la calle Olivo" },
    { texto: "Laura Gómez Ferrer\nRonda de Atocha 30, 5º izda.\n28012 Madrid", tipo: "direccion", valor: "Ronda de Atocha 30, 5º izda.\n28012 Madrid" },
    { texto: "DOMICILIO: CL MAYOR 12 3 B 50001 ZARAGOZA.", tipo: "direccion", valor: "CL MAYOR 12 3 B 50001 ZARAGOZA" },
    { texto: "Laura Gómez\nAlmendros 14, 3º A\n28045 Madrid", tipo: "direccion", valor: "Almendros 14, 3º A\n28045 Madrid" },
    { texto: "La vivienda, sita en Gran Vía 32, 5º, de Madrid, está libre", tipo: "direccion", valor: "Gran Vía 32, 5º, de Madrid" },
    { texto: "Vive en la calle Olivo desde niña", tipo: "direccion", valor: "calle Olivo" },
    { texto: "y que la plaza de garaje número 27 queda incluida", tipo: "direccion", valor: "ninguno" },
    { texto: "CLÁUSULA TERCERA. VÍA DE PAGO", tipo: "direccion", valor: "ninguno" },
    { texto: "Reside en Madrid desde 2019", tipo: "direccion", valor: "ninguno" },
    { texto: "Avda. de la Constitución, n.º 5, esc. B, 2.º dcha., 41001 Sevilla (Sevilla)", tipo: "direccion", valor: "Avda. de la Constitución, n.º 5, esc. B, 2.º dcha., 41001 Sevilla (Sevilla)" },

    // ------------------------------------------------------ código postal
    { texto: "Vive en el 28013 Madrid desde hace años", tipo: "cp", valor: "28013", confianza: "media" },
    { texto: "CP 08001 en la ficha", tipo: "cp", valor: "08001" },
    { texto: "Calle del Ejemplo 12, 28013 Madrid", tipo: "direccion", valor: "Calle del Ejemplo 12, 28013 Madrid" },
    { texto: "El importe 28013 euros del contrato", tipo: "cp", valor: "ninguno" },
    { texto: "Código 99999 del producto", tipo: "cp", valor: "ninguno" },

    // -------------------------------------------------- fecha nacimiento
    { texto: "Fecha de nacimiento: 15/03/1985", tipo: "fecha_nac", valor: "15/03/1985", confianza: "alta" },
    { texto: "Nacido el 1 de enero de 1990 en Madrid", tipo: "fecha_nac", valor: "1 de enero de 1990", confianza: "alta" },
    { texto: "F. nac. 02-07-1992 según el registro", tipo: "fecha_nac", valor: "02-07-1992" },
    { texto: "Nacida el 29/02/2000 (año bisiesto)", tipo: "fecha_nac", valor: "29/02/2000" },
    { texto: "Fecha de nacimiento 31/02/1990 imposible", tipo: "fecha_nac", valor: "ninguno" },
    { texto: "El contrato empieza el 01/10/2026", tipo: "fecha_nac", valor: "ninguno" },
    { texto: "El contrato empieza el 01/10/2026", tipo: "fecha_nac", valor: "01/10/2026", confianza: "media", opciones: { todasLasFechas: true } },

    // ------------------------------------------------------------ nombres
    { texto: "De una parte, D. Juan Pérez García, mayor de edad", tipo: "nombre", valor: "Juan Pérez García", confianza: "alta" },
    { texto: "Dña. María López Sánchez firma el contrato", tipo: "nombre", valor: "María López Sánchez", confianza: "alta" },
    { texto: "Juan Pérez García entregó la documentación", tipo: "nombre", valor: "Juan Pérez García", confianza: "alta" },
    { texto: "Fdo.: Carmen Ruiz Ortega", tipo: "nombre", valor: "Carmen Ruiz Ortega" },
    { texto: "JUAN PÉREZ GARCÍA, con DNI", tipo: "nombre", valor: "JUAN PÉREZ GARCÍA" },
    { texto: "El arrendador, José de la Fuente Martín, comparece", tipo: "nombre", valor: "José de la Fuente Martín" },
    { texto: "María del Carmen Sánchez Gil asiste", tipo: "nombre", valor: "María del Carmen Sánchez Gil" },
    { texto: "Santiago de Compostela es una ciudad preciosa", tipo: "nombre", valor: "ninguno" },
    { texto: "D. Santiago López acudió a la cita", tipo: "nombre", valor: "Santiago López" },
    { texto: "El Ministerio de Hacienda publicó la orden", tipo: "nombre", valor: "ninguno" },
    // «Expediente de…», «Informe de…», «Solicitud de…»: el documento no forma parte del nombre.
    { texto: "Expediente de Juan Pérez García", tipo: "nombre", valor: "Juan Pérez García", confianza: "alta" },
    { texto: "Informe de María López Sánchez sobre la vivienda", tipo: "nombre", valor: "María López Sánchez", confianza: "alta" },
    { texto: "Solicitud de Carmen Ruiz Ortega", tipo: "nombre", valor: "Carmen Ruiz Ortega" },
    { texto: "D. Juan Carta Pérez firma el acuerdo", tipo: "nombre", valor: "Juan Carta Pérez" },
    { texto: "Adjunto la copia del DNI de Juan Pérez García.", tipo: "nombre", valor: "Juan Pérez García", confianza: "alta" },
    { texto: "NIE de María López Sánchez: X1234567L", tipo: "nombre", valor: "María López Sánchez", confianza: "alta" },
    { texto: "Comparecen Juan Pérez García y otros.", tipo: "nombre", valor: "Juan Pérez García" },
    { texto: "Estimado Juan Pérez García:", tipo: "nombre", valor: "Juan Pérez García" },
    // Dos personas unidas por «y»: cada una por separado (hito de actualización 13).
    { texto: "Firman Juan Pérez García y María López Sánchez.", tipo: "nombre", valor: "María López Sánchez", confianza: "alta" },
    { texto: "Dña. María López Sánchez y Rosa Martín.", tipo: "nombre", valor: "Rosa Martín" },
    { texto: "Los señores Juan y María López García comparecen.", tipo: "nombre", valor: "María López García", confianza: "alta" },
    { texto: "Los señores Juan y María López García comparecen.", tipo: "nombre", valor: "Juan" },
    { texto: "Entre Luis Gómez Ruiz e Isabel Díaz Mora.", tipo: "nombre", valor: "Isabel Díaz Mora", confianza: "alta" },
    { texto: "Entre Luis Gómez Ruiz e Isabel Díaz Mora.", tipo: "nombre", valor: "Luis Gómez Ruiz" },
    { texto: "José Ortega y Gasset escribió el libro.", tipo: "nombre", valor: "José Ortega y Gasset", confianza: "alta" },
    { texto: "Real Decreto 84/1996 de afiliación", tipo: "nombre", valor: "ninguno" },
    { texto: "La Comunidad de Madrid aprobó el plan", tipo: "nombre", valor: "ninguno" },
    { texto: "El lunes 3 de marzo empieza el contrato", tipo: "nombre", valor: "ninguno" },
    { texto: "Sr. Pérez, le confirmo la cita. Juan Pérez García firmará.", tipo: "nombre", valor: "Pérez", confianza: "media" },
    { texto: "Trabajador: Antonio Gómez Ruiz", tipo: "nombre", valor: "Antonio Gómez Ruiz" },
    { texto: "Paciente Lucía Ortega Ramos, próxima cita", tipo: "nombre", valor: "Lucía Ortega Ramos" },
    { texto: "El piso está en Madrid y el precio es alto", tipo: "nombre", valor: "ninguno" },
    { texto: "Ejemplo, S.L. es la empresa contratante", tipo: "nombre", valor: "ninguno" },

    // -------------------------------------------- cantidades de dinero
    { texto: "La renta será de SEISCIENTOS CINCUENTA EUROS (650,00 €), que se paga", tipo: "importe", valor: "SEISCIENTOS CINCUENTA EUROS (650,00 €)", confianza: "alta" },
    { texto: "asciende a la cantidad de 7.800,00 euros.", tipo: "importe", valor: "7.800,00 euros" },
    { texto: "entrega mil trescientos euros en concepto de fianza", tipo: "importe", valor: "mil trescientos euros" },
    { texto: "una garantía adicional de 1.300 €.", tipo: "importe", valor: "1.300 €" },
    { texto: "el IBI, de dos mil quinientos euros con cincuenta céntimos al año", tipo: "importe", valor: "dos mil quinientos euros con cincuenta céntimos" },
    { texto: "una penalización de EUR 150 por cada impago", tipo: "importe", valor: "EUR 150" },
    { texto: "y de 1.250,50€ por daños", tipo: "importe", valor: "1.250,50€" },
    { texto: "Una inversión de 1,5 millones de euros", tipo: "importe", valor: "1,5 millones de euros" },
    { texto: "Total devengado 1.989,99", tipo: "importe", valor: "1.989,99", confianza: "media" },
    { texto: "El importe 28013 euros del contrato", tipo: "importe", valor: "28013 euros" },
    { texto: "una fianza de dos mensualidades", tipo: "importe", valor: "ninguno" },
    { texto: "Jornada de 37,50 horas semanales", tipo: "importe", valor: "ninguno" },
    { texto: "Retención de IRPF: 15,00 % sobre el salario", tipo: "importe", valor: "ninguno" },

    // ------------------------------------------------------------ empresas
    { texto: "Y de otra, la mercantil INMOBILIARIA LOS ALMENDROS DEL TORMES, S.L., con CIF", tipo: "empresa", valor: "INMOBILIARIA LOS ALMENDROS DEL TORMES, S.L.", confianza: "alta" },
    { texto: "Que la arrendataria trabaja en Reformas Hermanos Ruiz, S.L.U. y cobra", tipo: "empresa", valor: "Reformas Hermanos Ruiz, S.L.U." },
    { texto: "Construcciones y Reformas García e Hijos, S.L. presentó la oferta", tipo: "empresa", valor: "Construcciones y Reformas García e Hijos, S.L." },
    { texto: "FIRMADO ENTRE ACME IBERICA SA Y EL TRABAJADOR", tipo: "empresa", valor: "ACME IBERICA SA" },
    { texto: "Empresa: TALLERES LOPEZ-GOMEZ SA", tipo: "empresa", valor: "TALLERES LOPEZ-GOMEZ SA" },
    { texto: "Ejemplo, S.L. es la empresa contratante", tipo: "empresa", valor: "Ejemplo, S.L." },
    { texto: "suscrito con la empresa Termoclima Salmantina, se mantiene", tipo: "empresa", valor: "Termoclima Salmantina", confianza: "media" },
    { texto: "cobra su nómina en el Banco Santander, y que", tipo: "empresa", valor: "Banco Santander" },
    { texto: "Zafiro Digital Solutions SL (en adelante, «Zafiro») presta el servicio. Zafiro factura cada mes.", tipo: "empresa", valor: "Zafiro" },
    { texto: "Tras el contrato con Zafiro Digital Solutions SL, Zafiro Digital Solutions cobra", tipo: "empresa", valor: "Zafiro Digital Solutions" },
    { texto: "EMPRESA\tTRABAJADOR\nEMPRESA FICTICIA DE PRUEBAS, S.L.", tipo: "empresa", valor: "EMPRESA FICTICIA DE PRUEBAS, S.L." },
    { texto: "la mercantil INMOBILIARIA LOS ALMENDROS DEL\nTORMES, S.L., con CIF", tipo: "empresa", valor: "INMOBILIARIA LOS ALMENDROS DEL\nTORMES, S.L." },
    // Con la lista del BORME y las marcas conocidas (assets/data/empresas.bin)
    { texto: "Los recibos de la luz los cobra Iberdrola y los del móvil, Movistar.", tipo: "empresa", valor: "Iberdrola" },
    { texto: "Contrato de obra con Abaton Arquitectura para la reforma", tipo: "empresa", valor: "Abaton Arquitectura" },
    { texto: "El Corte Inglés le ha devuelto el importe", tipo: "empresa", valor: "El Corte Inglés" },
    { texto: "Visita a la Casa Grande de los abuelos", tipo: "empresa", valor: "ninguno" },
    { texto: "Certificado de la Seguridad Social y de Recursos Humanos", tipo: "empresa", valor: "ninguno" },
    { texto: "La empresa se compromete a pagar puntualmente", tipo: "empresa", valor: "ninguno" },
    { texto: "LA EMPRESA SE COMPROMETE A PAGAR PUNTUALMENTE", tipo: "empresa", valor: "ninguno" },
    { texto: "Grupo de cotización 5 y categoría profesional", tipo: "empresa", valor: "ninguno" },
    { texto: "por su forma jurídica (S.L., S.A.…) y por su NIF", tipo: "empresa", valor: "ninguno" },
    { texto: "con CIF B12345674 y domicilio social", tipo: "cif", valor: "B12345674", confianza: "alta" },
    { texto: "NIF: B-12345674", tipo: "cif", valor: "B-12345674" },
    { texto: "Referencia A12345678 del pedido", tipo: "cif", valor: "ninguno" },

    // --------------------------------------------------- palabras propias
    { texto: "El expediente PROYECTO ALFA es reservado", tipo: "personalizado", valor: "PROYECTO ALFA", opciones: { personalizados: ["proyecto alfa"] } },
    { texto: "Referencia a Fundación Ejemplo en el texto", tipo: "personalizado", valor: "Fundación Ejemplo", opciones: { personalizados: ["fundacion ejemplo"] } },
    { texto: "Nada que ocultar en esta frase", tipo: "personalizado", valor: "ninguno", opciones: { personalizados: ["secreto"] } },

    { texto: "Vive en Calle Mayor, 5 desde enero", tipo: "personalizado", valor: "Mayor, 5", opciones: { tipos: [], personalizados: ["mayor 5"] } },
    { texto: "Calle de la Indepen-\ndencia, 8", tipo: "personalizado", valor: "Indepen-\ndencia", opciones: { tipos: [], personalizados: ["independencia"] } },
    { texto: "Nº de expediente 2024/0815", tipo: "personalizado", valor: "Nº", opciones: { tipos: [], personalizados: ["n°"] } },
    { texto: "Referencia PROYALFA-7", tipo: "personalizado", valor: "ALFA", opciones: { tipos: [], personalizados: ["alfa"], parcial: true } },

    // ------------------- datos partidos entre dos líneas (hito de actualización 4)
    // En un PDF, cuando un dato no cabe al final de la línea, su última parte pasa a
    // la siguiente: el texto que llega al detector lleva un salto de línea en medio.
    { texto: "con NIF 12345678\nZ y domicilio en Madrid", tipo: "dni", valor: "12345678\nZ", confianza: "alta" },
    { texto: "con DNI número 12345678-\nZ, mayor de edad", tipo: "dni", valor: "12345678-\nZ", confianza: "alta" },
    { texto: "DNI 12345678\n-Z del arrendatario", tipo: "dni", valor: "12345678\n-Z", confianza: "alta" },
    { texto: "con DNI 12345678 \n Z y teléfono", tipo: "dni", valor: "12345678 \n Z", confianza: "alta" },
    { texto: "provisto de D.N.I. 12.345.678-Z, en su nombre", tipo: "dni", valor: "12.345.678-Z", confianza: "alta" },
    { texto: "D.N.I. núm. 12.345.678 Z vigente", tipo: "dni", valor: "12.345.678 Z", confianza: "alta" },
    { texto: "con D.N.I. 12.345.678-\nZ y domicilio", tipo: "dni", valor: "12.345.678-\nZ", confianza: "alta" },
    { texto: "Total pedido 12345678\nA partir de mañana", tipo: "dni", valor: "ninguno" },
    { texto: "con NIE X1234567\nL y domicilio", tipo: "nie", valor: "X1234567\nL", confianza: "alta" },
    { texto: "con NIE X-1234567-\nL y domicilio", tipo: "nie", valor: "X-1234567-\nL", confianza: "alta" },
    { texto: "con NIE X\n1234567L y domicilio", tipo: "nie", valor: "X\n1234567L", confianza: "alta" },
    { texto: "Modelo X1234567\nB de la serie", tipo: "nie", valor: "ninguno" },
    { texto: "con CIF B1234567\n4 y domicilio social", tipo: "cif", valor: "B1234567\n4" },
    { texto: "con NIF B-\n12345674 y domicilio social", tipo: "cif", valor: "B-\n12345674" },
    { texto: "cuenta ES91 2100 0418\n4502 0005 1332 del titular", tipo: "iban", valor: "ES91 2100 0418\n4502 0005 1332", confianza: "alta" },
    { texto: "IBAN ES91\n2100 0418 4502 0005 1332 del titular", tipo: "iban", valor: "ES91\n2100 0418 4502 0005 1332", confianza: "alta" },
    { texto: "IBAN ES9121000418\n450200051332 del titular", tipo: "iban", valor: "ES9121000418\n450200051332", confianza: "alta" },
    { texto: "IBAN ES91 2100 0418 45 0200051332 del titular", tipo: "iban", valor: "ES91 2100 0418 45 0200051332", confianza: "alta" },
    { texto: "cuenta ES91 2100 0418\n4502 0005 1333 con un dígito cambiado", tipo: "iban", valor: "ninguno" },
    { texto: "cuenta 2100 0418\n45 0200051332 del cliente", tipo: "cuenta", valor: "2100 0418\n45 0200051332" },
    { texto: "tarjeta 4111 1111\n1111 1111 de prueba", tipo: "tarjeta", valor: "4111 1111\n1111 1111", confianza: "alta" },
    { texto: "teléfono de contacto 612 345\n678 para avisos", tipo: "telefono", valor: "612 345\n678", confianza: "alta" },
    { texto: "móvil +34\n612 345 678 para avisos", tipo: "telefono", valor: "+34\n612 345 678", confianza: "alta" },
    { texto: "Tel. 91 234 56 78 de la oficina", tipo: "telefono", valor: "91 234 56 78", confianza: "alta" },
    { texto: "Tel. 91 234\n56 78 de la oficina", tipo: "telefono", valor: "91 234\n56 78", confianza: "alta" },
    { texto: "Unidades vendidas: 700 800 900 600 500 400 en total", tipo: "telefono", valor: "ninguno" },
    { texto: "Seguridad Social 28/12345678\n/40 del trabajador", tipo: "nss", valor: "28/12345678\n/40" },
    { texto: "vehículo con matrícula 1234\nBCD aparcado", tipo: "matricula", valor: "1234\nBCD" },
    { texto: "Feria de 2024\nBCN acoge a miles de visitantes", tipo: "matricula", valor: "ninguno" },
    { texto: "nacido el 15 de marzo\nde 1985 en Madrid", tipo: "fecha_nac", valor: "15 de marzo\nde 1985" },
    { texto: "De una parte, D. Juan Pérez\nGarcía, mayor de edad", tipo: "nombre", valor: "Juan Pérez\nGarcía" },
    { texto: "De otra parte, Dña. María\nLópez Sánchez, mayor de edad", tipo: "nombre", valor: "María\nLópez Sánchez" },
    { texto: "De una parte, D. José de la\nFuente Martín, mayor de edad", tipo: "nombre", valor: "José de la\nFuente Martín" },
    { texto: "Firmado: D. Juan Pérez García\nCláusula primera. Objeto del contrato", tipo: "nombre", valor: "Juan Pérez García" },
    { texto: "Arrendador: D. Juan Pérez\nMADRID, a 3 de octubre de 2026", tipo: "nombre", valor: "Juan Pérez" },
    { texto: "Laura Gómez Ferrer\nRonda de Atocha 30, 5º izda.\n28012 Madrid\nCONTRATO", tipo: "nombre", valor: "Laura Gómez Ferrer" },
    // Errores típicos al leer un escaneo (con { ocr: true }, como hace el tachador)
    { texto: "mayor de edad, con DNI 123456787 y domicilio en", tipo: "dni", valor: "123456787", confianza: "alta", opciones: { ocr: true } },
    { texto: "mayor de edad, con DNI 123456787 y domicilio en", tipo: "dni", valor: "ninguno" },
    { texto: "referencia 123456787 del pedido", tipo: "dni", valor: "ninguno", opciones: { ocr: true } },
    { texto: "con DNI 123456781 que no cuadra", tipo: "dni", valor: "ninguno", opciones: { ocr: true } },
    { texto: "y correo electrónico maria.lopezQexample.com, en adelante", tipo: "email", valor: "maria.lopezQexample.com", opciones: { ocr: true } },
    { texto: "la web www.quijoteQeditorial.com anuncia", tipo: "email", valor: "ninguno", opciones: { ocr: true } },
    // Hito de actualización 8: el DNI, el NIE o la cuenta justo debajo del nombre, en escaneos y fotos
    { texto: "Juan Pérez García\n123456787\nES91 2100 0418 4502 0005 1332", tipo: "dni", valor: "123456787", confianza: "media", opciones: { ocr: true } },
    { texto: "Juan Pérez García\nI2345678Z", tipo: "dni", valor: "I2345678Z", opciones: { ocr: true } },
    { texto: "Juan Pérez García\n1234S678Z", tipo: "dni", valor: "1234S678Z", opciones: { ocr: true } },
    { texto: "Factura n.º\n123456780\nTotal 450,00 €", tipo: "dni", valor: "ninguno", opciones: { ocr: true } },
    { texto: "María López Sánchez\nNIE Y23456787", tipo: "nie", valor: "Y23456787", confianza: "alta", opciones: { ocr: true } },
    { texto: "María López Sánchez\nY234S678Z", tipo: "nie", valor: "Y234S678Z", opciones: { ocr: true } },
    { texto: "María López Sánchez\nY23456781", tipo: "nie", valor: "ninguno", opciones: { ocr: true } },
    { texto: "Juan Pérez García\nES91 21OO 0418 4502 0005 1332", tipo: "iban", valor: "ES91 21OO 0418 4502 0005 1332", opciones: { ocr: true } },
    { texto: "Juan Pérez García\nE591 2100 0418 4502 0005 1332", tipo: "iban", valor: "E591 2100 0418 4502 0005 1332", opciones: { ocr: true } },
    { texto: "Juan Pérez García\nES91 21OO 0418 4502 0005 1333", tipo: "iban", valor: "ninguno", opciones: { ocr: true } },
    { texto: "Juan Pérez García\n2100 0418 45 O2OOO51332", tipo: "cuenta", valor: "2100 0418 45 O2OOO51332", opciones: { ocr: true } },
    // Dos líneas de un PDF leídas juntas: el dato pegado al apellido
    { texto: "Juan Pérez García12345678Z", tipo: "dni", valor: "12345678Z" },
    { texto: "María López SánchezX1234567L", tipo: "nie", valor: "X1234567L" },
    { texto: "Juan Pérez GarcíaES91 2100 0418 4502 0005 1332", tipo: "iban", valor: "ES91 2100 0418 4502 0005 1332" },
    // Nombres: no se alargan sobre un rótulo de la línea siguiente; apellidos primero
    { texto: "Juan Pérez García\nIBAN ES91 2100 0418 4502 0005 1332", tipo: "nombre", valor: "Juan Pérez García" },
    { texto: "JUAN PÉREZ GARCÍA IBAN ES91 2100 0418 4502 0005 1332", tipo: "nombre", valor: "JUAN PÉREZ GARCÍA" },
    { texto: "PÉREZ GARCÍA, JUAN\n12345678Z", tipo: "nombre", valor: "PÉREZ GARCÍA, JUAN", confianza: "alta" },
    { texto: "Trabajador: Pérez García, Juan Carlos", tipo: "nombre", valor: "Pérez García, Juan Carlos" },
    { texto: "Iban López García firma el contrato", tipo: "nombre", valor: "Iban López García" },
    { texto: "con domicilio en Calle del Ejemplo 12, 3. B, 28013 Madrid, en adelante", tipo: "direccion", valor: "Calle del Ejemplo 12, 3. B, 28013 Madrid" },
    { texto: "EL ARRENDADOR: Fdo.: Juan Pérez García LA ARRENDATARIA: Fdo.: María López", tipo: "nombre", valor: "Juan Pérez García" },
    { texto: "De una parte, Dña. María del Carmen Ruiz Ortega, mayor de edad", tipo: "nombre", valor: "María del Carmen Ruiz Ortega" },
    { texto: "Laura Gómez Ferrer\nRonda de Atocha 30, 5º izda.\n28012 Madrid\nCONTRATO", tipo: "direccion", valor: "Ronda de Atocha 30, 5º izda.\n28012 Madrid" },
    { texto: "la mercantil ZAFIRO DIGITAL SOLUTIONS,\nS.L., con domicilio", tipo: "empresa", valor: "ZAFIRO DIGITAL SOLUTIONS,\nS.L.", contiene: true },
    { texto: "correo electrónico juan.perez@example.com para avisos", tipo: "email", valor: "juan.perez@example.com" },

    // ------------------- cantidades de dinero en letra y partidas (hito de actualización 4)
    { texto: "una renta de 650\neuros mensuales", tipo: "importe", valor: "650\neuros", confianza: "alta" },
    { texto: "y de 1.250,50\n€ por daños", tipo: "importe", valor: "1.250,50\n€", confianza: "alta" },
    { texto: "una penalización de €\n1.250 por impago", tipo: "importe", valor: "€\n1.250", confianza: "alta" },
    { texto: "la renta será de SEISCIENTOS CINCUENTA EUROS (650,00\n€), que se paga", tipo: "importe", valor: "SEISCIENTOS CINCUENTA EUROS (650,00\n€)" },
    { texto: "la renta será de seiscientos cincuenta\neuros mensuales", tipo: "importe", valor: "seiscientos cincuenta\neuros" },
    { texto: "la renta será de SEISCIENTOS\nCINCUENTA EUROS al mes", tipo: "importe", valor: "SEISCIENTOS\nCINCUENTA EUROS" },
    { texto: "la cantidad de novecientos cincuenta (950) euros", tipo: "importe", valor: "novecientos cincuenta (950) euros" },
    { texto: "la cantidad de MIL CUATROCIENTOS (1.400) EUROS", tipo: "importe", valor: "MIL CUATROCIENTOS (1.400) EUROS" },
    { texto: "la cantidad de seiscientos cincuenta (650 €) mensuales", tipo: "importe", valor: "seiscientos cincuenta (650 €)" },
    { texto: "abonará seiscientos cincuenta (650 euros) al mes", tipo: "importe", valor: "seiscientos cincuenta (650 euros)" },
    { texto: "un importe de trescientos cincuenta y dos euros con ochenta y cinco céntimos (352,85 €)", tipo: "importe",
      valor: "trescientos cincuenta y dos euros con ochenta y cinco céntimos (352,85 €)" },
    { texto: "una multa de doscientos veintiún euros", tipo: "importe", valor: "doscientos veintiún euros" },
    { texto: "una fianza de dieciséis mil euros", tipo: "importe", valor: "dieciséis mil euros" },
    { texto: "una fianza de dieciséis mil euros (descompuesta)".normalize("NFD"), tipo: "importe", valor: "dieciséis mil euros".normalize("NFD") },
    { texto: "un precio de un millón doscientos mil euros", tipo: "importe", valor: "un millón doscientos mil euros" },
    { texto: "novecientos noventa y nueve euros con noventa y nueve céntimos", tipo: "importe", valor: "novecientos noventa y nueve euros con noventa y nueve céntimos" },
    { texto: "la suma de mil doscientos euros (1.200,00€) al año", tipo: "importe", valor: "mil doscientos euros (1.200,00€)" },
    { texto: "cuatrocientos cincuenta euros/mes", tipo: "importe", valor: "cuatrocientos cincuenta euros" },
    { texto: "una renta de cincuen-\nta euros al día", tipo: "importe", valor: "cincuen-\nta euros" },
    { texto: "una renta de doscientos cincuen-\nta euros al día", tipo: "importe", valor: "doscientos cincuen-\nta euros" },
    { texto: "Cien euros de señal", tipo: "importe", valor: "Cien euros" },
    { texto: "la renta anual será de ONCE MIL CUATROCIENTOS EUROS (11.400 €)", tipo: "importe", valor: "ONCE MIL CUATROCIENTOS EUROS (11.400 €)" },
    { texto: "dos millones de euros de capital", tipo: "importe", valor: "dos millones de euros" },
    { texto: "con un preaviso de treinta días y tres meses de fianza", tipo: "importe", valor: "ninguno" },
    { texto: "firmado por dos testigos el día cinco", tipo: "importe", valor: "ninguno" },

    // -------------------------- hito de actualización 17 (revisión de la extensión)
    // «Madrid.» no es «D.» (don): «Un» no es un nombre.
    { texto: "Enviaremos la documentación a Madrid.\nUn saludo cordial.", tipo: "nombre", valor: "ninguno" },
    { texto: "Vive en Madrid.\nUn saludo, Marta Iglesias Pardo.", tipo: "nombre", valor: "Marta Iglesias Pardo" },
    { texto: "Firmado: D. Juan Pérez García", tipo: "nombre", valor: "Juan Pérez García", confianza: "alta" },
    // La misma persona en otro sitio, sin «Sr.» delante, con sus apellidos.
    { texto: "Estimado Sr. Andrés Castillo: le escribimos.\nTitular\nAndrés Castillo Vega\nTeléfono", tipo: "nombre", valor: "Andrés Castillo Vega" },
    { texto: "Estimado Sr. Andrés Castillo: le escribimos.\nTitular\nANDRÉS CASTILLO VEGA", tipo: "nombre", valor: "ANDRÉS CASTILLO VEGA" },
    { texto: "Visite el Castillo de Olite con Andrés.", tipo: "nombre", valor: "ninguno" },
    // IBAN al final de una frase y de la línea: el punto no es del IBAN.
    { texto: "que se pagarán en la cuenta ES91 2100 0418 4502 0005 1332.\nCUARTA. Duración.", tipo: "iban", valor: "ES91 2100 0418 4502 0005 1332", confianza: "alta" },
    { texto: "en la cuenta ES91 2100 0418 4502 0005 1332.", tipo: "iban", valor: "ES91 2100 0418 4502 0005 1332" },
    // Seguridad Social: rótulo y control bien, confianza alta.
    { texto: "N.º afiliación S.S.: 28/10293847/50", tipo: "nss", valor: "28/10293847/50", confianza: "alta" },
    // Escaneos: la @ leída como otra letra, justo después del rótulo.
    { texto: "Email: andres.castilloGexample.com", tipo: "email", valor: "andres.castilloGexample.com", opciones: { ocr: true } },
    { texto: "Email: andres.castilloeexample.com\nIBAN", tipo: "email", valor: "andres.castilloeexample.com", opciones: { ocr: true } },
    { texto: "Correo electrónico: juaneexample.com", tipo: "email", valor: "juaneexample.com", opciones: { ocr: true } },
    { texto: "Visite andres.castilloGexample.com hoy", tipo: "email", valor: "ninguno", opciones: { ocr: true } },
    { texto: "Email: andres.castilloGexample.com", tipo: "email", valor: "ninguno" },
    // Direcciones: el º leído como cifra y la ciudad en la línea siguiente.
    { texto: "Enviaremos la documentación a Calle Río Duero 17, 4.9 C, 28029 Madrid.", tipo: "direccion", valor: "Calle Río Duero 17, 4.9 C, 28029 Madrid" },
    { texto: "Enviaremos la documentación a Calle Río Duero 17, 4.2 C, 28029 Madrid.", tipo: "direccion", valor: "Calle Río Duero 17, 4.2 C, 28029 Madrid" },
    { texto: "con domicilio en Calle Falsa 123, 28080\nMadrid. De otra parte, la empresa.", tipo: "direccion", valor: "Calle Falsa 123, 28080\nMadrid" },
    { texto: "con domicilio en Calle Falsa 123, 28080\nSEGUNDA. El precio.", tipo: "direccion", valor: "Calle Falsa 123, 28080" },

    // -------------------------- hito de actualización 19 (prueba final de la extensión)
    // El º leído como otro signo en un escaneo: el piso y la puerta también se tapan.
    { texto: "con DNI 123456787 y domicilio en\nCalle del Ejemplo 12, 3.? B, 28013 Madrid, en adelante, el ARRENDADOR.", tipo: "direccion", valor: "Calle del Ejemplo 12, 3.? B, 28013 Madrid", opciones: { ocr: true } },
    { texto: "domicilio en Calle del Ejemplo 12, 3.* B, 28013 Madrid.", tipo: "direccion", valor: "Calle del Ejemplo 12, 3.* B, 28013 Madrid" },
    { texto: "domicilio en Calle del Ejemplo 12, 3.” B, 28013 Madrid.", tipo: "direccion", valor: "Calle del Ejemplo 12, 3.” B, 28013 Madrid" },
    { texto: "domicilio en Calle del Ejemplo 12, 3.? izquierda, 28013 Madrid.", tipo: "direccion", valor: "Calle del Ejemplo 12, 3.? izquierda, 28013 Madrid" },
    { texto: "domicilio en Calle del Ejemplo 12, 3.?, 28013 Madrid.", tipo: "direccion", valor: "Calle del Ejemplo 12, 3.?, 28013 Madrid" },
    { texto: "Calle Mayor 12, 3? B, 28013 Madrid", tipo: "direccion", valor: "Calle Mayor 12, 3? B, 28013 Madrid" },
    // La dirección en varias líneas, con la puerta en la línea siguiente.
    { texto: "domicilio en Calle del Ejemplo 12, 3.º\nB, 28013 Madrid, en adelante.", tipo: "direccion", valor: "Calle del Ejemplo 12, 3.º\nB, 28013 Madrid" },
    { texto: "domicilio en Calle del Ejemplo 12, 3.?\nB, 28013 Madrid, en adelante.", tipo: "direccion", valor: "Calle del Ejemplo 12, 3.?\nB, 28013 Madrid" },
    { texto: "domicilio en Calle del Ejemplo 12,\n3.? B, 28013 Madrid, en adelante.", tipo: "direccion", valor: "Calle del Ejemplo 12,\n3.? B, 28013 Madrid" },
    { texto: "vivienda situada en Avenida de la Prueba 45,\n2.? A, 28080 Madrid, que se encuentra", tipo: "direccion", valor: "Avenida de la Prueba 45,\n2.? A, 28080 Madrid" },
    // Lo que no es la puerta se queda fuera.
    { texto: "Calle del Ejemplo 12, 3.º\nA la firma del contrato, la ARRENDATARIA entrega", tipo: "direccion", valor: "Calle del Ejemplo 12, 3.º" },
    { texto: "¿Vive usted en la calle Mayor 12? A mí me pilla lejos.", tipo: "direccion", valor: "calle Mayor 12" },
    { texto: "¿Vive usted en la calle Mayor 12? Bien, entonces firme aquí.", tipo: "direccion", valor: "calle Mayor 12" },
    // El correo de un escaneo con un espacio junto a un punto: la parte de delante también.
    { texto: "teléfono 612\n345 678 y correo electrónico maria .lopezQexample.com, en adelante, la ARRENDATARIA.", tipo: "email", valor: "maria .lopezQexample.com", opciones: { ocr: true } },
    { texto: "y correo electrónico maria. lopez@example.com, en adelante", tipo: "email", valor: "maria. lopez@example.com", opciones: { ocr: true } },
    { texto: "correo de la oficina de Madrid. juanQexample.com", tipo: "email", valor: "juanQexample.com", opciones: { ocr: true } },
    // Palabras propias en un escaneo: «3.º B» encuentra «3.? B».
    { texto: "Calle del Ejemplo 12, 3.? B, 28013 Madrid", tipo: "personalizado", valor: "3.? B", opciones: { tipos: [], personalizados: ["3.º B"], ocr: true } },
    { texto: "Calle del Ejemplo 12, 3.? B, 28013 Madrid", tipo: "personalizado", valor: "ninguno", opciones: { tipos: [], personalizados: ["3.º B"] } },

    // ------------------------------------------------- textos completos
    {
      texto: "Juan Pérez García (DNI 12345678Z), teléfono 612 345 678, correo juan.perez@example.com, " +
        "cuenta ES91 2100 0418 4502 0005 1332, vive en Calle del Ejemplo 12, 28013 Madrid.",
      tipo: "varios",
      esperados: ["nombre", "dni", "telefono", "email", "iban", "direccion"],
    },
    {
      texto: "NÓMINA. Trabajador: MARÍA LÓPEZ SÁNCHEZ. NIE X1234567L. " +
        "N.º afiliación Seguridad Social 28/12345678/40. Fecha de nacimiento: 02/07/1992.",
      tipo: "varios",
      esperados: ["nombre", "nie", "nss", "fecha_nac"],
    },
    {
      texto: "TEXTO EN MAYÚSCULAS: DNI 12345678Z, TELÉFONO 612 345 678, EMAIL JUAN@EXAMPLE.COM",
      tipo: "varios",
      esperados: ["dni", "telefono", "email"],
    },
    {
      texto: "El contrato de alquiler de la vivienda incluye la plaza de garaje y el trastero.",
      tipo: "varios",
      esperados: [],
    },
  ];

  global.CASOS_DETECTORES = CASOS;
  if (typeof module !== "undefined" && module.exports) module.exports = CASOS;
})(typeof globalThis !== "undefined" ? globalThis : this);
