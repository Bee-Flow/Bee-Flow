// Unit tests of web-build-sources.mjs on a made-up bundle (the real build is run by the script itself, not here).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bytesByOwner, diffLists, moduleShare, placeModule, renderReport, sourceList, staticClosure, summarize, THIRD_PARTY } from './web-build-sources.mjs';

const HUB = '/repo/agent-hub';
const MOD = '/repo/modules/cowork/frontend';
/** A stand-in for scripts/lib/roots.mjs locate(): the core root and one module root. */
const locateFile = (abs) => {
    if (abs.startsWith(`${MOD}/`)) return { pkg: 'agent-hub', treePath: abs.slice(MOD.length + 1), moduleId: 'cowork' };
    if (abs.startsWith(`${HUB}/`)) return { pkg: 'agent-hub', treePath: abs.slice(HUB.length + 1), moduleId: null };
    return null;
};
const OWNERS = { 'src/pages/apps/A.tsx': 'apps' };
const place = (id) => placeModule(id, { locateFile, ownerOf: (p) => OWNERS[p] ?? null });

const chunk = (fileName, modules, extra = {}) => ({ fileName, isEntry: false, isDynamicEntry: false, imports: [], dynamicImports: [], codeBytes: 0, modules, ...extra });
const CHUNKS = [
    chunk('index.js', [{ id: `${HUB}/src/main.tsx`, bytes: 100 }, { id: '\0vite/preload-helper', bytes: 5 }], { isEntry: true, imports: ['vendor.js'] }),
    chunk('vendor.js', [{ id: `${HUB}/node_modules/react/index.js`, bytes: 400 }]),
    chunk('AuthedApp.js', [{ id: `${HUB}/src/AuthedApp.tsx`, bytes: 50 }, { id: `${MOD}/src/components/cowork/Chip.tsx`, bytes: 20 }], { isDynamicEntry: true, imports: ['shared.js'] }),
    chunk('shared.js', [{ id: `${HUB}/src/pages/apps/A.tsx?raw`, bytes: 30 }]),
    chunk('lazy.js', [{ id: `${HUB}/src/pages/apps/A.tsx`, bytes: 10 }], { isDynamicEntry: true }),
];

test('a module is placed by tree path and owner, whichever root holds it', () => {
    assert.deepEqual(place(`${HUB}/src/main.tsx`), { treePath: 'src/main.tsx', owner: 'core' });
    assert.deepEqual(place(`${HUB}/src/pages/apps/A.tsx?raw`), { treePath: 'src/pages/apps/A.tsx', owner: 'apps' });
    assert.deepEqual(place(`${MOD}/src/components/cowork/Chip.tsx`), { treePath: 'src/components/cowork/Chip.tsx', owner: 'cowork' });
    assert.deepEqual(place(`${HUB}/node_modules/react/index.js`), { treePath: null, owner: THIRD_PARTY });
    assert.deepEqual(place('\0vite/preload-helper'), { treePath: null, owner: THIRD_PARTY });
    assert.deepEqual(place(`${HUB}/index.html`), { treePath: null, owner: THIRD_PARTY });
});

test('the source list is the sorted, distinct first-party tree paths', () => {
    assert.deepEqual(sourceList(CHUNKS, place), ['src/AuthedApp.tsx', 'src/components/cowork/Chip.tsx', 'src/main.tsx', 'src/pages/apps/A.tsx']);
});

test('the static closure follows static imports only', () => {
    assert.deepEqual(staticClosure(CHUNKS, ['index.js']), ['index.js', 'vendor.js']);
    assert.deepEqual(staticClosure(CHUNKS, ['index.js', 'AuthedApp.js']), ['AuthedApp.js', 'index.js', 'shared.js', 'vendor.js']);
});

test('bytes per owner, over every chunk or some', () => {
    assert.deepEqual(bytesByOwner(CHUNKS, place), { core: 150, [THIRD_PARTY]: 405, cowork: 20, apps: 40 });
    assert.deepEqual(bytesByOwner(CHUNKS, place, ['index.js']), { core: 100, [THIRD_PARTY]: 5 });
});

test('the module share counts first-party bytes only', () => {
    assert.deepEqual(moduleShare({ core: 60, cowork: 20, apps: 20, [THIRD_PARTY]: 1000 }), { all: 100, modules: 40, share: 0.4 });
    assert.equal(moduleShare({ [THIRD_PARTY]: 5 }).share, 0);
});

test('the summary names the mixed chunks, the first paint and the signed-in shell', () => {
    const s = summarize(CHUNKS, place);
    assert.equal(s.chunks, 5);
    assert.deepEqual(s.owners.core, { modules: 2, bytes: 150 });
    assert.deepEqual(s.mixed.map((m) => m.chunk), ['AuthedApp.js']);
    assert.deepEqual(s.entry.chunks, ['index.js']);
    assert.deepEqual(s.firstPaint.chunks, ['index.js', 'vendor.js']);
    assert.deepEqual(s.shell.chunks, ['AuthedApp.js', 'index.js', 'shared.js', 'vendor.js']);
    const md = renderReport(s, { sources: 4 });
    assert.match(md, /\| cowork \| 1 \| 0\.0 KB \|/);
    assert.match(md, /\| AuthedApp\.js \| core 0\.0 KB, cowork 0\.0 KB \|/);
});

test('a list diff names what is missing and what is new', () => {
    assert.deepEqual(diffLists(['a', 'b'], ['b', 'c']), { missing: ['a'], added: ['c'] });
    assert.deepEqual(diffLists(['a'], ['a']), { missing: [], added: [] });
});
