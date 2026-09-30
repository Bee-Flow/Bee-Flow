/**
 * core/collab/resources.js — the hooks co-editing calls on the notebook and
 * document stores, and how their answers are read: a snapshot the owner
 * skipped as identical is NOT a new version, and a document that is not a
 * page takes no live body.
 *
 * Run: cd server && node --test core/collab/resources.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { makeResources } = require('./resources');

const quiet = { warn() {} };

test('a new version answers its id; a skipped or deduplicated snapshot answers null', async () => {
    const answers = [
        { versionId: 'dv2', seq: 2 },
        { versionId: 'dv1', seq: 1, skipped: true },
    ];
    const notebookAnswers = [
        { id: 'nv5', seq: 5 },
        { id: 'nv4', seq: 4, deduped: true },
    ];
    const r = makeResources({
        documentStore: { recordVersion: async () => answers.shift() },
        notebookStore: { recordVersion: async () => notebookAnswers.shift() },
        log: quiet,
    });
    const v = { html: '<p>x</p>', source: 'checkpoint', contributors: [] };
    assert.strictEqual(await r.recordVersion('document', 'd1', v), 'dv2');
    assert.strictEqual(await r.recordVersion('document', 'd1', v), null, 'the old head is not a new version');
    assert.strictEqual(await r.recordVersion('notebook', 'n1', v), 'nv5');
    assert.strictEqual(await r.recordVersion('notebook', 'n1', v), null);
});

test('a document that is not a page takes no live body', async () => {
    const r = makeResources({
        documentStore: { writeCollabBody: async (id) => (id === 'page' ? { versionId: 'v1' } : null) },
        log: quiet,
    });
    const content = { html: '<p>x</p>', markdown: 'x', text: 'x', wordCount: 1 };
    assert.deepStrictEqual(await r.writeMirror('document', 'page', content), { written: true, versionId: 'v1' });
    assert.deepStrictEqual(await r.writeMirror('document', 'designed', content), { written: false });
});

test('a missing hook degrades to "not written", never a crash', async () => {
    const r = makeResources({ documentStore: {}, notebookStore: {}, log: quiet });
    assert.deepStrictEqual(await r.writeMirror('notebook', 'n1', { html: '' }), { written: false });
    assert.strictEqual(await r.recordVersion('document', 'd1', { html: '' }), null);
});

test('an owner that refuses the content is an outcome, not a failure; the page cap is offered up front', async () => {
    const tooLarge = Object.assign(new Error('The document body is larger than the 512 KB limit.'), { errorClass: 'document_too_large', status: 413 });
    let fail = tooLarge;
    const r = makeResources({
        documentStore: { MAX_HTML_BYTES: 512 * 1024, writeCollabBody: async () => { throw fail; } },
        notebookStore: {},
        log: quiet,
    });
    const content = { html: '<p>x</p>', markdown: 'x', text: 'x', wordCount: 1 };
    assert.deepStrictEqual(await r.writeMirror('document', 'page', content), { written: false, refused: true, reason: 'document_too_large' });
    fail = new Error('connection reset');
    await assert.rejects(r.writeMirror('document', 'page', content), /connection reset/, 'a failure still throws');
    assert.strictEqual(r.maxContentBytes('document'), 512 * 1024);
    assert.strictEqual(r.maxContentBytes('notebook'), null, 'a notebook body has no cap');
});

test('the seed reads the resource with its share lock, so a save in flight is waited for and imported', async () => {
    const seen = [];
    const r = makeResources({
        getOne: async (sql, params) => {
            seen.push(sql.replace(/\s+/g, ' ').trim());
            return /notebooks/.test(sql)
                ? { id: params[0], user_id: 'u1', project_id: 'p1', organization_id: 'o1', document_content: '<p>x</p>', document_md: 'x' }
                : { id: params[0], user_id: 'u1', project_id: 'p1', organization_id: 'o1', doc_type: 'page', kind: 'document', archived: false, body_html: '<p>x</p>' };
        },
        log: quiet,
    });
    await r.load('notebook', 'n1', { lock: true });
    await r.load('document', 'd1', { lock: true });
    await r.load('notebook', 'n1');
    assert.match(seen[0], /FROM notebooks WHERE id = \$1 FOR SHARE$/);
    assert.match(seen[1], /FROM studio_documents WHERE id = \$1 FOR SHARE$/);
    assert.doesNotMatch(seen[2], /FOR SHARE/, 'every other read stays a plain read');
});

test('an archived page is still a row to fold back into: not co-edited, but never read as gone', async () => {
    const row = { id: 'd1', user_id: 'u1', project_id: 'p1', organization_id: 'o1', doc_type: 'page', kind: 'document', archived: true, body_html: '<p>x</p>' };
    const r = makeResources({ getOne: async () => row, log: quiet });
    const archived = await r.load('document', 'd1');
    assert.strictEqual(archived.supported, false, 'nobody edits it live');
    assert.strictEqual(archived.archived, true);
    assert.strictEqual(archived.projectId, 'p1');
    const template = makeResources({ getOne: async () => ({ ...row, kind: 'template', archived: false }), log: quiet });
    assert.strictEqual(await template.load('document', 'd1'), null, 'a template is never project content');
});
