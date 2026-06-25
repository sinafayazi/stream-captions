// Copies the bundled transformers.js ESM build into vendor/ so the extension can
// load it locally (MV3 disallows remotely-hosted code). Run after `npm install`.
import { existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const candidates = [
  'node_modules/@huggingface/transformers/dist/transformers.min.js',
  'node_modules/@huggingface/transformers/dist/transformers.js',
];

const src = candidates.map((c) => resolve(root, c)).find(existsSync);
if (!src) {
  console.error('Could not find transformers.js build. Run `npm install` first.');
  process.exit(1);
}

const destDir = resolve(root, 'vendor');
mkdirSync(destDir, { recursive: true });
const dest = resolve(destDir, 'transformers.min.js');
copyFileSync(src, dest);
console.log(`Copied ${src} -> ${dest}`);
