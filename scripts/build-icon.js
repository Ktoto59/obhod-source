const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');

async function main() {
  const source = path.join(__dirname, '..', 'windows', 'assets', 'obhod-icon.svg');
  const output = path.join(__dirname, '..', 'windows', 'build');
  fs.mkdirSync(output, { recursive: true });
  const sizes = [16, 24, 32, 48, 64, 128, 256, 512];
  await Promise.all(sizes.map((size) => sharp(source)
    .resize(size, size, { fit: 'contain' })
    .png()
    .toFile(path.join(output, `icon-${size}.png`))));
  fs.copyFileSync(path.join(output, 'icon-512.png'), path.join(output, 'icon.png'));
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
