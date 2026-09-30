'use strict';

/**
 * GDPR-Art35-project-ai-participation — against a real Postgres (pglite):
 * subjects are the conversations where the AI joins by itself ('always' and
 * the new 'auto'); special-category data without a DPIA fails, the shield off
 * warns, a current DPIA (agent, project or org-wide) passes; the auto-fix
 * switches only the failing chats back to "on mention" and announces it;
 * ids only in evidence; the 'default' bucket.
 *
 * Run: cd server && node --test compliance/checks/gdpr/art35-project-ai-participation.test.js
 */

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');

const { useProjectCheckDb } = require('../../projects/testSchema');
const check = require('./art35-project-ai-participation');

const { pg, query } = useProjectCheckDb(`
        INSERT INTO projects (id, name, owner_id, organization_id, kind) VALUES
            ('ph', 'Clinic Bakker', 'u1', 'org1', 'workspace'),
            ('pn', 'Names', 'u1', 'org1', 'workspace'),
            ('pd', 'Solo', 'u2', '', 'workspace');
        INSERT INTO project_chats (id, project_id, title, created_by, ai_mode, agent_id, archived) VALUES
            ('c-auto', 'ph', 'sealed', 'u1', 'auto', NULL, false),
            ('c-always', 'ph', 'sealed', 'u1', 'always', 'agent-7', false),
            ('c-mention', 'ph', 'sealed', 'u1', 'mention', NULL, false),
            ('c-archived', 'ph', 'sealed', 'u1', 'always', NULL, true),
            ('c-names', 'pn', 'sealed', 'u1', 'auto', NULL, false),
            ('c-solo', 'pd', 'sealed', 'u2', 'auto', NULL, false);
        INSERT INTO project_comment_threads (id, project_id, ai_mode, status) VALUES
            ('t-auto', 'pn', 'auto', 'open'), ('t-closed', 'pn', 'auto', 'resolved');
    `);
const NOW = Date.parse('2026-09-29T12:00:00Z');
const announced = [];
let shieldOn = true;
const SIGNALS = new Map([['ph', { kinds: ['health', 'name'] }], ['pn', { kinds: ['name'] }]]);
const deps = (over = {}) => ({
    query,
    signals: { signalsFor: async () => ({ byProject: SIGNALS, unreadable: [] }) },
    shieldOn: async () => shieldOn,
    announce: async (projectId, chatId) => { announced.push([projectId, chatId]); },
    now: () => NOW,
    ...over,
});

beforeEach(() => { announced.length = 0; shieldOn = true; });

test('subjects are the open conversations where the AI joins by itself — the whole population', async () => {
    const listed = await check.listSubjects('org1', deps());
    assert.deepStrictEqual(listed.subjects.map(s => s.id), ['project_chat:c-always', 'project_chat:c-auto', 'project_chat:c-names', 'project_comment_thread:t-auto']);
    assert.strictEqual(listed.complete, true);
    assert.deepStrictEqual((await check.listSubjects('default', deps())).subjects.map(s => s.id), ['project_chat:c-solo']);
    assert.strictEqual(check.retiresVanished, true, 'a chat switched back to "on mention" is retired, not left failing');
    assert.match(check.retiredDetails, /no longer joins this conversation by itself/);
});

test('a subject query past its limit makes the list a window (complete: false)', async () => {
    const many = Array.from({ length: 5001 }, (_, i) => ({ id: `c${i}`, project_id: 'ph', agent_id: null, ai_mode: 'auto' }));
    const listed = await check.listSubjects('org1', deps({ query: async (sql) => (/FROM project_chats/.test(sql) ? many : []) }));
    assert.strictEqual(listed.complete, false);
    assert.strictEqual(listed.subjects.length, 5000);
});

// Every evaluate() used to list every subject again (two queries of up to
// 5000 rows each), per subject: quadratic per sweep and per auto-fix click.
function countingDeps() {
    const q = query;
    const counts = { subjects: 0 };
    return { counts, d: deps({ query: async (sql, p) => { if (/ai_mode IN|ai_mode = 'auto'/.test(sql) && /^\s*SELECT/.test(sql)) counts.subjects++; return q(sql, p); } }) };
}

test('evaluate judges the subject it is handed without listing every subject again', async () => {
    const { counts, d } = countingDeps();
    const { subjects } = await check.listSubjects('org1', d);
    assert.strictEqual(counts.subjects, 2, 'one query per surface to list');
    for (const s of subjects) await check.evaluate('org1', s, d);
    assert.strictEqual(counts.subjects, 2, 'no further listing, however many subjects');
    assert.strictEqual((await check.evaluate('org1', subjects.find(s => s.id === 'project_chat:c-auto'), d)).status, 'fail');
});

