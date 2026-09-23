import { defineConfig } from 'tsup';

export default defineConfig([
  {
    // npm: ESM + CJS with types.
    entry: ['src/index.ts'],
    format: ['esm', 'cjs'],
    dts: true,
    sourcemap: true,
    clean: true,
    target: 'es2019',
    platform: 'browser',
  },
  {
    // CDN: <script src=".../vexpay.global.js"> exposes window.VexPay.
    entry: { vexpay: 'src/global.ts' },
    format: ['iife'],
    globalName: 'VexPay',
    minify: true,
    sourcemap: true,
    target: 'es2019',
    platform: 'browser',
  },
]);
