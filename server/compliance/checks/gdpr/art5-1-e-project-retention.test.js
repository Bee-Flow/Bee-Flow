'use strict';

/**
 * GDPR-Art5-1-e-project-retention — against a real Postgres (pglite): the
 * newest activity across the project's content, the window (the project's own
 * record, else the org setting, else 365 days, said in the details), warn past
 * it, fail past twice it, an unreadable source never a pass, the 'default'
 * bucket, and no names in evidence.
 *
 * Run: cd server && node --test compliance/checks/gdpr/art5-1-e-project-retention.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');

const { useProjectCheckDb } = require('../../projects/testSchema');
const check = require('./art5-1-e-project-retention');

const NOW = Date.parse('2026-09-29T12:00:00Z');
const DAY = 86400_000;
const ago = (d) => new Date(NOW - d * DAY).toISOString();
const { query } = useProjectCheckDb(`
        INSERT INTO projects (id, name, owner_id, organization_id, kind, updated_at) VALUES
            ('old', 'Old client Smit', 'u1', 'org1', 'workspace', '${ago(800)}'),
            ('fresh', 'Fresh', 'u1', 'org1', 'workspace', '${ago(900)}'),
            ('solo', 'Solo', 'u2', '', 'workspace', '${ago(10)}');
        INSERT INTO project_activity (id, project_id, actor_id, action, created_at) VALUES ('a1', 'old', 'u1', 'x', '${ago(400)}');
        INSERT INTO project_chats (id, project_id, title, created_by, last_message_at) VALUES ('c1', 'fresh', 'sealed', 'u1', '${ago(3)}');
    `);
let settings = {};
let registrations = [];
const deps = (over = {}) => ({
    query,
    signals: { signalsFor: async () => ({ byProject: new Map([['old', {}], ['fresh', {}]]), unreadable: [] }) },
    complianceStore: {
        getSettings: async () => settings,
        listSubjectRegistrations: async () => registrations,
    },
    now: () => NOW,
    ...over,
});

test('idle past the default window warns and says the default applies', async () => {
    settings = {}; registrations = [];
    const r = await check.evaluate('org1', { id: 'project:old' }, deps());
    assert.strictEqual(r.status, 'warn');
    assert.strictEqual(r.evidence.idle_days, 400, 'the activity log is newer than the project row');
    assert.strictEqual(r.evidence.retention_source, 'default');
    assert.match(r.details, /default of 365 days applies/);
    assert.ok(!JSON.stringify(r).includes('Smit'));
});

test('the org window and the project record move the line; twice the window fails', async () => {
    settings = { project_retention_days: 180 };
    const org = await check.evaluate('org1', { id: 'project:old' }, deps());
    assert.strictEqual(org.status, 'fail');
    assert.strictEqual(org.evidence.retention_source, 'org');
    registrations = [{ subject_id: 'old', retention_days: 730 }];
    const own = await check.evaluate('org1', { id: 'project:old' }, deps());
    assert.strictEqual(own.status, 'pass');
    assert.strictEqual(own.evidence.retention_source, 'project');
});

test('a recent team-chat message keeps a project current', async () => {
    settings = {}; registrations = [];
    const r = await check.evaluate('org1', { id: 'project:fresh' }, deps());
    assert.strictEqual(r.status, 'pass');
    assert.strictEqual(r.evidence.idle_days, 3);
});

test('another org\'s project is not judged here; the default bucket judges its own', async () => {
    const foreign = await check.evaluate('org2', { id: 'project:old' }, deps());
    assert.strictEqual(foreign.status, 'not_applicable');
    const solo = await check.evaluate('default', { id: 'project:solo' }, deps());
    assert.strictEqual(solo.status, 'pass');
});

test('a source that fails is never a pass; missing tables are skipped', async () => {
    const q = query;
    const r = await check.evaluate('org1', { id: 'project:fresh' }, deps({ query: async (sql, p) => {
        if (/FROM notebooks/.test(sql)) { const e = new Error('x'); e.code = '42P01'; throw e; }
        if (/project_activity/.test(sql)) throw new Error('timeout');
        return q(sql, p);
    } }));
    assert.strictEqual(r.status, 'warn');
    assert.deepStrictEqual(r.evidence.unreadable, ['activity']);
    const blank = check._verdict({ projectId: 'x', lastAt: null, retentionDays: 365, source: 'default', now: NOW });
    assert.strictEqual(blank.status, 'warn');
});

test('a window that cannot be read is never judged silently against the default', async () => {
    // 'fresh' was used 3 days ago: inside the 365-day default, so a failed
    // read of the settings and the records used to pass it unseen.
    const down = () => Promise.reject(Object.assign(new Error('terminating connection'), { code: '57P01' }));
    const r = await check.evaluate('org1', { id: 'project:fresh' }, deps({
        complianceStore: { getSettings: down, listSubjectRegistrations: down },
    }));
    assert.strictEqual(r.status, 'warn');
    assert.match(r.details, /could not be read/);
    assert.deepStrictEqual(r.evidence.unreadable, ['retention settings', 'processing records']);
    // A store that is not provisioned yet is not a failed read.
    const missing = () => Promise.reject(Object.assign(new Error('missing'), { code: '42P01' }));
    const fresh = await check.evaluate('org1', { id: 'project:fresh' }, deps({
        complianceStore: { getSettings: missing, listSubjectRegistrations: missing },
    }));
    assert.strictEqual(fresh.status, 'pass');
});

test('subjects are the personal-data projects; an unreadable signal refuses to list', async () => {
    const listed = await check.listSubjects('org1', deps());
    assert.deepStrictEqual(listed.subjects.map(s => s.id), ['project:fresh', 'project:old']);
    assert.strictEqual(listed.complete, true);
    assert.strictEqual(check.retiresVanished, true);
    const windowed = await check.listSubjects('org1', deps({ signals: { signalsFor: async () => ({ byProject: new Map([['old', {}]]), unreadable: [], truncated: ['files'] }) } }));
    assert.strictEqual(windowed.complete, false, 'a source past its limit: judge what is listed, retire nothing');
    await assert.rejects(check.listSubjects('org1', deps({ signals: { signalsFor: async () => ({ byProject: new Map(), unreadable: ['files'] }) } })));
});
