'use strict';
// node --test components/website-sitemap-fetcher/index.test.js
//
// safeGet.js and ssrfGuard.js here are byte copies of the ones in
// webpage-to-markdown (scripts/check-duplicated-files.mjs); their own tests
// live there. This file proves the sitemap fetcher actually goes through them.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { fetchUrl, processSitemap } = require('./index');

let server;
let port;
let hits = 0;

before(async () => {
    server = http.createServer((req, res) => {
        hits++;
        res.writeHead(200, { 'content-type': 'application/xml' });
        res.end('<?xml version="1.0"?><urlset><url><loc>http://127.0.0.1/internal-only</loc></url></urlset>');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    port = server.address().port;
});

after(() => new Promise(resolve => server.close(resolve)));

test('fetchUrl refuses a loopback sitemap instead of reading it', async () => {
    const before = hits;
    await assert.rejects(
        fetchUrl(`http://127.0.0.1:${port}/sitemap.xml`, 5000),
        /Failed to fetch http:\/\/127\.0\.0\.1:\d+\/sitemap\.xml: Refused: target resolves to a private\/internal address\./,
    );
    assert.equal(hits, before, 'the internal server was never contacted');
});

test('fetchUrl refuses the metadata endpoint', async () => {
    await assert.rejects(
        fetchUrl('http://169.254.169.254/latest/meta-data/', 5000),
        /Refused: target resolves to a private\/internal address\./,
    );
});

test('a nested sitemap pointing at an internal host is skipped, not fetched', async () => {
    const before = hits;
    const allUrls = new Set();
    const visited = new Set();
    await processSitemap(`http://localhost:${port}/sitemap.xml`, 5000, undefined, 100, visited, allUrls);
    assert.equal(hits, before);
    assert.equal(allUrls.size, 0);
});
