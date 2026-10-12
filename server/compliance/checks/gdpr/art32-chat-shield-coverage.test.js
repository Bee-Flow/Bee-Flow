'use strict';

/**
 * GDPR-Art32-chat-shield-coverage: judged only on completed weeks, enough
 * people and enough turns; a warning never rests on fewer than 5 turns; the
 * evidence holds bands, suppressed percentages, dates and enums only.
 *
 * Run: cd server && node --test compliance/checks/gdpr/art32-chat-shield-coverage.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const check = require('./art32-chat-shield-coverage');

const TODAY = new Date('2026-10-21T12:00:00.000Z');   // Wednesday; last completed week starts 10-12
const ON = { state: 'on', version: '2026-09-01T00:00:00.000Z', from: '2026-09-01', surfaces: ['direct'], signals: ['outcomes'] };

function deps({ mon = ON, rows = {}, contributors = 12 } = {}) {
    const reads = [];
    return {
        reads,
        resolve: async () => mon,
        outcomeTotals: async (org, w) => { reads.push({ org, ...w }); return rows[w.surfaces[0]] || []; },
        contributorCount: async () => contributors,
        now: () => TODAY,
    };
}
const r = (value, turns, destination = 'external') => ({ value, destination, provider_type: 'openai', turns });

/** Every leaf outside the `pct` maps: no number below 5 except 0. */
function assertEvidenceClean(evidence) {
    const walk = (v, key) => {
        if (key && /(_id|^id|user)$/i.test(key)) assert.fail(`key ${key} in evidence`);
        if (v === null || typeof v !== 'object') {
            if (typeof v === 'number') assert.ok(v === 0 || v >= 5, `${key} = ${v}`);
            return;
        }
        for (const [k, x] of Object.entries(v)) {
            if (k === 'pct') {
                for (const p of Object.values(x)) assert.ok(p === null || p === '<5' || p === 'hidden' || Number.isInteger(p), `pct ${p}`);
                continue;
            }
            walk(x, k);
        }
    };
    walk(evidence, '');
    assert.ok(!('kinds' in evidence), 'never kinds');
}

test('off: not_applicable', async () => {
    const res = await check.evaluate('org1', null, deps({ mon: { state: 'off', surfaces: [] } }));
    assert.equal(res.status, 'not_applicable');
    assert.equal(res.details, 'Chat signals are off.');
});

test('no completed ISO week yet: not_applicable (amendment 8)', async () => {
    const d = deps({ mon: { ...ON, version: '2026-10-14T09:00:00.000Z' }, rows: { direct: [r('clean', 400)] } });
    const res = await check.evaluate('org1', null, d);
    assert.equal(res.status, 'not_applicable');
    assert.equal(res.evidence.surfaces.direct.reason, 'no_full_period');
    assert.equal(d.reads.length, 0, 'nothing is read for a surface without a full week');
    assert.ok(res.details.includes('Not counted:'));
});

test('4 contributors: not_applicable for that surface, and nothing about it in evidence', async () => {
    const res = await check.evaluate('org1', null, deps({ rows: { direct: [r('clean', 300), r('unscanned', 100)] }, contributors: 4 }));
    assert.equal(res.status, 'not_applicable');
    const e = res.evidence.surfaces.direct;
    assert.equal(e.reason, 'too_few_contributors');
    assert.equal(e.contributors, '<5');
    assert.equal(e.turns, null);
    assert.ok(Object.values(e.pct).every(v => v === null));
});

test('fewer than 25 turns: not_applicable', async () => {
    const res = await check.evaluate('org1', null, deps({ rows: { direct: [r('clean', 20), r('unscanned', 3)] } }));
    assert.equal(res.status, 'not_applicable');
    assert.equal(res.evidence.surfaces.direct.reason, 'too_few_turns');
    assert.equal(res.evidence.surfaces.direct.turns, 23);
});

test('a 5% external gap with a numerator of 5 warns; a gap with a numerator of 3 does not', async () => {
    const warn = await check.evaluate('org1', null, deps({ rows: { direct: [r('clean', 95), r('unscanned', 5)] } }));
    assert.equal(warn.status, 'warn');
    assert.deepEqual(warn.evidence.findings, [{ surface: 'direct', rule: 'unscanned_external' }]);
    assert.ok(warn.details.includes('Direct chat'));

    const small = await check.evaluate('org1', null, deps({ rows: { direct: [r('clean', 30), r('unscanned', 3)] } }));
    assert.equal(small.status, 'pass', '3 of 33 is 9%, but 3 turns are not enough to warn on');

    const internal = await check.evaluate('org1', null, deps({ rows: { direct: [r('clean', 50), r('unscanned', 20, 'internal')] } }));
    assert.equal(internal.status, 'pass', 'unscanned on an internal model is not a transfer gap');

    const unknown = await check.evaluate('org1', null, deps({ rows: { direct: [r('clean', 50), r('unscanned', 20, 'unknown')] } }));
    assert.equal(unknown.status, 'warn', 'the Swarm tier (unknown destination) counts as external');
});

