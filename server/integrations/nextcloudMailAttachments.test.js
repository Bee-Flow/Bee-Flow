'use strict';

/**
 * Attachments for nextcloud_mail_send (nextcloudMailAttachments.mts): a
 * generated file of the run is uploaded to Mail as multipart bytes, a Files
 * path goes in as a cloud attachment, and nothing is uploaded before every
 * entry is found and the caps hold. File lookups and the run's files are
 * injected; the Mail app is a fake fetch.
 *
 * Run: cd server && node --test integrations/nextcloudMailAttachments.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { resolveMailAttachments, parseAttachmentArgs, multipartFile } = require('./nextcloudMailAttachments.mts');

const PDF = Buffer.from('%PDF-1.7 confirmation');
const HANDLE = { kind: 'generated_file', fileId: 'gen-1' };

function setup({ uploadStatus = 201, uploadBody = { id: 314, type: 'local', fileName: 'Confirmation.pdf' }, files = {}, generated = { 'gen-1': { buffer: PDF, filename: 'Confirmation.pdf', mimeType: 'application/pdf', size: PDF.length } } } = {}) {
    const calls = [];
    const scopes = [];
    const ctx = {
        baseUrl: 'https://cloud.example.test',
        uid: 'alice',
        authError: 'Nextcloud is not connected.',
        runScope: { runId: 'run-1' },
        fetch: async (url, options = {}) => {
            calls.push({ url, ...options });
            return { ok: uploadStatus < 300, status: uploadStatus, text: async () => JSON.stringify(uploadBody) };
        },
    };
    const deps = {
        statFile: async (path) => files[path] || null,
        readGeneratedFile: async (handle, runScope) => {
            scopes.push(runScope);
            return generated[handle.fileId] || null;
        },
    };
    return { ctx, deps, calls, scopes };
}

test('a generated file is uploaded to Mail as the multipart field "attachment" and drafted as a local attachment', async () => {
    const { ctx, deps, calls, scopes } = setup();
    const out = await resolveMailAttachments([{ sourceHandle: HANDLE }], ctx, deps);
    assert.deepEqual(out, { attachments: [{ type: 'local', id: 314 }], names: ['Confirmation.pdf'] });
    assert.deepEqual(scopes, [{ runId: 'run-1' }], 'resolved against THIS run');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://cloud.example.test/index.php/apps/mail/api/attachments');
    assert.equal(calls[0].method, 'POST');
    const type = calls[0].headers['Content-Type'];
    assert.match(type, /^multipart\/form-data; boundary=/);
    assert.ok(Buffer.isBuffer(calls[0].body), 'bytes, so the connector can sign the exact body');
    const text = calls[0].body.toString('latin1');
    assert.match(text, /Content-Disposition: form-data; name="attachment"; filename="Confirmation\.pdf"\r\nContent-Type: application\/pdf\r\n\r\n%PDF-1\.7 confirmation\r\n/);
    assert.ok(text.endsWith(`--${type.split('boundary=')[1]}--\r\n`));
});

test('paths and generated files mix, in order; a path is never uploaded', async () => {
    const { ctx, deps, calls } = setup({ files: { '/Docs/terms.pdf': { name: 'terms.pdf', path: '/Docs/terms.pdf', type: 'file', size: 10 } } });
    const out = await resolveMailAttachments([{ path: '/Docs/terms.pdf' }, { sourceHandle: HANDLE }], ctx, deps);
    assert.deepEqual(out.attachments, [{ type: 'cloud', fileName: '/Docs/terms.pdf' }, { type: 'local', id: 314 }]);
    assert.deepEqual(out.names, ['terms.pdf', 'Confirmation.pdf']);
    assert.equal(calls.length, 1, 'only the generated file is uploaded');
});

test('a generated file that is not this run\'s, or a handle outside a run, is refused without an upload', async () => {
    const gone = setup({ generated: {} });
    assert.match((await resolveMailAttachments([{ sourceHandle: HANDLE }], gone.ctx, gone.deps)).error, /not a live file of this run/);
    assert.equal(gone.calls.length, 0);

    const chat = setup();
    chat.deps.readGeneratedFile = async () => { throw new Error('A generated_file handle can only be used inside an automation run — the file belongs to that run.'); };
    assert.match((await resolveMailAttachments([{ sourceHandle: HANDLE }], chat.ctx, chat.deps)).error, /inside an automation run/);
});

test('nothing is uploaded when a later entry is missing or the total is too large', async () => {
    const missing = setup();
    const out = await resolveMailAttachments([{ sourceHandle: HANDLE }, { path: '/nope.pdf' }], missing.ctx, missing.deps);
    assert.equal(out.error, 'Attachment not found in Nextcloud Files: /nope.pdf');
    assert.equal(missing.calls.length, 0);

    process.env.NEXTCLOUD_MAIL_ATTACHMENT_MAX_MB = '1';
    try {
        const big = setup({ files: { '/big.zip': { name: 'big.zip', path: '/big.zip', type: 'file', size: 2 * 1024 * 1024 } } });
        const r = await resolveMailAttachments([{ sourceHandle: HANDLE }, { path: '/big.zip' }], big.ctx, big.deps);
        assert.match(r.error, /more than the 1 MB one message may carry/);
        assert.equal(big.calls.length, 0);
    } finally {
        delete process.env.NEXTCLOUD_MAIL_ATTACHMENT_MAX_MB;
    }
});

test('the count cap holds and 0 lifts it', async () => {
    const files = { '/a': { name: 'a', path: '/a', type: 'file', size: 1 } };
    const three = [{ path: '/a' }, { path: '/a' }, { path: '/a' }];
    process.env.NEXTCLOUD_MAIL_ATTACHMENT_MAX_COUNT = '2';
    try {
        const capped = setup({ files });
        assert.match((await resolveMailAttachments(three, capped.ctx, capped.deps)).error, /NEXTCLOUD_MAIL_ATTACHMENT_MAX_COUNT/);
        process.env.NEXTCLOUD_MAIL_ATTACHMENT_MAX_COUNT = '0';
        const open = setup({ files });
        assert.equal((await resolveMailAttachments(three, open.ctx, open.deps)).attachments.length, 3);
    } finally {
        delete process.env.NEXTCLOUD_MAIL_ATTACHMENT_MAX_COUNT;
    }
});

test('a refused upload is an error naming the file', async () => {
    const { ctx, deps } = setup({ uploadStatus: 413, uploadBody: { message: 'too big' } });
    assert.match((await resolveMailAttachments([{ sourceHandle: HANDLE }], ctx, deps)).error, /did not take the attachment Confirmation\.pdf \(413\)/);
    const noAuth = setup({ uploadStatus: 401 });
    assert.equal((await resolveMailAttachments([{ sourceHandle: HANDLE }], noAuth.ctx, noAuth.deps)).error, 'Nextcloud is not connected.');
});

test('a Files id is looked up as the sender and attached by the path it resolves to', async () => {
    const { ctx, deps, calls } = setup();
    /** @type {number[]} */
    const asked = [];
    deps.fileById = async (fileId) => {
        asked.push(fileId);
        return fileId === 77 ? { path: '/Forms/upload 1.pdf', name: 'upload 1.pdf', isFolder: false, size: 10 } : { error: `File not found: file id ${fileId}` };
    };
    assert.deepEqual(await resolveMailAttachments([{ fileId: 77 }], ctx, deps), { attachments: [{ type: 'cloud', fileName: '/Forms/upload 1.pdf' }], names: ['upload 1.pdf'] });
    assert.deepEqual(asked, [77]);
    assert.equal(calls.length, 0, 'a Files file is never uploaded');
    assert.match((await resolveMailAttachments([{ fileId: 78 }], ctx, deps)).error, /Attachment file id 78: File not found/);
    deps.fileById = async () => ({ path: '/Forms', name: 'Forms', isFolder: true, size: 0 });
    assert.match((await resolveMailAttachments([{ fileId: 9 }], ctx, deps)).error, /is a folder/);
});

