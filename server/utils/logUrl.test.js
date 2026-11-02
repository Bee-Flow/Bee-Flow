'use strict';
/**
 * Run: cd server && node --test utils/logUrl.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const { urlWithoutQuery } = require('./logUrl.mts');

test('a server URL is logged without its query string or credentials', () => {
    assert.strictEqual(urlWithoutQuery('https://user:pw@mcp.example.test/v1/sse?token=abc'), 'https://mcp.example.test/v1/sse');
    assert.strictEqual(urlWithoutQuery('not a url'), '[invalid url]');
});