test('the failed-closed rate warns; the sent-anyway rate warns', async () => {
    const closed = await check.evaluate('org1', null, deps({ rows: { direct: [r('clean', 90), r('scan_failed_closed', 10)] } }));
    assert.deepEqual(closed.evidence.findings, [{ surface: 'direct', rule: 'failed_closed' }]);
    const sent = await check.evaluate('org1', null, deps({ rows: { direct: [r('clean', 80), r('protected', 15), r('sent_unprotected', 5)] } }));
    assert.deepEqual(sent.evidence.findings, [{ surface: 'direct', rule: 'sent_unprotected' }]);
    const fewFound = await check.evaluate('org1', null, deps({ rows: { direct: [r('clean', 80), r('protected', 3), r('sent_unprotected', 5)] } }));
    assert.equal(fewFound.status, 'pass', 'fewer than 10 findings: not judged');
});

test('otherwise pass, with suppressed figures in words and the static uncounted list', async () => {
    const res = await check.evaluate('org1', null, deps({ rows: { direct: [r('clean', 80), r('protected', 16), r('blocked', 4)] } }));
    assert.equal(res.status, 'pass');
    assert.ok(res.details.startsWith('100 turns on 1 chat type in 30 days; a hidden share completed a Privacy Shield scan; a hidden share of findings were protected before the model.'), res.details);
    assert.ok(res.details.includes('Counts are approximate.'));
    for (const s of ['voice', 'template chat', 'webpage builder', 'App Studio', 'Nextcloud Assistant', 'learning coach', 'component designer', 'support responder', 'notebook', 'mobile app']) {
        assert.ok(res.details.includes(s), s);
    }
    assert.equal(res.evidence.surfaces.direct.pct.blocked, '<5');

    const plain = await check.evaluate('org1', null, deps({ rows: { direct: [r('clean', 80), r('protected', 15), r('blocked', 5)] } }));
    assert.equal(plain.status, 'pass');
    assert.ok(plain.details.startsWith('100 turns on 1 chat type in 30 days; 100% completed a Privacy Shield scan; 100% of findings were protected before the model.'), plain.details);
});

test('a share hidden on a surface stays hidden in the pass details: a "<5" cell cannot be worked out from the total', async () => {
    // 2 unscanned turns read "<5"; their complement hides "protected", so the
    // per-surface scanned share is hidden, and "98% of 100" may not reappear
    // in the details.
    const res = await check.evaluate('org1', null, deps({ rows: { direct: [r('clean', 80), r('protected', 18), r('unscanned', 2, 'internal')] } }));
    assert.equal(res.status, 'pass');
    assert.equal(res.evidence.surfaces.direct.pct.scanned, 'hidden');
    assert.ok(!res.details.includes('98%'), res.details);
    assert.ok(res.details.includes('a hidden share completed a Privacy Shield scan'), res.details);
});

test('evidence: bands, percentages, "<5", "hidden", dates and enums only', async () => {
    const res = await check.evaluate('org1', null, deps({
        mon: { ...ON, surfaces: ['direct', 'agent', 'agent_public'] },
        rows: {
            direct: [r('clean', 40), r('protected', 3), r('sent_unprotected', 12), r('unscanned', 6, 'unknown')],
            agent: [r('clean', 2)],
            agent_public: [r('clean', 60), r('blocked', 1)],
        },
        contributors: 7,
    }));
    assertEvidenceClean(res.evidence);
    assert.deepEqual(Object.keys(res.evidence).sort(), ['findings', 'min_contributors', 'min_turns', 'surfaces', 'window']);
    assert.deepEqual(res.evidence.window, { granularity_employee: 'week', granularity_visitor: 'day', days: 30 });
    assert.equal(res.evidence.surfaces.direct.from, '2026-09-21');
    assert.equal(res.evidence.surfaces.direct.to, '2026-10-12');
    assert.equal(res.evidence.surfaces.agent_public.to, '2026-10-20');
    assert.equal(res.evidence.surfaces.agent.turns, '<5');
    assert.ok(!JSON.stringify(res.evidence).includes('"contributors":7'));
});

test('the "default" bucket is read under its own key', async () => {
    const d = deps({ rows: { direct: [r('clean', 30)] } });
    await check.evaluate(null, null, d);
    assert.equal(d.reads[0].org, 'default');
});