test('the auto-fix judges every chat from the one list it read', async () => {
    const { counts, d } = countingDeps();
    // Nothing fails with the shield on and no special-category data known, so
    // nothing is switched and the shared fixture stays as the later tests expect.
    const r = await check.autoFix('org1', {}, { ...d, signals: { signalsFor: async () => ({ byProject: new Map(), unreadable: [] }) } });
    assert.strictEqual(r.changed, 0);
    assert.strictEqual(counts.subjects, 2);
});

test('special-category data without a DPIA fails; ids only in evidence', async () => {
    const r = await check.evaluate('org1', { id: 'project_chat:c-auto' }, deps());
    assert.strictEqual(r.status, 'fail');
    assert.strictEqual(r.evidence.project_id, 'ph');
    assert.strictEqual(r.evidence.ai_mode, 'auto');
    assert.strictEqual(r.evidence.link, '/app/projects/ph/chats');
    assert.ok(!JSON.stringify(r).includes('Bakker'));
});

test('a current DPIA for the persona, the project or the whole organisation covers it; an expired one does not', async () => {
    await pg.exec(`INSERT INTO dpia_assessments (organization_id, agent_id, approved_at) VALUES ('org1', 'agent-7', NOW())`);
    assert.strictEqual((await check.evaluate('org1', { id: 'project_chat:c-always' }, deps())).status, 'pass');
    assert.strictEqual((await check.evaluate('org1', { id: 'project_chat:c-auto' }, deps())).status, 'fail', 'the persona DPIA covers only that persona');
    await pg.exec(`INSERT INTO dpia_assessments (organization_id, agent_id, approved_at, expires_at) VALUES ('org1', 'project:ph', NOW(), '2026-01-01')`);
    assert.strictEqual((await check.evaluate('org1', { id: 'project_chat:c-auto' }, deps())).status, 'fail', 'expired');
    await pg.exec(`INSERT INTO dpia_assessments (organization_id, agent_id, approved_at) VALUES ('org1', '${check.ORG_WIDE_DPIA_KEY}', NOW())`);
    assert.strictEqual((await check.evaluate('org1', { id: 'project_chat:c-auto' }, deps())).status, 'pass');
    await pg.exec(`DELETE FROM dpia_assessments`);
});

test('with the shield off the AI reads raw data: a warning, even without known personal data', async () => {
    shieldOn = false;
    const r = await check.evaluate('org1', { id: 'project_comment_thread:t-auto' }, deps());
    assert.strictEqual(r.status, 'warn');
    assert.match(r.details, /Privacy Shield is off/);
    shieldOn = true;
    assert.strictEqual((await check.evaluate('org1', { id: 'project_comment_thread:t-auto' }, deps())).status, 'pass');
});

test('unreadable signals or DPIA register warn; a vanished subject is not applicable', async () => {
    const sig = await check.evaluate('org1', { id: 'project_chat:c-auto' }, deps({ signals: { signalsFor: async () => ({ byProject: new Map(), unreadable: ['events'] }) } }));
    assert.strictEqual(sig.status, 'warn');
    const q = query;
    const dpia = await check.evaluate('org1', { id: 'project_chat:c-auto' }, deps({ query: async (sql, p) => {
        if (/dpia_assessments/.test(sql)) throw new Error('timeout');
        return q(sql, p);
    } }));
    assert.strictEqual(dpia.status, 'warn');
    assert.strictEqual((await check.evaluate('org1', { id: 'project_chat:c-mention' }, deps())).status, 'not_applicable');
});

test('the auto-fix switches only the failing chats to "on mention" and announces each', async () => {
    const r = await check.autoFix('org1', {}, deps());
    assert.strictEqual(r.changed, 2, 'c-auto and c-always hold health data without a DPIA; c-names does not fail');
    const { rows } = await pg.query(`SELECT id, ai_mode FROM project_chats ORDER BY id`);
    const mode = Object.fromEntries(rows.map(x => [x.id, x.ai_mode]));
    assert.strictEqual(mode['c-auto'], 'mention');
    assert.strictEqual(mode['c-always'], 'mention');
    assert.strictEqual(mode['c-names'], 'auto');
    assert.strictEqual(mode['c-archived'], 'always', 'archived chats are not touched');
    assert.deepStrictEqual(announced.sort(), [['ph', 'c-always'], ['ph', 'c-auto']]);
    const named = await check.autoFix('org1', { subjectId: 'project_chat:c-names' }, deps());
    assert.strictEqual(named.changed, 1);
    const foreign = await check.autoFix('org2', { subjectId: 'project_chat:c-solo' }, deps());
    assert.strictEqual(foreign.changed, 0, 'another org cannot switch this org\'s chat');
});
