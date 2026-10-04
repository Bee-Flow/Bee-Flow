/**
 * GET /learn-media/* — the video pack mount.
 *
 * Pins what the mount serves (only pack file types, with ranges and the right
 * cache policy) and what it refuses (traversal, dot files, listings, other
 * types, non-GET), and that a miss is a bare 404 rather than the SPA shell.
 *
 * Run: cd server && node --test learning/learnMedia.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const express = require('express');

const { createLearnMediaRouter, learnMediaDir, isServablePath, cacheControlFor, DEFAULT_DIR } = require('./learnMedia');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'learn-media-test-'));
const packDir = path.join(root, 'pack');
fs.mkdirSync(path.join(packDir, 'clips'), { recursive: true });
const VIDEO = Buffer.alloc(4096, 7);
fs.writeFileSync(path.join(packDir, 'manifest.json'), JSON.stringify({ version: '1', videos: {} }));
fs.writeFileSync(path.join(packDir, 'intro.3f9a2b1c.mp4'), VIDEO);
fs.writeFileSync(path.join(packDir, 'clips', 'plain.mp4'), VIDEO);
fs.writeFileSync(path.join(packDir, 'intro.3f9a2b1c.en.vtt'), 'WEBVTT\n');
fs.writeFileSync(path.join(packDir, 'notes.txt'), 'nope');
fs.writeFileSync(path.join(packDir, '.secret.json'), '{}');
fs.writeFileSync(path.join(root, 'outside.json'), '{"leak":true}');

let server;
let baseUrl;

test.before(async () => {
    const app = express();
    app.use('/learn-media', createLearnMediaRouter({ dir: packDir }));
    // Stand-in for the SPA renderer: a miss must never reach it.
    app.use((req, res) => res.status(200).type('html').send('<!doctype html><div id="root"></div>'));
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => {
    server?.close();
    fs.rmSync(root, { recursive: true, force: true });
});

// Raw request so the path reaches the server exactly as written (fetch would
// normalise `..` away before sending).
function get(rawPath, { method = 'GET', headers = {} } = {}) {
    return new Promise((resolve, reject) => {
        const req = http.request(`${baseUrl}/learn-media/x`, { method, headers, path: rawPath }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
        });
        req.on('error', reject);
        req.end();
    });
}

test('serves the manifest as JSON that is always revalidated', async () => {
    const res = await get('/learn-media/manifest.json');
    assert.strictEqual(res.status, 200);
    assert.match(res.headers['content-type'], /^application\/json/);
    assert.strictEqual(res.headers['cache-control'], 'no-cache');
    assert.strictEqual(res.headers['x-content-type-options'], 'nosniff');
    assert.deepStrictEqual(JSON.parse(res.body.toString()), { version: '1', videos: {} });
});

test('serves hashed media as immutable and supports range requests', async () => {
    const full = await get('/learn-media/intro.3f9a2b1c.mp4');
    assert.strictEqual(full.status, 200);
    assert.strictEqual(full.headers['content-type'], 'video/mp4');
    assert.strictEqual(full.headers['cache-control'], 'public, max-age=31536000, immutable');
    assert.strictEqual(full.headers['accept-ranges'], 'bytes');

    const part = await get('/learn-media/intro.3f9a2b1c.mp4', { headers: { Range: 'bytes=0-99' } });
    assert.strictEqual(part.status, 206);
    assert.strictEqual(part.body.length, 100);
    assert.strictEqual(part.headers['content-range'], `bytes 0-99/${VIDEO.length}`);
});

test('serves captions as text/vtt and unhashed files with a short cache', async () => {
    const vtt = await get('/learn-media/intro.3f9a2b1c.en.vtt');
    assert.strictEqual(vtt.status, 200);
    assert.match(vtt.headers['content-type'], /^text\/vtt/);
    const plain = await get('/learn-media/clips/plain.mp4');
    assert.strictEqual(plain.status, 200);
    assert.strictEqual(plain.headers['cache-control'], 'public, max-age=3600');
});

test('HEAD works, other methods do not', async () => {
    assert.strictEqual((await get('/learn-media/manifest.json', { method: 'HEAD' })).status, 200);
    const post = await get('/learn-media/manifest.json', { method: 'POST' });
    assert.strictEqual(post.status, 405);
    assert.strictEqual(post.headers.allow, 'GET, HEAD');
});

test('refuses traversal, dot files, listings and other types with a bare 404', async () => {
    for (const p of [
        '/learn-media/../outside.json',
        '/learn-media/clips/../../outside.json',
        '/learn-media/%2e%2e/outside.json',
        '/learn-media/..%2foutside.json',
        '/learn-media/clips%2fplain.mp4',
        '/learn-media/clips\\plain.mp4',
        '/learn-media/.secret.json',
        '/learn-media/notes.txt',
        '/learn-media/',
        '/learn-media/clips/',
        '/learn-media/clips',
        '/learn-media/missing.3f9a2b1c.mp4',
        '/learn-media/missing.json',
    ]) {
        const res = await get(p);
        assert.ok(res.status === 404 || res.status === 400, `${p} answered ${res.status}`);
        assert.ok(!/<!doctype html>/i.test(res.body.toString()), `${p} fell through to the SPA`);
        assert.ok(!res.body.toString().includes('leak'), `${p} leaked a file outside the pack`);
    }
});

test('a missing pack directory is a 404, not a crash', async () => {
    const app = express();
    app.use('/learn-media', createLearnMediaRouter({ dir: path.join(root, 'nope') }));
    const s = http.createServer(app);
    await new Promise((resolve) => s.listen(0, '127.0.0.1', resolve));
    try {
        const res = await fetch(`http://127.0.0.1:${s.address().port}/learn-media/manifest.json`);
        assert.strictEqual(res.status, 404);
    } finally {
        s.close();
    }
});

test('path and cache helpers', () => {
    assert.strictEqual(isServablePath('/a.mp4'), true);
    assert.strictEqual(isServablePath('/a/b.webp'), true);
    assert.strictEqual(isServablePath('/a.MP4'), true);
    assert.strictEqual(isServablePath('/a.html'), false);
    assert.strictEqual(isServablePath('a.mp4'), false);
    assert.strictEqual(isServablePath('/a/../b.mp4'), false);
    assert.strictEqual(isServablePath('/a/b/c/d/e.mp4'), false);
    assert.strictEqual(cacheControlFor('/x/manifest.json'), 'no-cache');
    assert.strictEqual(cacheControlFor('poster.abcdef0123.jpg'), 'public, max-age=31536000, immutable');
    assert.strictEqual(cacheControlFor('poster.jpg'), 'public, max-age=3600');
});

test('LEARN_MEDIA_DIR overrides the default directory', () => {
    assert.strictEqual(learnMediaDir({}), DEFAULT_DIR);
    assert.strictEqual(learnMediaDir({ LEARN_MEDIA_DIR: '  ' }), DEFAULT_DIR);
    assert.strictEqual(learnMediaDir({ LEARN_MEDIA_DIR: '/srv/media' }), path.resolve('/srv/media'));
    assert.ok(DEFAULT_DIR.endsWith(path.join('server', 'data', 'learn-media')));
});
