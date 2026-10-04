/**
 * The automation guard: what it detects, what it tokenizes, and what actually
 * leaves the platform.
 *
 * Hermetic: `detectPii` is stubbed (a tiny fixture matcher) so the tests are
 * deterministic and need no guard service — but tokenizeText / restoreTokens
 * are the REAL implementations, because token minting and restoration are
 * exactly what is under test. The guardrail-event store is stubbed to capture
 * audit rows.
 *
 * Run: node --test server/core/automationRunner/safety.guard.test.js
 */

const assert = require('node:assert');
const { test } = require('node:test');
const path = require('path');
const Module = require('module');

// ── piiDetection stub: real module, fake detector ──────────────────────────
// Required by ABSOLUTE path on purpose: requiring '../privacy/piiDetection' from this
// directory would populate Node's relative-resolve cache for that exact
// (dir, specifier) pair, and safety.js's own lazy `require('../privacy/piiDetection')`
// would then bypass the _resolveFilename hook below entirely — the stub would
// silently never be used.
const realPii = require(path.join(__dirname, '..', 'privacy', 'piiDetection'));
const detector = {
    // text → entities. Set per test.
    fixtures: [],
    degraded: null,
};
const { isCustomTypeId } = require(path.join(__dirname, '..', 'privacy', 'customTypes', 'ids'));
const piiStub = {
    ...realPii,
    async detectPii(text, categories, threshold, opts) {
        // The org's own data types need no guard: the real scan runs them.
        if (Array.isArray(categories) && categories.some(isCustomTypeId)) {
            return realPii.detectPii(text, categories.filter(isCustomTypeId), threshold, opts);
        }
        if (detector.degraded) return { hasPii: false, entities: [], ...detector.degraded };
        const entities = [];
        for (const f of detector.fixtures) {
            let from = 0;
            for (;;) {
                const i = String(text).indexOf(f.text, from);
                if (i < 0) break;
                entities.push({ category: f.category, label: f.label || f.category, offset: i, length: f.text.length, text: f.text, confidence: 0.99 });
                from = i + f.text.length;
            }
        }
        return { hasPii: entities.length > 0, entities, degraded: false };
    },
};

// ── guardrail event store stub ─────────────────────────────────────────────
const events = [];
const guardrailStub = { async logGuardrailEvent(e) { events.push(e); } };

const STUB_PII = path.join(__dirname, '__stub_pii_guard__.js');
const STUB_GUARDRAIL = path.join(__dirname, '__stub_guardrail_guard__.js');
require.cache[STUB_PII] = { id: STUB_PII, filename: STUB_PII, loaded: true, exports: piiStub };
require.cache[STUB_GUARDRAIL] = { id: STUB_GUARDRAIL, filename: STUB_GUARDRAIL, loaded: true, exports: guardrailStub };

const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    const from = parent && parent.filename ? parent.filename : '';
    if (from.endsWith(path.join('automationRunner', 'safety.js'))) {
        if (request === '../privacy/piiDetection') return STUB_PII;
        if (request === '../../stores/guardrailEventStore') return STUB_GUARDRAIL;
    }
    return origResolve.call(this, request, parent, ...rest);
};

const safety = require('./safety');
const { createTokenVault } = require('./tokenVault');

// ── helpers ────────────────────────────────────────────────────────────────
const JAN = { category: 'Person', label: 'Person Name', text: 'Jan de Vries' };
const MAIL = { category: 'Email', label: 'Email Address', text: 'jan@acme.nl' };

function policy(over = {}) {
    return {
        shield: {},
        orgId: 'org1',
        piiEnabled: true,
        action: 'tokenize',
        regexRules: [],
        monitorIntegrations: true,
        scope: { userInput: true, agentOutput: true },
        privacyScope: 'external',
        confidence: 0.7,
        categories: null,
        failureMode: 'fail_open',
        largeInputPolicy: 'fail_open',
        ...over,
    };
}
const audit = () => ({ organization_id: 'org1', user_id: 'u1', step_id: 's1', source: 'automation' });
const freshCtx = () => ({ tokenVault: createTokenVault({}) });

function reset() {
    events.length = 0;
    detector.fixtures = [JAN, MAIL];
    detector.degraded = null;
}

