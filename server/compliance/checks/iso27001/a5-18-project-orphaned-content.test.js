'use strict';

/**
 * ISO27001-A.5.18-project-orphaned-content — against a real Postgres
 * (pglite): an owner who left fails, orphaned shared chats and notebooks
 * warn, the details say a departed owner's shared chat cannot be taken back,
 * the 'default' bucket, not provisioned, and ids only in evidence.
 *
 * Run: cd server && node --test compliance/checks/iso27001/a5-18-project-orphaned-content.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');

const { useProjectCheckDb } = require('../../projects/testSchema');
const check = require('./a5-18-project-orphaned-content');

const { pg, query } = useProjectCheckDb(`
        INSERT INTO users (id, "organizationId", status) VALUES
            ('here', 'org1', 'active'), ('gone', 'org1', 'suspended'), ('moved', 'org2', 'active'), ('solo', '', 'active');
        INSERT INTO projects (id, name, owner_id, organization_id, kind) VALUES
            ('ok', 'Fine', 'here', 'org1', 'workspace'),
            ('headless', 'Acme Payroll', 'gone', 'org1', 'workspace'),
            ('bits', 'Bits', 'here', 'org1', 'workspace'),
            ('home', 'Home', 'solo', '', 'workspace');
        INSERT INTO direct_conversations (id, user_id, project_id, shared_scope) VALUES
            ('d1', 'moved', 'bits', 'project'), ('d2', 'here', 'bits', 'project'), ('d3', 'moved', 'bits', 'private');
        INSERT INTO agent_conversations (id, user_id, project_id, shared_scope) VALUES ('a1', 'ghost', 'bits', 'project');
        INSERT INTO notebooks (id, user_id, project_id) VALUES ('n1', 'gone', 'bits'), ('n2', 'here', 'ok');
    `);
const deps = { query: query };

test('a project whose owner left fails, and the orphaned chats and notebooks are counted', async () => {
    const r = await check.evaluate('org1', null, deps);
    assert.strictEqual(r.status, 'fail');
    assert.strictEqual(r.evidence.projects_without_owner, 1);
    assert.strictEqual(r.evidence.orphaned_threads, 2, 'the chat of someone who moved org and of a deleted account');
    assert.strictEqual(r.evidence.orphaned_notebooks, 1);
    assert.deepStrictEqual(r.evidence.offenders.map(o => o.project_id), ['headless', 'bits']);
    assert.match(r.details, /cannot be handed to someone else, only archived or deleted/);
    assert.ok(!JSON.stringify(r).includes('Acme'), 'no project name');
});

test('orphaned content alone warns; nothing orphaned passes; no projects is not applicable', () => {
    const warn = check._verdict({ projects: 3, owners: [], threads: { p: 1 }, notebooks: {} });
    assert.strictEqual(warn.status, 'warn');
    assert.strictEqual(warn.evidence.link, '/app/projects/p');
    assert.strictEqual(check._verdict({ projects: 3, owners: [], threads: {}, notebooks: {} }).status, 'pass');
    assert.strictEqual(check._verdict({ projects: 0, owners: [], threads: {}, notebooks: {} }).status, 'not_applicable');
    const partial = check._verdict({ projects: 3, owners: [], threads: {}, notebooks: {}, unreadable: ['threads'] });
    assert.strictEqual(partial.status, 'warn', 'an unreadable source is never a pass');
});

test('the default bucket owns the org-less projects', async () => {
    const r = await check.evaluate('default', null, deps);
    assert.strictEqual(r.status, 'pass');
    assert.strictEqual(r.evidence.projects, 1);
});

test('not provisioned is not applicable; a failing owner read warns', async () => {
    const missing = await check.evaluate('org1', null, { query: async () => { const e = new Error('x'); e.code = '42703'; throw e; } });
    assert.strictEqual(missing.status, 'not_applicable');
    const broken = await check.evaluate('org1', null, { query: async () => { throw new Error('reset'); } });
    assert.strictEqual(broken.status, 'warn');
});

test('a missing optional table is skipped, a failing one is named', async () => {
    const q = query;
    const r = await check.evaluate('org1', null, { query: async (sql, p) => {
        if (/FROM notebooks/.test(sql)) { const e = new Error('x'); e.code = '42P01'; throw e; }
        if (/direct_conversations/.test(sql)) throw new Error('timeout');
        return q(sql, p);
    } });
    assert.deepStrictEqual(r.evidence.unreadable, ['threads']);
    assert.strictEqual(r.evidence.orphaned_notebooks, 0);
});

test('an owner the directory sync deactivated (status inactive) has left; sign-up states and a legacy NULL have not', async () => {
    await pg.exec(`
        INSERT INTO users (id, "organizationId", status) VALUES
            ('nc-deleted', 'orgnc', 'inactive'), ('nc-new', 'orgnc', 'pending'), ('nc-wait', 'orgnc', 'waitlist'),
            ('nc-legacy', 'orgnc', NULL), ('nc-here', 'orgnc', 'active');
        INSERT INTO projects (id, name, owner_id, organization_id, kind) VALUES
            ('nc1', 'A', 'nc-deleted', 'orgnc', 'workspace'), ('nc2', 'B', 'nc-new', 'orgnc', 'workspace'),
            ('nc3', 'C', 'nc-legacy', 'orgnc', 'workspace'), ('nc4', 'D', 'nc-here', 'orgnc', 'workspace');
        INSERT INTO notebooks (id, user_id, project_id) VALUES ('ncn1', 'nc-deleted', 'nc4'), ('ncn2', 'nc-wait', 'nc4');
    `);
    const r = await check.evaluate('orgnc', null, deps);
    assert.strictEqual(r.status, 'fail', 'the project of a person deleted in Nextcloud has nobody to govern it');
    assert.strictEqual(r.evidence.projects_without_owner, 1);
    assert.strictEqual(r.evidence.orphaned_notebooks, 1);
    assert.deepStrictEqual(r.evidence.offenders.map(o => o.project_id), ['nc1', 'nc4']);
});
