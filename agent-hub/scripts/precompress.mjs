// Pre-compress the built SPA once, at maximum strength: a .gz (level 9, served
// by nginx `gzip_static`) next to every text asset. On-the-fly compression
// had to stay at a low level because it runs per request; these files are
// built once and, for /assets/, cached for a year. (Stock nginx has no
// brotli module, so there is no .br copy.)
//
// Usage: node scripts/precompress.mjs [dir=dist]
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

const EXT = /\.(js|mjs|css|svg|json|html|txt|xml|wasm)$/i;
const MIN_BYTES = 1024;

/** @param {string} dir @returns {string[]} */
function walk(dir) {
    return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const p = join(dir, e.name);
        return e.isDirectory() ? walk(p) : [p];
    });
}

/** @param {string} root @returns {number} files compressed */
export function precompress(root) {
    let n = 0;
    for (const file of walk(root)) {
        if (!EXT.test(file) || statSync(file).size < MIN_BYTES) continue;
        const src = readFileSync(file);
        const gz = gzipSync(src, { level: 9 });
        // A compressed copy that is not smaller is not worth shipping.
        if (gz.length < src.length) writeFileSync(`${file}.gz`, gz);
        n++;
    }
    return n;
}

if (import.meta.url === `file://${process.argv[1]}`) {
    const dir = process.argv[2] || 'dist';
    console.log(`precompress: ${precompress(dir)} files in ${dir}`);
}
