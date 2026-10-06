/**
 * A payload over the cap keeps its SHAPE in the sentinel.
 *
 * The sentinel used to carry only a 1 KB head of the serialized text. Every
 * reader of run steps got that (the editor's field discovery, the AI
 * builder's hint), so the deep fields of a big nested output (a page of
 * Graph mails, a Gmail thread with parts inside parts) were never offered
 * for mapping. The sentinel now carries `preview`: the same value with long
 * strings shortened, long lists cut to their first elements (the original
 * length in `previewCut`) and the depth kept, so every field stays
 * discoverable at its real path. Never the whole payload: the preview has a
 * byte budget and gets coarser until it fits.
 *
 * Run: node --test automation/payloadTruncation.preview.test.js
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    truncatePayload, isTruncatedOutput, shapePreview, DEFAULT_MAX_BYTES, PREVIEW_MAX_BYTES,
} = require('./payloadTruncation');
const { getPath } = require('./expr');

const part = (i) => ({
    mimeType: 'multipart/alternative',
    headers: [{ name: 'Content-Type', value: 'text/plain' }],
    parts: [{ mimeType: 'text/html', body: { size: 9000, data: 'PGh0bWw+'.repeat(1200) }, 'x-odd key': i }],
});
const GMAIL = {
    messages: Array.from({ length: 40 }, (_, i) => ({
        id: `m${i}`,
        payload: { headers: [{ name: 'Subject', value: `Mail ${i}` }], parts: [part(i), part(i + 1)] },
        ...(i === 3 ? { labelIds: ['INBOX'] } : {}),
    })),
    nextPageToken: 'abc',
    raw: JSON.stringify({ data: { items: Array.from({ length: 500 }, (_, i) => ({ id: i, note: 'n'.repeat(300) })) } }),
};

/** Every path of a value with [*] for lists (the shape), from the FIRST element of each list. */
function shapePaths(v, prefix = '', out = new Set()) {
    if (Array.isArray(v)) { if (v.length) shapePaths(v[0], `${prefix}[*]`, out); return out; }
    if (v && typeof v === 'object') {
        for (const k of Object.keys(v)) shapePaths(v[k], prefix ? `${prefix}${/^[A-Za-z_$][\w$]*$/.test(k) ? `.${k}` : `[${JSON.stringify(k)}]`}` : (/^[A-Za-z_$][\w$]*$/.test(k) ? k : `[${JSON.stringify(k)}]`), out);
        return out;
    }
    out.add(prefix);
    return out;
}

test('an output over the cap carries a shape-preserving preview within its budget', () => {
    const r = truncatePayload(GMAIL);
    assert.equal(r.truncated, true);
    assert.ok(r.originalBytes > DEFAULT_MAX_BYTES);
    assert.ok(isTruncatedOutput(r.value));
    const { preview, previewCut } = r.value;
    assert.ok(preview && typeof preview === 'object', 'a preview is there');
    assert.ok(Buffer.byteLength(JSON.stringify({ preview, previewCut })) <= PREVIEW_MAX_BYTES);
    // Depth kept: the deepest leaf is still at its real path.
    assert.equal(typeof getPath({ o: preview }, 'o.messages[0].payload.parts[0].parts[0].body.data'), 'string');
    assert.equal(getPath({ o: preview }, 'o.messages[0].payload.parts[0].parts[0]["x-odd key"]'), 0);
    // Every path of the first element's shape survives.
    for (const p of shapePaths(GMAIL.messages[0])) {
        assert.ok(shapePaths(preview.messages[0]).has(p), `missing ${p}`);
    }
    // Lists are cut, and say how long they were.
    assert.ok(preview.messages.length < 40);
    assert.equal(previewCut.messages, 40);
    // Long text is shortened, short text kept.
    assert.ok(preview.messages[0].payload.parts[0].parts[0].body.data.length < 300);
    assert.ok(preview.messages[0].payload.parts[0].parts[0].body.data.endsWith('…'));
    assert.equal(preview.nextPageToken, 'abc');
});

test('long JSON text stays JSON text with its shape', () => {
    const { preview, previewCut } = shapePreview(GMAIL, { maxBytes: PREVIEW_MAX_BYTES });
    const inner = JSON.parse(preview.raw);
    assert.equal(typeof inner.data.items[0].id, 'number');
    assert.ok(inner.data.items.length < 500);
    assert.equal(getPath({ o: preview }, 'o.raw.data.items[0].id'), 0, 'the runtime reads into it like the real one');
    assert.equal(previewCut['raw.data.items'], 500);
});

test('a root list and odd keys get canonical paths in previewCut', () => {
    const rows = Array.from({ length: 50 }, (_, i) => ({ 'line-items': Array.from({ length: 20 }, (_, j) => ({ j })), i }));
    const { preview, previewCut } = shapePreview(rows, { maxBytes: PREVIEW_MAX_BYTES });
    assert.ok(Array.isArray(preview));
    assert.equal(previewCut.$, 50);
    assert.equal(previewCut['[0]["line-items"]'], 20);
});

test('a pathological payload gets a coarser preview or none, never one over budget', () => {
    const wide = {};
    for (let i = 0; i < 20000; i++) wide[`key_${i}`] = { v: 'x'.repeat(50) };
    const p = shapePreview(wide, { maxBytes: 4096 });
    if (p) {
        assert.ok(Buffer.byteLength(JSON.stringify(p)) <= 4096);
        assert.ok(Object.keys(p.preview).length < 20000);
    }
    let deep = { leaf: 'end' };
    for (let i = 0; i < 5000; i++) deep = { d: deep };
    const d = shapePreview(deep, { maxBytes: PREVIEW_MAX_BYTES });
    assert.ok(!d || Buffer.byteLength(JSON.stringify(d)) <= PREVIEW_MAX_BYTES, 'very deep input does not throw or blow the budget');
});

test('values under the cap are untouched and carry no preview', () => {
    const r = truncatePayload({ a: 1 });
    assert.equal(r.truncated, false);
    assert.deepEqual(r.value, { a: 1 });
});