// ── tokenization + the run vault ───────────────────────────────────────────

test('detected values are tokenized and land in the run vault', async () => {
    reset();
    const ctx = freshCtx();
    const r = await safety.guardToolInput({ body: 'Mail Jan de Vries at jan@acme.nl' }, policy(), audit(), 'live', ctx);
    assert.match(r.value.body, /\[person_1\]/);
    assert.match(r.value.body, /\[email_1\]/);
    assert.strictEqual(ctx.tokenVault.all()['[person_1]'], 'Jan de Vries');
    assert.strictEqual(ctx.tokenVault.all()['[email_1]'], 'jan@acme.nl');
});

test('the same person keeps the same placeholder in a later node', async () => {
    reset();
    const ctx = freshCtx();
    await safety.guardToolInput({ a: 'Jan de Vries' }, policy(), audit(), 'live', ctx);
    const second = await safety.guardToolInput({ b: 'CC Jan de Vries please' }, policy(), { ...audit(), step_id: 's7' }, 'live', ctx);
    assert.match(second.value.b, /\[person_1\]/, 'node 7 must reuse node 1s placeholder, not mint [person_1] for someone else');
    assert.strictEqual(ctx.tokenVault.size, 1);
});

test('guardToolOutput hands its token map back (an unrestorable token cannot exist)', async () => {
    reset();
    const ctx = freshCtx();
    const r = await safety.guardToolOutput({ from: 'jan@acme.nl' }, policy(), audit(), 'live', ctx);
    assert.ok(r.tokenMap && r.tokenMap['[email_1]'] === 'jan@acme.nl', 'the map must come back to the caller');
    assert.strictEqual(safety.restoreForRunState(r.result, ctx).from, 'jan@acme.nl');
});

test('a placeholder minted by an EARLIER node still restores at a later boundary', async () => {
    reset();
    const ctx = freshCtx();
    const first = await safety.guardToolOutput({ name: 'Jan de Vries' }, policy(), audit(), 'live', ctx);
    // Simulate the tokenized value travelling downstream untouched (the old
    // behaviour) — the next boundary must still resolve it.
    detector.fixtures = []; // a placeholder is not personal data: nothing detects it
    const out = safety.prepareForEgress(first.result, policy({ privacyScope: 'external' }), ctx, { destination: 'internal' });
    assert.strictEqual(out.name, 'Jan de Vries');
});

// ── restoreFromVault: a real value is not a JSON literal ───────────────────
//
// The restore used to run on the SERIALISED form: JSON.stringify → a plain
// String.replace of the tokens → JSON.parse. restoreTokens writes the vault's
// RAW value into the JSON text without escaping it, so any value containing a
// quote, a backslash, a newline or a tab produced broken JSON, JSON.parse threw,
// and a `catch (_) { return value; }` handed back the STILL-TOKENIZED value.
// This is the single restore point for both prepareForEgress and
// restoreForRunState, so the customer received a literal `[address_1]`.

const MESSY = 'Kerkstraat 1 "achter"\nPostbus 3\\4\tRotterdam';

test('a value with quotes, newlines and backslashes restores instead of leaking the placeholder', async () => {
    reset();
    detector.fixtures = [{ category: 'Address', label: 'Physical Address', text: MESSY }];
    const ctx = freshCtx();
    const g = await safety.guardToolInput({ to: `Stuur naar ${MESSY} aub` }, policy(), audit(), 'live', ctx);
    assert.match(g.value.to, /\[address_1\]/, 'precondition: it was tokenized');

    const out = safety.prepareForEgress(g.value, policy(), ctx, { destination: 'internal' });
    assert.strictEqual(out.to, `Stuur naar ${MESSY} aub`);
    assert.doesNotMatch(out.to, /\[address_1\]/, 'the customer used to receive the raw placeholder');
});

