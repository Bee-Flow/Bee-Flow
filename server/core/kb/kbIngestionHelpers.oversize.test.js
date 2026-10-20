'use strict';
/**
 * An oversized page is refused by fetchUrlContent (KB_WEB_PAGE_MAX_BYTES) and
 * never falls through to the headless browser. Run: node --test core/kb/kbIngestionHelpers.oversize.test.js
 */
const test = require('node:test');
const assert = require('node:assert');

const ssrf = require('../../utils/ssrfGuard');
const helpers = require('./kbIngestionHelpers');

test('fetchUrlContent refuses a page over KB_WEB_PAGE_MAX_BYTES with a message naming the variable', async () => {
    const origSafeFetch = ssrf.safeFetch;
    const prev = process.env.KB_WEB_PAGE_MAX_BYTES;
    process.env.KB_WEB_PAGE_MAX_BYTES = '1000';
    ssrf.safeFetch = async () => new Response('<html><body>' + 'x'.repeat(5000) + '</body></html>', { status: 200, headers: { 'content-type': 'text/html' } });
    try {
        await assert.rejects(() => helpers.fetchUrlContent('https://93.184.216.34/page'), /KB_WEB_PAGE_MAX_BYTES/);
    } finally {
        ssrf.safeFetch = origSafeFetch;
        if (prev === undefined) delete process.env.KB_WEB_PAGE_MAX_BYTES; else process.env.KB_WEB_PAGE_MAX_BYTES = prev;
    }
});
