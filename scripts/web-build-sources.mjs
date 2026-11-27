#!/usr/bin/env node
/**
 * The source modules of the production build of the web client (agent-hub), by
 * tree path, and how the build divides between the core and the first-party
 * modules (plan phase 2, step 2.0: the baseline that proves a later round left the
 * full build with the same sources).
 *
 * Runs `vite build` in-process with agent-hub's own config (agent-hub/vite.config.js,
 * the same plugins and chunk groups as `npm run build`), output kept in memory
 * (nothing is written to agent-hub/dist), and reads the bundle the build returns:
 * per chunk its modules with their rendered bytes, its static and dynamic imports.
 * A first-party module is named by its tree path (`src/...`, the same in agent-hub/
 * and in modules/<id>/frontend/, scripts/lib/roots.mjs) and owned per
 * scripts/module-map.json (package agent-hub; `core` when no module owns it).
 * Everything else (node_modules, virtual modules) counts as `third-party`.
 *
 *   node scripts/web-build-sources.mjs                    a summary on stdout
 *   node scripts/web-build-sources.mjs --write <file>     the sorted list of tree paths
 *   node scripts/web-build-sources.mjs --check <file>     exit 1 when the build has other sources than the list
 *   node scripts/web-build-sources.mjs --report <file.md> the breakdown per owner (Markdown)
 * The flags combine (one build). The first-paint set is the entry chunk and every
 * chunk it imports statically (what dist/index.html loads before the app runs); the
 * signed-in shell adds the chunks of src/AuthedApp.tsx and src/AgentHub.tsx and their
 * static imports.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { locate } from './lib/roots.mjs';
import { loadModuleMap } from './module-map.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HUB = path.join(ROOT, 'agent-hub');
export const THIRD_PARTY = 'third-party';
/** The files whose chunks (and their static imports) make up the signed-in shell. */
const SHELL_FILES = ['src/AuthedApp.tsx', 'src/AgentHub.tsx'];

/**
 * @typedef {{ fileName: string, isEntry: boolean, isDynamicEntry: boolean, imports: string[], dynamicImports: string[],
 *   codeBytes: number, modules: { id: string, bytes: number }[] }} BuildChunk
 * @typedef {{ treePath: string | null, owner: string }} Placed
 */

/** Run the production build in memory; its chunks. */
export async function buildChunks() {
    const hubRequire = createRequire(path.join(HUB, 'package.json'));
    const { build } = await import(pathToFileURL(hubRequire.resolve('vite')).href);
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-web-build-'));
    try {
        const result = await build({
            root: HUB, configFile: path.join(HUB, 'vite.config.js'), logLevel: 'warn',
            build: { write: false, sourcemap: false, outDir, emptyOutDir: true },
        });
        const outputs = (Array.isArray(result) ? result : [result]).flatMap((r) => r.output);
        return outputs.filter((o) => o.type === 'chunk').map((c) => ({
            fileName: c.fileName, isEntry: !!c.isEntry, isDynamicEntry: !!c.isDynamicEntry,
            imports: [...c.imports], dynamicImports: [...c.dynamicImports], codeBytes: Buffer.byteLength(c.code),
            modules: Object.entries(c.modules).map(([id, m]) => ({ id, bytes: m.renderedLength ?? 0 })),
        }));
    } finally {
        fs.rmSync(outDir, { recursive: true, force: true });
    }
}

/**
 * The tree path and owner of a module id of the build.
 * @param {string} id
 * @param {{ locateFile?: (abs: string) => { pkg: string, treePath: string, moduleId: string | null } | null, ownerOf: (treePath: string) => string | null }} opts
 * @returns {Placed}
 */
