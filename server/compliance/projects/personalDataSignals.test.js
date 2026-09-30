'use strict';

/**
 * Personal-data signals per project, read from what is already persisted —
 * against a real Postgres (pglite) with the real project, team chat and
 * content-signal DDL, so the shipped SQL runs where its columns exist.
 *
 * Run: cd server && node --test compliance/projects/personalDataSignals.test.js
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { PGlite } = require('@electric-sql/pglite');

const { applyProjectCheckSchema, queryOf } = require('./testSchema');
const { makeSignalReader, hasSpecialKinds } = require('./personalDataSignals');

const pg = new PGlite();
let reader;

const KB = '11111111-1111-1111-1111-111111111111';
const DOC1 = '22222222-2222-2222-2222-222222222221';
const DOC2 = '22222222-2222-2222-2222-222222222222';

before(async () => {
    await applyProjectCheckSchema(pg);
    await pg.exec(`
        INSERT INTO projects (id, name, owner_id, organization_id, kind, files_kb_id) VALUES
            ('pf', 'Files', 'u1', 'org1', 'workspace', '${KB}'),
            ('pn', 'Notebook', 'u1', 'org1', 'workspace', NULL),
            ('pe', 'Events', 'u1', 'org1', NULL, NULL),
            ('pc', 'Content', 'u1', 'org1', 'workspace', NULL),
            ('pquiet', 'Quiet', 'u1', 'org1', 'workspace', NULL),
            ('psol', 'Solution', 'u1', 'org1', 'solution', NULL),
            ('pother', 'Elsewhere', 'u9', 'org2', 'workspace', NULL),
            ('pdef', 'Solo', 'u5', '', 'workspace', NULL);
        INSERT INTO knowledge_bases (id, organization_id, source_kind) VALUES ('${KB}', 'org1', 'project_files');
        INSERT INTO documents (id, knowledge_base_id, pii_status, pii_categories) VALUES
            ('${DOC1}', '${KB}', 'redacted', '["MedicalCondition", "Person"]'),
            ('${DOC2}', '${KB}', 'none', NULL);
        INSERT INTO notebooks (id, user_id, project_id, pii_token_map) VALUES ('n1', 'u1', 'pn', 'sealed'), ('n2', 'u1', 'pquiet', NULL),
            ('nsol', 'u1', 'psol', 'sealed'), ('ndef', 'u5', 'pdef', 'sealed');
        INSERT INTO project_chats (id, project_id, title, created_by) VALUES ('c1', 'pe', 'sealed', 'u1');
        INSERT INTO guardrail_events (organization_id, conversation_id, violation_categories, source) VALUES
            ('org1', 'c1', 'NationalIdentificationNumber,Email', 'project_chat'),
            ('org1', 'c1', 'Person', 'project_chat'),
            ('org2', 'c1', 'Person', 'project_chat');
        INSERT INTO guardrail_events (organization_id, conversation_id, violation_categories, source, is_dry_run) VALUES
            ('org1', 'c1', 'MedicalCondition', 'project_chat', true);
        INSERT INTO guardrail_events (organization_id, conversation_id, violation_categories, source, timestamp) VALUES
            ('org1', 'c1', 'Medication', 'project_chat', NOW() - INTERVAL '120 days');
        INSERT INTO studio_documents (id, user_id, project_id) VALUES ('d1', 'u1', 'pc'), ('d2', 'u1', 'pquiet'), ('dmoved', 'u1', NULL);
        INSERT INTO content_pii_signals (organization_id, project_id, subject_kind, subject_id, categories, kinds, mention_count, degraded) VALUES
            ('org1', 'pc', 'studio_document', 'd1', '{"Person": 4}', '{name}', 4, false),
            ('org1', 'pquiet', 'studio_document', 'd2', '{}', '{}', 0, true),
            ('org1', 'pquiet', 'studio_document', 'dmoved', '{"Email": 2}', '{email}', 2, false),
            ('org1', 'pquiet', 'studio_document', 'dgone', '{"Email": 2}', '{email}', 2, false);
    `);
    reader = makeSignalReader({ query: queryOf(pg) });
});
after(() => pg.close());

test('each source contributes the projects it proves hold personal data, with kinds', async () => {
    const { byProject, unreadable } = await reader.signalsFor('org1');
    assert.deepStrictEqual(unreadable, []);
    assert.deepStrictEqual([...byProject.keys()].sort(), ['pc', 'pe', 'pf', 'pn']);
    assert.deepStrictEqual(byProject.get('pf').kinds, ['health', 'name']);
    assert.deepStrictEqual(byProject.get('pf').sources, ['files']);
    assert.deepStrictEqual(byProject.get('pn').kinds, ['personal'], 'a token map proves personal data, not which kind');
    assert.deepStrictEqual(byProject.get('pe').kinds, ['email', 'id_number', 'name']);
    assert.deepStrictEqual(byProject.get('pc').categories, { Person: 4 });
});

test('dry runs, old events, degraded scans, other orgs and Solutions are not signals', async () => {
    const { byProject } = await reader.signalsFor('org1');
    assert.ok(!byProject.get('pe').kinds.includes('health'), 'the dry-run and the 120-day-old event are out');
    assert.ok(!byProject.has('pquiet'), 'a degraded scan is unknown, not a finding; a moved-out or deleted document takes its signal with it');
    assert.ok(!byProject.has('psol'));
    assert.ok(!byProject.has('pother'));
});

test('the default bucket sees the org-less projects', async () => {
    const { byProject } = await reader.signalsFor('default');
    assert.deepStrictEqual([...byProject.keys()], ['pdef']);
});

test('a source this install does not have is skipped; one that fails is named', async () => {
    const missing = makeSignalReader({ query: async (sql, params) => {
        if (/content_pii_signals/.test(sql)) { const e = new Error('relation does not exist'); e.code = '42P01'; throw e; }
        if (/guardrail_events/.test(sql)) throw new Error('canceling statement due to statement timeout');
        return queryOf(pg)(sql, params);
    } });
    const { byProject, unreadable } = await missing.signalsFor('org1');
    assert.deepStrictEqual(unreadable, ['events', 'comments']);
    assert.ok(byProject.has('pf'));
    assert.ok(!byProject.has('pc'));
});

test('the picture is memoised per org for a sweep', async () => {
    let calls = 0;
    const counted = makeSignalReader({ query: async (sql, params) => { calls++; return queryOf(pg)(sql, params); } });
    await counted.signalsFor('org1');
    const first = calls;
    await counted.signalsFor('org1');
    assert.strictEqual(calls, first);
    await counted.signalsFor('org2');
    assert.ok(calls > first);
});

test('special kinds are health and national identifiers', () => {
    assert.strictEqual(hasSpecialKinds(['name', 'health']), true);
    assert.strictEqual(hasSpecialKinds(['id_number']), true);
    assert.strictEqual(hasSpecialKinds(['name', 'personal']), false);
    assert.strictEqual(hasSpecialKinds(undefined), false);
});

// ── only PII decisions count ─────────────────────────────────────────────
//
// guardrail_events also records hidden-character smuggling, the org's own
// regex rules, a detector that was down and scans that failed. Pasting text
// with zero-width characters into a project notebook used to turn the project
// into a personal-data subject with the "category" '3 hidden chars'.

test('guardrail events that are not PII decisions never make a project a personal-data subject', async () => {
    await pg.exec(`
        INSERT INTO projects (id, name, owner_id, organization_id, kind) VALUES
            ('pu', 'Unicode', 'u1', 'orgnoise', 'workspace'), ('pa', 'Unavailable', 'u1', 'orgnoise', 'workspace'),
            ('pr', 'Regex', 'u1', 'orgnoise', 'workspace'), ('pb', 'Blocked', 'u1', 'orgnoise', 'workspace'),
            ('ps', 'Scan failed', 'u1', 'orgnoise', 'workspace');
        INSERT INTO notebooks (id, user_id, project_id) VALUES ('nu', 'u1', 'pu'), ('nr', 'u1', 'pr');
        INSERT INTO project_chats (id, project_id, title, created_by) VALUES ('ca', 'pa', 'sealed', 'u1'), ('cb', 'pb', 'sealed', 'u1'),
            ('cs', 'ps', 'sealed', 'u1');
        INSERT INTO guardrail_events (organization_id, conversation_id, violation_type, violation_categories, source, action_taken) VALUES
            ('orgnoise', 'nu', 'unicode_smuggling', '3 hidden chars', 'notebook', 'stripped'),
            ('orgnoise', 'ca', 'pii_unavailable', 'privacy_protection_unavailable', 'project_chat', 'blocked'),
            ('orgnoise', 'nr', 'regex', 'Client number,Email', 'notebook', 'blocked'),
            ('orgnoise', 'cb', 'pii', 'blocked', 'project_chat', 'blocked'),
            ('orgnoise', 'cs', 'pii', 'Email', 'project_chat', 'scan_failed');
    `);
    const { byProject, unreadable } = await makeSignalReader({ query: queryOf(pg) }).signalsFor('orgnoise');
    assert.deepStrictEqual(unreadable, []);
    assert.deepStrictEqual([...byProject.keys()], [],
        'smuggling, a detector that was down, a regex rule, a label that is no PII id and a failed scan prove nothing');
});

test('only canonical PII categories are kept from a PII decision; comment threads count as their own source', async () => {
    await pg.exec(`
        INSERT INTO projects (id, name, owner_id, organization_id, kind) VALUES ('pk', 'Kept', 'u1', 'orgkeep', 'workspace');
        INSERT INTO project_chats (id, project_id, title, created_by) VALUES ('ck', 'pk', 'sealed', 'u1');
        INSERT INTO project_comment_threads (id, project_id) VALUES ('tk', 'pk');
        INSERT INTO guardrail_events (organization_id, conversation_id, violation_type, violation_categories, source) VALUES
            ('orgkeep', 'ck', 'pii', 'Email Address, something else', 'project_chat'),
            ('orgkeep', 'tk', 'pii', 'MedicalCondition', 'project_comment'),
            ('orgkeep', 'tk', 'pii', 'Person', 'project_comment_gate');
    `);
    const { byProject } = await makeSignalReader({ query: queryOf(pg) }).signalsFor('orgkeep');
    assert.deepStrictEqual(byProject.get('pk'), {
        categories: { Email: 1, MedicalCondition: 1, Person: 1 },
        kinds: ['email', 'health', 'name'],
        sources: ['comments', 'events'],
    });
});

// ── one row per project, in a fixed order ────────────────────────────────
//
// The sources used to return one row per file or event under LIMIT 5000 with
// no ORDER BY: Postgres picked which rows came back, so a project could drop
// out of the picture in one sweep (and be retired as gone) and return in the
// next.

test('a busy project cannot push a quiet one out of the picture: events are counted per project', async () => {
    await pg.exec(`
        INSERT INTO projects (id, name, owner_id, organization_id, kind) VALUES
            ('pbusy', 'Busy', 'u1', 'orgbusy', 'workspace'), ('pquiet2', 'Quiet', 'u1', 'orgbusy', 'workspace');
        INSERT INTO project_chats (id, project_id, title, created_by) VALUES ('cbusy', 'pbusy', 'sealed', 'u1'), ('cquiet', 'pquiet2', 'sealed', 'u1');
        INSERT INTO guardrail_events (organization_id, conversation_id, violation_type, violation_categories, source)
            SELECT 'orgbusy', 'cbusy', 'pii', 'Person', 'project_chat' FROM generate_series(1, 5200);
        INSERT INTO guardrail_events (organization_id, conversation_id, violation_type, violation_categories, source) VALUES
            ('orgbusy', 'cquiet', 'pii', 'NationalIdentificationNumber', 'project_chat');
    `);
    const { byProject, truncated } = await makeSignalReader({ query: queryOf(pg) }).signalsFor('orgbusy');
    assert.deepStrictEqual(truncated, []);
    assert.deepStrictEqual(byProject.get('pbusy').categories, { Person: 5200 });
    assert.deepStrictEqual(byProject.get('pquiet2').kinds, ['id_number'], 'the quiet project with an identity number is always there');
});

test('a source past its project limit is named in `truncated`, and the same projects come back every time', async () => {
    await pg.exec(`
        INSERT INTO projects (id, name, owner_id, organization_id, kind)
            SELECT 'm' || lpad(i::text, 5, '0'), 'n', 'u1', 'orgmany', 'workspace' FROM generate_series(1, 5001) AS i;
        INSERT INTO notebooks (id, user_id, project_id, pii_token_map)
            SELECT 'nm' || i, 'u1', 'm' || lpad(i::text, 5, '0'), 'sealed' FROM generate_series(5001, 1, -1) AS i;
    `);
    const first = await makeSignalReader({ query: queryOf(pg) }).signalsFor('orgmany');
    const second = await makeSignalReader({ query: queryOf(pg) }).signalsFor('orgmany');
    assert.deepStrictEqual(first.truncated, ['notebooks']);
    assert.deepStrictEqual(first.unreadable, []);
    assert.strictEqual(first.byProject.size, 5000);
    assert.ok(first.byProject.has('m00001') && !first.byProject.has('m05001'), 'ordered by project id');
    assert.deepStrictEqual([...second.byProject.keys()], [...first.byProject.keys()]);
});
