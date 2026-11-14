/**
 * validateInputForPii's `options.report` (chat signals, build spec 5.2a).
 *
 * Chat signals count the decision the input gate ALREADY made on a turn,
 * never a second scan, so the gate says what it decided: a status before
 * every exit, plus the decision and the category ids when something was
 * found. Pinned here:
 *
 *   - every exit writes its own status, the cache-hit variants included;
 *   - without a report the return and the throws are identical;
 *   - the categories come from the LAST user message only: a colleague's
 *     e-mail address earlier in a shared thread never shows up in another
 *     person's turn (amendment 24). The detector is asked about that one
 *     message and nothing else;
 *   - categories are ids, never a span, a value or a token.
 *
 * The detector and the AI config are swapped on their module objects
 * (testUtils/swaps) before the gate loads; the gate, the allowlist, the
 * tokenizer and the scan cache are real.
 *
 * Run: cd server && node --test core/privacy/piiDetection/validate.report.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { makeSwaps } = require('../../../testUtils/swaps');

const fx = { detect: null, aiConfig: null, asked: [], scopes: [] };
const { swap, restore } = makeSwaps();
// The gate takes `detectPii` from ./detect when it loads, so swap it before
// anything that could load the gate is required.
const detect = require('./detect');
swap(detect, 'detectPii', async (text, ...rest) => { fx.asked.push(text); fx.scopes.push([rest[0], rest[1]]); return fx.detect(text, ...rest); });
const aiAgent = require('../../aiAgent');
swap(aiAgent, 'getAIConfig', async () => fx.aiConfig);
const { validateInputForPii } = require('./validate');
after(restore);

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
/** A detector that really looks at the text it is given: e-mail addresses only. */
function emailDetector(text) {
    const entities = [...text.matchAll(EMAIL)].map((m) => ({
        text: m[0], label: 'Email', category: 'EmailAddress', offset: m.index, length: m[0].length, confidence: 0.95,
    }));
    return { hasPii: entities.length > 0, entities };
}

const SHIELD = (over = {}) => ({ enabled: true, piiDetectionAction: 'tokenize', piiFailureMode: 'fail_closed', ...over });
const user = (content) => [{ role: 'user', content }];
let n = 0;
/** A text no earlier case has scanned, so the scan cache cannot answer for it. */
const fresh = (body) => `${body} #${++n}`;

beforeEach(() => {
    fx.detect = emailDetector;
    fx.aiConfig = { piiDetectionEnabled: false, piiDetectionAction: 'block' };
    fx.asked = [];
    fx.scopes = [];
});

async function reportOf(call) {
    const report = {};
    let threw = null;
    let returned;
    try { returned = await call(report); } catch (e) { threw = e; }
    return { report, threw, returned };
}

test('gate off, policy allow, nothing to scan: disabled, allowed_by_policy, too_short', async () => {
    const off = await reportOf((report) => validateInputForPii(user('mail me at a@b.nl'), false, { enabled: false }, null, null, { report }));
    assert.deepEqual(off.report, { status: 'disabled' });

    const allow = await reportOf((report) => validateInputForPii(user('mail me at a@b.nl'), false, SHIELD(), 'allow', null, { report }));
    assert.deepEqual(allow.report, { status: 'allowed_by_policy' });

    const noUser = await reportOf((report) => validateInputForPii([{ role: 'assistant', content: 'hello there' }], false, SHIELD(), null, null, { report }));
    assert.deepEqual(noUser.report, { status: 'too_short' });

    const short = await reportOf((report) => validateInputForPii(user('hi'), false, SHIELD(), null, null, { report }));
    assert.deepEqual(short.report, { status: 'too_short' });
    assert.deepEqual(fx.asked, [], 'none of these reached the detector');
});

