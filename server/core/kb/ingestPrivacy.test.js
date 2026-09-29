/**
 * The privacy screen at ingest.
 *
 * Every case here is a way of getting the PROMISE wrong rather than the code.
 * "We checked and it was clean", "we could not check", and "we checked and
 * removed something" are three different statements to a customer, and the
 * scanner collapses two of them into one `action:'pass'` — so the mapping is
 * the whole risk surface.
 *
 * Run: node --test --test-force-exit core/kb/ingestPrivacy.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const { applyShield, scanEnabledFor, isLegacyWarn, categoriesOf, OUTCOME, CONFIG_KEY } = require('./ingestPrivacy');

const TEXT = 'Quotes are valid 30 days. Contact Jan Jansen, jan@example.com.';
const TOKENISED = 'Quotes are valid 30 days. Contact [person_1], [email_1].';

function deps({ shield = { enabled: true }, scan, installed = true } = {}) {
    const calls = { scan: [] };
    return {
        calls,
        deps: {
            resolveShieldFor: async () => shield,
            guardInstalled: async () => installed,
            scanAttachmentText: async (args) => {
                calls.scan.push(args);
                return typeof scan === 'function' ? scan(args) : (scan || {
                    action: 'pass', text: args.text, findings: [], summary: { count: 0, byCategory: {} }, tokenMap: null,
                });
            },
        },
    };
}

test('a clean document is stored as-is and says so', async () => {
    const { deps: d } = deps();
    const r = await applyShield({ orgId: 'o1', text: TEXT, deps: d });
    assert.strictEqual(r.outcome, OUTCOME.PASS);
    assert.strictEqual(r.text, TEXT);
    assert.strictEqual(r.piiStatus, 'none');
});

test('a document with personal data is stored TOKENISED, and the map is not returned', async () => {
    // The map is what would let something undo this. There is deliberately
    // nothing downstream that can.
    const { deps: d } = deps({
        scan: () => ({
            action: 'tokenize', text: TOKENISED,
            findings: [{ category: 'Person' }, { category: 'Email' }],
            summary: { byCategory: { Person: 1, Email: 1 } },
            tokenMap: { '[email_1]': 'jan@example.com' },
        }),
    });
    const r = await applyShield({ orgId: 'o1', text: TEXT, deps: d });
    assert.strictEqual(r.outcome, OUTCOME.REDACTED);
    assert.strictEqual(r.text, TOKENISED);
    assert.strictEqual(r.piiStatus, 'redacted');
    assert.deepStrictEqual(r.piiCategories, ['Person', 'Email']);
    assert.ok(!('tokenMap' in r), 'the token map must not leave this module');
    assert.ok(!JSON.stringify(r).includes('jan@example.com'), 'and neither must the value');
});

test('the scan is never given a conversation, and never allowed to ask', async () => {
    // A conversation id would merge this document's map into a chat and make
    // the redaction reversible; `ask` has nobody to answer it at 06:00.
    const { deps: d, calls } = deps();
    await applyShield({ orgId: 'o1', text: TEXT, deps: d });
    assert.strictEqual(calls.scan[0].conversationId, null);
    assert.strictEqual(calls.scan[0].allowAsk, false);
});

test('an org whose action is "block" gets a row with a reason, not a vanished file', async () => {
    const { deps: d } = deps({
        scan: () => ({
            action: 'block', reason: 'pii',
            text: null, findings: [{ category: 'IBAN' }],
            summary: { byCategory: { IBAN: 1 } },
        }),
    });
    const r = await applyShield({ orgId: 'o1', text: TEXT, deps: d });
    assert.strictEqual(r.outcome, OUTCOME.SKIPPED);
    assert.strictEqual(r.text, null);
    assert.strictEqual(r.piiStatus, 'found');
    assert.match(r.reason, /personal data/i);
    assert.match(r.reason, /IBAN/, 'the reason names what was found, so it can be acted on');
});

test('an "ask" org redacts in the background rather than passing text through', async () => {
    // allowAsk:false means the scanner resolves this itself, but `ask` hands
    // back UNREDACTED text — a caller that forgot would store it believing it
    // had been screened.
    const { deps: d } = deps({
        scan: () => ({ action: 'ask', text: TEXT, findings: [{ category: 'Person' }], summary: { byCategory: { Person: 1 } } }),
    });
    const r = await applyShield({ orgId: 'o1', text: TEXT, deps: d });
    assert.strictEqual(r.piiStatus, 'redacted');
});

test('a guard that is not installed reads as unscanned, never as clean', async () => {
    // detectPii returns null and the scanner cannot tell that from "found
    // nothing" — both are action:'pass' with no findings. Claiming a clean
    // scan there is a promise nobody made.
    const { deps: d, calls } = deps({ installed: false });
    const r = await applyShield({ orgId: 'o1', text: TEXT, deps: d });
    assert.strictEqual(r.outcome, OUTCOME.PASS);
    assert.strictEqual(r.text, TEXT, 'the document is still stored');
    assert.strictEqual(r.piiStatus, 'unscanned');
    assert.match(r.reason, /not installed/i);
    assert.strictEqual(calls.scan.length, 0, 'and nothing is asked of a guard that is not there');
});

test('degraded + fail_closed holds the document for the next refresh', async () => {
    const { deps: d } = deps({
        shield: { enabled: true, piiFailureMode: 'fail_closed' },
        scan: () => ({ action: 'block', reason: 'degraded', text: null, findings: [], summary: { degraded: true } }),
    });
    const r = await applyShield({ orgId: 'o1', text: TEXT, deps: d });
    assert.strictEqual(r.outcome, OUTCOME.SKIPPED);
    assert.strictEqual(r.piiStatus, 'unscanned', 'not "found" — nothing was found, nothing could be looked for');
    assert.match(r.reason, /temporarily unavailable/i);
});

test('degraded + fail_open stores it, marked unscanned rather than clean', async () => {
    const { deps: d } = deps({
        shield: { enabled: true, piiFailureMode: 'fail_open' },
        scan: (a) => ({ action: 'pass', text: a.text, findings: [], summary: { degraded: true, degradedReason: 'guard_unreachable' } }),
    });
    const r = await applyShield({ orgId: 'o1', text: TEXT, deps: d });
    assert.strictEqual(r.outcome, OUTCOME.PASS);
    assert.strictEqual(r.piiStatus, 'unscanned');
    assert.match(r.reason, /unavailable/i);
});

test('a truncated scan keeps only what was checked, and says it is incomplete', async () => {
    const KEPT = 'Quotes are valid 30 days.…[document truncated]';
    const { deps: d } = deps({
        scan: () => ({ action: 'pass', text: KEPT, findings: [], summary: { truncated: true, sentChars: 25, totalChars: 400 } }),
    });
    const r = await applyShield({ orgId: 'o1', text: TEXT, deps: d });
    assert.strictEqual(r.text, KEPT, 'the unchecked tail must not be stored');
    assert.strictEqual(r.piiStatus, 'unscanned');
});

test('a legacy "warn" org is marked, and its text is left exactly alone', async () => {
    // resolveOrgShield passes the stored value through unvalidated, so this
    // row can still exist. Upgrading "just tell me" into redaction silently
    // would change what an org agreed to store.
    const { deps: d } = deps({
        shield: { enabled: true, piiDetectionAction: 'warn' },
        scan: () => ({
            action: 'tokenize', text: TOKENISED,
            findings: [{ category: 'Email' }], summary: { byCategory: { Email: 1 } },
        }),
    });
    const r = await applyShield({ orgId: 'o1', text: TEXT, deps: d });
    assert.strictEqual(r.outcome, OUTCOME.PASS);
    assert.strictEqual(r.text, TEXT, 'the ORIGINAL text');
    assert.strictEqual(r.piiStatus, 'found');
    assert.deepStrictEqual(r.piiCategories, ['Email']);
});

test('a shield that is off leaves documents unflagged, not amber', async () => {
    // "unscanned" on every document of an org that never asked for scanning
    // would be an alarm about a promise nobody made.
    const { deps: d, calls } = deps({ shield: { enabled: false } });
    const r = await applyShield({ orgId: 'o1', text: TEXT, deps: d });
    assert.strictEqual(r.piiStatus, 'none');
    assert.strictEqual(calls.scan.length, 0);
});

test('knowledge-base scanning defaults ON when the shield is on', () => {
    // Somebody who switched Privacy Shield on did not mean "except the
    // documents you keep forever and quote to customers".
    assert.strictEqual(scanEnabledFor({ enabled: true }), true);
    assert.strictEqual(scanEnabledFor({ enabled: true, [CONFIG_KEY]: true }), true);
    assert.strictEqual(scanEnabledFor({ enabled: true, [CONFIG_KEY]: false }), false);
    assert.strictEqual(scanEnabledFor({ enabled: false }), false);
    assert.strictEqual(scanEnabledFor(null), false);
});

test('a crash anywhere in the check is unscanned, never a thrown ingest', async () => {
    // A privacy check that fails must not take the document with it — but it
    // must not claim to have run either.
    const boom = { resolveShieldFor: async () => { throw new Error('config down'); } };
    const r1 = await applyShield({ orgId: 'o1', text: TEXT, deps: boom });
    assert.strictEqual(r1.piiStatus, 'unscanned');
    assert.match(r1.reason, /config down/);

    const { deps: d } = deps({ scan: () => { throw new Error('guard exploded'); } });
    const r2 = await applyShield({ orgId: 'o1', text: TEXT, deps: d });
    assert.strictEqual(r2.outcome, OUTCOME.PASS);
    assert.strictEqual(r2.text, TEXT);
    assert.strictEqual(r2.piiStatus, 'unscanned');
    assert.match(r2.reason, /guard exploded/);
});

test('empty text is not worth a scan', async () => {
    const { deps: d, calls } = deps();
    for (const t of ['', '   ', null, undefined]) {
        const r = await applyShield({ orgId: 'o1', text: t, deps: d });
        assert.strictEqual(r.piiStatus, 'none');
    }
    assert.strictEqual(calls.scan.length, 0);
});

test('pages are forwarded when the extractor produced them, and null when not', async () => {
    // Per-page budgets and a truncation boundary on a page edge both depend
    // on this; an empty array must not read as "one empty page".
    const { deps: d, calls } = deps();
    await applyShield({ orgId: 'o1', text: TEXT, pages: [{ pageNumber: 1, text: TEXT }], deps: d });
    assert.strictEqual(calls.scan[0].pages.length, 1);
    await applyShield({ orgId: 'o1', text: TEXT, pages: [], deps: d });
    assert.strictEqual(calls.scan[1].pages, null);
});

describe_categories();
function describe_categories() {
    test('categories come from the summary, and never carry a value', () => {
        assert.deepStrictEqual(categoriesOf({ summary: { byCategory: { Email: 2, IBAN: 1 } } }), ['Email', 'IBAN']);
        // Falls back to the findings when the summary has no breakdown.
        assert.deepStrictEqual(categoriesOf({ findings: [{ category: 'Person' }, { category: 'Person' }] }), ['Person']);
        assert.strictEqual(categoriesOf({ findings: [] }), null);
        assert.strictEqual(categoriesOf(null), null);
    });
}

test('isLegacyWarn recognises only the raw legacy value', () => {
    assert.strictEqual(isLegacyWarn({ piiDetectionAction: 'warn' }), true);
    assert.strictEqual(isLegacyWarn({ piiDetectionAction: 'tokenize' }), false);
    assert.strictEqual(isLegacyWarn({ privacyAction: 'ask' }), false, 'the canonical field never means warn');
    assert.strictEqual(isLegacyWarn(null), false);
});
