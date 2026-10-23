// Vitest setup file for scripts/ts-runtime-types.mjs: defines the global
// __tcRec the instrumented sources call, describes each value it is handed
// (a small JSON descriptor, never the value itself) and writes them to
// $TS_RUNTIME_REC_DIR when the test file ends. Loaded only by the
// collection run's generated config, never by the normal test setup.

import fs from 'node:fs';
import path from 'node:path';

const records = {};
const MAX_SAMPLES = 20; const MAX_KEYS = 40; const MAX_ELEMENTS = 10;

export function describe(v, depth = 0) {
    if (v === null) return { k: 'null' };
    const t = typeof v;
    if (t === 'undefined' || t === 'string' || t === 'number' || t === 'boolean' || t === 'bigint') return { k: t };
    if (t === 'function') return { k: 'fn' };
    if (t !== 'object') return { k: t };
    if (v.$$typeof) return { k: 'node' }; // a React element
    if (depth >= 3) return { k: 'deep' };
    try {
        if (Array.isArray(v)) {
            const e = []; const seen = new Set();
            for (const x of v.slice(0, MAX_ELEMENTS)) { const d = describe(x, depth + 1); const j = JSON.stringify(d); if (!seen.has(j)) { seen.add(j); e.push(d); } }
            return { k: 'arr', e };
        }
        const proto = Object.getPrototypeOf(v);
        if (proto !== Object.prototype && proto !== null) return { k: 'class', name: v.constructor?.name || '?' };
        const keys = Object.keys(v);
        if (keys.length > MAX_KEYS) return { k: 'big' };
        const p = {};
        for (const key of keys) p[key] = describe(v[key], depth + 1);
        return { k: 'obj', p };
    } catch { return { k: 'err' }; }
}

globalThis.__tcRec = (file, key, slots) => {
    try {
        const byKey = (records[file] ??= {});
        const bySlot = (byKey[key] ??= {});
        for (const [slot, value] of Object.entries(slots)) {
            const list = (bySlot[slot] ??= []);
            if (list.length >= MAX_SAMPLES) continue;
            const d = describe(value); const j = JSON.stringify(d);
            if (!list.some((x) => JSON.stringify(x) === j)) list.push(d);
        }
    } catch { /* observation must never break a test */ }
};

// vitest runs with globals: true, so afterAll needs no import (and this file
// stays importable by plain node for its unit tests).
globalThis.afterAll?.(() => {
    const dir = process.env.TS_RUNTIME_REC_DIR;
    if (!dir || !Object.keys(records).length) return;
    // nosemgrep: ajinabraham.njsscan.crypto.crypto_node.node_insecure_random_generator -- a temp file name for a dev-only recorder, not a secret
    fs.writeFileSync(path.join(dir, `${process.pid}-${Math.random().toString(36).slice(2)}.json`), JSON.stringify(records));
});
