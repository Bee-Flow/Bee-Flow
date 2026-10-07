'use strict';

/**
 * GDPR-Art32-project-access — against a real Postgres (pglite) with the real
 * project DDL: the pure verdict, the org scoping (a real org and the
 * 'default' bucket), not-provisioned tolerance, no names in evidence, and the
 * auto-fix that removes only memberships whose target no longer exists.
 *
 * Run: cd server && node --test compliance/checks/gdpr/art32-project-access.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');

const { useProjectCheckDb } = require('../../projects/testSchema');
const check = require('./art32-project-access');

const { pg, query } = useProjectCheckDb(`
        INSERT INTO users (id, "organizationId", status) VALUES
            ('owner', 'org1', 'active'), ('ann', 'org1', 'active'), ('left', 'org1', 'suspended'),
            ('mover', 'org2', 'active'), ('solo', '', 'active'), ('solo2', '', 'active');
        INSERT INTO groups (id, "organizationId", name) VALUES ('g1', 'org1', 'Team'), ('gx', 'org2', 'Other');
        INSERT INTO projects (id, name, owner_id, organization_id, kind) VALUES
            ('clean', 'Clean', 'owner', 'org1', 'workspace'),
            ('drift', 'Client Jansen', 'owner', 'org1', 'workspace'),
            ('stale', 'Stale', 'owner', 'org1', NULL),
            ('sol', 'Solution', 'owner', 'org1', 'solution'),
            ('home', 'Home', 'solo', '', 'workspace');
        INSERT INTO project_shares (id, project_id, shared_with_type, shared_with_id, permission) VALUES
            ('s1', 'clean', 'user', 'ann', 'editor'),
            ('s2', 'clean', 'group', 'g1', 'viewer'),
            ('s3', 'drift', 'user', 'mover', 'viewer'),
            ('s4', 'drift', 'group', 'gx', 'viewer'),
            ('s5', 'stale', 'user', 'left', 'viewer'),
            ('s6', 'stale', 'user', 'ghost', 'viewer'),
            ('s7', 'stale', 'group', 'gone', 'viewer'),
            ('s8', 'sol', 'user', 'mover', 'viewer'),
            ('s9', 'home', 'user', 'solo2', 'editor');
    `);
const deps = { query: query };

test('a member or group of another organisation fails; ids and counts only in evidence', async () => {
    const r = await check.evaluate('org1', null, deps);
    assert.strictEqual(r.status, 'fail');
    assert.strictEqual(r.evidence.foreign_count, 2);
    assert.strictEqual(r.evidence.dangling_count, 3);
    assert.strictEqual(r.evidence.projects, 3, 'the Solution is not a collaborative project');
    assert.deepStrictEqual(r.evidence.offenders.map(o => o.project_id), ['drift', 'stale']);
    assert.strictEqual(r.evidence.offenders[0].link, '/app/projects/drift/members');
    const json = JSON.stringify(r);
    assert.ok(!json.includes('Jansen'), 'a project name never reaches the result');
    assert.ok(!json.includes('mover') && !json.includes('ghost'), 'nor a member id');
    assert.match(r.details, /project:drift/);
});

test('the default bucket judges the org-less projects on their own terms', async () => {
    const r = await check.evaluate('default', null, deps);
    assert.strictEqual(r.status, 'pass', 'an org-less member of an org-less project is at home');
    assert.strictEqual(r.evidence.projects, 1);
});

test('the pure verdict: nothing to judge, dangling only, all clean', () => {
    assert.strictEqual(check._verdict({ projects: 0, rows: [], orgId: 'o' }).status, 'not_applicable');
    const warn = check._verdict({ projects: 2, orgId: 'o', rows: [{ project_id: 'a', target_exists: false, target_org: 'default', target_left: false }] });
    assert.strictEqual(warn.status, 'warn');
    assert.strictEqual(warn.evidence.link, '/app/projects/a/members', 'one project affected → one deep link');
    assert.strictEqual(check._verdict({ projects: 2, rows: [], orgId: 'o' }).status, 'pass');
});

test('past the row limit the foreign members come first and the counts say "at least"', async () => {
    // Without an ORDER BY, Postgres could return only dangling rows under the
    // LIMIT, the status dropped from fail to warn, and the counts read as exact.
    const cut = check._verdict({ projects: 1, rows: [{ project_id: 'p', target_exists: false, target_left: false, target_org: 'x' }], orgId: 'orgA', truncated: true });
    assert.strictEqual(cut.evidence.counts_truncated, true);
    assert.match(cut.details, /^At least 1 membership/);
    assert.strictEqual(check._verdict({ projects: 1, rows: [], orgId: 'orgA' }).evidence.counts_truncated, false);

    let sql = '';
    const foreign = { project_id: 'p1', target_exists: true, target_left: false, target_org: 'orgB' };
    const dangling = { project_id: 'p2', target_exists: false, target_left: false, target_org: 'default' };
    const many = [foreign, ...Array.from({ length: 5000 }, () => dangling)];
    const r = await check.evaluate('orgA', null, { query: async (q) => {
        if (/COUNT\(\*\)::int AS n FROM projects/.test(q)) return [{ n: 2 }];
        sql = q;
        return many;
    } });
    assert.match(sql, /ORDER BY target_exists DESC, target_left ASC, project_id/);
    assert.match(sql, /LIMIT 5001\b/);
    assert.strictEqual(r.status, 'fail');
    assert.strictEqual(r.evidence.counts_truncated, true);
    assert.strictEqual(r.evidence.foreign_count + r.evidence.dangling_count, 5000, 'the row past the limit is not counted');
    assert.match(r.details, /^At least 1 membership/);
});

test('the fingerprint follows which projects are affected, not how many rows', () => {
    const a = check.fingerprintOf({ offenders: [{ project_id: 'x', foreign: 1, dangling: 0 }] });
    const b = check.fingerprintOf({ offenders: [{ project_id: 'x', foreign: 3, dangling: 0 }] });
    const c = check.fingerprintOf({ offenders: [{ project_id: 'x', foreign: 1, dangling: 1 }] });
    assert.deepStrictEqual(a, b);
    assert.notDeepStrictEqual(a, c);
});

test('a missing table is not provisioned; any other read error is a warning, never a pass', async () => {
    const missing = await check.evaluate('org1', null, { query: async () => { const e = new Error('nope'); e.code = '42P01'; throw e; } });
    assert.strictEqual(missing.status, 'not_applicable');
    const broken = await check.evaluate('org1', null, { query: async () => { const e = new Error('timeout'); e.code = '57014'; throw e; } });
    assert.strictEqual(broken.status, 'warn');
    assert.match(broken.details, /could not be read/);
});

test('the auto-fix removes only memberships of deleted accounts and groups, in this org', async () => {
    const r = await check.autoFix('org1', {}, deps);
    assert.strictEqual(r.changed, 2, 'the ghost user and the deleted group');
    const { rows } = await pg.query(`SELECT id FROM project_shares ORDER BY id`);
    assert.deepStrictEqual(rows.map(x => x.id), ['s1', 's2', 's3', 's4', 's5', 's8', 's9'],
        'the suspended account (may come back) and the foreign members (a human decides) stay');
    const again = await check.autoFix('org1', { subjectId: 'project:stale' }, deps);
    assert.strictEqual(again.changed, 0);
});

test('a membership of an account the directory sync deactivated (status inactive) is flagged; sign-up states are not', async () => {
    await pg.exec(`
        INSERT INTO users (id, "organizationId", status) VALUES
            ('nc-owner', 'orgnc', 'active'), ('nc-deleted', 'orgnc', 'inactive'), ('nc-new', 'orgnc', 'unverified'),
            ('nc-legacy', 'orgnc', NULL);
        INSERT INTO projects (id, name, owner_id, organization_id, kind) VALUES ('ncp', 'P', 'nc-owner', 'orgnc', 'workspace');
        INSERT INTO project_shares (id, project_id, shared_with_type, shared_with_id, permission) VALUES
            ('nc-s1', 'ncp', 'user', 'nc-deleted', 'editor'), ('nc-s2', 'ncp', 'user', 'nc-new', 'viewer'),
            ('nc-s3', 'ncp', 'user', 'nc-legacy', 'viewer');
    `);
    const r = await check.evaluate('orgnc', null, deps);
    assert.strictEqual(r.status, 'warn');
    assert.strictEqual(r.evidence.dangling_count, 1);
    assert.strictEqual(r.evidence.foreign_count, 0);
});
