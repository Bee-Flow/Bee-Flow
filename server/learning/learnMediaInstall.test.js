/**
 * syncFromPin against a loopback http server standing in for the GitHub release.
 *
 * Run: cd server && node --test learning/learnMediaInstall.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const { syncFromPin, validatePin } = require('./learnMediaInstall');

const sha = (buf) => createHash('sha256').update(buf).digest('hex');
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'learn-media-install-'));
test.after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

let n = 0;
const scratch = () => {
    const d = path.join(tmpRoot, `d${++n}`);
    fs.mkdirSync(d, { recursive: true });
    return d;
};

/** Build a release: assets by release name, manifest, pin. `bodies` maps relPath to content. */
function makeRelease(version, bodies, baseUrl) {
    const assets = new Map();
    const files = {};
    const videos = {};
    for (const [rel, body] of Object.entries(bodies)) {
        const buf = Buffer.from(body);
        files[rel] = sha(buf);
        assets.set(path.posix.basename(rel), buf);
        const id = rel.split('/')[0];
        videos[id] ??= { file: rel };
    }
    const manifestBuf = Buffer.from(JSON.stringify({ version, videos, files }));
    const manifestName = `manifest-${version}.json`;
    assets.set(manifestName, manifestBuf);
    const pin = {
        version, manifest: manifestName, manifestSha256: sha(manifestBuf), baseUrl,
        videoIds: Object.keys(videos),
    };
    return { assets, pin, files };
}

let release; // Map of asset name -> Buffer, swapped per test
let hits;
let server;
let base;

