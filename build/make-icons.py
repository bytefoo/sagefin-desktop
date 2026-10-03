"""Builds the app's icons from the SageFin logo. Run from this folder: python3 make-icons.py

macOS draws a Dock icon exactly as given, so an icon has to bring its own shape: Apple's template is
a 1024 canvas with an 824 rounded square in the middle and clear space around it. A plain square
logo fills the whole tile and sits larger and squarer than every icon beside it.

Windows and Linux mask or frame the image themselves, so they get the plain square.
Needs Pillow.
"""

from pathlib import Path

from PIL import Image, ImageDraw

HERE = Path(__file__).parent
LOGO = HERE / "logo.png"  # The 1024px SageFin logo.

CANVAS = 1024
BODY = 824  # Apple's icon grid: the shape is 824 of 1024.
RADIUS = 185  # About 22.5% of the body, the corner the system's own icons use.
SCALE = 4  # The mask is drawn large and shrunk, so the corner is smooth.

logo = Image.open(LOGO).convert("RGBA")

mask = Image.new("L", (BODY * SCALE, BODY * SCALE), 0)
ImageDraw.Draw(mask).rounded_rectangle((0, 0, BODY * SCALE - 1, BODY * SCALE - 1), radius=RADIUS * SCALE, fill=255)
mask = mask.resize((BODY, BODY), Image.LANCZOS)

body = logo.resize((BODY, BODY), Image.LANCZOS)
body.putalpha(mask)

mac = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
offset = (CANVAS - BODY) // 2
mac.paste(body, (offset, offset), body)
mac.save(HERE / "icon-mac.png")

logo.resize((512, 512), Image.LANCZOS).save(HERE / "icon.png")
print("wrote icon-mac.png (1024, shaped) and icon.png (512, square)")
