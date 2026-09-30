'use strict';

/**
 * GDPR-Art30-project-personal-data — against a real Postgres (pglite): the
 * subjects are the projects signals say hold personal data; no record warns,
 * special categories without a record fail, a current record passes, a stale
 * one warns; coverage names projects holding unexamined content; an unreadable
 * signal source refuses to list (so nothing is retired on a guess); ids and
 * counts only in evidence; the 'default' bucket.
 *
 * Run: cd server && node --test compliance/checks/gdpr/art30-project-personal-data.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');

const { useProjectCheckDb } = require('../../projects/testSchema');
const { makeSignalReader } = require('../../projects/personalDataSignals');
const check = require('./art30-project-personal-data');

const { query } = useProjectCheckDb(`
        INSERT INTO projects (id, name, owner_id, organization_id, kind) VALUES
            ('ph', 'Patient files De Vries', 'u1', 'org1', 'workspace'),
            ('pn', 'Names', 'u1', 'org1', 'workspace'),
            ('pq', 'Quiet', 'u1', 'org1', 'workspace'),
            ('pd', 'Solo', 'u2', '', 'workspace');
        INSERT INTO content_pii_signals (organization_id, project_id, subject_kind, subject_id, categories, kinds, mention_count) VALUES
            ('org1', 'ph', 'studio_document', 'd1', '{"MedicalCondition": 2, "Person": 1}', '{health,name}', 3),
            ('org1', 'pn', 'notebook_document', 'n1', '{"Person": 5}', '{name}', 5),
            ('default', 'pd', 'studio_document', 'd9', '{"Email": 1}', '{email}', 1);
        INSERT INTO studio_documents (id, user_id, project_id) VALUES ('d1', 'u1', 'ph'), ('d2', 'u1', 'pq'), ('d9', 'u2', 'pd');
        INSERT INTO notebooks (id, user_id, project_id) VALUES ('n1', 'u1', 'pn');
        INSERT INTO project_chats (id, project_id, title, created_by, ai_mode, message_count) VALUES
            ('c-off', 'pn', 'sealed', 'u1', 'off', 4), ('c-empty', 'pq', 'sealed', 'u1', 'off', 0);
    `);
const NOW = Date.parse('2026-09-29T12:00:00Z');
const DAY = 86400_000;
let registrations = [];
const deps = () => ({
    query,
    signals: makeSignalReader({ query: query }),
    complianceStore: {
        listSubjectRegistrations: async (orgId, kind) => (orgId === 'org1' && kind === 'project' ? registrations : []),
        getSettings: async () => ({ datatable_review_days: 90 }),
    },
    now: () => NOW,
});

test('subjects are the projects with a personal-data signal, as ids — the whole population', async () => {
    const listed = await check.listSubjects('org1', deps());
    assert.deepStrictEqual(listed, { subjects: [{ id: 'project:ph', label: 'project:ph' }, { id: 'project:pn', label: 'project:pn' }], complete: true });
    assert.deepStrictEqual((await check.listSubjects('default', deps())).subjects.map(s => s.id), ['project:pd']);
    assert.strictEqual(check.retiresVanished, true, 'a project that lost its last signal is retired by the runner');
    assert.doesNotMatch(check.retiredDetails, /No longer exists/, 'a project without signals may very well still exist');
});

test('a signal source past its limit makes the list a window, so the runner retires nothing', async () => {
    const d = deps();
    d.signals = { signalsFor: async () => ({ byProject: new Map([['ph', { kinds: ['health'] }]]), unreadable: [], truncated: ['events'] }) };
    assert.deepStrictEqual(await check.listSubjects('org1', d), { subjects: [{ id: 'project:ph', label: 'project:ph' }], complete: false });
});

test('special categories without a record fail; ordinary personal data without one warns', async () => {
    registrations = [];
    const health = await check.evaluate('org1', { id: 'project:ph' }, deps());
    assert.strictEqual(health.status, 'fail');
    assert.deepStrictEqual(health.evidence.kinds, ['health', 'name']);
    assert.deepStrictEqual(health.evidence.categories, { MedicalCondition: 2, Person: 1 });
    assert.strictEqual(health.evidence.link, '/app/projects/ph');
    assert.ok(!JSON.stringify(health).includes('De Vries'), 'no project name anywhere');
    const names = await check.evaluate('org1', { id: 'project:pn' }, deps());
    assert.strictEqual(names.status, 'warn');
});

test('a current record passes; a stale one or one without a lawful basis warns', async () => {
    registrations = [{ subject_id: 'ph', lawful_basis: 'legal_obligation', confirmed_at: new Date(NOW - 10 * DAY).toISOString() }];
    assert.strictEqual((await check.evaluate('org1', { id: 'project:ph' }, deps())).status, 'pass');
    registrations = [{ subject_id: 'ph', lawful_basis: 'legal_obligation', confirmed_at: new Date(NOW - 100 * DAY).toISOString() }];
    const stale = await check.evaluate('org1', { id: 'project:ph' }, deps());
    assert.strictEqual(stale.status, 'warn');
    assert.match(stale.details, /100 days ago; your interval is 90/);
    registrations = [{ subject_id: 'ph', lawful_basis: null, confirmed_at: new Date(NOW).toISOString() }];
    assert.strictEqual((await check.evaluate('org1', { id: 'project:ph' }, deps())).status, 'warn');
});

test('a subject whose signal vanished is not applicable', async () => {
    const r = check._verdict({ projectId: 'x', signal: null, registration: null, reviewDays: 180, now: NOW });
    assert.strictEqual(r.status, 'not_applicable');
});

test('coverage names the projects holding content no signal covers', async () => {
    const cov = await check.listCoverage('org1', deps());
    assert.strictEqual(cov.total, 3);
    assert.deepStrictEqual(cov.unexamined.map(u => u.id), ['project:pn', 'project:pq'],
        'pq: an unscanned document; pn: a team chat with the AI off; an empty off-chat is nothing to read');
    assert.strictEqual(cov.examined, 1);
    assert.ok(!JSON.stringify(cov).includes('Quiet'));
});

test('an unreadable signal source refuses to list, so the runner retires nothing', async () => {
    const d = deps();
    d.signals = { signalsFor: async () => ({ byProject: new Map(), unreadable: ['events'] }) };
    await assert.rejects(check.listSubjects('org1', d), /unreadable: events/);
});

test('the fingerprint changes with the kinds and the record, not with counts', () => {
    const a = check.fingerprintOf({ kinds: ['name'], registered: false, categories: { Person: 1 } });
    const b = check.fingerprintOf({ kinds: ['name'], registered: false, categories: { Person: 9 } });
    const c = check.fingerprintOf({ kinds: ['health', 'name'], registered: false });
    assert.deepStrictEqual(a, b);
    assert.notDeepStrictEqual(a, c);
});
