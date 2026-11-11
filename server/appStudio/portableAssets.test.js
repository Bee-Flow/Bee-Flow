/**
 * The uploaded files of an app in a copy: read again like an upload (portableAssets.mts), read out
 * of an app and stored into another with every reference rewritten (portableAssetStore.mts).
 *
 * Run: cd server && node --test appStudio/portableAssets.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { png, sha, entry, memoryAssetStore } = require('../testUtils/portableAssets.testkit');
const {
    readPortableAssets, remapAssetRefs, writePortableAssets, portableAssetBudget, DEFAULT_PORTABLE_ASSET_BYTES,
} = require('./portableAssets.mts');
const { collectPortableAssets, carryAssetsInto, applyCopiedAssets } = require('./portableAssetStore.mts');

const APP = { id: 'app-target', userId: 'owner-1' };
const wanted = (...ids) => new Set(ids);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

/** A definition with the asset in each place a copy rewrites: a whole string, rich markdown, custom CSS. */
function defWith(id, other = 'gone-1') {
    return {
        schemaVersion: 3,
        design: { logoUrl: `asset:${id}`, customCss: `.hero { background: url(asset:${id}) }` },
        screens: [{ id: 's1', sections: [{ id: 'x', components: [
            { id: 'c1', type: 'image', props: { src: `asset:${other}` } },
            { id: 'c2', type: 'markdown', props: { rich: true, content: `![a](asset:${id}) and ![b](asset:${other})` } },
        ] }] }],
    };
}

test('the type comes from the bytes: a declared type is never used, an SVG is refused whatever it claims', () => {
    const lied = entry('a', png(1), { mime: 'image/svg+xml' });
    const svg = { ...entry('b', SVG), mime: 'image/png' };
    const out = readPortableAssets([lied, svg], wanted('a', 'b'));
    assert.deepEqual(out.assets.map((a) => [a.id, a.mime]), [['a', 'image/png']]);
    assert.match(out.dropped.join(' '), /asset:b is not a picture or font/);
});

test('bytes that do not match their sha256, a second entry for an id and an unusable id are left out and named', () => {
    const tampered = { ...entry('a', png(2)), data: png(3).toString('base64') };
    const out = readPortableAssets([tampered, entry('b'), entry('b', png(4)), { id: '../x', data: 'AA==' }, 'nope'], wanted('a', 'b'));
    assert.deepEqual(out.assets.map((a) => a.id), ['b']);
    assert.equal(out.dropped.length, 4, out.dropped.join(' | '));
    assert.match(out.dropped[0], /do not match the sha256/);
});

test('a file the definition does not refer to does not come along', () => {
    const out = readPortableAssets([entry('used'), entry('spare', png(5))], wanted('used'));
    assert.deepEqual(out.assets.map((a) => a.id), ['used']);
    assert.deepEqual(out.dropped, []);
});

test('the total of one copy is an operator budget, 0 = unlimited', () => {
    assert.equal(portableAssetBudget({}), DEFAULT_PORTABLE_ASSET_BYTES);
    assert.equal(portableAssetBudget({ STUDIO_APP_PORTABLE_ASSET_BYTES: '0' }), Infinity);
    assert.equal(portableAssetBudget({ STUDIO_APP_PORTABLE_ASSET_BYTES: 'lots' }), DEFAULT_PORTABLE_ASSET_BYTES);
    const env = { STUDIO_APP_PORTABLE_ASSET_BYTES: String(png(0).length + 10) };
    const out = readPortableAssets([entry('a'), entry('b', png(20))], wanted('a', 'b'), env);
    assert.deepEqual(out.assets.map((a) => a.id), ['a']);
    assert.match(out.dropped[0], /STUDIO_APP_PORTABLE_ASSET_BYTES/);
    assert.equal(readPortableAssets([entry('a'), entry('b', png(20))], wanted('a', 'b'), { STUDIO_APP_PORTABLE_ASSET_BYTES: '0' }).assets.length, 2);
});

test('remap: every place is rewritten the same way; a whole reference that did not arrive becomes null, text keeps it', () => {
    const def = defWith('old-1');
    const out = remapAssetRefs(def, new Map([['old-1', 'new-9']]));
    assert.equal(def.design.logoUrl, 'asset:new-9');
    assert.equal(def.design.customCss, '.hero { background: url(asset:new-9) }');
    const [image, markdown] = def.screens[0].sections[0].components;
    assert.equal(markdown.props.content, '![a](asset:new-9) and ![b](asset:gone-1)');
    assert.equal(image.props.src, null);
    assert.deepEqual(out, { remapped: 3, cleared: ['screens[0].sections[0].components[0].props.src'], textLeft: 1 });
});

