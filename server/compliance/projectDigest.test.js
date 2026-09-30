'use strict';

/**
 * The daily project-findings digest: one notice per org per day, only about
 * new (or changed) findings of project checks, never about a decided one,
 * counts and a link only.
 *
 * Run: cd server && node --test compliance/projectDigest.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');

const { makeProjectDigest } = require('./projectDigest');
const findingState = require('./findingState');

const DEFS = {
    'GDPR-Art30-project-personal-data': { id: 'GDPR-Art30-project-personal-data', regulation: 'GDPR', projectCheck: true },
    'GDPR-Art32-project-access': { id: 'GDPR-Art32-project-access', regulation: 'GDPR', projectCheck: true },
    'GDPR-Art32-dlp-enabled': { id: 'GDPR-Art32-dlp-enabled', regulation: 'GDPR' },
    'AIA-Art50-project-ai-edits-attributed': { id: 'AIA-Art50-project-ai-edits-attributed', regulation: 'AIA', projectCheck: true },
};

function harness({ rows, states = [], active = ['GDPR'] } = {}) {
    const log = new Set();
    const sent = [];
    let now = Date.parse('2026-09-29T08:00:00Z');
    const store = {
        getLatestPerCheck: async () => rows,
        listFindingStates: async () => states,
        wasNotified: async (o, k, id, off) => log.has([o, k, id, off].join('|')),
        markNotified: async (o, k, id, off) => {
            const key = [o, k, id, off].join('|');
            if (log.has(key)) return false;
            log.add(key);
            return true;
        },
    };
    const digest = makeProjectDigest({
        complianceStore: store,
        registry: { get: (id) => DEFS[id] || null },
        frameworkPolicy: { activeRegulations: async () => new Set(active) },
        notices: { notify: async (orgId, n) => { sent.push({ orgId, ...n }); return 1; } },
        now: () => now,
    });
    return { digest, sent, log, advance: (ms) => { now += ms; } };
}

const ROWS = [
    { check_id: 'GDPR-Art30-project-personal-data', status: 'warn', scope_type: 'per-source', scope_id: 'project:p1', evidence: { kinds: ['name'] } },
    { check_id: 'GDPR-Art30-project-personal-data', status: 'fail', scope_type: 'per-source', scope_id: 'project:p2', evidence: { kinds: ['health'] } },
    { check_id: 'GDPR-Art32-project-access', status: 'pass', scope_type: 'global', scope_id: null, evidence: {} },
    { check_id: 'GDPR-Art32-dlp-enabled', status: 'fail', scope_type: 'global', scope_id: null, evidence: {} },
    { check_id: 'AIA-Art50-project-ai-edits-attributed', status: 'warn', scope_type: 'global', scope_id: null, evidence: {} },
];

test('the first digest reports the open project findings of active frameworks, as counts and a link', async () => {
    const { digest, sent } = harness({ rows: ROWS });
    const r = await digest.sendDigest('org1');
    assert.deepStrictEqual(r, { sent: true, count: 2 });
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0].category, 'heads_up');
    assert.match(sent[0].message, /^2 new finding\(s\) in collaborative projects since the last digest, 1 of them failing\./);
    assert.strictEqual(sent[0].link, '/app/admin/compliance/overview');
    assert.ok(!/p1|p2/.test(JSON.stringify(sent[0])), 'no project id in the notice');
});

test('one digest per day; the same findings are never reported twice; a changed one is', async () => {
    const h = harness({ rows: ROWS });
    await h.digest.sendDigest('org1');
    assert.deepStrictEqual(await h.digest.sendDigest('org1'), { sent: false, reason: 'already_sent' });
    h.advance(24 * 3600_000);
    assert.deepStrictEqual(await h.digest.sendDigest('org1'), { sent: false, reason: 'nothing_new' });
    const worse = ROWS.map(r => (r.scope_id === 'project:p1' ? { ...r, status: 'fail' } : r));
    const h2 = harness({ rows: worse });
    for (const k of h.log) h2.log.add(k);
    h2.advance(24 * 3600_000);
    const r = await h2.digest.sendDigest('org1');
    assert.deepStrictEqual(r, { sent: true, count: 1 }, 'warn → fail is news');
});

test('a decided finding is not reported', async () => {
    const row = ROWS[0];
    const states = [{ check_id: row.check_id, scope_key: row.scope_id, fingerprint: findingState.fingerprintOf(row), state: 'accepted_risk' }];
    const { digest } = harness({ rows: [row], states });
    assert.deepStrictEqual(await digest.sendDigest('org1'), { sent: false, reason: 'nothing_new' });
});

test('a digest that fails is a log line, never a throw', async () => {
    const digest = makeProjectDigest({
        complianceStore: { wasNotified: async () => { throw new Error('db down'); } },
        registry: { get: () => null },
        frameworkPolicy: { activeRegulations: async () => new Set() },
        notices: { notify: async () => 0 },
    });
    assert.deepStrictEqual(await digest.sendDigest('org1'), { sent: false, reason: 'error' });
});
