'use strict';

/**
 * AIA-Art50-project-ai-edits-attributed — against a real Postgres (pglite):
 * AI-written versions without an AI contributor warn, attributed ones pass,
 * tables that do not record authorship yet are not applicable, the
 * 'default' bucket, counts only in evidence.
 *
 * Run: cd server && node --test compliance/checks/aia/art50-project-ai-edits-attributed.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');

const { useProjectCheckDb } = require('../../projects/testSchema');
const check = require('./art50-project-ai-edits-attributed');

const { query } = useProjectCheckDb(`
        INSERT INTO projects (id, name, owner_id, organization_id, kind) VALUES
            ('p1', 'One', 'u1', 'org1', 'workspace'), ('p2', 'Two', 'u2', '', 'workspace');
        INSERT INTO notebooks (id, user_id, project_id) VALUES ('n1', 'u1', 'p1'), ('n2', 'u2', 'p2');
        INSERT INTO studio_documents (id, user_id, project_id) VALUES ('d1', 'u1', 'p1');
        INSERT INTO notebook_versions (id, notebook_id, source, contributors) VALUES
            ('v1', 'n1', 'ai', '[{"kind": "ai", "agentId": "a1"}, {"userId": "u1", "kind": "user"}]'),
            ('v2', 'n1', 'checkpoint', '[{"userId": "u1", "kind": "user"}]'),
            ('v3', 'n2', 'ai', '[{"kind": "ai"}]');
        INSERT INTO studio_document_versions (id, document_id, source, contributors) VALUES
            ('w1', 'd1', 'ai', '[{"userId": "u1", "kind": "user"}]');
    `);
const deps = { query: query };

test('an AI-written version that does not name the AI warns, with counts only', async () => {
    const r = await check.evaluate('org1', null, deps);
    assert.strictEqual(r.status, 'warn');
    assert.strictEqual(r.evidence.ai_versions, 2);
    assert.strictEqual(r.evidence.unattributed, 1);
    assert.strictEqual(r.evidence.documents_unattributed, 1);
    assert.ok(!JSON.stringify(r.evidence).includes('u1'), 'no author ids');
});

test('the default bucket passes when its AI versions are attributed', async () => {
    const r = await check.evaluate('default', null, deps);
    assert.strictEqual(r.status, 'pass');
});

test('version tables without authorship columns are not applicable; no AI versions either', async () => {
    const missing = await check.evaluate('org1', null, { query: async () => { const e = new Error('column "source" does not exist'); e.code = '42703'; throw e; } });
    assert.strictEqual(missing.status, 'not_applicable');
    assert.strictEqual(missing.evidence.authorship_recorded, false);
    assert.strictEqual(check._verdict({ notebooks: { ai_versions: 0, unattributed: 0, projects: 0 }, documents: null }).status, 'not_applicable');
    const broken = await check.evaluate('org1', null, { query: async () => { throw new Error('timeout'); } });
    assert.strictEqual(broken.status, 'warn');
});
