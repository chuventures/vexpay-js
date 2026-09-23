// Fails the build when the CDN bundle exceeds the budget (spec: < 10 kB gzipped).
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';

const BUDGET = 10 * 1024;
const file = new URL('../dist/vexpay.global.js', import.meta.url);
const size = gzipSync(readFileSync(file), { level: 9 }).length;
const kb = (size / 1024).toFixed(2);

if (size > BUDGET) {
  console.error(`dist/vexpay.global.js is ${kb} kB gzipped — over the 10 kB budget.`);
  process.exit(1);
}
console.log(`dist/vexpay.global.js: ${kb} kB gzipped (budget 10 kB).`);