export function placeModule(id, { locateFile = locate, ownerOf }) {
    if (id.startsWith('\0') || id.includes('/node_modules/')) return { treePath: null, owner: THIRD_PARTY };
    const file = id.split('?')[0];
    const at = path.isAbsolute(file) ? locateFile(file) : null;
    if (!at || at.pkg !== 'agent-hub' || !at.treePath.startsWith('src/')) return { treePath: null, owner: THIRD_PARTY };
    return { treePath: at.treePath, owner: at.moduleId ?? ownerOf(at.treePath) ?? 'core' };
}

/** The sorted, distinct tree paths of the first-party modules of a build. */
export function sourceList(chunks, place) {
    const paths = new Set();
    for (const c of chunks) for (const m of c.modules) {
        const p = place(m.id).treePath;
        if (p) paths.add(p);
    }
    return [...paths].sort();
}

/** A chunk and every chunk it imports statically, transitively. */
export function staticClosure(chunks, start) {
    const byName = new Map(chunks.map((c) => [c.fileName, c]));
    const seen = new Set();
    const queue = [...start];
    while (queue.length) {
        const name = queue.pop();
        if (seen.has(name) || !byName.has(name)) continue;
        seen.add(name);
        queue.push(...byName.get(name).imports);
    }
    return [...seen].sort();
}

/** Bytes per owner over some chunks (all when `only` is absent). */
export function bytesByOwner(chunks, place, only) {
    const out = {};
    for (const c of chunks) {
        if (only && !only.includes(c.fileName)) continue;
        for (const m of c.modules) {
            const { owner } = place(m.id);
            out[owner] = (out[owner] ?? 0) + m.bytes;
        }
    }
    return out;
}

/** Everything the report says, as data. */
export function summarize(chunks, place) {
    const owners = {};
    for (const c of chunks) for (const m of c.modules) {
        const { treePath, owner } = place(m.id);
        const o = (owners[owner] ??= { modules: new Set(), bytes: 0 });
        o.modules.add(treePath ?? m.id);
        o.bytes += m.bytes;
    }
    const mixed = chunks.map((c) => ({ chunk: c.fileName, bytes: bytesByOwner([c], place) }))
        .filter((c) => Object.keys(c.bytes).filter((o) => o !== THIRD_PARTY).length > 1);
    const entry = chunks.filter((c) => c.isEntry).map((c) => c.fileName);
    const firstPaint = staticClosure(chunks, entry);
    const shellStarts = chunks.filter((c) => c.modules.some((m) => SHELL_FILES.includes(place(m.id).treePath ?? ''))).map((c) => c.fileName);
    const shell = staticClosure(chunks, [...entry, ...shellStarts]);
    return {
        chunks: chunks.length,
        owners: Object.fromEntries(Object.entries(owners).sort(([a], [b]) => a.localeCompare(b))
            .map(([o, v]) => [o, { modules: v.modules.size, bytes: v.bytes }])),
        mixed,
        entry: { chunks: entry, bytes: bytesByOwner(chunks, place, entry) },
        firstPaint: { chunks: firstPaint, bytes: bytesByOwner(chunks, place, firstPaint) },
        shell: { chunks: shell, bytes: bytesByOwner(chunks, place, shell) },
    };
}

const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
const sum = (o) => Object.values(o).reduce((a, b) => a + b, 0);

/** The share of first-party bytes in a set of chunks that modules own. */
export function moduleShare(bytes) {
    const firstParty = Object.entries(bytes).filter(([o]) => o !== THIRD_PARTY);
    const all = firstParty.reduce((a, [, b]) => a + b, 0);
    const mod = firstParty.filter(([o]) => o !== 'core').reduce((a, [, b]) => a + b, 0);
    return { all, modules: mod, share: all ? mod / all : 0 };
}

function setLines(title, set) {
    const share = moduleShare(set.bytes);
    const lines = Object.entries(set.bytes).sort(([, a], [, b]) => b - a).map(([o, b]) => `| ${o} | ${kb(b)} |`);
    return [`### ${title}`, '', `${set.chunks.length} chunk(s), ${kb(sum(set.bytes))} rendered. Module-owned: ${kb(share.modules)} of ${kb(share.all)} first-party bytes (${(share.share * 100).toFixed(1)}%).`, '',
        '| Owner | Rendered |', '|---|---|', ...lines, ''];
}

