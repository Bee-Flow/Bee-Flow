// Compiled-JavaScript diff of converted files against the last commit that
// still holds their JavaScript (BASE, 4c5dba38), per file.
//   node .claude/handoff/ts-conversion/wave3/eqcheck.mjs <list.json> [base]
// list.json: { files: [{ file, target }] } (paths relative to agent-hub), or a
// chunk from chunks.json via chunk.mjs.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const { compile } = await import(path.join(ROOT, 'scripts/ts-equivalence.mjs'));
const BASE = process.argv[3] || '4c5dba38';
const list = JSON.parse(fs.readFileSync(process.argv[2], 'utf8')).files;
let bad = 0;
for (const { file, target } of list) {
    const a = await compile(execFileSync('git', ['-C', ROOT, 'show', `${BASE}:agent-hub/${file}`], { encoding: 'utf8', maxBuffer: 1 << 28 }));
    const b = await compile(fs.readFileSync(path.join(ROOT, 'agent-hub', target), 'utf8'));
    if (a.length === b.length && a.every((l, i) => l === b[i])) continue;
    bad++; const sa = new Set(a), sb = new Set(b);
    console.log(`DIFFERENT ${target}\n${a.filter((l) => !sb.has(l)).map((l) => `- ${l}`).join('\n')}\n${b.filter((l) => !sa.has(l)).map((l) => `+ ${l}`).join('\n')}`);
}
console.log(`${list.length - bad} identical, ${bad} different`);
