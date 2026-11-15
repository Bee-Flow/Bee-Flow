/**
 * aiStepImages.mts: when an ai_step / data_extraction step shows a picture to
 * the model, and what it does instead.
 *
 * Proven: the setting is off by default and then the OCR text goes; a run
 * under the Privacy Shield never sends an image (OCR text and a note instead);
 * a model without vision gets the text; a dry run never loads an image; a
 * handle no step of this run read is not loaded; the per-step caps (count and
 * MB, 0 = none) hold; what does go is an image_url data-URL block behind the
 * guarded text.
 *
 * Run: cd server && node --test core/automationRunner/aiStepImages.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const { test, afterEach } = require('node:test');
const assert = require('node:assert');
const images = require('./aiStepImages.mts');

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const handle = (path) => ({ kind: 'nextcloud_image', path, contentType: 'image/png' });

/** A run in which step `read` read two receipts (a fan-out) through OCR. */
function runState() {
    return {
        trigger: { output: {} },
        steps: {
            read: { output: { iterations: 2, results: [
                { index: 0, output: { path: '/R/a.png', content: 'TOTAL 12,50', sourceHandle: handle('/R/a.png') } },
                { index: 1, output: { path: '/R/b.png', content: 'TOTAL 7,00', sourceHandle: handle('/R/b.png') } },
            ] } },
        },
        secrets: {},
    };
}

const STEP = { id: 'ask', images: [{ kind: 'ref', path: 'steps.read.output' }] };
const LIVE = { step: STEP, ctx: { orgId: 'org1', userId: 'u1' }, runState: runState(), mode: 'live', modelId: 'm', policy: { piiEnabled: false } };

function deps(over = {}) {
    const loaded = [];
    return {
        loaded,
        d: {
            imageAiEnabled: async () => true,
            modelAcceptsImages: async () => true,
            loadImage: async (path, _ctx, opts) => { loaded.push({ path, maxBytes: opts.maxBytes }); return { ok: true, buffer: PNG, mimeType: 'image/png' }; },
            ...over,
        },
    };
}

afterEach(() => { delete process.env.AUTOMATION_AI_IMAGES_MAX; delete process.env.AUTOMATION_AI_IMAGES_MAX_MB; });

test('a step without images is untouched', async () => {
    assert.strictEqual(await images.prepareStepImages({ ...LIVE, step: { id: 'x' } }, deps().d), null);
});

