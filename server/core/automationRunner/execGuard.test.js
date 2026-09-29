/**
 * The guard STEP — "does this contain personal data, and what happens if it does".
 *
 * The Privacy Shield already scans what a routine sends; this is the same
 * detector placed where an author can see it and react (a document lands in
 * Drive, it turns out to hold personal data, an alert goes out).
 *
 * Hermetic: `detectPii` is stubbed so the tests need no guard service, but
 * `tokenizeText` and the whole safety pipeline are the REAL implementations —
 * the masking and the fail-closed routing are exactly what is under test.
 *
 * Run: node --test server/core/automationRunner/execGuard.test.js
 */

const assert = require('node:assert');
const { test } = require('node:test');
const path = require('path');
const Module = require('module');

// Heavy leaves pre-mocked through the require cache before anything pulls them
// in (the execHttpRequest/execParseJson idiom) — a real db/configStore opens
// handles and the test never exits. `./safety` and the piiDetection PIPELINE
// stay real on purpose: the guard step's whole claim is that it gives the same
// answer the shield would, and a stubbed pipeline could not show that.
function mock(relPath, exports) {
    const resolved = require.resolve(relPath);
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}
mock('../../stores/automationStore', { getAutomation: async () => null, recordRunStep: async () => {} });
mock('../../stores/configStore', { getConfig: async () => null, getSecret: async () => '' });
mock('../../stores/notificationStore', {});
mock('../../db', { pool: {} });
mock('../aiAgent', { getProviderForModel: async () => null, getAIConfig: async () => ({}) });
mock('../providers', { getAdapter: () => ({}) });
mock('../../automation/codeSandbox', { run: async () => ({}) });
// An organisation WITHOUT automation_privacy_steps. The runner must never ask:
// a live guard keeps running after a lapse (automation/licensedSteps.js puts
// the gate on activation and test runs, never here).
const licenceAsked = [];
mock('../entitlements/entitlements', {
    hasCapability: async (id) => { licenceAsked.push(id); return false; },
    resolveCapabilitySet: async () => { licenceAsked.push('resolveCapabilitySet'); return { degraded: false, has: () => false }; },
});

// Required by ABSOLUTE path on purpose: requiring '../privacy/piiDetection' relatively
// from here would populate Node's relative-resolve cache for that exact
// (dir, specifier) pair, and the lazy requires inside safety.js / engine.js
// would then bypass the hook below — the stub would silently never be used.
const realPii = require(path.join(__dirname, '..', 'privacy', 'piiDetection'));

const detector = { fixtures: [], installed: true, degraded: null };
const piiStub = {
    ...realPii,
    async detectPii(text, categories) {
        // null = "no detector installed at all", which callers must read as
        // "we did not look" rather than "nothing found".
        if (!detector.installed) return null;
        if (detector.degraded) return { hasPii: false, entities: [], ...detector.degraded };
        const entities = [];
        for (const f of detector.fixtures) {
            if (categories && !categories.includes(f.category)) continue;
            let from = 0;
            for (;;) {
                const i = String(text).indexOf(f.text, from);
                if (i < 0) break;
                entities.push({ category: f.category, label: f.category, offset: i, length: f.text.length, text: f.text, confidence: 0.99 });
                from = i + f.text.length;
            }
        }
        return { hasPii: entities.length > 0, entities, degraded: false };
    },
};

const STUB_PII = path.join(__dirname, '__stub_pii_execguard__.js');
require.cache[STUB_PII] = { id: STUB_PII, filename: STUB_PII, loaded: true, exports: piiStub };

const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    const from = parent && parent.filename ? parent.filename : '';
    const mine = from.endsWith(path.join('automationRunner', 'safety.js'))
        || from.endsWith(path.join('automationRunner', 'engine.js'))
        || from.endsWith(path.join('automationRunner', 'execPrivacy.js'));
    if (mine && request === '../privacy/piiDetection') return STUB_PII;
    return origResolve.call(this, request, parent, ...rest);
};

const { execGuard } = require('./engine');

// ── fixtures ───────────────────────────────────────────────────────────────
// Real category ids (core/piiDetection PII_CATEGORIES) — buildPiiSummary
// resolves against them, so a made-up id would summarise to nothing.
const JAN = { category: 'Person', text: 'Jan de Vries' };
const MAIL = { category: 'Email', text: 'jan@acme.nl' };
const CLEAN = 'Quarterly figures are up and the warehouse is on schedule.';
const DIRTY = 'Mail Jan de Vries at jan@acme.nl about the invoice.';

