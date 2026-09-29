// Remove build output. Separate from `rm -rf` in an npm script so the command
// works the same on Windows, where contributors build the Windows installer.
import { rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

for (const dir of ['dist', 'release']) {
    await rm(resolve(root, dir), { recursive: true, force: true });
    console.log(`removed ${dir}/`);
}
