'use strict';
/** Span URLs carry no query string and no token-like path segment. Run: node --test telemetry/spanUrl.test.js */
const test = require('node:test');
const assert = require('node:assert/strict');
const { scrubPath, scrubUrl, scrubSpanUrls } = require('./spanUrl.mts');

const TOKEN = 'a3f9c2e81b7d4f60a3f9c2e81b7d4f60a3f9c2e81b7d4f60';

test('a share token in the path is masked and the query string dropped', () => {
    assert.equal(scrubPath(`/api/public/share/${TOKEN}?email=x@y.example`), '/api/public/share/:token');
    assert.equal(scrubUrl(`https://u:p@host.example/s/${TOKEN}/view?token=abc#f`), 'https://host.example/s/:token/view');
});

test('ids and ordinary words stay readable', () => {
    assert.equal(scrubPath('/api/agents/8b0e6a3c-1d2f-4a5b-9c8d-7e6f5a4b3c2d/chat'), '/api/agents/8b0e6a3c-1d2f-4a5b-9c8d-7e6f5a4b3c2d/chat');
    assert.equal(scrubPath('/api/knowledge-bases/123/documents'), '/api/knowledge-bases/123/documents');
    assert.equal(scrubPath('/api/conversation-messages-export-settings'), '/api/conversation-messages-export-settings');
});

test('a started span\'s URL attributes are rewritten in place', () => {
    const attributes = { 'http.target': `/s/${TOKEN}?q=1`, 'url.full': `https://h.example/s/${TOKEN}?q=1`, 'url.query': 'q=1', 'http.method': 'GET' };
    const span = { attributes, setAttribute(k, v) { attributes[k] = v; } };
    scrubSpanUrls(span);
    assert.deepEqual(attributes, { 'http.target': '/s/:token', 'url.full': 'https://h.example/s/:token', 'http.method': 'GET' });
});