/**
 * The Markdown report.
 * @param {ReturnType<typeof summarize>} s
 * @param {{ date?: string, sources?: number }} [opts]
 */
export function renderReport(s, { date, sources } = {}) {
    const ownerRows = Object.entries(s.owners).map(([o, v]) => `| ${o} | ${v.modules} | ${kb(v.bytes)} |`);
    const mixedRows = s.mixed.map((m) => `| ${m.chunk} | ${Object.entries(m.bytes).sort(([, a], [, b]) => b - a).map(([o, b]) => `${o} ${kb(b)}`).join(', ')} |`);
    return [
        '# The production build of the web client, per owner',
        '',
        `Generated by \`node scripts/web-build-sources.mjs --report\`${date ? ` on ${date}` : ''}: \`vite build\` of agent-hub with its own config, in memory. `
            + 'Bytes are the rendered length of each module in its chunk (after tree-shaking, before minification); owners per '
            + '`scripts/module-map.json`; `third-party` is node_modules and virtual modules. '
            + `${s.chunks} chunks${sources ? `, ${sources} first-party source modules (build-sources.txt)` : ''}.`,
        '',
        '## Per owner',
        '',
        '| Owner | Modules | Rendered |', '|---|---|---|', ...ownerRows,
        '',
        '## Chunks that mix owners',
        '',
        `${s.mixed.length} chunk(s) hold modules of more than one first-party owner (third-party bytes listed too).`,
        '',
        '| Chunk | Bytes per owner |', '|---|---|', ...mixedRows,
        '',
        '## Loaded before the first paint',
        '',
        ...setLines('The entry chunk', s.entry),
        ...setLines('Entry and its static imports (dist/index.html preloads these)', s.firstPaint),
        ...setLines('The signed-in shell (adds AuthedApp.tsx, AgentHub.tsx and their static imports)', s.shell),
    ].join('\n');
}

/** The lines one list has and the other lacks. */
export function diffLists(expected, actual) {
    const a = new Set(actual);
    const e = new Set(expected);
    return { missing: expected.filter((p) => !a.has(p)), added: actual.filter((p) => !e.has(p)) };
}

async function main(argv) {
    const flag = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };
    const map = loadModuleMap(ROOT);
    const cache = new Map();
    const place = (id) => {
        if (!cache.has(id)) cache.set(id, placeModule(id, { ownerOf: (p) => map.ownerOf('agent-hub', p) }));
        return cache.get(id);
    };
    const chunks = await buildChunks();
    const list = sourceList(chunks, place);
    const s = summarize(chunks, place);
    const write = flag('--write');
    if (write) fs.writeFileSync(write, `${list.join('\n')}\n`);
    const report = flag('--report');
    if (report) fs.writeFileSync(report, `${renderReport(s, { date: new Date().toISOString().slice(0, 10), sources: list.length })}\n`);
    const check = flag('--check');
    if (check) {
        const { missing, added } = diffLists(fs.readFileSync(check, 'utf8').split('\n').filter(Boolean), list);
        if (missing.length || added.length) {
            console.error([`the build's sources differ from ${check}:`, ...missing.map((p) => `  - ${p}`), ...added.map((p) => `  + ${p}`)].join('\n'));
            return 1;
        }
        console.log(`the build has the ${list.length} sources of ${check}`);
    }
    if (!write && !report && !check) {
        console.log(`${list.length} first-party sources in ${s.chunks} chunks`);
        for (const [o, v] of Object.entries(s.owners)) console.log(`  ${o.padEnd(20)} ${String(v.modules).padStart(5)} modules  ${kb(v.bytes)}`);
    }
    return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main(process.argv.slice(2)).then((code) => process.exit(code), (err) => { console.error(err); process.exit(1); });
}
