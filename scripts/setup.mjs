// Copies the bundled transformers.js ESM build into vendor/ so the extension can
// load it locally (MV3 disallows remotely-hosted code). Run after `npm install`.
import { existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { dirname, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const distDir = resolve(root, 'node_modules/@huggingface/transformers/dist');
const destDir = resolve(root, 'vendor');
mkdirSync(destDir, { recursive: true });

// The main ESM build (filename varies across versions).
const mainCandidates = ['transformers.min.js', 'transformers.js'];
const mainSrc = mainCandidates.map((c) => resolve(distDir, c)).find(existsSync);
if (!mainSrc) {
  console.error('Could not find transformers.js build. Run `npm install` first.');
  process.exit(1);
}
copyFileSync(mainSrc, resolve(destDir, 'transformers.min.js'));
console.log(`Copied ${basename(mainSrc)} -> vendor/transformers.min.js`);

// ONNX runtime wasm + glue, so nothing loads from a CDN (MV3 CSP-safe).
for (const f of ['ort-wasm-simd-threaded.jsep.wasm', 'ort-wasm-simd-threaded.jsep.mjs']) {
  const src = resolve(distDir, f);
  if (existsSync(src)) {
    copyFileSync(src, resolve(destDir, f));
    console.log(`Copied ${f} -> vendor/${f}`);
  } else {
    console.warn(`Warning: ${f} not found in dist (ONNX runtime may load from CDN).`);
  }
}
