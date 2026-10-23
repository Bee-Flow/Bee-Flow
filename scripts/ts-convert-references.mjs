#!/usr/bin/env node
// After a JS -> TS conversion: every place that names a converted file by its
// old path follows it to the new one. Only references that unambiguously
// resolve to the converted agent-hub file are touched:
//   - the full path with the prefix (`agent-hub/src/a/b.jsx`) anywhere in the
//     repo; the bare `src/a/b.jsx`, or `'components/x/Y.jsx'` inside a string,
//     only in a file under agent-hub/ (there `src/` is agent-hub's own);
//   - an import/require/readFileSync specifier that resolves to the file
//     (`'./Y.jsx'` from a sibling): an import loses the extension, a file read
//     gets the new one;
//   - a key in agent-hub/.file-budget.json (the ceiling belongs to the file).
// A flat name (`src/App.jsx`, `src/main.jsx`, `App.jsx`) is never rewritten
// without the agent-hub/ prefix: it is also the React template of user
// webpages, quoted in server AI prompts, learn texts, mobile and the module
// SDK (wave 3 rewrote 30 such files: a behaviour change). A shorter suffix
// (`flow/layout.js`) can mean two files and is left alone too: the tests that
// read it say whether it needed to change.
//
//   node scripts/ts-convert-references.mjs --pairs pairs.json [--dry]
//   (pairs.json: { files: [{ file, target }] }, paths relative to agent-hub)

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HUB = path.join(ROOT, 'agent-hub');

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Rewrites `text` (the content of `file`, repo-relative) for every pair; returns the new text. */
/** `src/App.jsx`, `App.jsx`: a name with no directory below src, which other things are called too. */
export const isFlat = (rel) => !rel.replace(/^src\//, '').includes('/');

export function rewrite(text, file, pairs) {
    let out = text;
    const insideHub = file.startsWith('agent-hub/');
    for (const { file: oldRel, target: newRel } of pairs) {
        const oldBase = path.basename(oldRel); const newBase = path.basename(newRel);
        const flat = isFlat(oldRel);
        // 1. The path from agent-hub/src: with the agent-hub/ prefix anywhere; the
        //    bare `src/...` (and `'components/x/Y.jsx'` in a string) only inside
        //    agent-hub, and never a flat name.
        out = out.replace(new RegExp(`(^|[^\\w./-])agent-hub/${esc(oldRel)}(?![\\w.-])`, 'g'), (m, pre) => `${pre}agent-hub/${newRel}`);
        if (insideHub && !flat) {
            out = out.replace(new RegExp(`(^|[^\\w./-])${esc(oldRel)}(?![\\w.-])`, 'g'), (m, pre) => pre + newRel);
            const fromSrc = oldRel.replace(/^src\//, '');
            out = out.replace(new RegExp(`(['"\`])${esc(fromSrc)}\\1`, 'g'), (m, q) => `${q}${newRel.replace(/^src\//, '')}${q}`);
        }
        // 1b. A brace list in a path glob (ci.yml: `agent-hub/src/.../runtime/{a.ts,uiBits.jsx}`).
        out = out.replace(/((?:agent-hub\/)?src\/[\w./-]*\/)\{([^}'"\n]+)\}/g, (m, prefix, list) => {
            if (!prefix.startsWith('agent-hub/') && !insideHub) return m;
            const items = list.split(',').map((it) => ((prefix.replace(/^agent-hub\//, '') + it) === oldRel ? newBase : it));
            return `${prefix}{${items.join(',')}}`;
        });
        // 2. Relative specifiers that resolve to the file.
        const dirOfFile = path.dirname(path.join(ROOT, file));
        out = out.replace(new RegExp(`(['"\`])(\\.{1,2}/(?:[^'"\`]*/)?)${esc(oldBase)}\\1`, 'g'), (m, q, rel) => {
            if (path.resolve(dirOfFile, rel + oldBase) !== path.join(HUB, oldRel)) return m;
            const isImport = new RegExp(`(from\\s*|import\\(\\s*|vi\\.mock\\(\\s*|require\\(\\s*)${esc(m)}`).test(out);
            return isImport ? `${q}${rel}${oldBase.replace(/\.[jt]sx?$/, '')}${q}` : `${q}${rel}${newBase}${q}`;
        });
        // 3. A bare basename in a test beside the file (path.join(here, 'Y.jsx')).
        if (path.dirname(path.join(ROOT, file)) === path.dirname(path.join(HUB, oldRel)) && /\.test\.[jt]sx?$/.test(file)) {
            out = out.replace(new RegExp(`(['"\`])${esc(oldBase)}\\1`, 'g'), (m, q) => `${q}${newBase}${q}`);
        }
    }
    return out;
}

/**
 * Tests (agent-hub's and mobile's lockstep tests) also name a file by a
 * shorter tail: `${FLOW}/flowOrder.js`, read('flow/nodes/NoteNode.jsx'). A
 * tail is rewritten when exactly one file of agent-hub/src (as it was before
 * the conversion: `allOld`) ends with it, so `flow/layout.js` (two of them)
 * stays as it is.
 */
export function rewriteTails(text, pairs, allOld) {
    // Every string literal, whole: its path is what it names, minus a leading
    // `${VAR}/`, `./` or `../` (the base a test joins it to).
    return text.replace(/(['"`])((?:\$\{[^}]+\}\/|(?:\.\.?\/)+)?)([\w.@/-]+\.(?:jsx?|tsx?))\1/g, (m, q, prefix, rel) => {
        if (isFlat(rel)) return m; // `src/App.jsx`: the webpage template as much as agent-hub's file
        const hits = pairs.filter((p) => p.file === rel || p.file.endsWith(`/${rel}`));
        if (hits.length !== 1) return m;
        const owners = allOld.filter((f) => f === rel || f.endsWith(`/${rel}`));
        if (owners.length !== 1) return m;
        const { file: oldRel, target: newRel } = hits[0];
        const newTail = newRel.slice(newRel.length - (rel.length + (newRel.length - oldRel.length)));
        return `${q}${prefix || ''}${newTail}${q}`;
    });
}

function arg(name, fallback) { const i = process.argv.indexOf(name); return i === -1 ? fallback : process.argv[i + 1]; }

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const pairs = JSON.parse(fs.readFileSync(arg('--pairs'), 'utf8')).files;
    const dry = process.argv.includes('--dry');
    const bases = [...new Set(pairs.map((p) => path.basename(p.file)))];
    // Candidate files: any tracked text file that mentions one of the old basenames.
    let listed = '';
    try { listed = execFileSync('git', ['-C', ROOT, 'grep', '-l', '-F', ...bases.flatMap((b) => ['-e', b]), '--', ':!.claude/handoff'], { encoding: 'utf8', maxBuffer: 1 << 28 }); } catch { /* none */ }
    // agent-hub/src as it was before the conversion: what a tail could have meant.
    const allOld = execFileSync('git', ['-C', ROOT, 'ls-tree', '-r', '--name-only', 'HEAD', 'agent-hub/src'], { encoding: 'utf8', maxBuffer: 1 << 28 })
        .split('\n').filter(Boolean).map((f) => f.replace(/^agent-hub\//, ''));
    let changed = 0;
    for (const file of listed.split('\n').filter(Boolean)) {
        const abs = path.join(ROOT, file);
        if (!fs.existsSync(abs)) continue;
        const text = fs.readFileSync(abs, 'utf8');
        let out = rewrite(text, file, pairs);
        // Tails only where agent-hub is what the paths are about: inside agent-hub, or
        // a test that names agent-hub (a server test's `routes/automation/actions.js`
        // is the server's file, whatever agent-hub happens to hold). A `.jsx` tail
        // elsewhere is NOT agent-hub's by default: the webpage template (`src/App.jsx`)
        // is quoted in server and mobile tests too.
        if (/\.test\.[jt]sx?$|\/testing\//.test(file) && (file.startsWith('agent-hub/') || /agent-hub/.test(text))) out = rewriteTails(out, pairs, allOld);
        if (file === 'agent-hub/.file-budget.json') {
            for (const { file: o, target: n } of pairs) out = out.replace(`"${o}":`, `"${n}":`);
        }
        if (out !== text) { changed++; console.error(`${dry ? 'would update' : 'updated'} ${file}`); if (!dry) fs.writeFileSync(abs, out); }
    }
    console.error(`${changed} file(s) ${dry ? 'would change' : 'changed'}`);
}