test.before(async () => {
    server = http.createServer((req, res) => {
        hits.push(req.url);
        const m = /^\/release\/([^/]+)$/.exec(req.url);
        const o = /^\/objects\/([^/]+)$/.exec(req.url);
        if (m && m[1].startsWith('redirect-')) { // GitHub-style hop to another host/path
            res.statusCode = 302;
            res.setHeader('Location', `/objects/${m[1].slice('redirect-'.length)}`);
            return res.end();
        }
        const name = (m || o)?.[1];
        const buf = name && release.assets.get(name);
        if (!buf) { res.statusCode = 404; return res.end(); }
        res.setHeader('Content-Length', buf.length);
        return res.end(buf);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}/release/`;
});
test.after(() => server.close());

const BODIES = {
    'intro/intro.aaaaaaaaaaaa.mp4': 'video one',
    'intro/intro.aaaaaaaaaaaa.en.vtt': 'WEBVTT one',
    'second/second.bbbbbbbbbbbb.mp4': 'video two',
};
/** The manifest the installer wrote, parsed: data, not source text. */
function readManifest(dir) {
    return JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
}
const leftovers = (dir) => fs.readdirSync(dir).filter((f) => f.startsWith('.'));

test('fresh install downloads everything and writes the manifest', async () => {
    release = makeRelease('v1', BODIES, base);
    hits = [];
    const dir = scratch();
    const r = await syncFromPin(release.pin, dir);
    assert.deepStrictEqual(r, { status: 'installed', version: 'v1', downloaded: 3, reused: 0, bytes: Buffer.byteLength('video one') + Buffer.byteLength('WEBVTT one') + Buffer.byteLength('video two') });
    assert.strictEqual(readManifest(dir).version, 'v1');
    assert.strictEqual(fs.readFileSync(path.join(dir, 'second/second.bbbbbbbbbbbb.mp4'), 'utf8'), 'video two');
    assert.deepStrictEqual(leftovers(dir), []);
});

test('a second sync after one file changed downloads only that file', async () => {
    release = makeRelease('v1', BODIES, base);
    const dir = scratch();
    await syncFromPin(release.pin, dir);

    release = makeRelease('v2', {
        'intro/intro.aaaaaaaaaaaa.mp4': BODIES['intro/intro.aaaaaaaaaaaa.mp4'],
        'intro/intro.aaaaaaaaaaaa.en.vtt': BODIES['intro/intro.aaaaaaaaaaaa.en.vtt'],
        'second/second.cccccccccccc.mp4': 'video two, new cut',
    }, base);
    hits = [];
    const r = await syncFromPin(release.pin, dir);
    assert.strictEqual(r.status, 'installed');
    assert.strictEqual(r.downloaded, 1);
    assert.strictEqual(r.reused, 2);
    assert.deepStrictEqual(hits.sort(), ['/release/manifest-v2.json', '/release/second.cccccccccccc.mp4']);
    assert.strictEqual(readManifest(dir).version, 'v2');
    assert.ok(!fs.existsSync(path.join(dir, 'second/second.bbbbbbbbbbbb.mp4')), 'the file only the old manifest listed is gone');
    assert.ok(fs.existsSync(path.join(dir, 'intro/intro.aaaaaaaaaaaa.mp4')));
    assert.deepStrictEqual(leftovers(dir), []);
});

test('the installed version equal to the pin is a no-op without any request', async () => {
    release = makeRelease('v1', BODIES, base);
    const dir = scratch();
    await syncFromPin(release.pin, dir);
    hits = [];
    const r = await syncFromPin(release.pin, dir);
    assert.deepStrictEqual(r, { status: 'up-to-date', version: 'v1', downloaded: 0, reused: 0, bytes: 0 });
    assert.deepStrictEqual(hits, []);
});

test('a manifest whose sha256 differs from the pin is rejected and the old pack stays live', async () => {
    const dir = scratch();
    release = makeRelease('v1', BODIES, base);
    await syncFromPin(release.pin, dir);
    release = makeRelease('v2', BODIES, base);
    release.pin.manifestSha256 = 'f'.repeat(64);
    await assert.rejects(syncFromPin(release.pin, dir), /manifest sha256 does not match the pin/);
    assert.strictEqual(readManifest(dir).version, 'v1');
    assert.deepStrictEqual(leftovers(dir), []);
});

test('a file whose hash differs from the manifest is rejected and the old pack stays live', async () => {
    const dir = scratch();
    release = makeRelease('v1', BODIES, base);
    await syncFromPin(release.pin, dir);
    release = makeRelease('v2', { ...BODIES, 'second/second.bbbbbbbbbbbb.mp4': 'video two, v2' }, base);
    release.assets.set('second.bbbbbbbbbbbb.mp4', Buffer.from('tampered in transit'));
    await assert.rejects(syncFromPin(release.pin, dir), /sha256 mismatch for second\/second\.bbbbbbbbbbbb\.mp4/);
    assert.strictEqual(readManifest(dir).version, 'v1');
    assert.strictEqual(fs.readFileSync(path.join(dir, 'second/second.bbbbbbbbbbbb.mp4'), 'utf8'), 'video two');
    assert.deepStrictEqual(leftovers(dir), []);
});

test('a manifest whose version differs from the pin is rejected', async () => {
    release = makeRelease('v1', BODIES, base);
    const body = JSON.parse(release.assets.get('manifest-v1.json'));
    body.version = 'other';
    const buf = Buffer.from(JSON.stringify(body));
    release.assets.set('manifest-v1.json', buf);
    release.pin.manifestSha256 = sha(buf);
    await assert.rejects(syncFromPin(release.pin, scratch()), /does not match the pin/);
});

test('a pin that requires a video the manifest lacks is rejected', async () => {
    release = makeRelease('v1', BODIES, base);
    release.pin.videoIds.push('missing-video');
    await assert.rejects(syncFromPin(release.pin, scratch()), /no video missing-video/);
});

test('unsafe manifest paths are rejected before any file is fetched', async () => {
    release = makeRelease('v1', { 'intro/../../evil.mp4': 'x' }, base);
    hits = [];
    await assert.rejects(syncFromPin(release.pin, scratch()), /invalid path/);
    assert.deepStrictEqual(hits, ['/release/manifest-v1.json']);
    release = makeRelease('v1', { 'intro/run.sh': 'x' }, base);
    await assert.rejects(syncFromPin(release.pin, scratch()), /invalid path/);
});

test('LEARN_MEDIA_SOURCE overrides pin.baseUrl', async () => {
    release = makeRelease('v1', BODIES, 'https://unreachable.invalid/learn-media/');
    const dir = scratch();
    await assert.rejects(syncFromPin(release.pin, dir, { fetchImpl: async () => { throw new Error('offline'); } }), /offline/);
    const r = await syncFromPin(release.pin, dir, { env: { LEARN_MEDIA_SOURCE: base.replace(/\/$/, '') } });
    assert.strictEqual(r.status, 'installed');
    assert.strictEqual(readManifest(dir).version, 'v1');
});

test('follows a redirect, as GitHub release downloads do', async () => {
    release = makeRelease('v1', { 'intro/intro.aaaaaaaaaaaa.mp4': 'via redirect' }, base);
    const orig = release.assets;
    release.assets = new Map([...orig, ['redirect-intro.aaaaaaaaaaaa.mp4', Buffer.alloc(0)]]);
    // Ask for the redirecting name by pointing the asset URL at it through a fetch wrapper.
    const fetchImpl = (url, init) => fetch(String(url).replace('/release/intro.aaaaaaaaaaaa.mp4', '/release/redirect-intro.aaaaaaaaaaaa.mp4'), init);
    hits = [];
    const dir = scratch();
    await syncFromPin(release.pin, dir, { fetchImpl });
    assert.ok(hits.includes('/objects/intro.aaaaaaaaaaaa.mp4'));
    assert.strictEqual(fs.readFileSync(path.join(dir, 'intro/intro.aaaaaaaaaaaa.mp4'), 'utf8'), 'via redirect');
});

test('refuses plain http to a remote host, and an https redirect that drops to remote http', async () => {
    release = makeRelease('v1', BODIES, 'http://example.com/release/');
    await assert.rejects(syncFromPin(release.pin, scratch()), /https/);
    release = makeRelease('v1', BODIES, 'https://example.com/release/');
    const fetchImpl = async () => new Response(null, { status: 302, headers: { Location: 'http://example.com/x' } });
    await assert.rejects(syncFromPin(release.pin, scratch(), { fetchImpl }), /https/);
});

test('validatePin', () => {
    release = makeRelease('v1', BODIES, base);
    assert.strictEqual(validatePin(release.pin), release.pin);
    for (const bad of [null, [], { ...release.pin, version: '../x' }, { ...release.pin, manifest: '../m.json' },
        { ...release.pin, manifestSha256: 'abc' }, { ...release.pin, baseUrl: 'nope' }, { ...release.pin, videoIds: ['a/b'] }]) {
        assert.throws(() => validatePin(bad));
    }
});
