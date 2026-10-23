#!/usr/bin/env node
// Merges `import type { A } from 'x'; import type { B } from 'x';` into one
// `import type { A, B } from 'x';` per module specifier (the converter writes
// one line per type it imports). Only top-level, named, type-only imports
// without a default or namespace binding; the first one keeps its place.
//
//   node scripts/ts-merge-type-imports.mjs <file> [<file> ...]   (paths from the repo root or absolute)

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const LINE = /^import type \{ ([^}]+) \} from (['"])([^'"]+)\2;[ \t]*$/;

/**
 * A module imported for values too: its `import type { X }` goes into that
 * import as `type X` (one import per module; a test that counts imports per
 * module sees one). The value import may span lines.
 */
export function foldIntoValueImports(source) {
    let out = source;
    for (const m of [...source.matchAll(/^import type \{ ([^}]+) \} from (['"])([^'"]+)\2;[ \t]*\n/gm)]) {
        const spec = m[3];
        const value = new RegExp(`^import \\{([^}]*)\\} from (['"])${spec.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\2;`, 'm');
        const v = out.match(value);
        if (!v) continue;
        const names = m[1].split(',').map((x) => x.trim()).filter(Boolean);
        const have = v[1].split(',').map((x) => x.trim()).filter(Boolean);
        const extra = names.filter((n) => !have.includes(n) && !have.includes(`type ${n}`)).map((n) => `type ${n}`);
        let body;
        if (v[1].includes('\n')) {
            // keep the one-name-per-line layout: same indent, trailing comma kept
            const indent = (v[1].match(/\n([ \t]+)\S/) || [, '    '])[1];
            const trimmed = v[1].replace(/\s+$/, '');
            body = `${trimmed}${trimmed.endsWith(',') ? '' : ','}${extra.map((e) => `\n${indent}${e},`).join('')}\n`;
        } else body = ` ${[...have, ...extra].join(', ')} `;
        out = out.replace(v[0], `import {${body}} from ${v[2]}${spec}${v[2]};`).replace(m[0], '');
    }
    return out;
}

export function mergeTypeImports(source) {
    return foldIntoValueImports(mergeTypeLines(source));
}

function mergeTypeLines(source) {
    const lines = source.split('\n');
    const first = new Map(); const names = new Map(); const drop = new Set();
    lines.forEach((l, i) => {
        const m = l.match(LINE); if (!m) return;
        const spec = m[3];
        const list = m[1].split(',').map((s) => s.trim()).filter(Boolean);
        if (!first.has(spec)) { first.set(spec, i); names.set(spec, list); return; }
        for (const n of list) if (!names.get(spec).includes(n)) names.get(spec).push(n);
        drop.add(i);
    });
    if (!drop.size) return source;
    return lines.map((l, i) => {
        if (drop.has(i)) return null;
        const m = l.match(LINE);
        if (m && first.get(m[3]) === i) return `import type { ${names.get(m[3]).join(', ')} } from ${m[2]}${m[3]}${m[2]};`;
        return l;
    }).filter((l) => l !== null).join('\n');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    let changed = 0;
    for (const f of process.argv.slice(2)) {
        const src = fs.readFileSync(f, 'utf8'); const out = mergeTypeImports(src);
        if (out !== src) { fs.writeFileSync(f, out); changed++; }
    }
    console.error(`merged type imports in ${changed} file(s)`);
}
