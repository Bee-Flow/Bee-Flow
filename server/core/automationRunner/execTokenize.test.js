/**
 * The tokenize STEP — "hide the personal data, and put it back automatically".
 *
 * The same round trip chat makes: reversible placeholders go out, real values
 * come back. What is under test is that the two halves actually meet — a
 * placeholder nothing can resolve is worse than no tokenization at all, because
 * `[email_1]` then travels into a document as literal text.
 *
 * `detectPii` is stubbed; the token vault, tokenizeText and restoreTokens are
 * the REAL implementations, because they are the round trip.
 *
 * Run: node --test server/core/automationRunner/execTokenize.test.js
 */

const assert = require('node:assert');
const { test } = require('node:test');
const path = require('path');
const Module = require('module');

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
// a live hide or restore step keeps running after a lapse (the house rule in
// automation/licensedSteps.js; the gate sits on activation and test runs).
const licenceAsked = [];
mock('../entitlements/entitlements', {
    hasCapability: async (id) => { licenceAsked.push(id); return false; },
    resolveCapabilitySet: async () => { licenceAsked.push('resolveCapabilitySet'); return { degraded: false, has: () => false }; },
});

const realPii = require(path.join(__dirname, '..', 'privacy', 'piiDetection'));
const detector = { fixtures: [], installed: true };
const piiStub = {
    ...realPii,
    async detectPii(text, categories) {
        if (!detector.installed) return null;
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
const STUB_PII = path.join(__dirname, '__stub_pii_tokenize__.js');
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

const { execTokenize, execUntokenize } = require('./engine');
const safety = require('./safety');
const { createTokenVault } = require('./tokenVault');

const MAIL = { category: 'Email', text: 'tomsmit@beeflow.nl' };
const JAN = { category: 'Person', text: 'Jan de Vries' };
const DIRTY = 'mijn email is: tomsmit@beeflow.nl';

function ctxWith(over = {}) {
    return {
        tokenVault: createTokenVault({}),
        _safetyPolicy: {
            shield: {}, orgId: 'bee-flow', piiEnabled: true, action: 'tokenize', regexRules: [],
            monitorIntegrations: true, scope: {}, privacyScope: 'external',
            confidence: 0.7, categories: null, customTerms: [],
            failureMode: 'fail_open', largeInputPolicy: 'fail_open',
            ...over,
        },
    };
}
const stateWith = (body) => ({ steps: { s1: { output: { body } } } });
const step = (over = {}) => ({ id: 't1', type: 'tokenize', sourceRef: 'steps.s1.output.body', ...over });

function reset() {
    detector.fixtures = [MAIL, JAN];
    detector.installed = true;
}

// ── the round trip ─────────────────────────────────────────────────────────

test('personal data becomes a reversible placeholder', async () => {
    reset();
    const ctx = ctxWith();
    const { output } = await execTokenize(step(), ctx, stateWith(DIRTY), 'live');
    assert.strictEqual(output.text, 'mijn email is: [email_1]');
    assert.strictEqual(output.count, 1);
    assert.deepStrictEqual(output.categories, { Email: 1 });
    // The counter is what makes it reversible — the guard's mask strips it.
    assert.match(output.text, /_\d\]/);
});

test('the mapping lands in the RUN vault, so restoring needs nothing wired', async () => {
    reset();
    const ctx = ctxWith();
    const { output } = await execTokenize(step(), ctx, stateWith(DIRTY), 'live');
    assert.strictEqual(ctx.tokenVault.all()['[email_1]'], 'tomsmit@beeflow.nl');
    // This is the function the runner ALREADY calls on every AI reply and tool
    // result — nothing new has to happen for the values to come back.
    assert.strictEqual(safety.restoreForRunState(output.text, ctx), DIRTY);
});

test('a value keeps ONE placeholder across steps', async () => {
    // Two nodes tokenizing the same address must not mint [email_1] and
    // [email_2] for it — a later restore would still work, but a human reading
    // the run would see one person as two.
    reset();
    const ctx = ctxWith();
    const a = await execTokenize(step(), ctx, stateWith(DIRTY), 'live');
    const b = await execTokenize(step({ id: 't2' }), ctx, stateWith(`ook: ${MAIL.text}`), 'live');
    assert.strictEqual(a.output.text, 'mijn email is: [email_1]');
    assert.strictEqual(b.output.text, 'ook: [email_1]');
    assert.strictEqual(ctx.tokenVault.size, 1);
});

test('two different values never share a placeholder', async () => {
    reset();
    const ctx = ctxWith();
    const { output } = await execTokenize(step(), ctx, stateWith(`${JAN.text} <${MAIL.text}>`), 'live');
    assert.strictEqual(output.count, 2);
    assert.strictEqual(new Set(Object.values(ctx.tokenVault.all())).size, 2);
    assert.strictEqual(safety.restoreForRunState(output.text, ctx), `${JAN.text} <${MAIL.text}>`);
});

test('an object source is tokenized as its JSON and restores whole', async () => {
    reset();
    const ctx = ctxWith();
    const state = { steps: { s1: { output: { body: { from: MAIL.text, subject: 'Hoi' } } } } };
    const { output } = await execTokenize(step(), ctx, state, 'live');
    assert.ok(!output.text.includes(MAIL.text));
    assert.deepStrictEqual(JSON.parse(safety.restoreForRunState(output.text, ctx)), { from: MAIL.text, subject: 'Hoi' });
});

test('clean text passes through untouched, and mints nothing', async () => {
    reset();
    const ctx = ctxWith();
    const { output } = await execTokenize(step(), ctx, stateWith('Quarterly figures are up.'), 'live');
    assert.strictEqual(output.text, 'Quarterly figures are up.');
    assert.strictEqual(output.count, 0);
    assert.strictEqual(ctx.tokenVault.size, 0);
});

// ── it must never claim to have hidden something it did not ────────────────

test('a detector that could not scan FAILS instead of passing the original on', async () => {
    // The failure this step must never have: handing the next node real
    // personal data in a field called "text" that everyone believes is hidden.
    reset();
    detector.installed = false;
    await assert.rejects(
        () => execTokenize(step(), ctxWith(), stateWith(DIRTY), 'live'),
        (err) => {
            assert.strictEqual(err.errorClass, 'tokenize_degraded');
            return true;
        },
    );
});

test('no policy to read is a failure too, and says which one', async () => {
    reset();
    for (const [over, wording] of [
        [{ orgId: null }, /belongs to no organisation/],
        [{ disabledForAutomations: true }, /excluded routines/],
        [{ piiEnabled: false }, /PII detection switched off/],
    ]) {
        await assert.rejects(
            () => execTokenize(step(), ctxWith(over), stateWith(DIRTY), 'live'),
            (err) => {
                assert.strictEqual(err.errorClass, 'tokenize_no_policy');
                assert.match(err.message, wording);
                return true;
            },
        );
    }
});

test('an unbound step fails rather than "hiding" an empty string', async () => {
    reset();
    await assert.rejects(
        () => execTokenize(step({ sourceRef: '' }), ctxWith(), stateWith(DIRTY), 'live'),
        (err) => {
            assert.strictEqual(err.errorClass, 'tokenize_no_source');
            return true;
        },
    );
});

// ── tighten, never loosen (shared with the guard) ──────────────────────────

test('a step category list narrows what gets hidden', async () => {
    reset();
    const ctx = ctxWith();
    const { output } = await execTokenize(step({ categories: ['Email'] }), ctx, stateWith(`${JAN.text} <${MAIL.text}>`), 'live');
    assert.strictEqual(output.count, 1);
    assert.ok(output.text.includes(JAN.text), 'the name was out of scope for this step');
});

// ── putting the real values back, on purpose ───────────────────────────────
//
// The runner restores automatically wherever a value comes BACK into the
// routine (an AI reply, a tool result). This step is for the values that never
// do: carried forward by a `set`, written to a table, read straight off the
// tokenize step's own output.

test('the untokenize step puts the real values back', async () => {
    reset();
    const ctx = ctxWith();
    const tok = await execTokenize(step(), ctx, stateWith(DIRTY), 'live');
    const state = { steps: { t1: { output: { text: tok.output.text } } } };

    const { output } = await execUntokenize({ id: 'u1', type: 'untokenize', sourceRef: 'steps.t1.output.text' }, ctx, state);
    assert.strictEqual(output.text, DIRTY);
    assert.strictEqual(output.restored, 1);
    assert.strictEqual(output.unresolved, undefined);
});

test('it restores inside a whole object, not just a string', async () => {
    reset();
    const ctx = ctxWith();
    const tok = await execTokenize(step(), ctx, stateWith(`${JAN.text} <${MAIL.text}>`), 'live');
    const state = { steps: { t1: { output: { row: { note: tok.output.text, id: 7 } } } } };

    const { output } = await execUntokenize({ id: 'u1', type: 'untokenize', sourceRef: 'steps.t1.output.row' }, ctx, state);
    assert.deepStrictEqual(output.value, { note: `${JAN.text} <${MAIL.text}>`, id: 7 });
    assert.strictEqual(output.restored, 2);
});

test('a placeholder the vault cannot resolve is COUNTED, not left to be found later', async () => {
    // This happens for real: the vault evicts at its ceiling, and a token from
    // another run was never in this one. Left alone, `[person_9]` lands in a
    // document looking deliberate.
    reset();
    const ctx = ctxWith();
    await execTokenize(step(), ctx, stateWith(DIRTY), 'live');
    const state = { steps: { t1: { output: { text: 'from [email_1] and [person_9]' } } } };

    const { output } = await execUntokenize({ id: 'u1', type: 'untokenize', sourceRef: 'steps.t1.output.text' }, ctx, state);
    assert.strictEqual(output.text, `from ${MAIL.text} and [person_9]`);
    assert.strictEqual(output.restored, 1);
    assert.strictEqual(output.unresolved, 1);
    assert.deepStrictEqual(output.unresolvedTokens, ['[person_9]']);
});

test('text with no placeholders passes through unchanged', async () => {
    reset();
    const ctx = ctxWith();
    const state = { steps: { t1: { output: { text: 'nothing to restore here' } } } };
    const { output } = await execUntokenize({ id: 'u1', type: 'untokenize', sourceRef: 'steps.t1.output.text' }, ctx, state);
    assert.strictEqual(output.text, 'nothing to restore here');
    assert.strictEqual(output.restored, 0);
});

test('an unbound restore step fails rather than silently doing nothing', async () => {
    reset();
    await assert.rejects(
        () => execUntokenize({ id: 'u1', type: 'untokenize', sourceRef: '' }, ctxWith(), stateWith(DIRTY)),
        (err) => {
            assert.strictEqual(err.errorClass, 'untokenize_no_source');
            return true;
        },
    );
});

// ── no licence check at run time ───────────────────────────────────────────
// The plan gate for Privacy Shield steps is at activation, publishing and test
// runs (automation/licensedSteps.js). What is live keeps running, and
// untokenize is never gated at all, so the runner asks nobody.

test('without the privacy-steps plan a LIVE hide and restore still run, and the licence is never asked', async () => {
    reset();
    licenceAsked.length = 0;
    const ctx = ctxWith();
    const tok = await execTokenize(step(), ctx, stateWith(DIRTY), 'live');
    assert.strictEqual(tok.output.text, 'mijn email is: [email_1]');
    const back = await execUntokenize({ id: 'u1', type: 'untokenize', sourceRef: 'steps.t1.output.text' }, ctx, { steps: { t1: { output: { text: tok.output.text } } } });
    assert.strictEqual(back.output.text, DIRTY);
    assert.deepStrictEqual(licenceAsked, []);
});
