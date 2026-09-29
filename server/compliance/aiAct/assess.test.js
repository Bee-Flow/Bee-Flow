/**
 * aiAct/assess — outcome matrix, answer allow-list, expiry.
 * Run: node --test --test-force-exit server/compliance/aiAct/assess.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const assess = require('./assess');

const S = (over = {}) => ({ contains_ai: true, customer_facing: false, generates_content: false, disclosure_present: false, marking_enabled: false, ...over });

test('outcome matrix: no AI → not_applicable regardless of answers', () => {
    assert.strictEqual(assess.outcome(S({ contains_ai: false }), { art5: { answer: 'yes' } }), 'not_applicable');
    assert.strictEqual(assess.outcome({}, {}), 'not_applicable');
    assert.strictEqual(assess.outcome(null, null), 'not_applicable');
});

test('outcome matrix: art5 yes → prohibited beats everything; annex_iii yes → high_risk beats transparency', () => {
    assert.strictEqual(assess.outcome(S({ customer_facing: true }), { art5: { answer: 'yes' }, annex_iii: { answer: 'yes' } }), 'prohibited');
    assert.strictEqual(assess.outcome(S(), { art5: { answer: true } }), 'prohibited');
    assert.strictEqual(assess.outcome(S({ customer_facing: true, generates_content: true }), { annex_iii: { answer: 'yes' } }), 'high_risk');
    assert.strictEqual(assess.outcome(S(), { art5: { answer: 'no' }, annex_iii: { answer: 'YES' } }), 'high_risk');
});

test('outcome matrix: transparency when customer-facing or generating (signals or admin answers), else minimal', () => {
    assert.strictEqual(assess.outcome(S({ customer_facing: true }), {}), 'transparency');
    assert.strictEqual(assess.outcome(S({ generates_content: true }), {}), 'transparency');
    assert.strictEqual(assess.outcome(S(), { art50: { interacts: 'yes' } }), 'transparency');
    assert.strictEqual(assess.outcome(S(), { art50: { generates: 'yes' } }), 'transparency');
    assert.strictEqual(assess.outcome(S(), { art50: { interacts: 'no', generates: 'no' } }), 'minimal');
    assert.strictEqual(assess.outcome(S(), {}), 'minimal');
    // the admin cannot narrow a detected signal
    assert.strictEqual(assess.outcome(S({ customer_facing: true }), { art50: { interacts: 'no' } }), 'transparency');
    for (const o of ['not_applicable', 'prohibited', 'high_risk', 'transparency', 'minimal']) assert.ok(assess.OUTCOMES.includes(o));
});

test('normalizeAnswers is an allow-list: unknown keys, free text and foreign practices are dropped', () => {
    const n = assess.normalizeAnswers({
        art5: { answer: 'no', practices: ['social_scoring', 'made_up', 'social_scoring', 42], note: 'John Doe asked' },
        art50: { interacts: true, disclosure: 'maybe', generates: 'NO', marking: 'yes', prompt: 'system prompt text' },
        annex_iii: {
            answer: 'unknown', category: 'employment', who: 'jane@example.com',
            // the per-domain half is an allow-list too: a domain the catalogue
            // does not know is dropped, and its value never reaches the JSONB
            domains: { employment: 'yes', made_up_domain: 'yes', biometrics: 'sort of', note: 'jane@example.com' },
        },
        extra: { email: 'x@y.z' },
    });
    const UNANSWERED = {
        biometrics: 'unknown', critical_infrastructure: 'unknown', education: 'unknown', employment: 'unknown',
        essential_services: 'unknown', credit: 'unknown', insurance: 'unknown', law_enforcement: 'unknown',
        migration: 'unknown', justice: 'unknown',
    };
    assert.deepStrictEqual(n, {
        art5: { answer: 'no', practices: ['social_scoring'] },
        art50: { interacts: 'yes', disclosure: 'unknown', generates: 'no', marking: 'yes' },
        annex_iii: {
            // one domain answered yes, so the single answer is DERIVED from
            // the ten rather than read from the client's `answer: 'unknown'`
            answer: 'yes',
            category: 'employment',
            domains: { ...UNANSWERED, employment: 'yes' },
        },
    });
    assert.ok(!JSON.stringify(n).includes('@'), 'no e-mail survives normalisation');
    assert.ok(!JSON.stringify(n).includes('made_up_domain'), 'and no unknown domain either');
    assert.deepStrictEqual(assess.normalizeAnswers(undefined).art5, { answer: 'unknown', practices: [] });
    assert.deepStrictEqual(assess.normalizeAnswers(undefined).annex_iii.domains, UNANSWERED,
        'the ten are always present, so \'not asked\' is a value and not an absence');
    assert.strictEqual(assess.normalizeAnswers({ annex_iii: { category: 'x'.repeat(100) } }).annex_iii.category.length, 40);
    assert.strictEqual(assess.normalizeAnswers({ annex_iii: { category: '' } }).annex_iii.category, null);
});

test('expiresAt: attested_at + 12 months in UTC; invalid dates throw', () => {
    const at = new Date('2026-09-14T10:00:00Z');
    assert.strictEqual(assess.expiresAt(at).toISOString(), '2027-09-14T10:00:00.000Z');
    assert.strictEqual(assess.expiresAt('2026-01-31T00:00:00Z').toISOString(), '2027-01-31T00:00:00.000Z');
    assert.strictEqual(assess.VALID_MONTHS, 12);
    assert.throws(() => assess.expiresAt('nope'), /not a date/);
});

test('openDuties: disclosure when interacting without one, marking when generating without the org flag', () => {
    assert.deepStrictEqual(assess.openDuties(S({ customer_facing: true, generates_content: true }), {}), ['art50_1_disclosure', 'art50_2_marking']);
    assert.deepStrictEqual(assess.openDuties(S({ customer_facing: true, disclosure_present: true, generates_content: true, marking_enabled: true }), {}), []);
    assert.deepStrictEqual(assess.openDuties(S({ customer_facing: true }), { art50: { disclosure: 'yes' } }), [], 'an attested disclosure closes the duty');
    assert.deepStrictEqual(assess.openDuties(S(), { art50: { generates: 'yes' } }), ['art50_2_marking']);
    assert.deepStrictEqual(assess.openDuties(S({ contains_ai: false, customer_facing: true }), {}), []);
});

test('assess() bundles normalised answers, outcome, duties and expiry; not_applicable never expires', () => {
    const at = new Date('2026-09-14T10:00:00Z');
    const r = assess.assess(S({ generates_content: true }), { art50: { marking: 'no' } }, { attestedAt: at });
    assert.strictEqual(r.outcome, 'transparency');
    assert.deepStrictEqual(r.open_duties, ['art50_2_marking']);
    assert.strictEqual(r.expires_at.toISOString(), '2027-09-14T10:00:00.000Z');
    assert.strictEqual(r.answers.art50.marking, 'no');
    const na = assess.assess(S({ contains_ai: false }), {}, { attestedAt: at });
    assert.strictEqual(na.outcome, 'not_applicable');
    assert.strictEqual(na.expires_at, null);
});
