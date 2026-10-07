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

const fx = { detect: null, aiConfig: null, asked: [] };
const { swap, restore } = makeSwaps();
// The gate takes `detectPii` from ./detect when it loads, so swap it before
// anything that could load the gate is required.
const detect = require('./detect');
swap(detect, 'detectPii', async (text, ...rest) => { fx.asked.push(text); return fx.detect(text, ...rest); });
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
    fx.detect = () => null;
    const absent = await reportOf((report) => validateInputForPii(user(fresh('a@b.nl please')), false, SHIELD(), null, null, { report }));
    assert.deepEqual(absent.report, { status: 'guard_absent' });

    fx.detect = () => ({ hasPii: false, entities: [], guardAbsent: true });
    const ownWordsOnly = await reportOf((report) => validateInputForPii(user(fresh('a@b.nl please')), false, SHIELD(), null, null, { report }));
    assert.deepEqual(ownWordsOnly.report, { status: 'guard_absent' });

    fx.detect = () => ({ hasPii: false, entities: [], degraded: true, degradedReason: 'guard_unreachable' });
    const open = await reportOf((report) => validateInputForPii(user(fresh('a@b.nl please')), false, SHIELD({ piiFailureMode: 'fail_open' }), null, null, { report }));
    assert.deepEqual(open.report, { status: 'failed_open' });
    const closed = await reportOf((report) => validateInputForPii(user(fresh('a@b.nl please')), false, SHIELD(), null, null, { report }));
    assert.equal(closed.threw.privacyUnavailable, true);
    assert.deepEqual(closed.report, { status: 'failed_closed' });

    fx.detect = () => { throw new Error('socket hang up'); };
    const crashed = await reportOf((report) => validateInputForPii(user(fresh('a@b.nl please')), false, SHIELD(), null, null, { report }));
    assert.equal(crashed.returned, null, 'the catch-all still fails open');
    assert.deepEqual(crashed.report, { status: 'failed_open' });
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
