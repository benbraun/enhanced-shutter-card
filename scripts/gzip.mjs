/**
 * Post-build step: write a max-compression .gz sibling for the bundle so Home
 * Assistant (aiohttp) can serve the precompressed file to clients that send
 * `Accept-Encoding: gzip`. The original .js is kept and served as a fallback.
 */
import { gzipSync } from 'node:zlib';
import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const targets = ['dist/enhanced-shutter-card.js'];

for (const rel of targets) {
  const path = fileURLToPath(new URL('../' + rel, import.meta.url));
  const src = readFileSync(path);
  const gz = gzipSync(src, { level: 9 });
  writeFileSync(path + '.gz', gz);
  const pct = ((1 - gz.length / src.length) * 100).toFixed(1);
  console.log(`gzip: ${rel} ${src.length} -> ${rel}.gz ${gz.length} bytes (-${pct}%)`);
}
