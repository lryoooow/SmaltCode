import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';
import { Data } from 'resedit';
const assets = join(dirname(fileURLToPath(import.meta.url)), '../packages/desktop/assets');
const svg = readFileSync(join(assets, 'smalt.svg'));
const png = size => new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render().asPng();
const icon = new Data.IconFile();
for (const size of [16, 24, 32, 48, 64, 128, 256]) icon.icons.push({ data: new Data.RawIconItem(png(size), size, size, 32) });
writeFileSync(join(assets, 'smalt.ico'), Buffer.from(icon.generate()));
writeFileSync(join(assets, 'smalt.png'), png(256));
// Apple's ICNS container: big-endian chunk lengths including each chunk header.
const chunks = [['icp4', 16], ['icp5', 32], ['icp6', 64], ['ic07', 128], ['ic08', 256], ['ic09', 512], ['ic10', 1024]].map(([type, size]) => {
  const payload = png(size), header = Buffer.alloc(8);
  header.write(type, 0, 4, 'ascii'); header.writeUInt32BE(payload.length + 8, 4);
  return Buffer.concat([header, payload]);
});
const header = Buffer.alloc(8); header.write('icns'); header.writeUInt32BE(8 + chunks.reduce((n, b) => n + b.length, 0), 4);
writeFileSync(join(assets, 'smalt.icns'), Buffer.concat([header, ...chunks]));
// Menu-bar templates use the same fox silhouette; macOS supplies light/dark tint.
const fox = svg.toString('utf8').match(/<path id="fox-symbol"[^>]*\/>/)?.[0];
if (!fox) throw new Error('Canonical fox symbol is missing');
const tray = `<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="32 32 192 192">${fox.replace('fill="#FFFFFF"', 'fill="#000000"')}</svg>`;
for (const [suffix, size] of [['', 22], ['@2x', 44]]) writeFileSync(join(assets, `smalt-trayTemplate${suffix}.png`), new Resvg(tray, { fitTo: { mode: 'width', value: size } }).render().asPng());
console.log('Generated PNG, ICO, ICNS and menu-bar templates from the canonical smalt.svg');