test('a fresh scan: clean, found + tokenised, found + blocked', async () => {
    const clean = await reportOf((report) => validateInputForPii(user(fresh('nothing personal here')), false, SHIELD(), null, null, { report }));
    assert.deepEqual(clean.report, { status: 'clean' });

    const masked = await reportOf((report) => validateInputForPii(user(fresh('write to ada@example.org')), false, SHIELD(), null, null, { report }));
    assert.deepEqual(masked.report, { status: 'found', decision: 'tokenised', categories: ['EmailAddress'] });
    assert.ok(masked.returned.tokenizedText.includes('['), 'still tokenised as before');

    const blocked = await reportOf((report) => validateInputForPii(user(fresh('write to ada@example.org')), false, SHIELD({ piiDetectionAction: 'block' }), null, null, { report }));
    assert.match(blocked.threw.message, /PII Detected/);
    assert.deepEqual(blocked.report, { status: 'found', decision: 'blocked', categories: ['EmailAddress'] });
});

test('the cache-hit variants report exactly what the fresh scan reported', async () => {
    for (const [body, shield, expected] of [
        ['still nothing personal', SHIELD(), { status: 'clean' }],
        ['ping bob@example.org', SHIELD(), { status: 'found', decision: 'tokenised', categories: ['EmailAddress'] }],
        ['ping eve@example.org', SHIELD({ piiDetectionAction: 'block' }), { status: 'found', decision: 'blocked', categories: ['EmailAddress'] }],
    ]) {
        const text = fresh(body);
        const first = await reportOf((report) => validateInputForPii(user(text), false, shield, null, null, { report }));
        const asked = fx.asked.length;
        const again = await reportOf((report) => validateInputForPii(user(text), false, shield, null, null, { report }));
        assert.equal(fx.asked.length, asked, `${body}: the second read is a cache hit`);
        assert.deepEqual(first.report, expected, body);
        assert.deepEqual(again.report, expected, `${body}, cached`);
    }
});

test('no detector, a degraded detector and a failing detector', async () => {
    // No guard installed: with the shield on and the mode fail_closed (the
    // shield's default) the scan the org asked for cannot happen, so the turn
    // is refused; under fail_open the feature is simply off, as before.
    fx.detect = () => null;
    const absentOpen = await reportOf((report) => validateInputForPii(user(fresh('a@b.nl please')), false, SHIELD({ piiFailureMode: 'fail_open' }), null, null, { report }));
    assert.deepEqual(absentOpen.report, { status: 'guard_absent' });
    const absentClosed = await reportOf((report) => validateInputForPii(user(fresh('a@b.nl please')), false, SHIELD(), null, null, { report }));
    assert.equal(absentClosed.threw.privacyUnavailable, true);
    assert.equal(absentClosed.threw.degradedReason, 'guard_not_installed');
    assert.deepEqual(absentClosed.report, { status: 'failed_closed' });
    // The global flag alone, mode unset: no shield asked for the scan.
    fx.aiConfig = { piiDetectionEnabled: true, piiDetectionAction: 'block' };
    const absentGlobal = await reportOf((report) => validateInputForPii(user(fresh('a@b.nl please')), false, null, null, null, { report }));
    assert.deepEqual(absentGlobal.report, { status: 'guard_absent' });
    fx.aiConfig = { piiDetectionEnabled: false, piiDetectionAction: 'block' };

    fx.detect = () => ({ hasPii: false, entities: [], guardAbsent: true });
    const ownWordsOnly = await reportOf((report) => validateInputForPii(user(fresh('a@b.nl please')), false, SHIELD({ piiFailureMode: 'fail_open' }), null, null, { report }));
    assert.deepEqual(ownWordsOnly.report, { status: 'guard_absent' });
    const ownWordsClosed = await reportOf((report) => validateInputForPii(user(fresh('a@b.nl please')), false, SHIELD(), null, null, { report }));
    assert.deepEqual(ownWordsClosed.report, { status: 'failed_closed' });

    fx.detect = () => ({ hasPii: false, entities: [], degraded: true, degradedReason: 'guard_unreachable' });
    const open = await reportOf((report) => validateInputForPii(user(fresh('a@b.nl please')), false, SHIELD({ piiFailureMode: 'fail_open' }), null, null, { report }));
    assert.deepEqual(open.report, { status: 'failed_open' });
    const closed = await reportOf((report) => validateInputForPii(user(fresh('a@b.nl please')), false, SHIELD(), null, null, { report }));
    assert.equal(closed.threw.privacyUnavailable, true);
    assert.deepEqual(closed.report, { status: 'failed_closed' });

    // A detector that throws is a gate failure: the failure policy decides,
    // not the catch-all on its own.
    fx.detect = () => { throw new Error('socket hang up'); };
    const crashedOpen = await reportOf((report) => validateInputForPii(user(fresh('a@b.nl please')), false, SHIELD({ piiFailureMode: 'fail_open' }), null, null, { report }));
    assert.equal(crashedOpen.returned, null, 'fail_open: the catch-all lets the text through');
    assert.deepEqual(crashedOpen.report, { status: 'failed_open' });
    const crashedClosed = await reportOf((report) => validateInputForPii(user(fresh('a@b.nl please')), false, SHIELD(), null, null, { report }));
    assert.equal(crashedClosed.threw.privacyUnavailable, true);
    assert.match(crashedClosed.threw.degradedReason, /^gate_error: socket hang up/);
    assert.deepEqual(crashedClosed.report, { status: 'failed_closed' });
});