// resolveAutomationPolicy returns ctx._safetyPolicy verbatim when set, so the
// tests state the org's posture directly instead of standing up an org.
function ctxWith(over = {}) {
    return {
        _safetyPolicy: {
            shield: {}, orgId: 'org1', piiEnabled: true, action: 'tokenize', regexRules: [],
            monitorIntegrations: true, scope: {}, privacyScope: 'external',
            confidence: 0.7, categories: null, customTerms: [],
            failureMode: 'fail_open', largeInputPolicy: 'fail_open',
            ...over,
        },
    };
}
const stateWith = (body) => ({ steps: { s1: { output: { body } } } });
const guard = (over = {}) => ({ id: 'g1', type: 'guard', sourceRef: 'steps.s1.output.body', ...over });

function reset() {
    detector.fixtures = [JAN, MAIL];
    detector.installed = true;
    detector.degraded = null;
}

// ── the answer, and the branch it takes ────────────────────────────────────

test('personal data routes to the "then" branch and names what it found', async () => {
    reset();
    const { output } = await execGuard(guard(), ctxWith(), stateWith(DIRTY), 'live');
    assert.strictEqual(output.branch, 'then');
    assert.strictEqual(output.hasPii, true);
    assert.strictEqual(output.count, 2);
    assert.deepStrictEqual(output.categories, { Person: 1, Email: 1 });
    assert.ok(!output.degraded);
});

test('clean text routes to the "else" branch', async () => {
    reset();
    const { output } = await execGuard(guard(), ctxWith(), stateWith(CLEAN), 'live');
    assert.strictEqual(output.branch, 'else');
    assert.strictEqual(output.hasPii, false);
    assert.deepStrictEqual(output.categories, {});
});

test('a whole object is scanned as its JSON, not refused for not being a string', async () => {
    reset();
    const state = { steps: { s1: { output: { record: { name: 'Jan de Vries', total: 12 } } } } };
    const { output } = await execGuard(guard({ sourceRef: 'steps.s1.output.record' }), ctxWith(), state, 'live');
    assert.strictEqual(output.branch, 'then');
    assert.deepStrictEqual(output.categories, { Person: 1 });
});

test('an unresolvable source scans nothing and says so, rather than erroring', async () => {
    reset();
    const { output } = await execGuard(guard({ sourceRef: 'steps.nope.output.x' }), ctxWith(), stateWith(DIRTY), 'live');
    assert.strictEqual(output.branch, 'else');
    assert.strictEqual(output.scanned, 0);
});

test('an UNBOUND guard fails the run instead of quietly reporting clean', async () => {
    // The builder lets a half-configured guard be saved (an error there makes
    // the node unsaveable and Execute then fails with "step not found in
    // definition"). Running one must still be loud: scanning the empty string
    // would find nothing and route "clean" — a green tick meaning nobody looked.
    reset();
    for (const bad of [{ sourceRef: '' }, { sourceRef: '   ' }, { sourceRef: undefined }]) {
        await assert.rejects(
            () => execGuard(guard(bad), ctxWith(), stateWith(DIRTY), 'live'),
            (err) => {
                assert.strictEqual(err.errorClass, 'guard_no_source');
                return true;
            },
        );
    }
});

// ── tighten, never loosen ──────────────────────────────────────────────────

test('a step category list NARROWS the org list', async () => {
    reset();
    const { output } = await execGuard(guard({ categories: ['Email'] }), ctxWith(), stateWith(DIRTY), 'live');
    assert.deepStrictEqual(output.categories, { Email: 1 }, 'the person hit is out of scope for this step');
});

test('a step cannot look for a category the org excluded', async () => {
    reset();
    // The org only looks for names; the step asking for emails too must not
    // widen that — a routine may hold itself to a HIGHER standard, never a lower.
    const { output } = await execGuard(
        guard({ categories: ['Email'] }), ctxWith({ categories: ['Person'] }), stateWith(DIRTY), 'live',
    );
    assert.deepStrictEqual(output.categories, { Person: 1 });
});

test('the confidence threshold can only be raised', async () => {
    reset();
    let seen = null;
    const spy = { ...piiStub, async detectPii(text, cats, conf) { seen = conf; return piiStub.detectPii(text, cats, conf); } };
    require.cache[STUB_PII].exports = spy;
    try {
        await execGuard(guard({ confidence: 0.9 }), ctxWith({ confidence: 0.7 }), stateWith(DIRTY), 'live');
        assert.strictEqual(seen, 0.9, 'stricter wins');
        await execGuard(guard({ confidence: 0.4 }), ctxWith({ confidence: 0.7 }), stateWith(DIRTY), 'live');
        assert.strictEqual(seen, 0.7, 'looser is ignored');
    } finally {
        require.cache[STUB_PII].exports = piiStub;
    }
});

// ── "we could not look" is not "clean" ─────────────────────────────────────

