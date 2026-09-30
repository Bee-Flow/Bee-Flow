'use strict';

/**
 * GDPR-Art32-project-files-unscanned — against a real Postgres (pglite): the
 * shield-off deferral, the unscanned count per project, the 'default' bucket,
 * not provisioned, ids only in evidence, and the bounded rescan auto-fix.
 *
 * Run: cd server && node --test compliance/checks/gdpr/art32-project-files-unscanned.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');

const { useProjectCheckDb } = require('../../projects/testSchema');
const check = require('./art32-project-files-unscanned');

const KB1 = '11111111-1111-1111-1111-111111111111';
const KB2 = '11111111-1111-1111-1111-111111111112';
const KB3 = '11111111-1111-1111-1111-111111111113';
const doc = (n) => `22222222-2222-2222-2222-00000000000${n}`;
const { query } = useProjectCheckDb(`
        INSERT INTO projects (id, name, owner_id, organization_id, kind, files_kb_id) VALUES
            ('p1', 'Client Visser', 'u1', 'org1', 'workspace', '${KB1}'),
            ('p2', 'Two', 'u1', 'org1', 'workspace', '${KB2}'),
            ('p3', 'Home', 'u2', '', 'workspace', '${KB3}');
        INSERT INTO knowledge_bases (id, organization_id, source_kind) VALUES
            ('${KB1}', 'org1', 'project_files'), ('${KB2}', 'org1', 'project_files'), ('${KB3}', NULL, 'project_files');
        INSERT INTO documents (id, knowledge_base_id, title, status, pii_status) VALUES
            ('${doc(1)}', '${KB1}', 'Visser contract.pdf', 'processed', 'unscanned'),
            ('${doc(2)}', '${KB1}', 'b', 'processed', 'unscanned'),
            ('${doc(3)}', '${KB1}', 'c', 'redacted', 'redacted'),
            ('${doc(4)}', '${KB2}', 'd', 'skipped', 'unscanned'),
            ('${doc(5)}', '${KB2}', 'e', 'processed', 'none'),
            ('${doc(6)}', '${KB3}', 'f', 'processed', 'none');
    `);
const rescanned = [];
const deps = (over = {}) => ({
    query,
    shieldScansFiles: async () => true,
    rescan: async (row) => { rescanned.push(row.document_id); return 'checked'; },
    ...over,
});

test('unchecked project files warn, per project, with ids and counts only', async () => {
    const r = await check.evaluate('org1', null, deps());
    assert.strictEqual(r.status, 'warn');
    assert.strictEqual(r.evidence.files, 4, 'a withheld (skipped) file is not stored content');
    assert.strictEqual(r.evidence.unscanned, 2);
    assert.deepStrictEqual(r.evidence.offenders, [{ project_id: 'p1', unscanned: 2, link: '/app/projects/p1/knowledge' }]);
    assert.strictEqual(r.evidence.link, '/app/projects/p1/knowledge');
    assert.ok(!JSON.stringify(r).includes('Visser'));
});

test('with the shield off the check defers to the DLP check; no files is not applicable', async () => {
    const off = await check.evaluate('org1', null, deps({ shieldScansFiles: async () => false }));
    assert.strictEqual(off.status, 'not_applicable');
    assert.match(off.details, /GDPR-Art32-dlp-enabled/);
    assert.strictEqual(check._verdict({ shieldOn: true, total: 0, perProject: [] }).status, 'not_applicable');
    assert.strictEqual(check._verdict({ shieldOn: true, total: 3, perProject: [] }).status, 'pass');
});

test('the default bucket sees its own project files only', async () => {
    const r = await check.evaluate('default', null, deps());
    assert.strictEqual(r.status, 'pass');
    assert.strictEqual(r.evidence.files, 1);
});

test('unreadable shield or tables are warnings or not provisioned, never a pass', async () => {
    const shield = await check.evaluate('org1', null, deps({ shieldScansFiles: async () => { throw new Error('config down'); } }));
    assert.strictEqual(shield.status, 'warn');
    const missing = await check.evaluate('org1', null, deps({ query: async () => { const e = new Error('x'); e.code = '42P01'; throw e; } }));
    assert.strictEqual(missing.status, 'not_applicable');
    const broken = await check.evaluate('org1', null, deps({ query: async () => { throw new Error('reset'); } }));
    assert.strictEqual(broken.status, 'warn');
});

test('the auto-fix rescans a bounded batch of this org\'s unscanned files, optionally one project', async () => {
    rescanned.length = 0;
    const r = await check.autoFix('org1', {}, deps());
    assert.deepStrictEqual(rescanned.sort(), [doc(1), doc(2)]);
    assert.strictEqual(r.changed, 2);
    assert.match(r.summary, /Scanned 2 of 2/);
    rescanned.length = 0;
    await check.autoFix('org1', { subjectId: 'project:p2' }, deps());
    assert.deepStrictEqual(rescanned, []);
    const failing = await check.autoFix('org1', {}, deps({ rescan: async () => { throw new Error('guard down'); } }));
    assert.strictEqual(failing.failed, 2);
    assert.strictEqual(failing.changed, 0);
});