test('the statuses are distinct per exit', async () => {
    const seen = new Set();
    const exits = [
        () => validateInputForPii(user('x@y.nl!'), false, { enabled: false }, null, null, { report: r() }),
        () => validateInputForPii(user('x@y.nl!'), false, SHIELD(), 'allow', null, { report: r() }),
        () => validateInputForPii(user('hi'), false, SHIELD(), null, null, { report: r() }),
        () => validateInputForPii(user(fresh('plain')), false, SHIELD(), null, null, { report: r() }),
        () => validateInputForPii(user(fresh('z@y.nl')), false, SHIELD(), null, null, { report: r() }),
    ];
    let current;
    function r() { current = {}; return current; }
    for (const exit of exits) {
        try { await exit(); } catch (_) { /* a throw is an exit too */ }
        seen.add(`${current.status}/${current.decision || ''}`);
    }
    assert.equal(seen.size, exits.length, [...seen].join(', '));
});

test('without a report the gate answers byte-for-byte as before', async () => {
    const text = fresh('mail carol@example.org today');
    const withReport = await validateInputForPii(user(text), false, SHIELD(), null, null, { report: {} });
    const without = await validateInputForPii(user(text), false, SHIELD(), null, null, {});
    const bare = await validateInputForPii(user(text), false, SHIELD());
    assert.deepEqual(without, withReport);
    assert.deepEqual(bare, withReport);

    const blockText = fresh('mail dave@example.org today');
    const errs = [];
    for (const options of [{ report: {} }, {}]) {
        try { await validateInputForPii(user(blockText), false, SHIELD({ piiDetectionAction: 'block' }), null, null, options); } catch (e) { errs.push(e); }
    }
    assert.equal(errs.length, 2);
    assert.equal(errs[0].message, errs[1].message);
    assert.deepEqual(errs[0].piiEntities, errs[1].piiEntities);
    assert.deepEqual(errs[0].violationCodes, errs[1].violationCodes);
});

test('shared thread: a colleague\'s e-mail earlier in the history is not this turn\'s category', async () => {
    // User A wrote an address, the assistant answered, user B wrote nothing
    // personal. B's turn is what is counted, and it is clean.
    const history = [
        { role: 'user', content: 'Hi, this is Ann, reach me at ann.devries@example.org' },
        { role: 'assistant', content: 'Noted.' },
        { role: 'user', content: fresh('Can you summarise the plan for the team') },
    ];
    const res = await reportOf((report) => validateInputForPii(history, false, SHIELD(), null, null, { report }));
    assert.deepEqual(res.report, { status: 'clean' });
    assert.equal(res.report.categories, undefined, 'no categories at all');
    assert.equal(fx.asked.length, 1, 'one scan');
    assert.ok(!fx.asked[0].includes('ann.devries'), 'the detector only ever saw the last user message');
});

test('categories are category ids: never the value, the span or the token', async () => {
    const res = await reportOf((report) => validateInputForPii(user(fresh('cc frank@example.org and gina@example.org')), false, SHIELD(), null, null, { report }));
    assert.deepEqual(res.report.categories, ['EmailAddress'], 'distinct ids, one per category');
    const wire = JSON.stringify(res.report);
    for (const leak of ['frank', 'gina', 'example.org', '[email', 'offset']) {
        assert.ok(!wire.includes(leak), `the report carries "${leak}": ${wire}`);
    }
});

