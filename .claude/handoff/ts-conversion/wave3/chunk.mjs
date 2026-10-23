// Writes the working files for one chunk: <out>/c3-N.json (with the chunk's
// current typecheck errors and the errors it causes in importers) and
// <out>/c3-N.files (the target list for tsc-locked.sh).
//   node .claude/handoff/ts-conversion/wave3/chunk.mjs <N> <outDir> <tsc-output.txt>
// tsc-output.txt: `cd agent-hub && node ./node_modules/typescript-7/bin/tsc --noEmit --pretty false > it`
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const HUB = path.resolve(HERE, '../../../../agent-hub');
const [n, outDir, tscFile] = process.argv.slice(2);
const chunks = JSON.parse(fs.readFileSync(path.join(HERE, 'chunks.json'), 'utf8'));
const files = chunks[Number(n) - 1].map((f) => ({ ...f, errors: [], importerErrors: [] }));
const all = chunks.flat().map((f) => f.target);
const by = new Map(files.map((f) => [f.target, f]));
const resolve = (from, spec) => { const b = path.join(path.dirname(from), spec).replace(/\.[jt]sx?$/, ''); return all.filter((t) => t.replace(/\.[jt]sx?$/, '') === b || t.replace(/\/index\.[jt]sx?$/, '') === b); };
for (const m of fs.readFileSync(tscFile, 'utf8').matchAll(/^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/gm)) {
    if (by.has(m[1])) { by.get(m[1]).errors.push(`${m[2]} ${m[4]} ${m[5]}`); continue; }
    if (all.includes(m[1])) continue;
    let src = ''; try { src = fs.readFileSync(path.join(HUB, m[1]), 'utf8'); } catch { /* gone */ }
    for (const x of src.matchAll(/(?:from\s+|import\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g)) for (const t of resolve(m[1], x[1])) if (by.has(t)) by.get(t).importerErrors.push(`${m[1]}:${m[2]} ${m[4]} ${m[5]}`);
}
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, `c3-${n}.json`), JSON.stringify({ files }, null, 1));
fs.writeFileSync(path.join(outDir, `c3-${n}.files`), `${files.map((f) => f.target).join('\n')}\n`);
console.log(`chunk ${n}: ${files.length} files, ${files.reduce((a, f) => a + f.errors.length, 0)} errors, ${files.reduce((a, f) => a + f.importerErrors.length, 0)} importer errors`);
