'use strict';

/**
 * The pure rules of the App Studio asset store (appAssets.mts) and what they change in the
 * definition pipeline: the sniffed type, the refs a definition holds, stripping them for a
 * copy, the operator budget, and `asset:<id>` in image.src / design.logoUrl.
 *
 * Run: cd server && node --test appStudio/appAssets.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const assets = require('./appAssets.mts');
const { canonicalizeAppDefinition } = require('./canonicalize');
const { validateAppDefinition } = require('./validate');
const { requiredSchemaVersion } = require('./schemaSince.mts');
const { sniffFamily, magicMatchesDeclared } = require('../middleware/uploadGuard');

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

function woff2(size = 64, claimed = size) {
    const b = Buffer.alloc(size);
    b.write('wOF2', 0, 'latin1');
    b.writeUInt32BE(claimed, 8);
    return b;
}

function appWith({ src = 'https://example.com/a.png', logoUrl, srcFrom } = {}) {
    const props = { src, ...(srcFrom ? { srcFrom } : {}) };
    return {
        meta: { name: 'A' },
        ...(logoUrl !== undefined ? { design: { logoUrl } } : {}),
        homeScreenId: 'scr_aaaa1111',
        screens: [{ id: 'scr_aaaa1111', name: 'S', sections: [{ id: 'sec_aaaa1111', children: [{ id: 'cmp_aaaa1111', type: 'image', props }] }] }],
        actions: {},
    };
}

test('the type comes from the bytes: raster images and a WOFF2 whose header names its own length', () => {
    assert.equal(assets.sniffAssetMime(PNG), 'image/png');
    assert.equal(assets.sniffAssetMime(woff2()), 'font/woff2');
    assert.equal(assets.sniffAssetMime(woff2(64, 65)), null, 'a header that lies about the length is not a font');
    assert.equal(assets.sniffAssetMime(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')), null);
    assert.equal(assets.sniffAssetMime(Buffer.from('%PDF-1.7 ...')), null);
    assert.equal(assets.sniffAssetMime(Buffer.from('wOF2 and then some text')), null);
});

test('the upload guard knows woff2 by the same rule, and a text file that starts with the tag stays text', () => {
    assert.equal(sniffFamily(woff2()), 'woff2');
    assert.equal(magicMatchesDeclared('font/woff2', woff2()), true);
    assert.equal(magicMatchesDeclared('font/woff2', woff2(64, 99)), false);
    assert.equal(sniffFamily(Buffer.from('wOF2 is a word in this sentence that is long enough to fill the header.')), 'text');
});

test('the operator budget: unset or garbage is the default, 0 is unlimited, a number is that number', () => {
    assert.equal(assets.assetTotalBytesBudget({}), assets.DEFAULT_ASSET_TOTAL_BYTES);
    assert.equal(assets.assetTotalBytesBudget({ STUDIO_APP_ASSET_TOTAL_BYTES: 'lots' }), assets.DEFAULT_ASSET_TOTAL_BYTES);
    assert.equal(assets.assetTotalBytesBudget({ STUDIO_APP_ASSET_TOTAL_BYTES: '-1' }), assets.DEFAULT_ASSET_TOTAL_BYTES);
    assert.equal(assets.assetTotalBytesBudget({ STUDIO_APP_ASSET_TOTAL_BYTES: '0' }), Infinity);
    assert.equal(assets.assetTotalBytesBudget({ STUDIO_APP_ASSET_TOTAL_BYTES: '2048' }), 2048);
});

test('collectAssetRefs finds every asset:<id> with its paths; stripAssetRefs nulls them and says where', () => {
    const def = appWith({ src: 'asset:a1', logoUrl: 'asset:a1', srcFrom: { kind: 'static', value: 'asset:b2' } });
    const refs = assets.collectAssetRefs(def);
    assert.deepEqual([...refs.keys()].sort(), ['a1', 'b2']);
    assert.deepEqual(refs.get('a1').sort(), ['design.logoUrl', 'screens[0].sections[0].children[0].props.src']);
    assert.equal(assets.hasAssetRef(def), true);
    assert.equal(assets.hasAssetRef(appWith()), false);
    assert.equal(assets.collectAssetRefs({ text: 'see asset:a1 here', bad: 'asset:a.b' }).size, 0, 'only a whole, well-formed value is a reference');

    const stripped = assets.stripAssetRefs(def);
    assert.equal(stripped.length, 3);
    assert.equal(def.design.logoUrl, null);
    assert.equal(def.screens[0].sections[0].children[0].props.src, null);
    assert.equal(assets.hasAssetRef(def), false);
});

test('an existing https image and logo keep their bytes and version; an asset ref is accepted and needs version 3', () => {
    const before = canonicalizeAppDefinition(appWith({ logoUrl: 'https://example.com/logo.png' })).def;
    assert.equal(before.schemaVersion, 2);
    assert.equal(before.design.logoUrl, 'https://example.com/logo.png');
    assert.equal('srcFrom' in before.screens[0].sections[0].children[0].props, false, 'the added prop is not written when absent');
    assert.equal(requiredSchemaVersion(before), 2);

    const withAsset = canonicalizeAppDefinition(appWith({ src: 'asset:a1', logoUrl: 'asset:a1' })).def;
    assert.equal(withAsset.schemaVersion, 3);
    assert.equal(withAsset.design.logoUrl, 'asset:a1');
    assert.equal(withAsset.screens[0].sections[0].children[0].props.src, 'asset:a1');
    const { ok, errors } = validateAppDefinition(withAsset);
    assert.equal(ok, true, JSON.stringify(errors));

    const bound = canonicalizeAppDefinition(appWith({ srcFrom: { kind: 'static', value: null } })).def;
    assert.equal(bound.schemaVersion, 3, 'image.srcFrom is since 3');
    assert.equal(canonicalizeAppDefinition(appWith({ srcFrom: null })).def.schemaVersion, 2, 'a null srcFrom leaves no trace');
});

test('a malformed asset value is still refused where only an https URL was', () => {
    const { def, repairs } = canonicalizeAppDefinition(appWith({ logoUrl: 'asset:has space' }));
    assert.equal(def.design.logoUrl, null);
    assert.ok(repairs.some((r) => r.code === 'design.value_invalid'));
    const bad = canonicalizeAppDefinition(appWith({ src: 'asset:' })).def;
    assert.ok(validateAppDefinition(bad).errors.some((e) => e.code === 'prop.url_invalid'));
});

test('the missing-asset warning only runs with a list, and names the first path', () => {
    const def = canonicalizeAppDefinition(appWith({ src: 'asset:a1', logoUrl: 'asset:zz' })).def;
    assert.deepEqual(validateAppDefinition(def).warnings.filter((w) => w.code === 'asset.missing'), []);
    const { warnings } = validateAppDefinition(def, { assetIds: ['a1'] });
    assert.deepEqual(warnings.filter((w) => w.code === 'asset.missing').map((w) => w.path), ['design.logoUrl']);
});

test('the public page look accepts an asset logo; served headers never let the browser guess', () => {
    const def = { ...appWith(), publicAccess: { entryScreenId: 'scr_aaaa1111', design: { logoUrl: 'asset:p1' } } };
    const canon = canonicalizeAppDefinition(def).def;
    assert.equal(canon.publicAccess.design.logoUrl, 'asset:p1');
    assert.equal(validateAppDefinition(canon).ok, true);
    const headers = assets.assetResponseHeaders('image/svg+xml');
    assert.equal(headers['Content-Type'], 'application/octet-stream', 'a type outside the list is never served as itself');
    assert.equal(headers['X-Content-Type-Options'], 'nosniff');
});

test('a record purge never deletes an asset row, and keeps the blob an asset still names', async () => {
    const { purgeAttachments } = require('./connectorRetention.mts');
    let rows = [
        { id: 'asset-1', sha256: 'same', fieldKey: assets.ASSET_FIELD_KEY },
        { id: 'att-1', sha256: 'same', fieldKey: 'photo' },
    ];
    const deleted = [];
    const files = [];
    await purgeAttachments({ id: 'app', userId: 'owner' }, ['asset-1', 'att-1'], {
        listAttachments: async () => rows,
        deleteAttachment: async (id) => { deleted.push(id); rows = rows.filter((r) => r.id !== id); },
        deleteFile: async (key) => { files.push(key); },
        buildAttachmentKey: (o, a, sha) => `${o}/${a}/${sha}`,
    });
    assert.deepEqual(deleted, ['att-1']);
    assert.deepEqual(files, []);
});