test('a restored value cannot inject structure into the surrounding object', async () => {
    // The old serialise-replace-reparse round trip let a crafted value close its
    // JSON string and add keys of its own.
    reset();
    const INJECT = 'Jan","isAdmin":"yes';
    detector.fixtures = [{ category: 'Person', label: 'Person Name', text: INJECT }];
    const ctx = freshCtx();
    const g = await safety.guardToolInput({ name: INJECT, keep: 'me' }, policy(), audit(), 'live', ctx);
    const out = safety.restoreForRunState(g.value, ctx);
    assert.deepStrictEqual(Object.keys(out), ['name', 'keep'], 'no key may appear that the payload did not have');
    assert.strictEqual(out.name, INJECT);
});

test('nested arrays/objects restore leaf by leaf', async () => {
    reset();
    const ctx = freshCtx();
    const g = await safety.guardToolOutput(
        { rows: [{ from: 'jan@acme.nl' }, { from: 'Jan de Vries' }], n: 2 },
        policy(), audit(), 'live', ctx,
    );
    const out = safety.restoreForRunState(g.result, ctx);
    assert.strictEqual(out.rows[0].from, 'jan@acme.nl');
    assert.strictEqual(out.rows[1].from, 'Jan de Vries');
    assert.strictEqual(out.n, 2, 'non-string leaves are untouched');
});

test('a failed restore surfaces instead of quietly returning placeholders', async () => {
    // "We could not put the real values back" and "there was nothing to put
    // back" are different answers; collapsing them is how tokens reached a
    // third party while the run reported success.
    reset();
    const ctx = freshCtx();
    const g = await safety.guardToolInput({ to: 'jan@acme.nl' }, policy(), audit(), 'live', ctx);
    require.cache[STUB_PII].exports = {
        ...piiStub,
        restoreTokens: () => { throw new Error('restore backend down'); },
    };
    try {
        assert.throws(
            () => safety.prepareForEgress(g.value, policy(), ctx, { destination: 'internal' }),
            /restore backend down/,
        );
    } finally {
        require.cache[STUB_PII].exports = piiStub;
    }
});

// ── the destination/action matrix ──────────────────────────────────────────

test('tokenize + scope external: placeholders leave, on-box gets real values', async () => {
    reset();
    const ctx = freshCtx();
    const g = await safety.guardToolInput({ to: 'jan@acme.nl' }, policy(), audit(), 'live', ctx);
    const p = policy({ privacyScope: 'external', action: 'tokenize' });
    assert.strictEqual(safety.prepareForEgress(g.value, p, ctx, { destination: 'external' }).to, '[email_1]');
    assert.strictEqual(safety.prepareForEgress(g.value, p, ctx, { destination: 'internal' }).to, 'jan@acme.nl');
});

test('tokenize + scope all is STRICTER: on-box destinations get placeholders too', async () => {
    reset();
    const ctx = freshCtx();
    const g = await safety.guardToolInput({ to: 'jan@acme.nl' }, policy(), audit(), 'live', ctx);
    const p = policy({ privacyScope: 'all', action: 'tokenize' });
    assert.strictEqual(safety.prepareForEgress(g.value, p, ctx, { destination: 'internal' }).to, '[email_1]',
        "'all' must never be weaker than 'external'");
});

test('redact masks irreversibly at the boundary — and drops the counter', async () => {
    reset();
    const ctx = freshCtx();
    const g = await safety.guardToolInput({ body: 'Jan de Vries en jan@acme.nl' }, policy({ action: 'redact' }), audit(), 'live', ctx);
    const out = safety.prepareForEgress(g.value, policy({ action: 'redact' }), ctx, { destination: 'external' });
    assert.match(out.body, /\[person\]/);
    assert.match(out.body, /\[email\]/);
    assert.doesNotMatch(out.body, /Jan de Vries|jan@acme\.nl/, 'redact must actually protect the egress');
    assert.doesNotMatch(out.body, /_\d/, 'no counter — occurrences must not be re-linkable');
});

test('a category key containing underscores still masks', () => {
    assert.strictEqual(safety.maskTokens({ v: 'x [credit_card_1] y' }).v, 'x [credit_card] y');
});

test('action off leaves everything alone', () => {
    const ctx = freshCtx();
    const out = safety.prepareForEgress({ a: '[person_1]' }, policy({ action: 'off' }), ctx, { destination: 'external' });
    assert.strictEqual(out.a, '[person_1]');
});

// ── block ──────────────────────────────────────────────────────────────────

