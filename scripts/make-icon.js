'use strict';

/**
 * Rasterise the gallery icon.
 *
 * The VS Code marketplace and the Extensions view want a PNG, but the source
 * of truth is the SVG next to it, so the two cannot drift.
 *
 *   npm run icon
 */

const fs = require('fs');
const path = require('path');

const SOURCE = path.join(__dirname, '..', 'resources', 'icon-gallery.svg');
const TARGET = path.join(__dirname, '..', 'resources', 'icon.png');
const SIZE = 128;

async function main() {
  let sharp;
  try {
    sharp = require('sharp');
  } catch {
    console.error(
      'sharp is not installed, so the PNG cannot be generated.\n' +
        'Run: npm install --save-dev sharp',
    );
    process.exit(1);
  }

  const svg = fs.readFileSync(SOURCE);
  await sharp(svg, { density: 384 }).resize(SIZE, SIZE).png().toFile(TARGET);

  const { size } = fs.statSync(TARGET);
  console.log(`wrote ${path.relative(process.cwd(), TARGET)} (${SIZE}x${SIZE}, ${size} bytes)`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