// ── Which policy the gate applies, and which scan it asks for ─────────────

const status = async (call) => (await reportOf(call)).report.status;
const DEGRADED = () => ({ hasPii: false, entities: [], degraded: true, degradedReason: 'guard_unreachable' });

test('the gate switches on for the global flag or the agent flag as well as the shield', async () => {
    fx.aiConfig = { piiDetectionEnabled: true };
    assert.equal(await status((report) => validateInputForPii(user(fresh('plain words')), false, null, null, null, { report })), 'clean');
    fx.aiConfig = { piiDetectionEnabled: false };
    assert.equal(await status((report) => validateInputForPii(user(fresh('plain words')), true, null, null, null, { report })), 'clean');
    assert.equal(await status((report) => validateInputForPii(user(fresh('plain words')), false, null, null, null, { report })), 'disabled');
});

test('the action: the per-call override, then the shield, then the AI config, then block', async () => {
    const decision = async (shield, override, aiAction) => {
        fx.aiConfig = { piiDetectionEnabled: true, piiDetectionAction: aiAction };
        return (await reportOf((report) => validateInputForPii(user(fresh('to ann@example.org')), false, shield, override, null, { report }))).report.decision;
    };
    assert.equal(await decision(SHIELD({ piiDetectionAction: 'block' }), 'tokenize', 'block'), 'tokenised');
    assert.equal(await decision(SHIELD({ piiDetectionAction: 'tokenize' }), null, 'block'), 'tokenised');
    assert.equal(await decision(SHIELD({ piiDetectionAction: undefined }), null, 'tokenize'), 'tokenised');
    assert.equal(await decision(SHIELD({ piiDetectionAction: undefined }), null, undefined), 'blocked');
});

test('the failure mode: the shield, then the AI config, then fail_closed', async () => {
    fx.detect = DEGRADED;
    fx.aiConfig = { piiDetectionEnabled: false, piiFailureMode: 'fail_open' };
    assert.equal(await status((report) => validateInputForPii(user(fresh('ann@example.org')), false, SHIELD({ piiFailureMode: undefined }), null, null, { report })), 'failed_open');
    fx.aiConfig = { piiDetectionEnabled: false, piiFailureMode: 'fail_closed' };
    assert.equal(await status((report) => validateInputForPii(user(fresh('ann@example.org')), false, SHIELD({ piiFailureMode: 'fail_open' }), null, null, { report })), 'failed_open');
    fx.aiConfig = { piiDetectionEnabled: false };
    assert.equal(await status((report) => validateInputForPii(user(fresh('ann@example.org')), false, SHIELD({ piiFailureMode: undefined }), null, null, { report })), 'failed_closed');
});

test('no guard: refused when the AI config says fail_closed, even under a fail_open shield', async () => {
    fx.detect = () => null;
    fx.aiConfig = { piiDetectionEnabled: true, piiFailureMode: 'fail_closed' };
    const global = await reportOf((report) => validateInputForPii(user(fresh('ann@example.org')), false, null, null, null, { report }));
    assert.equal(global.threw.degradedReason, 'guard_not_installed');
    assert.equal(global.threw.privacyUnavailableKind, 'unavailable');
    const shieldOpen = await reportOf((report) => validateInputForPii(user(fresh('ann@example.org')), false, SHIELD({ piiFailureMode: 'fail_open' }), null, null, { report }));
    assert.equal(shieldOpen.threw.degradedReason, 'guard_not_installed');
});

test('own words found without a guard are acted on, and that answer is not cached', async () => {
    fx.detect = (text) => ({ ...emailDetector(text), guardAbsent: true });
    const text = fresh('to ann@example.org');
    const first = await reportOf((report) => validateInputForPii(user(text), false, SHIELD(), null, null, { report }));
    assert.equal(first.report.decision, 'tokenised');
    await validateInputForPii(user(text), false, SHIELD());
    assert.equal(fx.asked.length, 2, 'asked again: nothing was cached');
});