test('the size cap counts a file given by id', async () => {
    process.env.NEXTCLOUD_MAIL_ATTACHMENT_MAX_MB = '1';
    try {
        const { ctx, deps } = setup();
        deps.fileById = async () => ({ path: '/big.zip', name: 'big.zip', isFolder: false, size: 2 * 1024 * 1024 });
        assert.match((await resolveMailAttachments([{ fileId: 5 }], ctx, deps)).error, /NEXTCLOUD_MAIL_ATTACHMENT_MAX_MB/);
    } finally {
        delete process.env.NEXTCLOUD_MAIL_ATTACHMENT_MAX_MB;
    }
});

test('the argument shape: a list of { path }, { fileId } or { sourceHandle }, one of them, nothing else', () => {
    assert.deepEqual(parseAttachmentArgs(undefined), { items: [] });
    assert.deepEqual(parseAttachmentArgs([{ path: ' /a.pdf ' }]), { items: [{ path: '/a.pdf' }] });
    assert.match(parseAttachmentArgs([{ path: '/a', sourceHandle: HANDLE }]).error, /one of path, fileId or sourceHandle/);
    assert.match(parseAttachmentArgs([{ path: '/a', fileId: 7 }]).error, /one of path, fileId or sourceHandle/);
    assert.deepEqual(parseAttachmentArgs([{ fileId: '77' }]), { items: [{ fileId: 77 }] });
    assert.match(parseAttachmentArgs([{ fileId: -1 }]).error, /positive whole number/);
    assert.match(parseAttachmentArgs([{ fileId: '7 OR 1' }]).error, /positive whole number/);
    assert.match(parseAttachmentArgs([{ sourceHandle: { kind: 'gmail_attachment', messageId: '1' } }]).error, /generated_file/);
    assert.match(parseAttachmentArgs({ path: '/a' }).error, /must be a list/);
});

test('a file name cannot break out of its multipart header', () => {
    const { body } = multipartFile('attachment', 'a"\r\nX-Evil: 1.pdf', 'application/pdf\r\nX: y', Buffer.from('x'));
    const text = body.toString('utf8');
    assert.ok(!text.includes('\r\nX-Evil'), 'no injected header line');
    assert.ok(!text.includes('\r\nX: y'));
    assert.match(text, /filename="a%22X-Evil: 1\.pdf"/);
});