test('a copy writes its entries sorted by id, with the sha256 of the bytes', () => {
    const out = writePortableAssets([{ id: 'b', mime: 'image/png', bytes: png(1) }, { id: 'a', mime: 'image/png', bytes: png(2) }]);
    assert.deepEqual(out.map((a) => a.id), ['a', 'b']);
    assert.equal(out[0].sha256, sha(png(2)));
});

test('collect reads the bytes of the files the definition uses, and names a reference to a file the app does not have', async () => {
    const store = memoryAssetStore([{ id: 'old-1', bytes: png(1) }, { id: 'unused', bytes: png(2) }]);
    const out = await collectPortableAssets(APP, defWith('old-1'), store.deps);
    assert.deepEqual(out.assets.map((a) => [a.id, a.sha256]), [['old-1', sha(png(1))]]);
    assert.deepEqual(out.left, ['asset:gone-1 is not among this app\'s uploaded files']);
});

test('carry stores each file through the upload door, rewrites the copy and leaves the given definition alone', async () => {
    const store = memoryAssetStore();
    const def = defWith('old-1');
    const before = JSON.stringify(def);
    const out = await carryAssetsInto(APP, def, [entry('old-1', png(1))], store.deps);
    assert.equal(JSON.stringify(def), before);
    assert.deepEqual(store.stored.map((s) => s.mime), ['image/png']);
    assert.equal(out.definition.design.logoUrl, 'asset:new-1');
    assert.deepEqual(out.report, { carried: 1, reused: 0, cleared: 1, skipped: [] });
});

test('carry reuses a file the app already holds (a template upgrade), and a refused file is named and cleared', async () => {
    const held = memoryAssetStore([{ id: 'mine', bytes: png(1) }]);
    const again = await carryAssetsInto(APP, defWith('old-1'), [entry('old-1', png(1))], held.deps);
    assert.equal(held.stored.length, 0);
    assert.equal(again.definition.design.logoUrl, 'asset:mine');
    assert.equal(again.report.reused, 1);

    const scan = Object.assign(new Error('The file failed a malware scan and was refused.'), { status: 422 });
    const refused = memoryAssetStore([], { storeImpl: () => { throw scan; } });
    const out = await carryAssetsInto(APP, defWith('old-1'), [entry('old-1', png(1))], refused.deps);
    assert.equal(out.definition.design.logoUrl, null);
    assert.match(out.report.skipped[0], /malware scan/);
});

test('a full app stops at the first quota refusal instead of trying every file', async () => {
    let tries = 0;
    const quota = Object.assign(new Error('An app holds at most 200 uploaded files.'), { status: 409 });
    const store = memoryAssetStore([], { storeImpl: () => { tries += 1; throw quota; } });
    const def = { design: { logoUrl: 'asset:a' }, screens: [{ id: 's', props: { src: 'asset:b' } }] };
    await carryAssetsInto(APP, def, [entry('a', png(1)), entry('b', png(2))], store.deps);
    assert.equal(tries, 1);
});

test('nothing to carry changes nothing: no file stored, no save', async () => {
    const store = memoryAssetStore();
    const saves = [];
    const appStore = { saveDefinition: async (...a) => { saves.push(a); return { ok: true }; }, setTemplateStamp: async () => {} };
    const def = defWith('old-1');
    for (const assets of [undefined, []]) {
        const out = await applyCopiedAssets({ app: APP, definition: def, assets, deps: store.deps, appStore });
        assert.equal(out.report, null);
        assert.equal(out.definition, def);
    }
    const plain = { screens: [] };
    assert.equal((await applyCopiedAssets({ app: APP, definition: plain, assets: [entry('x')], deps: store.deps, appStore })).report, null);
    assert.deepEqual(saves, []);
});

test('apply saves the rewritten definition and moves the template stamp onto it', async () => {
    const store = memoryAssetStore();
    const calls = [];
    const appStore = {
        saveDefinition: async (id, owner, def) => { calls.push(['save', id, owner, def.design.logoUrl]); return { ok: true }; },
        setTemplateStamp: async (id, owner, stamp) => { calls.push(['stamp', id, stamp.templateVersion, stamp.templateInstallHash]); },
    };
    const out = await applyCopiedAssets({ app: APP, definition: defWith('old-1'), assets: [entry('old-1')], templateVersion: 4, deps: store.deps, appStore });
    const { hashDefinition } = require('./templateUpgrade');
    assert.deepEqual(calls, [['save', 'app-target', 'owner-1', 'asset:new-1'], ['stamp', 'app-target', 4, hashDefinition(out.definition)]]);
});
