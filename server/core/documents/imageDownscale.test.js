/**
 * Image downscaling — the two caps that fail a whole request.
 *
 * The regression behind the byte half: seven phone photos of a meter cupboard,
 * every one of them already inside the 2000px dimension cap, came to over
 * twenty megabytes as PNG and Anthropic answered 413 request_too_large. The
 * module measured pixels and never bytes, so it passed all seven through
 * untouched and reported success.
 *
 * Run: node --test core/documents/imageDownscale.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const { downscaleClaudeMessages, MAX_IMAGE_BYTES, MAX_REQUEST_IMAGE_BYTES } = require('./imageDownscale');

let sharp = null;
try { sharp = require('sharp'); } catch { /* covered by the skip below */ }

/** A photographic-ish PNG: noise, so it does not compress away to nothing. */
async function noisyPng(w, h) {
    // Real high-entropy noise. An arithmetic ramp looks random and compresses
    // to nothing, which quietly made the fixture too small to test with.
    const px = Buffer.alloc(w * h * 3);
    let x = 123456789;
    for (let i = 0; i < px.length; i++) {
        x ^= x << 13; x >>>= 0;
        x ^= x >>> 17;
        x ^= x << 5; x >>>= 0;
        px[i] = x & 0xff;
    }
    return sharp(px, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
}

function imageBlock(buf, mediaType = 'image/png') {
    return { type: 'image', source: { type: 'base64', media_type: mediaType, data: buf.toString('base64') } };
}

test('a heavy PNG inside the dimension cap is still shrunk', { skip: !sharp && 'sharp unavailable' }, async () => {
    const png = await noisyPng(1900, 1900);   // under 2000px on both sides
    assert.ok(png.length > MAX_IMAGE_BYTES, `fixture must be heavy (${png.length} bytes)`);

    const messages = [{ role: 'user', content: [imageBlock(png)] }];
    await downscaleClaudeMessages(messages);

    const out = messages[0].content[0];
    assert.strictEqual(out.type, 'image', 'the picture survives — it is what the model was asked about');
    const bytes = Buffer.byteLength(out.source.data, 'base64');
    assert.ok(bytes < png.length, `must get smaller: ${png.length} → ${bytes}`);
    assert.strictEqual(out.source.media_type, 'image/jpeg', 'a photograph is re-encoded, not left as PNG');
});

test('a small PNG is left exactly alone', { skip: !sharp && 'sharp unavailable' }, async () => {
    const png = await sharp({ create: { width: 40, height: 40, channels: 3, background: '#336699' } }).png().toBuffer();
    const before = png.toString('base64');
    const messages = [{ role: 'user', content: [imageBlock(png)] }];
    await downscaleClaudeMessages(messages);
    assert.strictEqual(messages[0].content[0].source.data, before, 'identity for anything already small');
    assert.strictEqual(messages[0].content[0].source.media_type, 'image/png', 'and its encoding is untouched');
});

test('the request budget is enforced across images, with a note in place of the drop', { skip: !sharp && 'sharp unavailable' }, async () => {
    // A JPEG just UNDER the per-image cap, repeated until the request budget
    // must bite. Every one of them passes the per-image check on its own and
    // is left untouched — which is the whole point: the failure this guards
    // against is collective, not individual.
    let jpg = null;
    for (const quality of [92, 85, 75, 60, 45]) {
        const candidate = await sharp(await noisyPng(1400, 1400)).jpeg({ quality }).toBuffer();
        if (candidate.length < MAX_IMAGE_BYTES) { jpg = candidate; break; }
    }
    assert.ok(jpg, 'could not build a fixture under the per-image cap');
    const count = Math.ceil(MAX_REQUEST_IMAGE_BYTES / jpg.length) + 2;

    const content = [];
    for (let i = 0; i < count; i++) content.push(imageBlock(jpg, 'image/jpeg'));
    const messages = [{ role: 'user', content }];
    await downscaleClaudeMessages(messages);

    const kept = messages[0].content.filter((b) => b.type === 'image');
    const notes = messages[0].content.filter((b) => b.type === 'text');
    assert.ok(kept.length > 0, 'some images still go');
    assert.ok(notes.length > 0, 'the overflow is announced, never silently dropped');
    assert.ok(/omitted/i.test(notes[0].text), notes[0].text);

    const total = kept.reduce((n, b) => n + Buffer.byteLength(b.source.data, 'base64'), 0);
    assert.ok(total <= MAX_REQUEST_IMAGE_BYTES, `kept ${total} bytes, budget ${MAX_REQUEST_IMAGE_BYTES}`);
});

test('URL-source images are not touched', { skip: !sharp && 'sharp unavailable' }, async () => {
    const messages = [{ role: 'user', content: [{ type: 'image', source: { type: 'url', url: 'https://example.test/a.png' } }] }];
    await downscaleClaudeMessages(messages);
    assert.deepStrictEqual(messages[0].content[0].source, { type: 'url', url: 'https://example.test/a.png' });
});
