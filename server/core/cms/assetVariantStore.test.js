// @typecheck
const test = require('node:test');
const assert = require('node:assert');
const sharp = require('sharp');
const { variantKey, storeVariants, scheduleVariants } = require('./assetVariantStore');

async function sample() {
    const raw = Buffer.alloc(1400 * 100 * 3);
    for (let i = 0; i < raw.length; i++) raw[i] = (i * 7919) % 251;
    return sharp(raw, { raw: { width: 1400, height: 100, channels: 3 } }).jpeg({ quality: 100 }).toBuffer();
}

function fakeStorage(failOn = '') {
    /** @type {Map<string, { body: Buffer, type: string }>} */
    const files = new Map();
    return {
        files,
        async uploadFile(/** @type {string} */ key, /** @type {Buffer} */ body, /** @type {string} */ type) {
            if (failOn && key.includes(failOn)) throw new Error('disk full');
            files.set(key, { body, type });
        },
    };
}

test('variant keys live outside the cms/ prefix, so the asset list and route never expose them', () => {
    assert.strictEqual(variantKey('cms/17-ab-hero.png', 640, 'avif'), 'cms-variants/17-ab-hero.png@640.avif');
});

test('an upload gets AVIF and WebP at every width narrower than the image', async () => {
    const storage = fakeStorage();
    const n = await storeVariants({ key: 'cms/1-a-x.jpg', source: await sample(), contentType: 'image/jpeg', storage });
    // 320, 640, 960, 1280 are narrower than 1400; 1920 would enlarge.
    assert.strictEqual(n, 8);
    const avif = storage.files.get('cms-variants/1-a-x.jpg@640.avif');
    assert.ok(avif && avif.type === 'image/avif');
    assert.strictEqual((await sharp(avif.body).metadata()).width, 640);
});

test('svg, video and undecodable bytes store nothing and do not throw', async () => {
    const storage = fakeStorage();
    assert.strictEqual(await storeVariants({ key: 'cms/1-a.svg', source: Buffer.from('<svg/>'), contentType: 'image/svg+xml', storage }), 0);
    assert.strictEqual(await storeVariants({ key: 'cms/1-a.png', source: Buffer.from('junk'), contentType: 'image/png', storage }), 0);
    assert.strictEqual(storage.files.size, 0);
});

test('a storage failure for one variant does not stop the others or throw', async () => {
    const storage = fakeStorage('@640.');
    const n = await storeVariants({ key: 'cms/1-a-y.jpg', source: await sample(), contentType: 'image/jpeg', storage });
    assert.strictEqual(n, 6);
});

test('scheduled jobs run one after another', async () => {
    const storage = fakeStorage();
    const source = await sample();
    const a = scheduleVariants({ key: 'cms/1-a-a.jpg', source, contentType: 'image/jpeg', storage });
    const b = scheduleVariants({ key: 'cms/1-a-b.jpg', source, contentType: 'image/jpeg', storage });
    assert.deepStrictEqual(await Promise.all([a, b]), [8, 8]);
});

test('the backfill handles images without a done marker, newest first, and skips handled ones', async () => {
    const { backfillVariants } = require('./assetVariantStore');
    const source = await sample();
    const storage = fakeStorage();
    const { Readable } = require('node:stream');
    const originals = new Map([['cms/1700000000002-a-new.jpg', source], ['cms/1700000000001-a-old.jpg', source], ['cms/1700000000000-a-clip.mp4', Buffer.from('v')]]);
    const full = Object.assign(storage, {
        async listKeys(/** @type {string} */ prefix) {
            return [...originals.keys(), ...storage.files.keys()].filter((k) => k.startsWith(prefix));
        },
        async streamFile(/** @type {string} */ key) {
            return { stream: Readable.from([originals.get(key)]), contentType: 'image/jpeg' };
        },
    });
    storage.files.set('cms-variants/1700000000001-a-old.jpg.done', { body: Buffer.from('1'), type: 'text/plain' });
    assert.strictEqual(await backfillVariants(full), 1);
    assert.ok(storage.files.has('cms-variants/1700000000002-a-new.jpg@640.avif'));
    assert.ok(storage.files.has('cms-variants/1700000000002-a-new.jpg.done'));
    assert.ok(!storage.files.has('cms-variants/1700000000001-a-old.jpg@640.avif'));
    assert.strictEqual(await backfillVariants(full), 0);
});

test('a storage that cannot list makes the backfill a quiet no-op', async () => {
    const { backfillVariants } = require('./assetVariantStore');
    const broken = Object.assign(fakeStorage(), {
        async listKeys() { throw new Error('local mode'); },
        async streamFile() { throw new Error('unused'); },
    });
    assert.strictEqual(await backfillVariants(broken), 0);
});