test('fail_closed treats a missing detector as a hit — never a quiet pass', async () => {
    // The failure this step must never have: reporting safe because nothing
    // actually scanned.
    reset();
    detector.installed = false;
    const { output } = await execGuard(guard(), ctxWith({ failureMode: 'fail_closed' }), stateWith(DIRTY), 'live');
    assert.strictEqual(output.branch, 'then');
    assert.strictEqual(output.hasPii, false, 'nothing was FOUND — but nothing was looked at either');
    assert.strictEqual(output.degraded, true);
    assert.strictEqual(output.degradedReason, 'guard_not_installed');
});

test('fail_open takes the clean branch but still flags that it could not scan', async () => {
    reset();
    detector.installed = false;
    const { output } = await execGuard(guard(), ctxWith({ failureMode: 'fail_open' }), stateWith(DIRTY), 'live');
    assert.strictEqual(output.branch, 'else');
    assert.strictEqual(output.degraded, true, 'the run record must not read as a successful clean scan');
});

test('having no policy to scan under is reported, and the three reasons are told apart', async () => {
    reset();
    // Only one of these is a setting somebody chose. A routine with no
    // organisation has no org shield to resolve AT ALL, and calling that
    // "disabled" sends the author hunting through a Privacy Shield page that
    // is switched on and looks correct.
    const cases = [
        [{ orgId: null }, 'no_organisation'],
        [{ disabledForAutomations: true }, 'shield_disabled'],
        [{ piiEnabled: false }, 'pii_detection_off'],
    ];
    for (const [over, reason] of cases) {
        const { output } = await execGuard(guard(), ctxWith(over), stateWith(DIRTY), 'live');
        assert.strictEqual(output.degraded, true, reason);
        assert.strictEqual(output.degradedReason, reason);
    }
});

// ── stop ───────────────────────────────────────────────────────────────────

test('onFound.stop fails the run with a stable error class', async () => {
    reset();
    await assert.rejects(
        () => execGuard(guard({ onFound: { stop: true } }), ctxWith(), stateWith(DIRTY), 'live'),
        (err) => {
            assert.strictEqual(err.errorClass, 'guard_pii_found');
            assert.match(err.message, /personal data found \(Person, Email\)/);
            return true;
        },
    );
});

test('onFound.stop does NOT stop a clean run', async () => {
    reset();
    const { output } = await execGuard(guard({ onFound: { stop: true } }), ctxWith(), stateWith(CLEAN), 'live');
    assert.strictEqual(output.branch, 'else');
});

test('a dry run reports "would stop" instead of failing the preview', async () => {
    reset();
    const { output } = await execGuard(guard({ onFound: { stop: true } }), ctxWith(), stateWith(DIRTY), 'dry_run');
    assert.strictEqual(output.wouldStop, true);
    assert.strictEqual(output.branch, 'then');
});

test('fail_closed + stop halts even though nothing was found', async () => {
    reset();
    detector.installed = false;
    await assert.rejects(
        () => execGuard(guard({ onFound: { stop: true } }), ctxWith({ failureMode: 'fail_closed' }), stateWith(DIRTY), 'live'),
        (err) => {
            assert.match(err.message, /could not scan/);
            return true;
        },
    );
});

// ── mask ───────────────────────────────────────────────────────────────────

test('onFound.mask hands the next step a copy with no counter to re-link on', async () => {
    reset();
    const { output } = await execGuard(guard({ onFound: { mask: true } }), ctxWith(), stateWith(DIRTY), 'live');
    assert.strictEqual(output.masked, 'Mail [person] at [email] about the invoice.');
    // `[person_1]` would let two occurrences be matched back up; this is the
    // irreversible form, the same thing the shield's 'redact' action means.
    assert.doesNotMatch(output.masked, /_\d\]/);
});

test('a masking failure yields null and a flag — never the original text', async () => {
    reset();
    const boom = { ...piiStub, tokenizeText() { throw new Error('tokenizer down'); } };
    require.cache[STUB_PII].exports = boom;
    try {
        const { output } = await execGuard(guard({ onFound: { mask: true } }), ctxWith(), stateWith(DIRTY), 'live');
        assert.strictEqual(output.masked, null, 'a field the author believes is masked must never hold the real value');
        assert.strictEqual(output.degraded, true);
        assert.match(output.maskError, /tokenizer down/);
    } finally {
        require.cache[STUB_PII].exports = piiStub;
    }
});

test('nothing found means nothing to mask', async () => {
    reset();
    const { output } = await execGuard(guard({ onFound: { mask: true } }), ctxWith(), stateWith(CLEAN), 'live');
    assert.strictEqual(output.masked, undefined);
});

// ── BFSF-355: "Check + Hide" ────────────────────────────────────────────────
//
// One node that scans AND hides what it finds. The whole point is that it hides
// REVERSIBLY — unlike `onFound.mask`, which redacts to `[person]` and cannot be
// undone — so a later "Show real values again" genuinely puts the originals
// back. These tests assert that round trip end to end through the run vault,
// because a reveal that cannot reverse would be a lie told by a privacy product.

