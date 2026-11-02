/**
 * Run: cd server && node --test routes/studioAppAttachmentHeaders.test.js
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { attachmentResponseHeaders } = require('./studioAppAttachmentHeaders.mts');

test('SVG and other active types are downloads under a sandbox policy', () => {
    for (const mime of ['image/svg+xml', 'text/html', 'application/xml', 'application/octet-stream', 'IMAGE/SVG+XML; charset=utf-8']) {
        const h = attachmentResponseHeaders(mime);
        assert.strictEqual(h['Content-Disposition'], 'attachment', mime);
        assert.match(h['Content-Security-Policy'], /sandbox/, mime);
    }
});

test('raster images render inline, still sandboxed; PDF renders inline', () => {
    for (const mime of ['image/png', 'image/jpeg', 'image/webp', 'image/gif']) {
        const h = attachmentResponseHeaders(mime);
        assert.strictEqual(h['Content-Disposition'], 'inline', mime);
        assert.match(h['Content-Security-Policy'], /sandbox/, mime);
    }
    assert.deepStrictEqual(attachmentResponseHeaders('application/pdf'), { 'Content-Disposition': 'inline' });
});