test('all gates open: each image goes as a data-URL image_url block, in order, with no fallback text', async () => {
    const { d, loaded } = deps();
    const prep = await images.prepareStepImages(LIVE, d);
    assert.deepStrictEqual(loaded.map((l) => l.path), ['/R/a.png', '/R/b.png']);
    assert.strictEqual(prep.report.sent, 2);
    assert.strictEqual(prep.report.note, null);
    assert.strictEqual(prep.fallbackText, '');
    assert.deepStrictEqual(prep.blocks[1], { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG.toString('base64')}` } });
    assert.match(prep.blocks[0].text, /a\.png, b\.png/);
    const msg = images.withImageBlocks(images.withImageText({ role: 'user', content: 'Inputs' }, prep), prep);
    assert.strictEqual(msg.content[0].text, 'Inputs');
    assert.strictEqual(msg.content.length, 4);
});

test('the setting is off by default: nothing is loaded, the OCR text and a note go instead', async () => {
    const { d, loaded } = deps({ imageAiEnabled: async () => false });
    const prep = await images.prepareStepImages(LIVE, d);
    assert.deepStrictEqual(loaded, []);
    assert.deepStrictEqual(prep.blocks, []);
    assert.match(prep.fallbackText, /TOTAL 12,50/);
    assert.match(prep.fallbackText, /TOTAL 7,00/);
    assert.match(prep.report.note, /off for this organisation/);
    assert.deepStrictEqual(prep.report.fellBack.map((f) => f.reason), ['setting_off', 'setting_off']);
    const msg = images.withImageBlocks(images.withImageText({ role: 'user', content: 'Inputs' }, prep), prep);
    assert.strictEqual(typeof msg.content, 'string', 'no image block, a plain text message');
    assert.match(msg.content, /Note: Images to AI is off/);
});

test('the Privacy Shield on the run refuses every image: OCR text and a note, never a block', async () => {
    const { d, loaded } = deps();
    const prep = await images.prepareStepImages({ ...LIVE, policy: { piiEnabled: true } }, d);
    assert.deepStrictEqual(loaded, []);
    assert.deepStrictEqual(prep.blocks, []);
    assert.match(prep.report.note, /Privacy Shield/);
    assert.match(prep.fallbackText, /TOTAL 12,50/);
    // An org that excluded automations from the shield is not shielded here.
    const excluded = await images.prepareStepImages({ ...LIVE, policy: { piiEnabled: false, disabledForAutomations: true } }, deps().d);
    assert.strictEqual(excluded.report.sent, 2);
});

test('a model that cannot see gets the text', async () => {
    const { d, loaded } = deps({ modelAcceptsImages: async () => false });
    const prep = await images.prepareStepImages(LIVE, d);
    assert.deepStrictEqual(loaded, []);
    assert.match(prep.report.note, /cannot read images/);
});

test('a dry run never loads or sends an image', async () => {
    const { d, loaded } = deps();
    const prep = await images.prepareStepImages({ ...LIVE, mode: 'dry_run' }, d);
    assert.deepStrictEqual(loaded, []);
    assert.deepStrictEqual(prep.blocks, []);
    assert.match(prep.report.note, /dry run/);
});

test('a handle no step of this run read is not loaded', async () => {
    const { d, loaded } = deps();
    const typed = { ...LIVE, step: { id: 'ask', images: [{ kind: 'literal', value: handle('/Private/elsewhere.png') }] } };
    const prep = await images.prepareStepImages(typed, d);
    assert.deepStrictEqual(loaded, []);
    assert.deepStrictEqual(prep.report.fellBack, [{ name: 'elsewhere.png', reason: 'not_read_in_run' }]);
    assert.match(prep.report.note, /not read by an earlier step/);
});

test('caps: at most AUTOMATION_AI_IMAGES_MAX images, the rest as text', async () => {
    process.env.AUTOMATION_AI_IMAGES_MAX = '1';
    const { d, loaded } = deps();
    const prep = await images.prepareStepImages(LIVE, d);
    assert.deepStrictEqual(loaded.map((l) => l.path), ['/R/a.png']);
    assert.strictEqual(prep.report.sent, 1);
    assert.deepStrictEqual(prep.report.fellBack, [{ name: 'b.png', reason: 'over_cap' }]);
    assert.match(prep.fallbackText, /TOTAL 7,00/);
    assert.doesNotMatch(prep.fallbackText, /TOTAL 12,50/);
});

test('caps: the MB budget is passed down and shrinks; 0 means no cap', async () => {
    process.env.AUTOMATION_AI_IMAGES_MAX_MB = '1';
    const { d, loaded } = deps();
    await images.prepareStepImages(LIVE, d);
    assert.strictEqual(loaded[0].maxBytes, 1024 * 1024);
    assert.strictEqual(loaded[1].maxBytes, 1024 * 1024 - PNG.length);
    process.env.AUTOMATION_AI_IMAGES_MAX_MB = '0';
    process.env.AUTOMATION_AI_IMAGES_MAX = '0';
    const free = deps();
    const prep = await images.prepareStepImages(LIVE, free.d);
    assert.strictEqual(free.loaded[0].maxBytes, 0);
    assert.strictEqual(prep.report.sent, 2);
});

test('an image over the size budget falls back as over_cap; an unreadable one as unreadable', async () => {
    process.env.AUTOMATION_AI_IMAGES_MAX_MB = '1';
    const { d } = deps({ loadImage: async (path) => (path.endsWith('a.png')
        ? { ok: false, reason: 'the image is larger than the size limit for images sent to AI' }
        : { ok: false, reason: 'the file is not a PNG, JPEG, GIF or WebP image' }) });
    const prep = await images.prepareStepImages(LIVE, d);
    assert.deepStrictEqual(prep.report.fellBack.map((f) => f.reason), ['over_cap', 'unreadable']);
});

test('text the step already reads is not repeated (a data_extraction source)', async () => {
    const { d } = deps({ imageAiEnabled: async () => false });
    const prep = await images.prepareStepImages({ ...LIVE, knownText: 'Receipt\nTOTAL 12,50\n' }, d);
    assert.doesNotMatch(prep.fallbackText, /TOTAL 12,50/);
    assert.match(prep.fallbackText, /TOTAL 7,00/);
});

test('handles are found in a single read answer, a fan-out and a bare handle', () => {
    assert.deepStrictEqual(images.collectImageHandles(handle('/x.png')), [{ kind: 'nextcloud_image', path: '/x.png' }]);
    assert.strictEqual(images.collectImageHandles(runState().steps.read.output).length, 2);
    assert.deepStrictEqual(images.collectImageHandles({ kind: 'nextcloud_image', path: '' }), []);
    assert.strictEqual(images.imagesReadInRun(runState()).get('/R/b.png'), 'TOTAL 7,00');
});