test('a message in blocks: the first text block is what is scanned; no text block is too short', async () => {
    const body = fresh('to ann@example.org');
    await validateInputForPii([{ role: 'user', content: [{ type: 'image' }, { type: 'text', text: body }, { type: 'text', text: 'later block' }] }], false, SHIELD());
    assert.deepEqual(fx.asked, [body]);
    assert.equal(await status((report) => validateInputForPii([{ role: 'user', content: [{ type: 'image' }] }], false, SHIELD(), null, null, { report })), 'too_short');
});

test('the scope asked for: the shield\'s categories and threshold, else the AI config\'s, else everything at the default', async () => {
    await validateInputForPii(user(fresh('plain')), false, SHIELD({ piiDetectionCategories: ['Email', 'AzureStorageAccountKey', 'NoSuchThing'], piiDetectionConfidenceThreshold: 0.5 }));
    assert.deepEqual(fx.scopes.pop(), [['Email', 'ApiKeyOrSecret'], 0.5]);
    await validateInputForPii(user(fresh('plain')), false, SHIELD({ piiDetectionCategories: [], piiDetectionConfidenceThreshold: '0.5' }));
    const [all, defaultThreshold] = fx.scopes.pop();
    assert.equal(all.length, 21);
    assert.equal(defaultThreshold, 0.7);

    // No shield passed and none stored: the AI config's list, legacy ids mapped.
    const configStore = require('../../../stores/configStore');
    const undo = swap(configStore, 'getAllConfig', async () => ({}));
    try {
        fx.aiConfig = { piiDetectionEnabled: true, piiDetectionCategories: ['EUNationalIdentificationNumber', 'Email', 'Gone'], piiDetectionConfidenceThreshold: 0.8 };
        await validateInputForPii(user(fresh('plain')), false, null);
        assert.deepEqual(fx.scopes.pop(), [['NationalIdentificationNumber', 'Email'], 0.8]);
        fx.aiConfig = { piiDetectionEnabled: true, piiDetectionCategories: [] };
        await validateInputForPii(user(fresh('plain')), false, null);
        assert.deepEqual(fx.scopes.pop().map((v) => (Array.isArray(v) ? v.length : v)), [21, 0.7]);
    } finally { undo(); }
    // A store that cannot be read: everything, at the AI config's threshold.
    const undoThrow = swap(configStore, 'getAllConfig', async () => { throw new Error('store down'); });
    try {
        fx.aiConfig = { piiDetectionEnabled: true, piiDetectionCategories: ['Email'], piiDetectionConfidenceThreshold: 0.8 };
        await validateInputForPii(user(fresh('plain')), false, null);
        assert.deepEqual(fx.scopes.pop().map((v) => (Array.isArray(v) ? v.length : v)), [21, 0.8]);
    } finally { undoThrow(); }
});

test('a fail-closed degradation names its kind: too large, a timeout, or unavailable', async () => {
    for (const [reason, kind, advice] of [
        ['input_too_large: 9 windows', 'too_large', /too large to scan/],
        ['guard timeout', 'timeout', /temporarily unavailable/],
        [undefined, 'unavailable', /temporarily unavailable/],
    ]) {
        fx.detect = () => ({ hasPii: false, entities: [], degraded: true, degradedReason: reason, degradedCategories: ['Email'] });
        const res = await reportOf((report) => validateInputForPii(user(fresh('ann@example.org')), false, SHIELD(), null, null, { report }));
        assert.equal(res.threw.privacyUnavailableKind, kind, String(reason));
        assert.match(res.threw.message, advice);
        assert.equal(res.threw.degradedReason, reason || null);
        assert.deepEqual(res.threw.degradedCategories, ['Email']);
    }
});

test('a block names the categories and carries one violation code per entity', async () => {
    const res = await reportOf(() => validateInputForPii(user(fresh('cc ann@example.org and bo@example.org')), false, SHIELD({ piiDetectionAction: 'block' })));
    assert.match(res.threw.message, /^PII Detected: Message contains sensitive personal information \(Email\)\./);
    assert.deepEqual(res.threw.violationCodes, ['PII:EmailAddress', 'PII:EmailAddress']);
});
