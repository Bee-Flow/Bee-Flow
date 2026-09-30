'use strict';

/**
 * Content signals — the background scan behind the project personal-data
 * checks. Everything is injected; what is under test is WHEN a scan runs
 * (coalesced, never on the caller's turn, only with the shield on), WHAT is
 * kept (categories and counts, never text) and that a failure is "unknown",
 * never "clean".
 *
 * Run: cd server && node --test core/dlp/contentSignals.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');

const { makeContentSignals, MAX_SCAN_CHARS } = require('./contentSignals');

const KINDS = { Person: 'name', Email: 'email', MedicalCondition: 'health' };

function harness({ shield = { enabled: true, piiDetectionCategories: ['Person'], piiDetectionConfidenceThreshold: 0.8 }, detect } = {}) {
    const rows = [];
    const detectCalls = [];
    const loads = [];
    const sig = makeContentSignals({
        resolveShieldFor: async () => (typeof shield === 'function' ? shield() : shield),
        detectWithLedger: async (text, opts) => {
            detectCalls.push({ text, opts });
            return detect ? detect(text, opts) : { entities: [{ category: 'Person' }, { category: 'person' }, { category: 'Email' }], degraded: false };
        },
        store: { upsertSignal: async (r) => { rows.push(r); return r; } },
        normalizeCategory: (c) => (String(c).toLowerCase() === 'person' ? 'Person' : c),
        kindOfCategory: (c) => KINDS[c] || null,
        coalesceMs: 10_000,
    });
    const job = (over = {}) => ({
        orgId: 'org1', projectId: 'p1', subjectKind: 'studio_document', subjectId: 'd1', versionId: 'v1',
        loadText: async () => { loads.push(over.versionId || 'v1'); return 'Jan Jansen, jan@example.com'; },
        ...over,
    });
    return { sig, rows, detectCalls, loads, job };
}

test('queueing does no work on the caller\'s turn and returns at once', async () => {
    const h = harness();
    assert.strictEqual(h.sig.queueContentScan(h.job()), true);
    await new Promise(r => setImmediate(r));
    assert.strictEqual(h.loads.length, 0);
    assert.strictEqual(h.rows.length, 0);
    h.sig._reset();
});

test('checkpoints of one subject coalesce: one scan, of the latest version', async () => {
    const h = harness();
    h.sig.queueContentScan(h.job({ versionId: 'v1' }));
    h.sig.queueContentScan(h.job({ versionId: 'v2' }));
    h.sig.queueContentScan(h.job({ versionId: 'v3' }));
    h.sig.queueContentScan(h.job({ subjectId: 'd2', versionId: 'x1' }));
    assert.strictEqual(h.sig._pendingCount(), 2);
    await h.sig._drain();
    assert.deepStrictEqual(h.loads.sort(), ['v3', 'x1']);
    assert.strictEqual(h.rows.length, 2);
});

test('the row holds categories, kinds and counts — never the text', async () => {
    const h = harness();
    h.sig.queueContentScan(h.job());
    await h.sig._drain();
    const [row] = h.rows;
    assert.deepStrictEqual(row.categories, { Person: 2, Email: 1 });
    assert.deepStrictEqual(row.kinds.sort(), ['email', 'name']);
    assert.strictEqual(row.mentionCount, 3);
    assert.strictEqual(row.degraded, false);
    assert.strictEqual(row.organizationId, 'org1');
    assert.ok(!JSON.stringify(row).includes('Jansen'));
    assert.deepStrictEqual(h.detectCalls[0].opts, { categories: ['Person'], threshold: 0.8, scope: 'g' });
});

test('with the shield off nothing is loaded, scanned or stored', async () => {
    for (const shield of [null, { enabled: false }, { enabled: true, privacyScanEnabled: false }]) {
        const h = harness({ shield });
        const r = await h.sig.scanNow(h.job());
        assert.deepStrictEqual(r, { ok: true, skipped: 'shield_off' });
        assert.strictEqual(h.loads.length, 0);
        assert.strictEqual(h.rows.length, 0);
    }
});

test('a degraded scan, a failed scan and a truncated text are recorded as unknown, never clean', async () => {
    const degraded = harness({ detect: () => ({ entities: [], degraded: true }) });
    await degraded.sig.scanNow(degraded.job());
    assert.strictEqual(degraded.rows[0].degraded, true);

    const failing = harness({ detect: () => { throw new Error('guard down'); } });
    const r = await failing.sig.scanNow(failing.job());
    assert.deepStrictEqual(r, { ok: false, degraded: true });
    assert.strictEqual(failing.rows[0].degraded, true);
    assert.strictEqual(failing.rows[0].mentionCount, 0);

    const long = harness({ detect: (text) => ({ entities: [], degraded: false, len: text.length }) });
    await long.sig.scanNow(long.job({ loadText: async () => 'x'.repeat(MAX_SCAN_CHARS + 10) }));
    assert.strictEqual(long.detectCalls[0].text.length, MAX_SCAN_CHARS);
    assert.strictEqual(long.rows[0].degraded, true);
});

test('bad jobs are refused without throwing; an unreadable shield skips', async () => {
    const h = harness();
    assert.strictEqual(h.sig.queueContentScan(null), false);
    assert.strictEqual(h.sig.queueContentScan(h.job({ subjectKind: 'email' })), false);
    assert.strictEqual(h.sig.queueContentScan(h.job({ loadText: 'text' })), false);
    const broken = harness({ shield: () => { throw new Error('config down'); } });
    assert.deepStrictEqual(await broken.sig.scanNow(broken.job()), { ok: false, skipped: 'shield_unreadable' });
    assert.strictEqual(broken.rows.length, 0);
});

test('an org-less project is filed under the default bucket', async () => {
    const h = harness();
    await h.sig.scanNow(h.job({ orgId: '' }));
    assert.strictEqual(h.rows[0].organizationId, 'default');
});
