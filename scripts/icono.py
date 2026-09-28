# Icono de la extensión (512×512, PNG con transparencia): el candado de docuprivado
# (assets/icons/favicon.svg de la web) en blanco sobre un cuadrado redondeado del color
# de la marca, para que se vea igual en tema claro y oscuro. No usa nada de la marca Claude.
# Uso: python scripts/icono.py  →  icon.png
from PIL import Image, ImageDraw

F = 4                      # se dibuja a 4 veces el tamaño y se reduce (bordes suaves)
T = 512 * F
MARCA = (15, 92, 110, 255)          # #0F5C6E, el color de la web
BLANCO = (255, 255, 255, 255)

img = Image.new("RGBA", (T, T), (0, 0, 0, 0))
d = ImageDraw.Draw(img)
d.rounded_rectangle([0, 0, T - 1, T - 1], radius=112 * F, fill=MARCA)

# Candado del favicon (caja de 32×32), escalado y centrado.
esc = T * 0.60 / 27.1
cx, cy = 16, 15.95
def p(x, y):
    return (T / 2 + (x - cx) * esc, T / 2 + (y - cy) * esc)
def r(v):
    return v * esc

grosor = r(3.2)
# Arco del candado: centro (16,10), radio 6, de 180° a 360°, y sus dos patas hasta y=14.5
# (PIL dibuja el grosor hacia dentro de la caja: se amplía medio grosor para centrarlo en el radio 6)
g = 3.2 / 2
x0, y0 = p(10 - g, 4 - g); x1, y1 = p(22 + g, 16 + g)
d.arc([x0, y0, x1, y1], start=180, end=360, fill=BLANCO, width=round(grosor))
for x in (10, 22):
    a = p(x, 10); b = p(x, 14.5)
    d.line([a, b], fill=BLANCO, width=round(grosor))
    for q in (b,):
        d.ellipse([q[0] - grosor / 2, q[1] - grosor / 2, q[0] + grosor / 2, q[1] + grosor / 2], fill=BLANCO)
# Cuerpo
a = p(5.5, 13.5); b = p(26.5, 29.5)
d.rounded_rectangle([a, b], radius=r(3.5), fill=BLANCO)
# Cerradura (en el color de la marca)
c = p(16, 20.5)
d.ellipse([c[0] - r(2.4), c[1] - r(2.4), c[0] + r(2.4), c[1] + r(2.4)], fill=MARCA)
a = p(14.8, 21); b = p(17.2, 25.6)
d.rounded_rectangle([a, b], radius=r(1.2), fill=MARCA)

img.resize((512, 512), Image.LANCZOS).save("icon.png", optimize=True)
print("icon.png 512x512")
