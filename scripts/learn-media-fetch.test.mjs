// Run: node --test scripts/learn-media-fetch.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { fetchLearnMediaPack, isSafePackPath, verifyPack } from './learn-media-fetch.mjs';

const sha = (buf) => createHash('sha256').update(buf).digest('hex');
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'learn-media-fetch-'));
test.after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

let n = 0;
const scratch = (name) => {
    const d = path.join(tmpRoot, `${name}-${++n}`);
    fs.mkdirSync(d, { recursive: true });
    return d;
};

/** Build a pack directory and its .tar.gz. `mutate(dir, manifest)` may tamper before packing. */
function makePack({ wrap = false, mutate } = {}) {
    const work = scratch('pack');
    const dir = wrap ? path.join(work, 'learn-media-2026.10') : work;
    fs.mkdirSync(path.join(dir, 'clips'), { recursive: true });
    const files = {
        'clips/agents-intro.3f9a2b1c.mp4': Buffer.alloc(2048, 1),
        'clips/agents-intro.3f9a2b1c.en.vtt': Buffer.from('WEBVTT\n\n00:00.000 --> 00:01.000\nHello\n'),
        'clips/agents-intro.3f9a2b1c.jpg': Buffer.alloc(64, 2),
    };
    for (const [rel, buf] of Object.entries(files)) fs.writeFileSync(path.join(dir, rel), buf);
    const manifest = {
        version: '2026.10.1',
        videos: {
            'agents-intro': {
                file: 'clips/agents-intro.3f9a2b1c.mp4',
                captions: { en: 'clips/agents-intro.3f9a2b1c.en.vtt' },
                poster: 'clips/agents-intro.3f9a2b1c.jpg',
                duration: 74,
                transcript: ['Hello'],
            },
        },
        files: Object.fromEntries(Object.entries(files).map(([rel, buf]) => [rel, sha(buf)])),
    };
    mutate?.(dir, manifest);
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
    const tarball = path.join(scratch('tgz'), 'pack.tar.gz');
    execFileSync('tar', ['-czf', tarball, '-C', work, '.']);
    return { tarball, manifest };
}

function existingPack() {
    const dest = path.join(scratch('dest'), 'learn-media');
    fs.mkdirSync(dest);
    fs.writeFileSync(path.join(dest, 'manifest.json'), '{"version":"old","videos":{}}');
    return dest;
}

// Temp files would land beside the target (an old version) or as dot entries inside it.
const leftovers = (dest) => [
    ...fs.readdirSync(path.dirname(dest)).filter((f) => f !== path.basename(dest)),
    ...(fs.existsSync(dest) ? fs.readdirSync(dest).filter((f) => f.startsWith('.')) : []),
];

test('installs a pack from a local path and replaces the old one', async () => {
    const { tarball } = makePack();
    const dest = existingPack();
    const r = await fetchLearnMediaPack({ source: tarball, dest, expectedSha256: sha(fs.readFileSync(tarball)) });
    assert.equal(r.version, '2026.10.1');
    assert.equal(r.videos, 1);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dest, 'manifest.json'), 'utf8')).version, '2026.10.1');
    assert.ok(fs.existsSync(path.join(dest, 'clips/agents-intro.3f9a2b1c.mp4')));
    assert.deepEqual(leftovers(dest), [], 'no temp files left behind');
});

test('installs in place: the directory itself (a volume or bind mount) is never replaced', async () => {
    const { tarball } = makePack();
    const dest = path.join(scratch('dest'), 'learn-media');
    fs.mkdirSync(path.join(dest, 'old'), { recursive: true });
    const oldFiles = { 'old/retired.11111111.mp4': 'a', 'old/kept-by-both.jpg': 'b' };
    for (const [rel, body] of Object.entries(oldFiles)) fs.writeFileSync(path.join(dest, rel), body);
    fs.writeFileSync(path.join(dest, 'operator-notes.json'), '{}'); // never listed by any manifest
    fs.writeFileSync(path.join(dest, 'manifest.json'), JSON.stringify({
        version: 'old', videos: {}, files: Object.fromEntries(Object.keys(oldFiles).map((rel) => [rel, 'a'.repeat(64)])),
    }));
    const inode = fs.statSync(dest).ino;

    await fetchLearnMediaPack({ source: tarball, dest });

    assert.equal(fs.statSync(dest).ino, inode, 'same directory, so a bind mount keeps seeing it');
    assert.equal(JSON.parse(fs.readFileSync(path.join(dest, 'manifest.json'), 'utf8')).version, '2026.10.1');
    assert.ok(fs.existsSync(path.join(dest, 'clips/agents-intro.3f9a2b1c.mp4')));
    assert.equal(fs.existsSync(path.join(dest, 'old')), false, 'files only the old manifest listed are removed, and their empty folder');
    assert.ok(fs.existsSync(path.join(dest, 'operator-notes.json')), 'a file no manifest listed is never deleted');
    assert.deepEqual(leftovers(dest), []);
});

