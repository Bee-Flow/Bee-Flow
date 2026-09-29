// Copy the shell UI's static files (HTML, CSS, images) next to the JavaScript
// tsc emitted for them.
//
// There is no bundler in this package on purpose. The shell UI is a handful of
// local pages — an onboarding flow, a settings window, an error screen — and a
// bundler would add a dependency tree, a config file and a watch mode to move
// three files. tsc emits browser-loadable ES modules; this script moves the
// rest.
import { cp, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const from = resolve(root, 'src/shell');
const to = resolve(root, 'dist/ui/shell');

await mkdir(to, { recursive: true });
await cp(from, to, {
    recursive: true,
    // Everything tsc already handled, plus its tests.
    filter: (src) => !src.endsWith('.ts') || src.endsWith('.d.ts'),
});
console.log(`copied shell assets -> ${to.replace(root + '/', '')}`);