const { createTokenVault } = require('./tokenVault');
const safety = require('./safety');

const ctxHiding = (over = {}) => ({ ...ctxWith(over), tokenVault: createTokenVault({}) });

test('check + hide replaces what it found and still takes the "then" branch', async () => {
    reset();
    const ctx = ctxHiding();
    const { output } = await execGuard(guard({ onFound: { tokenize: true } }), ctx, stateWith(DIRTY), 'live');
    assert.strictEqual(output.branch, 'then', 'it is still a check: the branch is the answer');
    assert.strictEqual(output.hasPii, true);
    assert.ok(!output.text.includes('Jan de Vries'), `the name survived: ${output.text}`);
    assert.ok(!output.text.includes('jan@acme.nl'), `the address survived: ${output.text}`);
    assert.match(output.text, /\[Person_1\]|\[person_1\]/i);
    assert.strictEqual(output.vaultSize, 2);
});

test('what it hid comes BACK — the placeholders are reversible, not redaction', async () => {
    reset();
    const ctx = ctxHiding();
    const { output } = await execGuard(guard({ onFound: { tokenize: true } }), ctx, stateWith(DIRTY), 'live');
    // The real restore path the runner uses wherever a value re-enters the run.
    const back = await safety.restoreForRunState(output.text, ctx);
    assert.strictEqual(back, DIRTY, 'a reveal downstream must return the original text');
});

test('check + hide does NOT reuse the irreversible mask path', async () => {
    reset();
    const ctx = ctxHiding();
    const { output } = await execGuard(guard({ onFound: { tokenize: true } }), ctx, stateWith(DIRTY), 'live');
    // `masked` is the redaction action's field and must stay absent: it drops
    // the counter, so `[person]` cannot be re-linked and nothing can restore it.
    assert.strictEqual(output.masked, undefined);
    assert.ok(!/\[Person\]/i.test(output.text.replace(/\[Person_\d+\]/gi, '')));
});

test('the two hiding actions can coexist without contaminating each other', async () => {
    reset();
    const ctx = ctxHiding();
    const { output } = await execGuard(guard({ onFound: { tokenize: true, mask: true } }), ctx, stateWith(DIRTY), 'live');
    assert.strictEqual(await safety.restoreForRunState(output.text, ctx), DIRTY, 'output.text stays reversible');
    assert.ok(output.masked && !/_\d/.test(output.masked), 'output.masked stays irreversible');
});

test('clean text hides nothing and mints nothing', async () => {
    reset();
    const ctx = ctxHiding();
    const { output } = await execGuard(guard({ onFound: { tokenize: true } }), ctx, stateWith(CLEAN), 'live');
    assert.strictEqual(output.branch, 'else');
    assert.strictEqual(output.text, undefined, 'nothing was found, so there is nothing to hand on');
    assert.strictEqual(ctx.tokenVault.size, 0);
});

test('a scan that could NOT run never hands back the original as if it were hidden', async () => {
    // The one failure this mode may never have: a value the author believes is
    // tokenized, carrying real personal data into the next step. fail_closed
    // routes to "then" on a degraded scan, which is exactly when the tokenizing
    // action would otherwise mint nothing and pass the text straight through.
    reset();
    detector.degraded = { degraded: true, degradedReason: 'unavailable' };
    const ctx = ctxHiding({ failureMode: 'fail_closed' });
    const { output } = await execGuard(guard({ onFound: { tokenize: true } }), ctx, stateWith(DIRTY), 'live');
    assert.strictEqual(output.branch, 'then', 'fail_closed still assumes the worst');
    assert.strictEqual(output.text, null, 'null, never the unhidden original');
    assert.match(output.hideError, /could not scan/i);
    assert.strictEqual(output.degraded, true);
});

test('a plain check is untouched by any of this', async () => {
    reset();
    const ctx = ctxHiding();
    const { output } = await execGuard(guard(), ctx, stateWith(DIRTY), 'live');
    assert.strictEqual(output.text, undefined, 'no onFound.tokenize, no hidden copy');
    assert.strictEqual(ctx.tokenVault.size, 0, 'and nothing minted into the vault');
});

// ── no licence check at run time ───────────────────────────────────────────

test('without the privacy-steps plan a LIVE guard still scans and routes, and the licence is never asked', async () => {
    reset();
    licenceAsked.length = 0;
    const { output } = await execGuard(guard({ onFound: { tokenize: true } }), { ...ctxWith(), tokenVault: require('./tokenVault').createTokenVault({}) }, stateWith(DIRTY), 'live');
    assert.strictEqual(output.branch, 'then');
    assert.strictEqual(output.hasPii, true);
    assert.deepStrictEqual(licenceAsked, []);
});
