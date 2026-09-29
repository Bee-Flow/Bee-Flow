/**
 * Publish-time media dimension enrichment.
 *
 * Run: cd server && node --test utils/mediaDims.test.js
 */
const test = require('node:test');
const assert = require('node:assert');

const { enrichMediaDims, assetKeyFromSrc } = require('./mediaDims');

const probeOf = (map) => async (key) => map[key] || null;

test('asset keys are recognised in both stored forms, external URLs are not', () => {
    assert.strictEqual(assetKeyFromSrc('cms/beeflow-hive.svg'), 'cms/beeflow-hive.svg');
    assert.strictEqual(assetKeyFromSrc('/api/cms/asset/cms/shot.png'), 'cms/shot.png');
    assert.strictEqual(assetKeyFromSrc('/api/cms/asset/cms/a%20b.png'), 'cms/a b.png');
    assert.strictEqual(assetKeyFromSrc('https://example.com/x.png'), null);
    assert.strictEqual(assetKeyFromSrc(''), null);
});

test('media objects get dimensions wherever they sit in the tree', async () => {
    const tree = {
        blocks: [
            { type: 'hero', content: { media: { kind: 'image', src: 'cms/hero.png', alt: 'x', frame: 'browser' } } },
            {
                type: 'features',
                content: {
                    items: [
                        { title: 'a', media: { src: '/api/cms/asset/cms/f1.png', alt: '', frame: 'hairline', kind: 'image' } },
                    ],
                },
            },
        ],
    };
    const n = await enrichMediaDims(tree, probeOf({
        'cms/hero.png': { width: 1600, height: 1000 },
        'cms/f1.png': { width: 800, height: 600 },
    }));
    assert.strictEqual(n, 2);
    assert.deepStrictEqual(
        [tree.blocks[0].content.media.width, tree.blocks[0].content.media.height],
        [1600, 1000],
    );
    assert.strictEqual(tree.blocks[1].content.items[0].media.width, 800);
});

test('anything already carrying a dimension is left alone', async () => {
    // An embed frame's authored height has layout meaning; overwriting it
    // with an intrinsic image height would change the page.
    const embed = { src: 'cms/e.png', alt: 'embed', height: 480 };
    const done = { kind: 'image', src: 'cms/d.png', alt: '', frame: '', width: 10, height: 20 };
    const n = await enrichMediaDims({ a: embed, b: done }, probeOf({
        'cms/e.png': { width: 999, height: 999 },
        'cms/d.png': { width: 999, height: 999 },
    }));
    assert.strictEqual(n, 0);
    assert.strictEqual(embed.height, 480);
    assert.strictEqual(embed.width, undefined);
    assert.strictEqual(done.width, 10);
});

test('videos, external srcs and probe failures change nothing', async () => {
    const video = { kind: 'video', src: 'cms/clip.mp4', frame: 'browser' };
    const ext = { kind: 'image', src: 'https://cdn.example.com/x.png', alt: '' };
    const broken = { kind: 'image', src: 'cms/corrupt.png', alt: '', frame: '' };
    const n = await enrichMediaDims([video, ext, broken], async (key) => {
        if (key === 'cms/corrupt.png') throw new Error('boom');
        return { width: 1, height: 1 };
    });
    assert.strictEqual(n, 0);
    assert.strictEqual(video.width, undefined);
    assert.strictEqual(ext.width, undefined);
    assert.strictEqual(broken.width, undefined);
});

test('one asset used by many media objects is probed once', async () => {
    let calls = 0;
    const probe = async () => { calls++; return { width: 5, height: 5 }; };
    const a = { kind: 'image', src: 'cms/same.png', alt: '', frame: '' };
    const b = { kind: 'image', src: 'cms/same.png', alt: '', frame: '' };
    const n = await enrichMediaDims([a, b], probe);
    assert.strictEqual(n, 2);
    assert.strictEqual(calls, 1);
});