test('block throws in live and only annotates in dry-run (payload untouched)', async () => {
    reset();
    await assert.rejects(
        safety.guardToolInput({ to: 'jan@acme.nl' }, policy({ action: 'block' }), audit(), 'live', freshCtx()),
        (e) => e.guardrailBlocked === true && e.violationType === 'pii',
    );
    const dry = await safety.guardToolInput({ to: 'jan@acme.nl' }, policy({ action: 'block' }), audit(), 'dry_run', freshCtx());
    assert.strictEqual(dry.wouldBlock, true);
    assert.strictEqual(dry.value.to, 'jan@acme.nl', 'dry-run annotates, it does not transform');
});

// ── scan failure / degradation ─────────────────────────────────────────────

test('fail_closed: a degraded detector blocks instead of passing as clean', async () => {
    reset();
    detector.degraded = { degraded: true, degradedReason: 'guard_circuit_open' };
    await assert.rejects(
        safety.guardToolInput({ body: 'anything' }, policy({ failureMode: 'fail_closed' }), audit(), 'live', freshCtx()),
        (e) => e.guardrailBlocked === true && e.violationType === 'scan_failed',
    );
    assert.ok(events.some(e => e.action_taken === 'scan_failed'), 'the failure must be audited');
});

test('BFSF-373: a fail-closed block explains what happened and what to do, not the raw guard reason', async () => {
    reset();
    detector.degraded = { degraded: true, degradedReason: 'guard_unreachable: socket hang up' };
    const out = { issues: [{ summary: 'first' }, { summary: 'second' }, { summary: 'third' }] };
    await assert.rejects(
        safety.guardToolOutput(out, policy({ failureMode: 'fail_closed', scope: { toolOutput: true } }), audit(), 'live', freshCtx()),
        (e) => {
            assert.strictEqual(e.guardrailBlocked, true);
            assert.strictEqual(e.violationType, 'scan_failed');
            assert.match(e.message, /this step's output \(3 values\)/, 'the user should see how much was being checked');
            assert.match(e.message, /could not be reached/);
            assert.match(e.message, /Run it again/);
            assert.match(e.message, /lower result limit/);
            assert.match(e.message, /ask an admin/);
            assert.doesNotMatch(e.message, /guard_unreachable|socket hang up/, 'the raw reason belongs in the log');
            return true;
        },
    );
});

test('BFSF-373: the advice follows the kind of failure', async () => {
    const cases = [
        ['guard_unreachable: guard-service /pii timeout', /took too long/],
        ['input_too_large', /too large to check/],
        ['guard_circuit_open', /paused for a moment/],
        ['guard_not_installed', /No privacy check service is installed/],
    ];
    for (const [degradedReason, advice] of cases) {
        reset();
        detector.degraded = { degraded: true, degradedReason };
        await assert.rejects(
            safety.guardToolInput({ body: 'anything' }, policy({ failureMode: 'fail_closed' }), audit(), 'live', freshCtx()),
            (e) => {
                assert.match(e.message, /this step's input \(1 value\)/);
                assert.match(e.message, advice, `wrong advice for ${degradedReason}`);
                return true;
            },
        );
    }
});

test('fail_open: a degraded detector passes, but visibly', async () => {
    reset();
    detector.degraded = { degraded: true, degradedReason: 'guard_unreachable' };
    const r = await safety.guardToolInput({ body: 'anything' }, policy({ failureMode: 'fail_open' }), audit(), 'live', freshCtx());
    assert.deepStrictEqual(r.markers, ['privacy_protection_unavailable']);
    assert.strictEqual(r.blocked, false);
});

test('degradation is narrowed to the categories the org actually scans for', async () => {
    reset();
    detector.degraded = { degraded: true, degradedReason: 'partial', degradedCategories: ['CreditCard'] };
    const r = await safety.guardToolInput(
        { body: 'anything' },
        policy({ failureMode: 'fail_closed', categories: ['Person'] }),
        audit(), 'live', freshCtx(),
    );
    assert.strictEqual(r.blocked, false, 'a category this org does not scan for degrading is not its problem');
});

test('no detector installed is treated as a scan failure, not as clean', async () => {
    reset();
    const noDetector = { ...piiStub, detectPii: async () => null };
    require.cache[STUB_PII].exports = noDetector;
    try {
        await assert.rejects(
            safety.guardToolInput({ body: 'some content worth scanning' }, policy({ failureMode: 'fail_closed' }), audit(), 'live', freshCtx()),
            (e) => e.guardrailBlocked === true,
        );
    } finally {
        require.cache[STUB_PII].exports = piiStub;
    }
});

// ── org allowlist + own sensitive terms (inert on automations before) ─────────

test('the never-redact allowlist keeps the org own name out of the tokenizer', async () => {
    reset();
    detector.fixtures = [{ category: 'Organization', label: 'Organization', text: 'Bee Flow' }];
    const ctx = freshCtx();
    const r = await safety.guardToolInput(
        { body: 'Factuur van Bee Flow' },
        policy({ shield: { piiAllowTerms: ['Bee Flow'] } }),
        audit(), 'live', ctx,
    );
    assert.strictEqual(r.value.body, 'Factuur van Bee Flow');
    assert.strictEqual(ctx.tokenVault.size, 0);
});

test('the org own sensitive terms are caught even when the detector finds nothing', async () => {
    reset();
    detector.fixtures = [];
    // An old "Always hide these" term, as the resolver hands it over: a
    // migrated type whose id is in the category list.
    const { migrateLegacyTerms } = require(path.join(__dirname, '..', 'privacy', 'customTypes'));
    const types = migrateLegacyTerms('org1', [{ id: 't1', label: 'Codename', pattern: 'Aurora', type: 'literal' }]);
    require(path.join(__dirname, '..', 'privacy', 'customTypes', 'registry')).syncOrg('org1', types);
    const ctx = freshCtx();
    const r = await safety.guardToolInput(
        { body: 'Project Aurora start maandag' },
        policy({ categories: [types[0].id] }),
        audit(), 'live', ctx,
    );
    assert.match(r.value.body, /\[customterm_1\]/);
    assert.strictEqual(ctx.tokenVault.all()['[customterm_1]'], 'Aurora');
});

// ── regex guardrails ───────────────────────────────────────────────────────

test('a regex rule redacts in place and is audited as its own violation type', async () => {
    reset();
    detector.fixtures = [];
    const r = await safety.guardToolInput(
        { body: 'ref SECRET-42 here' },
        policy({ regexRules: [{ name: 'Internal ref', pattern: 'SECRET-\\d+' }] }),
        audit(), 'live', freshCtx(),
    );
    assert.strictEqual(r.value.body, 'ref [REDACTED:Internal ref] here');
    assert.ok(events.some(e => e.violation_type === 'regex' && e.action_taken === 'redacted'));
});

// ── identifier arguments ───────────────────────────────────────────────────
//
// A false positive on an id field does not protect anything (the provider issued
// the id) and breaks the call it addresses. Live case: GLiNER reads a Gmail
// message id as a phone number (16 hex chars, 8 of them digits), so an automation
// reading each mail of a search result sent a placeholder to Gmail and failed
// with "Invalid id value" on every one of its ten iterations.
const GMAIL_ID = '19fdc22de311daf4';
const PHONEY_ID = { category: 'PhoneNumber', label: 'Phone Number', text: GMAIL_ID };

test('a tool input that addresses a record by id is not redacted', async () => {
    reset();
    detector.fixtures = [PHONEY_ID];
    const r = await safety.guardToolInput({ messageId: GMAIL_ID }, policy(), audit(), 'live', freshCtx());
    assert.strictEqual(r.value.messageId, GMAIL_ID, 'the id must reach the provider intact');
    assert.strictEqual(r.tokenMap, null, 'nothing minted');
    assert.ok(r.markers.includes('identifier_passed_unredacted'), 'and the decision is marked');
    assert.ok(
        events.some(e => e.violation_type === 'pii' && e.action_taken === 'passed_unredacted'),
        'the detection is still audited — the shield saw it and said what it did',
    );
});

test('id-shaped keys are recognised in their common spellings', async () => {
    reset();
    detector.fixtures = [PHONEY_ID];
    const r = await safety.guardToolInput(
        { thread_id: GMAIL_ID, fileID: GMAIL_ID, uuid: GMAIL_ID, messageIds: [GMAIL_ID] },
        policy(), audit(), 'live', freshCtx(),
    );
    assert.deepStrictEqual(r.value, {
        thread_id: GMAIL_ID, fileID: GMAIL_ID, uuid: GMAIL_ID, messageIds: [GMAIL_ID],
    });
});

test('the exemption does not extend to prose, to other fields, or to outputs', async () => {
    reset();
    detector.fixtures = [JAN];
    const long = await safety.guardToolInput({ id: 'Signed off by Jan de Vries' }, policy(), audit(), 'live', freshCtx());
    assert.match(long.value.id, /\[person_1\]/, 'a field called id holding prose is scanned like any text');

    const other = await safety.guardToolInput({ identifier: 'Jan de Vries' }, policy(), audit(), 'live', freshCtx());
    assert.match(other.value.identifier, /\[person_1\]/, 'only id-SUFFIXED keys are addresses');

    const out = await safety.guardToolOutput({ userId: 'Jan de Vries' }, policy(), audit(), 'live', freshCtx());
    assert.match(out.result.userId, /\[person_1\]/, 'an id in an OUTPUT is content — the vault restores it downstream');
});

test('a guardrail RULE still redacts an identifier argument', async () => {
    reset();
    detector.fixtures = [PHONEY_ID];
    const r = await safety.guardToolInput(
        { messageId: GMAIL_ID },
        policy({ regexRules: [{ name: 'No hex handles', pattern: '19[0-9a-f]{14}' }] }),
        audit(), 'live', freshCtx(),
    );
    assert.strictEqual(r.value.messageId, '[REDACTED:No hex handles]',
        'an explicit org rule outranks the addressing exemption');
});

test('a block action ignores a detection on an identifier argument', async () => {
    reset();
    detector.fixtures = [PHONEY_ID];
    const r = await safety.guardToolInput({ messageId: GMAIL_ID }, policy({ action: 'block' }), audit(), 'live', freshCtx());
    assert.strictEqual(r.blocked, false, 'a false positive on an id must not kill the run either');
});

// ── audit hygiene ──────────────────────────────────────────────────────────

test('a retry of the same payload does not double-count in the dashboard', async () => {
    reset();
    const ctx = freshCtx();
    await safety.guardToolInput({ to: 'jan@acme.nl' }, policy(), audit(), 'live', ctx);
    await safety.guardToolInput({ to: 'jan@acme.nl' }, policy(), audit(), 'live', ctx); // the retry
    assert.strictEqual(events.filter(e => e.violation_type === 'pii').length, 1);
});

test('different data in a loop iteration is still counted separately', async () => {
    reset();
    detector.fixtures = [JAN, { category: 'Person', label: 'Person Name', text: 'Ada Lovelace' }];
    const ctx = freshCtx();
    await safety.guardToolInput({ to: 'Jan de Vries' }, policy(), audit(), 'live', ctx);
    await safety.guardToolInput({ to: 'Ada Lovelace' }, policy(), audit(), 'live', ctx);
    assert.strictEqual(events.filter(e => e.violation_type === 'pii').length, 2);
});

// ── ai_step prompt ─────────────────────────────────────────────────────────

test('the ai_step SYSTEM prompt is guarded too, not just the user message', async () => {
    reset();
    const messages = [
        { role: 'system', content: 'Je schrijft namens Jan de Vries.' },
        { role: 'user', content: 'Stel een mail op.' },
    ];
    const r = await safety.guardAiInput(messages, policy(), audit(), 'live', freshCtx());
    assert.match(messages[0].content, /\[person_1\]/, 'the interpolated system prompt used to reach the model raw');
    assert.strictEqual(r.blocked, false);
});

test('scope userInput=false switches the prompt guard off', async () => {
    reset();
    const messages = [{ role: 'user', content: 'Jan de Vries' }];
    await safety.guardAiInput(messages, policy({ scope: { userInput: false, agentOutput: true } }), audit(), 'live', freshCtx());
    assert.strictEqual(messages[0].content, 'Jan de Vries');
});

test.after(() => { Module._resolveFilename = origResolve; });
