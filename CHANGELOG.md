# Registro de cambios

## 1.0.0 — 28/09/2026

Primera versión pública.

- **Buscar documentos** por nombre, tipo o fecha en las carpetas autorizadas, sin abrirlos.
- **Contar los datos personales** de PDF y fotos sin modificarlos. Solo se enseñan si se pide, y tapados en parte: el DNI como recomienda la AEPD (***4567**).
- **Tachar** PDF (también escaneados y formularios rellenables) y fotos o capturas, uno a uno o carpetas enteras:
  - con perfiles como en la web (nómina, contrato, captura);
  - con una hoja de revisión que marca primero lo dudoso;
  - sin volver a tachar lo que ya tiene copia, salvo que se pidan otras opciones;
  - la misma persona se tacha también donde aparece sin «Sr.» delante, con sus apellidos;
  - en escaneos y fotos, también el correo con la «@» mal leída y la dirección completa, con el piso y la puerta aunque el «º» se lea mal o la puerta pase a la línea siguiente;
  - aviso de «tachado falso»: si un PDF lleva datos que no se ven (debajo de un recuadro negro, del color del fondo o en letra diminuta) pero se pueden copiar, lo dice. En la copia ya no están.
- **Quitar la ubicación** y los datos ocultos de las fotos, también las HEIC del iPhone, sin recomprimirlas cuando se puede.
- **Anonimizar** textos y Word conservando su formato, uno o un expediente entero con una sola tabla, y **devolver los datos reales** a la respuesta de una IA.
- **Copia protegida del DNI**, NIE, carnet de conducir o pasaporte:
  - recortada a su tamaño real y puesta derecha;
  - con marca de agua de la finalidad;
  - las dos caras aunque vengan en la misma foto;
  - una copia por trámite.
- **Comparar dos versiones de un contrato**:
  - los cambios importantes primero: importes (también sin «€»), fechas y plazos, cambios de cuenta bancaria, cláusulas nuevas y palabras delicadas;
  - los datos personales tapados en lo que se enseña en la conversación;
  - las cláusulas movidas de sitio y los posibles errores de lectura de un escaneo, aparte;
  - un informe con todos los cambios y la versión nueva en Word con control de cambios.
- **Cuatro plantillas de peticiones:** tachar una carpeta, preparar el DNI, anonimizar para una IA y ver qué ha cambiado en un contrato.
- **Código abierto**, con licencia Apache 2.0 (`LICENSE` y `NOTICE`).
- **Privacidad:** no se conecta a internet, solo usa las carpetas elegidas y nunca modifica los originales. Las respuestas no llevan la ruta completa del ordenador (que suele llevar tu nombre de usuario), solo la ruta desde la carpeta que elegiste.

Las versiones 0.1 a 0.6 fueron versiones de prueba, sin publicar.
