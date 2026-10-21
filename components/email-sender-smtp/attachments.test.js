'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { resolveAttachments } = require('./attachments');
const { isForbiddenAddress, attachmentFilename } = require('./fetchUrl');

function fixture() {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'attach-test-'));
    const root = path.join(base, 'root');
    fs.mkdirSync(path.join(root, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(root, 'report.txt'), 'hello');
    fs.writeFileSync(path.join(root, 'sub', 'a.txt'), 'nested');
    fs.writeFileSync(path.join(base, 'secret.txt'), 'secret');
    return { base, root };
}

const PUBLIC = [{ address: '93.184.216.34', family: 4 }];
const reply = (status, headers, body = '') => ({ status, headers, body: Readable.from([Buffer.from(body)]) });
const publicDeps = (httpGet, extra = {}) => ({ lookup: async () => PUBLIC, httpGet, ...extra });

test('a file inside the root is read, by relative or absolute path', async () => {
    const { root } = fixture();
    const out = await resolveAttachments(['report.txt', path.join(root, 'sub', 'a.txt')], root);
    assert.deepEqual(out.map((a) => a.filename), ['report.txt', 'a.txt']);
    assert.equal(out[0].content.toString(), 'hello');
    assert.deepEqual(await resolveAttachments([], root), []);
});

test('path traversal and absolute paths outside the root are rejected', async () => {
    const { base, root } = fixture();
    await assert.rejects(resolveAttachments(['../secret.txt'], root), /outside the attachment folder/);
    await assert.rejects(resolveAttachments([path.join(base, 'secret.txt')], root), /outside the attachment folder/);
    await assert.rejects(resolveAttachments(['/proc/self/environ'], root), /outside|not found/);
    await assert.rejects(resolveAttachments(['missing.txt'], root), /not found/);
    await assert.rejects(resolveAttachments(['sub'], root), /not a regular file/);
});

test('file:, data: and other schemes are rejected', async () => {
    const { root } = fixture();
    for (const u of ['file:///etc/passwd', 'data:text/plain;base64,aGk=', 'ftp://example.com/a.pdf', 'gopher://x/']) {
        await assert.rejects(resolveAttachments([u], root), /only http\(s\) URLs and files/);
    }
});

test('a file name with a colon is a file, and ..notes.txt is inside the root', async () => {
    const { root } = fixture();
    fs.writeFileSync(path.join(root, 'report:v2.pdf'), 'pdf');
    fs.writeFileSync(path.join(root, '..notes.txt'), 'notes');
    const out = await resolveAttachments(['report:v2.pdf', '..notes.txt'], root);
    assert.deepEqual(out.map((a) => a.filename), ['report:v2.pdf', '..notes.txt']);
});

test('a symlink that escapes the root is rejected', async () => {
    const { base, root } = fixture();
    fs.symlinkSync(path.join(base, 'secret.txt'), path.join(root, 'link.txt'));
    fs.symlinkSync(base, path.join(root, 'dirlink'));
    await assert.rejects(resolveAttachments(['link.txt'], root), /outside the attachment folder/);
    await assert.rejects(resolveAttachments(['dirlink/secret.txt'], root), /outside the attachment folder/);
});

test('a missing attachment folder is created instead of failing', async () => {
    const { base } = fixture();
    const root = path.join(base, 'new', 'folder');
    await assert.rejects(resolveAttachments(['a.txt'], root), /not found in the attachment folder/);
    assert.ok(fs.statSync(root).isDirectory());
});

test('a folder file over ATTACHMENT_MAX_BYTES is rejected, 0 means unlimited', async () => {
    const { root } = fixture();
    await assert.rejects(resolveAttachments(['report.txt'], root, { maxBytes: 3 }), /too large/);
    assert.equal((await resolveAttachments(['report.txt'], root, { maxBytes: 0 })).length, 1);
});

test('addresses: private, loopback, link-local, metadata and mapped forms are forbidden', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0',
        '::1', '::', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:169.254.169.254', '::127.0.0.1', 'nonsense']) {
        assert.equal(isForbiddenAddress(ip), true, ip);
    }
    for (const ip of ['93.184.216.34', '8.8.8.8', '2606:2800:220:1:248:1893:25c8:1946']) {
        assert.equal(isForbiddenAddress(ip), false, ip);
    }
});

