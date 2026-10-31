from pathlib import Path
from PIL import Image

root = Path(__file__).resolve().parent.parent
build = root / "windows/build"
sizes = [16, 24, 32, 48, 64, 128, 256]
images = [Image.open(build / f"icon-{size}.png").convert("RGBA") for size in sizes]
images[-1].save(build / "icon.ico", format="ICO", append_images=images[:-1], sizes=[(s, s) for s in sizes])