test('a failed install keeps the old pack files in place', async () => {
    const { tarball } = makePack({ mutate: (dir) => fs.writeFileSync(path.join(dir, 'clips/agents-intro.3f9a2b1c.jpg'), 'tampered') });
    const dest = path.join(scratch('dest'), 'learn-media');
    fs.mkdirSync(dest);
    fs.writeFileSync(path.join(dest, 'a.mp4'), 'a');
    fs.writeFileSync(path.join(dest, 'manifest.json'), JSON.stringify({ version: 'old', videos: {}, files: { 'a.mp4': sha(Buffer.from('a')) } }));
    await assert.rejects(fetchLearnMediaPack({ source: tarball, dest }), /sha256 mismatch/);
    assert.deepEqual(fs.readdirSync(dest).sort(), ['a.mp4', 'manifest.json']);
});

test('a move that fails halfway takes back what it moved and leaves the old manifest live', async () => {
    const { tarball } = makePack();
    const dest = existingPack();
    // Sorted, the .mp4 moves last; a non-empty directory in its place makes that rename fail.
    fs.mkdirSync(path.join(dest, 'clips/agents-intro.3f9a2b1c.mp4'), { recursive: true });
    fs.writeFileSync(path.join(dest, 'clips/agents-intro.3f9a2b1c.mp4/x.jpg'), 'x');
    await assert.rejects(fetchLearnMediaPack({ source: tarball, dest }));
    assert.equal(JSON.parse(fs.readFileSync(path.join(dest, 'manifest.json'), 'utf8')).version, 'old');
    assert.deepEqual(fs.readdirSync(path.join(dest, 'clips')), ['agents-intro.3f9a2b1c.mp4'], 'the files it had moved are gone again');
    assert.deepEqual(leftovers(dest), []);
});

test('accepts a pack wrapped in one top-level directory', async () => {
    const { tarball } = makePack({ wrap: true });
    const dest = path.join(scratch('dest'), 'learn-media');
    await fetchLearnMediaPack({ source: tarball, dest });
    assert.ok(fs.existsSync(path.join(dest, 'manifest.json')));
});

test('downloads over http on loopback', async () => {
    const { tarball } = makePack();
    const server = http.createServer((req, res) => {
        if (req.url !== '/pack.tar.gz') { res.statusCode = 404; return res.end(); }
        res.setHeader('Content-Type', 'application/gzip');
        fs.createReadStream(tarball).pipe(res);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
        const base = `http://127.0.0.1:${server.address().port}`;
        const dest = path.join(scratch('dest'), 'learn-media');
        await fetchLearnMediaPack({ source: `${base}/pack.tar.gz`, dest });
        assert.ok(fs.existsSync(path.join(dest, 'manifest.json')));
        await assert.rejects(fetchLearnMediaPack({ source: `${base}/missing.tar.gz`, dest: path.join(scratch('dest'), 'lm') }), /HTTP 404/);
    } finally {
        server.close();
    }
});

test('refuses plain http to a remote host', async () => {
    await assert.rejects(fetchLearnMediaPack({ source: 'http://example.com/pack.tar.gz', dest: path.join(scratch('dest'), 'lm') }), /https/);
});

const failures = [
    ['a tampered file', (dir) => fs.writeFileSync(path.join(dir, 'clips/agents-intro.3f9a2b1c.mp4'), Buffer.alloc(2048, 9)), /sha256 mismatch/],
    ['an unlisted file', (dir) => fs.writeFileSync(path.join(dir, 'clips/extra.jpg'), 'x'), /not listed/],
    ['a listed file that is missing', (_dir, m) => { m.files['clips/gone.mp4'] = 'a'.repeat(64); }, /not in the pack/],
    ['a video naming an uncovered file', (_dir, m) => { m.videos['agents-intro'].poster = 'clips/other.webp'; }, /does not cover/],
    ['a disallowed file type', (dir, m) => { fs.writeFileSync(path.join(dir, 'run.sh'), 'x'); m.files['run.sh'] = sha(Buffer.from('x')); }, /not allowed/],
    ['a symlink', (dir) => fs.symlinkSync('/etc/passwd', path.join(dir, 'clips/link.jpg')), /not a regular file/],
    ['no files map', (_dir, m) => { delete m.files; }, /files/],
];
for (const [what, mutate, rx] of failures) {
    test(`rejects ${what} and keeps the old pack`, async () => {
        const { tarball } = makePack({ mutate });
        const dest = existingPack();
        await assert.rejects(fetchLearnMediaPack({ source: tarball, dest }), rx);
        assert.equal(JSON.parse(fs.readFileSync(path.join(dest, 'manifest.json'), 'utf8')).version, 'old');
        assert.deepEqual(leftovers(dest), []);
    });
}

test('rejects a tarball whose own hash does not match', async () => {
    const { tarball } = makePack();
    const dest = existingPack();
    await assert.rejects(fetchLearnMediaPack({ source: tarball, dest, expectedSha256: 'f'.repeat(64) }), /LEARN_MEDIA_PACK_SHA256/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dest, 'manifest.json'), 'utf8')).version, 'old');
});

test('isSafePackPath', () => {
    for (const ok of ['manifest.json', './clips/a.mp4', 'clips/', 'a.b.c.vtt', 'x.WEBP']) assert.equal(isSafePackPath(ok), true, ok);
    for (const bad of ['../a.mp4', 'clips/../../a.mp4', '/etc/a.json', 'C:/a.mp4', 'a\\b.mp4', '.hidden.json', 'a.sh', 'clips/.git/', '', 'a/..b.mp4']) {
        assert.equal(isSafePackPath(bad), false, bad);
    }
});

test('verifyPack needs a manifest', async () => {
    await assert.rejects(verifyPack(scratch('empty')), /no manifest/);
});
