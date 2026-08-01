// Builds the Chrome Web Store upload ZIP: exactly the files the extension needs
// at runtime, and nothing else (no node_modules, no .git, no build scripts).
// vendor/ MUST already be populated — run `npm run setup` first.
import { existsSync, rmSync, mkdirSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(readFileSync(resolve(root, 'manifest.json'), 'utf8'));

const INCLUDE = ['manifest.json', 'icons', 'src', 'vendor', 'README.md', 'PRIVACY.md', 'LICENSE'];

for (const f of INCLUDE) {
  if (!existsSync(resolve(root, f))) {
    console.error(`Missing ${f}. Did you run \`npm run setup\`?`);
    process.exit(1);
  }
}

const outDir = resolve(root, 'dist');
mkdirSync(outDir, { recursive: true });
const zipPath = resolve(outDir, `stream-captions-${version}.zip`);
rmSync(zipPath, { force: true });

// -x excludes the junk macOS and editors leave inside otherwise-wanted dirs.
execFileSync('zip', ['-r', '-9', '-q', zipPath, ...INCLUDE,
  '-x', '*.DS_Store', '*/.gitkeep', '*.map'], { cwd: root, stdio: 'inherit' });

console.log(`Built ${zipPath.replace(root + '/', '')}`);