test('URLs pointing at internal addresses are refused before any request', async () => {
    const { root } = fixture();
    const httpGet = async () => { throw new Error('must not connect'); };
    for (const u of ['http://127.0.0.1:8080/x', 'http://10.0.0.5/a.pdf', 'http://169.254.169.254/latest/meta-data/',
        'http://[::1]/x', 'http://[::ffff:127.0.0.1]/x', 'http://2130706433/x', 'http://user:pw@example.com/x']) {
        await assert.rejects(resolveAttachments([u], root, publicDeps(httpGet)), /refused/, u);
    }
    // A name that resolves to a private address, or only partly to a public one.
    const rebind = { lookup: async () => [...PUBLIC, { address: '10.0.0.9', family: 4 }], httpGet };
    await assert.rejects(resolveAttachments(['http://example.com/a.pdf'], root, rebind), /refused/);
});

test('a real local server is refused by the guard (default transport)', async () => {
    const { root } = fixture();
    const server = require('node:http').createServer((_q, r) => r.end('secret'));
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    try {
        await assert.rejects(resolveAttachments([`http://127.0.0.1:${server.address().port}/`], root), /refused/);
        await assert.rejects(resolveAttachments([`http://localhost:${server.address().port}/`], root), /refused/);
    } finally { server.close(); }
});

test('a public URL is fetched, pinned to the checked address, named from Content-Disposition or the path', async () => {
    const { root } = fixture();
    const seen = [];
    const httpGet = async (req) => {
        seen.push(req);
        return reply(200, { 'content-type': 'application/pdf', 'content-disposition': 'attachment; filename="inv 1.pdf"' }, 'PDF');
    };
    const [a] = await resolveAttachments(['https://example.com/dl/x.pdf'], root, publicDeps(httpGet));
    assert.equal(a.filename, 'inv 1.pdf');
    assert.equal(a.contentType, 'application/pdf');
    assert.equal(a.content.toString(), 'PDF');
    assert.equal(seen[0].address, '93.184.216.34');
    const [b] = await resolveAttachments(['https://example.com/dl/rep%20ort.pdf?x=1'], root, publicDeps(async () => reply(200, {}, 'x')));
    assert.equal(b.filename, 'rep ort.pdf');
    assert.equal(attachmentFilename('', new URL('https://example.com/')), 'attachment');
    assert.equal(attachmentFilename("attachment; filename*=UTF-8''a%C3%A9.txt", new URL('https://e.com/z')), 'aé.txt');
    assert.equal(attachmentFilename('attachment; filename="../../etc/passwd"', new URL('https://e.com/z')), 'passwd');
});

test('the size cap applies to the declared length and to the streamed body; 0 is unlimited', async () => {
    const { root } = fixture();
    const big = () => reply(200, {}, 'x'.repeat(100));
    await assert.rejects(resolveAttachments(['https://example.com/a'], root, publicDeps(async () => big(), { maxBytes: 10 })), /too large/);
    await assert.rejects(resolveAttachments(['https://example.com/a'], root,
        publicDeps(async () => reply(200, { 'content-length': '100' }, 'x'), { maxBytes: 10 })), /too large/);
    const [ok] = await resolveAttachments(['https://example.com/a'], root, publicDeps(async () => big(), { maxBytes: 0 }));
    assert.equal(ok.content.length, 100);
});

test('redirects are followed with a re-check per hop, and a redirect to a private address is refused', async () => {
    const { root } = fixture();
    const lookup = async (host) => (host === 'internal.example' ? [{ address: '10.0.0.1', family: 4 }] : PUBLIC);
    const to = (location) => async () => reply(302, { location });
    await assert.rejects(resolveAttachments(['https://example.com/a'], root, { lookup, httpGet: to('http://internal.example/x') }), /refused/);
    await assert.rejects(resolveAttachments(['https://example.com/a'], root, { lookup, httpGet: to('http://169.254.169.254/') }), /refused/);
    await assert.rejects(resolveAttachments(['https://example.com/a'], root, { lookup, httpGet: to('file:///etc/passwd') }), /only http\(s\)/);
    await assert.rejects(resolveAttachments(['https://example.com/a'], root, { lookup, httpGet: to('/loop') }), /too many redirects/);
    let n = 0;
    const [a] = await resolveAttachments(['https://example.com/a'], root, {
        lookup, httpGet: async () => (n++ === 0 ? reply(301, { location: '/final.txt' }) : reply(200, {}, 'ok')),
    });
    assert.equal(a.filename, 'final.txt');
});

test('a failing status is an error', async () => {
    const { root } = fixture();
    await assert.rejects(resolveAttachments(['https://example.com/a'], root, publicDeps(async () => reply(404, {}))), /status 404/);
});
