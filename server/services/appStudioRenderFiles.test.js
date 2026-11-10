/**
 * The screenshot page's in-process files (appStudioRenderFiles.mts): self-hosted fonts from a
 * listed folder, and the rendered app's own scanned assets. Nothing else, and never a path
 * joined onto a folder.
 *
 * Run: node --test services/appStudioRenderFiles.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');

const { makeFileFulfil, FONT_DIRS, SCREENSHOT_ASSET_PREFIX, _resetFontIndex } = require('./appStudioRenderFiles.mts');

const APP = { id: 'app1', userId: 'owner-9' };

function fontDir() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-fonts-'));
    fs.mkdirSync(path.join(dir, 'inter'));
    fs.writeFileSync(path.join(dir, 'inter', 'Inter-Variable.woff2'), Buffer.from('wOF2-bytes'));
    fs.writeFileSync(path.join(dir, 'inter', 'notes.txt'), 'not a font');
    return dir;
}

test.beforeEach(() => _resetFontIndex());

test('a listed font is served as woff2; anything else under fonts/ is not', async () => {
    const dir = fontDir();
    const fulfil = makeFileFulfil(null, { fontDirs: [path.join(dir, 'missing'), dir] });
    const font = await fulfil('fonts/inter/Inter-Variable.woff2');
    assert.equal(font.contentType, 'font/woff2');
    assert.equal(font.body.toString(), 'wOF2-bytes');
    assert.equal(await fulfil('fonts/inter/notes.txt'), null);
    assert.equal(await fulfil('fonts/../inter/Inter-Variable.woff2'), null);
    assert.equal(await fulfil('fonts/inter/../../etc/passwd'), null);
    assert.equal(await fulfil('somewhere/else'), null);
});

test('the default font folders are the staged bundle folder, then agent-hub/public/fonts', () => {
    assert.ok(FONT_DIRS[0].endsWith(path.join('vendor', 'app-runtime', 'fonts')));
    assert.ok(FONT_DIRS[1].endsWith(path.join('agent-hub', 'public', 'fonts')));
});

function assetDeps(rows, bytes = Buffer.from('png-bytes')) {
    const seen = [];
    return {
        seen,
        deps: {
            fontDirs: [],
            getAssetRow: async (app, id) => { seen.push([app.id, id]); return rows[id] || null; },
            openAsset: async () => ({ stream: Readable.from([bytes]) }),
        },
    };
}

test('an asset of the rendered app is read through its store, scanned files only', async () => {
    const { deps, seen } = assetDeps({
        logo_1: { id: 'logo_1', mimeType: 'image/png', scanned: true, quarantined: false },
        raw_1: { id: 'raw_1', mimeType: 'image/png', scanned: false, quarantined: false },
        bad_1: { id: 'bad_1', mimeType: 'image/png', scanned: true, quarantined: true },
    });
    const fulfil = makeFileFulfil(APP, deps);
    const file = await fulfil(`${SCREENSHOT_ASSET_PREFIX}logo_1`);
    assert.deepEqual(file, { contentType: 'image/png', body: Buffer.from('png-bytes') });
    assert.deepEqual(seen, [['app1', 'logo_1']], 'looked up under the rendered app, never one named in the URL');
    assert.equal(await fulfil(`${SCREENSHOT_ASSET_PREFIX}raw_1`), null, 'not scanned yet');
    assert.equal(await fulfil(`${SCREENSHOT_ASSET_PREFIX}bad_1`), null, 'quarantined');
    assert.equal(await fulfil(`${SCREENSHOT_ASSET_PREFIX}nope`), null);
    assert.equal(await fulfil(`${SCREENSHOT_ASSET_PREFIX}a/b`), null, 'not an asset id');
    assert.equal(await fulfil('api/studio-apps/other-app/assets/logo_1'), null);
});

test('without an app row no asset is served', async () => {
    const { deps, seen } = assetDeps({ logo_1: { id: 'logo_1', mimeType: 'image/png', scanned: true, quarantined: false } });
    assert.equal(await makeFileFulfil(null, deps)(`${SCREENSHOT_ASSET_PREFIX}logo_1`), null);
    assert.equal(seen.length, 0);
});

test('a failing store answers nothing instead of throwing into the page route', async () => {
    const fulfil = makeFileFulfil(APP, { fontDirs: [], getAssetRow: async () => { throw new Error('db down'); }, openAsset: async () => null });
    assert.equal(await fulfil(`${SCREENSHOT_ASSET_PREFIX}logo_1`), null);
});
