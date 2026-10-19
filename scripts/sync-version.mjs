import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
for (const name of ['kernel', 'cli', 'desktop']) if (JSON.parse(readFileSync(join(root, 'packages', name, 'package.json'), 'utf8')).version !== version) throw new Error('Workspace version mismatch: ' + name);
const file = join(root, 'packages/kernel/src/version.ts');
const source = '// Generated from the root package.json by scripts/sync-version.mjs.\nexport const VERSION = ' + JSON.stringify(version) + ';\n';
let current; try { current = readFileSync(file, 'utf8'); } catch {}
if (current !== source) writeFileSync(file, source);
