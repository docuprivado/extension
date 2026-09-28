# docuprivado para Claude Desktop

Extensión gratuita de [docuprivado.es](https://docuprivado.es/) para Claude Desktop: tacha datos personales, anonimiza archivos, protege la copia del DNI y compara contratos **sin que tus documentos salgan de tu ordenador**.

Versión 1.0.0 · [docuprivado.es/claude](https://docuprivado.es/claude/)

## Para qué sirve

Para ahorrarte tiempo. Lo que en la web haces documento a documento (abrir la página, subir el archivo, revisar, descargar), aquí lo pides con una frase y con carpetas enteras:

> «Tacha los datos personales de todas las nóminas de la carpeta Alquiler.»

La extensión trabaja en tu ordenador, con los mismos motores que las herramientas de docuprivado.es, y Claude te cuenta el resultado.

## Requisitos

- **Claude Desktop** para Windows o macOS, con la sesión de Claude iniciada. Probada en Windows 11 con Claude Desktop 2.9939.2. En macOS debería funcionar igual (no usa nada propio de Windows), pero todavía no se ha probado en un Mac.
- La documentación de Anthropic no limita las extensiones a ningún plan de Claude. En las cuentas de empresa (Team o Enterprise), el administrador puede desactivarlas.
- No hace falta instalar nada más: Claude Desktop ya trae lo necesario para que funcione. Ocupa unos 17 MB al descargarla y unos 40 MB instalada.

## Instalación en 3 pasos

1. **Descarga** `docuprivado-1.0.0.mcpb` desde [docuprivado.es/claude](https://docuprivado.es/claude/). Si quieres comprobar que el archivo es el original, compara su huella SHA-256 con la de la página:
   - en Windows, en una ventana de PowerShell: `Get-FileHash docuprivado-1.0.0.mcpb`
   - en macOS, en el Terminal: `shasum -a 256 docuprivado-1.0.0.mcpb`
2. **Instálala:** en Claude Desktop, ve a **Ajustes → Extensiones** y arrastra el archivo a esa página (o haz doble clic en él). Revisa lo que enseña y pulsa **Instalar**. Claude Desktop enseña un aviso en rojo: que la instalación da a la extensión acceso a todo tu ordenador y que Anthropic no ha verificado la información del desarrollador. Es el aviso general de las extensiones que se instalan desde un archivo. Esta, en concreto, solo usa las carpetas que elijas en el paso 3 (su propio código rechaza todo lo demás) y no se conecta a internet.
3. **Elige las carpetas** que puede usar (por ejemplo, Documentos o Descargas) y, si quieres, una carpeta para los resultados. La extensión no puede tocar nada fuera de ellas. Para cambiarlas después: **Ajustes → Extensiones → docuprivado**.

Listo: abre un chat nuevo y pídeselo a Claude con tus palabras. Para empezar, «¿Qué puedes hacer con docuprivado?».

## Qué puedes pedirle

| Qué hace | Ejemplo de frase |
|---|---|
| **Buscar tus documentos** por nombre, tipo o fecha, sin abrirlos | «Busca las nóminas que tengo en Documentos.» |
| **Contar los datos personales** de un PDF o una foto, sin modificarlo (solo te los enseña, tapados en parte, si lo pides) | «¿Qué datos personales hay en nomina-septiembre.pdf?» |
| **Tachar los datos personales** de PDF (también escaneados y formularios) y de fotos o capturas, uno o carpetas enteras, con una hoja para revisarlos; y te avisa si un PDF lleva datos escondidos que no se ven pero se pueden copiar (un «tachado falso») | «Tacha los PDF de Contratos, pero deja visible el nombre de mi empresa.» |
| **Quitar la ubicación** y los demás datos ocultos de tus fotos (también las HEIC del iPhone) | «Quita la ubicación de todas las fotos de la carpeta Viaje.» |
| **Anonimizar** archivos de texto y Word (conservando su formato) para pasárselos a una IA, con una tabla para devolverles después los datos reales | «Anonimiza correo-cliente.docx para pasárselo a ChatGPT.» |
| **Devolver los datos reales** a la respuesta de la IA con esa tabla | «Devuelve los datos reales a respuesta-ia.txt con la tabla de antes.» |
| **Preparar la copia del DNI**, NIE, carnet de conducir o pasaporte: recortada a su tamaño real, derecha y con una marca de agua que dice para qué es | «Prepara mi DNI para alquilar un piso: las fotos son dni-frente.jpg y dni-detras.jpg.» |
| **Comparar dos versiones** de un contrato (Word, PDF o texto) y decirte qué ha cambiado, con un informe y la versión nueva en Word con control de cambios | «¿Qué ha cambiado entre contrato-v1.docx y contrato-v2.docx?» |

**Plantillas de peticiones.** La extensión trae cuatro peticiones preparadas para empezar sin escribir: «Tachar todos los documentos de una carpeta», «Preparar mi DNI para entregarlo», «Anonimizar un documento antes de pasárselo a una IA» y «Ver qué ha cambiado en un contrato». Cada una te pide solo lo imprescindible (la carpeta, para qué es la copia o los archivos).

La extensión **siempre crea copias nuevas** (por ejemplo, `nomina-tachado.pdf`) en una subcarpeta `docuprivado` junto al original, o en la carpeta de resultados que elijas. Nunca modifica ni borra tus archivos, y si ya existe una copia con ese nombre, añade « (2)».

## Límites

- **Revisa siempre el resultado.** La detección automática de datos personales no acierta el 100 %: por eso cada tachado va con una hoja de revisión, con lo dudoso marcado para revisarlo primero.
- **Tamaño:** hasta 100 MB por archivo.
- **Formatos:** tacha PDF e imágenes (JPG, PNG, WebP y HEIC); anonimiza Word (.docx) y texto (.txt, .md, .csv); no abre el Word antiguo (.doc). Los PDF con contraseña no se tachan: ábrelos en [docuprivado.es](https://docuprivado.es/tachar-documento/).
- **Escaneos y fotos:** se leen con un lector de texto en español que va dentro de la extensión. Un escaneo borroso o torcido se lee peor, y en una comparación algunos cambios pueden ser letras mal leídas (la extensión los separa y lo avisa).
- **Trabajos largos:** Claude Desktop espera como mucho un minuto a cada respuesta. Con carpetas grandes o escaneos largos, la extensión sigue trabajando y Claude te pedirá que le digas «continúa» para darte el resultado.
- **Tachado:** en el PDF tachado, cada página es una imagen: no se puede copiar ni buscar su texto (es lo que garantiza que no queda nada debajo).
- **Anonimizar un Word:** las imágenes y los objetos incrustados no se revisan, y se avisa si los hay.
- **Comparar:** es orientativo y no sustituye el asesoramiento de un profesional. El Word con control de cambios lleva el texto y los párrafos, no el formato del original; se abre con Word o LibreOffice.

## Política de privacidad

*Última actualización: 28 de septiembre de 2026.*

Esta política explica qué hace con tus datos la extensión de docuprivado para Claude Desktop.

- **No recoge, no envía y no almacena datos.** La extensión no se conecta a internet: no tiene servidor, ni cuentas, ni estadísticas de uso, ni publicidad. Todo lo que necesita (los lectores de PDF, de escaneos y de fotos, y las listas para reconocer nombres) va dentro del archivo que instalas.
- **Funciona sin conexión.** La extensión no necesita internet para hacer su trabajo; la conversación con Claude, en cambio, sí va por internet.
- **Solo accede a las carpetas que eliges** al instalarla. Cualquier ruta fuera de ellas se rechaza, también si la pide una instrucción escondida en un documento.
- **Nunca modifica ni borra tus archivos:** crea copias nuevas.
- **No guarda registros con contenido.** Claude Desktop guarda en tu ordenador un registro técnico de cada extensión. La extensión solo escribe en él cifras (su versión, tiempos, cuántos archivos ha procesado), nunca nombres de archivos, carpetas ni nada de lo que dicen tus documentos. Las tablas del anonimizador se guardan donde tú indicas y solo en tu ordenador.
- **Qué llega a la conversación.** Por defecto, Claude solo recibe resúmenes («14 datos ocultos en 6 páginas: 2 DNI, 7 nombres…») y los nombres de los archivos que usa o crea, con su ruta desde la carpeta que elegiste («Documentos\Alquiler\nomina-tachado.pdf»), no el contenido de tus documentos. La ruta completa del ordenador, que suele llevar tu nombre de usuario, no se envía. Solo si lo pides expresamente recibe más: los datos encontrados, tapados en parte (un DNI como `***4567**`); el texto de un archivo ya anonimizado; o, al comparar dos documentos, los cambios importantes con su antes y después, con los datos personales tapados.
- **Lo que escribes en el chat, o lo que le pides a la extensión que te enseñe, sí pasa por Claude** y se rige por la [política de privacidad de Anthropic](https://www.anthropic.com/legal/privacy), no por esta.
- **Responsable:** el titular de docuprivado.es (sus datos están en el [aviso legal](https://docuprivado.es/aviso-legal/)). Para cualquier duda sobre esta política: [contacto@docuprivado.es](mailto:contacto@docuprivado.es).

## Soporte y versiones nuevas

- Dudas y problemas: [contacto@docuprivado.es](mailto:contacto@docuprivado.es) o [docuprivado.es/contacto](https://docuprivado.es/contacto/). Nunca te pediremos tus documentos.
- Como no se conecta a internet, la extensión no puede avisarte de que hay una versión nueva. La última estará siempre en [docuprivado.es/claude](https://docuprivado.es/claude/); para actualizarla, instala el archivo nuevo igual que el primero. «¿Qué puedes hacer con docuprivado?» te dice qué versión tienes.

## Créditos y licencias

**La extensión es código abierto, con licencia [Apache 2.0](LICENSE).** Quien la copie o la modifique tiene que conservar el aviso de [NOTICE](NOTICE), con el enlace a docuprivado.es, y no puede usar el nombre «docuprivado».

La extensión usa estos componentes de código abierto. Sus licencias van dentro del paquete, junto a cada uno.

| Componente | Para qué | Licencia |
|---|---|---|
| [SDK de MCP para TypeScript](https://github.com/modelcontextprotocol/typescript-sdk) 2.1.0 y [Zod](https://zod.dev/) 4.6.5 | Comunicarse con Claude Desktop | MIT |
| [PDFium](https://pdfium.googlesource.com/pdfium/) (vía [@embedpdf/pdfium](https://github.com/embedpdf/embed-pdf-viewer) 2.15.1) | Dibujar y comprobar las páginas de los PDF | BSD-3-Clause y Apache-2.0 (envoltorio MIT) |
| [PDF.js](https://mozilla.github.io/pdf.js/) 6.1.200 | Leer el texto de los PDF | Apache-2.0 |
| [pdf-lib](https://pdf-lib.js.org/) 1.17.1 | Crear los PDF tachados y la copia del DNI | MIT |
| [Tesseract.js](https://github.com/naptha/tesseract.js) 7.0.0 y sus datos de español | Leer escaneos y fotos | Apache-2.0 |
| [OpenCV.js](https://opencv.org/) 4.7.0 | Encontrar y enderezar el DNI en la foto | Apache-2.0 |
| [diff-match-patch](https://github.com/google/diff-match-patch) | Comparar documentos palabra a palabra | Apache-2.0 |
| [jpeg-js](https://github.com/jpeg-js/jpeg-js) 0.4.4 y [pngjs](https://github.com/pngjs/pngjs) 7.0.0 | Leer y guardar imágenes | BSD-3-Clause y MIT |
| [libheif](https://github.com/strukturag/libheif) y libde265, vía [libheif-js](https://github.com/catdad-experiments/libheif-js) 1.23.2 | Abrir las fotos HEIC del iPhone | **LGPL-3.0**: va en un archivo aparte y sin modificar, con su licencia; su código está en esos enlaces |

**Datos.** Para reconocer nombres y apellidos se usan las listas de frecuencia del Instituto Nacional de Estadística (elaboración propia con datos extraídos del sitio web del INE: [www.ine.es](https://www.ine.es/)). Para reconocer nombres de empresas, una lista elaborada a partir de los índices de sociedades del BORME (basado en datos de la Agencia Estatal Boletín Oficial del Estado: [www.boe.es](https://www.boe.es/)). Son listas para decidir si una palabra parece un nombre, no datos de personas concretas.

docuprivado no está afiliado a Anthropic ni cuenta con su respaldo. Claude es una marca de Anthropic.

---

## In English (summary)

**docuprivado for Claude Desktop** is a free, local extension from [docuprivado.es](https://docuprivado.es/) (a Spanish privacy toolkit). It lets you ask Claude, in one sentence and for whole folders, to redact personal data from PDFs and images, strip location and hidden metadata from photos, pseudonymise Word and text files before sharing them with an AI (and restore them afterwards), prepare a watermarked copy of a Spanish ID card or passport, and compare two versions of a contract. It is designed for Spanish documents.

**Privacy:** everything runs on your computer. The extension makes no network connections, only accesses the folders you choose, never modifies or deletes your files (it always writes new copies), and keeps no logs with content. By default Claude only receives summaries and file names, not document content. What you type in the chat is handled by Claude under [Anthropic's privacy policy](https://www.anthropic.com/legal/privacy). Contact: [contacto@docuprivado.es](mailto:contacto@docuprivado.es).

**License:** [Apache 2.0](LICENSE); keep the [NOTICE](NOTICE) file. The license grants no permission to use the name "docuprivado".
