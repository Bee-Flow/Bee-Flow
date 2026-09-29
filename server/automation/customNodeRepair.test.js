/**
 * Unit tests for the execute-test-repair loop.
 *
 * The loop is core/aiAgent.js's `_chatLoop` in the shape a code body needs,
 * and the three things pinned hardest here are the three places that shape
 * can go wrong:
 *
 * 1. IT IS BOUNDED. `_chatLoop` counts to 30 and stops. A repair loop that
 *    does not count costs one model call and one V8 isolate per pass, and a
 *    body a model cannot fix is exactly the body it will keep not fixing.
 *    The ceiling holds even when the caller asks for fifty.
 *
 * 2. IT NEVER RETURNS THE LAST BROKEN BODY AS IF IT WORKED. The obvious way
 *    to write this loop keeps the latest candidate in a variable and returns
 *    it at the end; a caller reading `.code` then saves the body that was
 *    tested LEAST of all as a working node. Every failing exit answers
 *    `code: null`, with the last candidate under a name nobody reaches for by
 *    accident.
 *
 * 3. GREEN IS NOT "DID NOT THROW". A body that throws nothing and returns
 *    nothing is the failure customNode.js makes declared outputs mandatory to
 *    prevent, so the declared outputs have to BE THERE in what the body
 *    returned.
 *
 * The model is injected (`defaultDeps`, the complianceFacts.js pattern), so
 * nothing here talks to one. The last two tests run the REAL isolate, because
 * a loop tested only against a fake sandbox proves that the fake works.
 *
 * Run: cd server && node --test --test-force-exit automation/customNodeRepair.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const {
    repairCodeBody, repairCustomNode, defaultDeps,
    MAX_REPAIR_ATTEMPTS, ATTEMPT_CEILING,
} = require('./customNodeRepair');

// A fake sandbox: answers each call from a script of outcomes, and records
// what it was asked to run.
function fakeSandbox(outcomes) {
    const seen = [];
    let i = 0;
    return {
        seen,
        runTest: async (args) => {
            seen.push(args);
            const outcome = outcomes[Math.min(i, outcomes.length - 1)];
            i++;
            if (typeof outcome === 'function') return outcome(args);
            if (outcome instanceof Error) throw outcome;
            return outcome;
        },
    };
}

// A fake repairer: hands back a new body each time, and records its evidence.
function fakeFixer(bodies) {
    const calls = [];
    let i = 0;
    return {
        calls,
        proposeFix: async (evidence) => {
            calls.push(evidence);
            const next = bodies[Math.min(i, bodies.length - 1)];
            i++;
            return typeof next === 'function' ? next(evidence) : next;
        },
    };
}

const ran = (result) => ({ result, logs: [], calls: [] });

// ── The happy paths ─────────────────────────────────────────────────────

test('a body that runs is reported as tested, not as repaired', async () => {
    const sandbox = fakeSandbox([ran({ total: 12.1 })]);
    const fixer = fakeFixer(['never']);
    const r = await repairCodeBody(
        { code: 'return { total: 12.1 };', expectOutputs: ['total'] },
        defaultDeps({ runTest: sandbox.runTest, proposeFix: fixer.proposeFix }),
    );
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.code, 'return { total: 12.1 };');
    assert.strictEqual(r.repaired, false, 'nothing was fixed — saying "repaired" would be a fix nobody made');
    assert.strictEqual(r.attemptsUsed, 1);
    assert.deepStrictEqual(r.result, { total: 12.1 });
    assert.strictEqual(fixer.calls.length, 0, 'a working body must not cost a model call');
});

test('a fixed body comes back green, with the whole attempt log', async () => {
    const sandbox = fakeSandbox([new Error('Code step error: tota is not defined'), ran({ total: 12.1 })]);
    const fixer = fakeFixer(['return { total: 12.1 };']);
    const r = await repairCodeBody(
        { code: 'return { total: tota };', expectOutputs: ['total'] },
        defaultDeps({ runTest: sandbox.runTest, proposeFix: fixer.proposeFix }),
    );
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.repaired, true);
    assert.strictEqual(r.code, 'return { total: 12.1 };');
    assert.strictEqual(r.attempts.length, 2);
    assert.strictEqual(r.attempts[0].ok, false);
    assert.strictEqual(r.attempts[0].code, 'return { total: tota };', 'each attempt keeps the body it tested');
    assert.match(r.attempts[0].error, /tota is not defined/);
    assert.strictEqual(r.attempts[1].ok, true);
    // The evidence really reaches the repairer — a fixer asked to fix code it
    // cannot see the failure of is a model guessing.
    assert.match(fixer.calls[0].error, /tota is not defined/);
    assert.strictEqual(fixer.calls[0].attempt, 1);
});

test('the repairer is given every kind of evidence the run produced', async () => {
    const sandbox = fakeSandbox([
        { result: { total: 1 }, logs: ['checking 3 rows'], calls: [{ kind: 'tool', name: 'gmail_send', args: { to: 'x' } }] },
        ran({ total: 1, currency: 'EUR' }),
    ]);
    const fixer = fakeFixer(['return { total: 1, currency: "EUR" };']);
    const r = await repairCodeBody(
        { code: 'return { total: 1 };', expectOutputs: ['total', 'currency'], goal: 'normalise VAT' },
        defaultDeps({ runTest: sandbox.runTest, proposeFix: fixer.proposeFix }),
    );
    assert.strictEqual(r.ok, true);
    const first = r.attempts[0];
    assert.deepStrictEqual(first.missingOutputs, ['currency']);
    assert.deepStrictEqual(first.logs, ['checking 3 rows']);
    assert.deepStrictEqual(first.wouldHaveCalled, [{ kind: 'tool', name: 'gmail_send', args: { to: 'x' } }]);
    assert.deepStrictEqual(first.result, { total: 1 });
    const ev = fixer.calls[0];
    assert.deepStrictEqual(ev.missingOutputs, ['currency']);
    assert.deepStrictEqual(ev.wouldHaveCalled, first.wouldHaveCalled);
    assert.strictEqual(ev.goal, 'normalise VAT');
    assert.deepStrictEqual(ev.expectOutputs, ['total', 'currency']);
});

test('"it called nothing" is an answer — the evidence keys are always there', async () => {
    const sandbox = fakeSandbox([ran({ a: 1 })]);
    const r = await repairCodeBody({ code: 'return { a: 1 };' }, defaultDeps({ runTest: sandbox.runTest }));
    assert.deepStrictEqual(r.attempts[0].wouldHaveCalled, []);
    assert.deepStrictEqual(r.attempts[0].logs, []);
    assert.strictEqual(r.attempts[0].error, null);
});

// ── Green is not "did not throw" ────────────────────────────────────────

test('a body that returns nothing is not green, however quietly it ran', async () => {
    const sandbox = fakeSandbox([ran(undefined)]);
    const r = await repairCodeBody(
        { code: 'ctx.log("done");', expectOutputs: ['total'] },
        defaultDeps({ runTest: sandbox.runTest }),
    );
    assert.strictEqual(r.ok, false);
    assert.deepStrictEqual(r.attempts[0].missingOutputs, ['total'], 'the node declares it; the body has to produce it');
});

test('a scalar return does not satisfy a declared output either', async () => {
    const sandbox = fakeSandbox([ran(5)]);
    const r = await repairCodeBody({ code: 'return 5;', expectOutputs: ['total'] }, defaultDeps({ runTest: sandbox.runTest }));
    assert.strictEqual(r.ok, false);
    assert.deepStrictEqual(r.attempts[0].missingOutputs, ['total']);
});

test('a body with nothing declared is green as soon as it runs', async () => {
    // Nothing declared, nothing to check: the node contract is what makes
    // outputs mandatory, and this loop does not invent a second rule.
    const sandbox = fakeSandbox([ran(undefined)]);
    const r = await repairCodeBody({ code: 'ctx.log("hi");' }, defaultDeps({ runTest: sandbox.runTest }));
    assert.strictEqual(r.ok, true);
});

// ── The bound ───────────────────────────────────────────────────────────

test('the loop stops at the bound and says the body is still broken', async () => {
    const sandbox = fakeSandbox([new Error('Code step error: still wrong')]);
    const fixer = fakeFixer([(ev) => `${ev.code}\n// try ${ev.attempt}`]);
    const r = await repairCodeBody(
        { code: 'return tota;', expectOutputs: ['total'] },
        defaultDeps({ runTest: sandbox.runTest, proposeFix: fixer.proposeFix }),
    );
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'not_repaired');
    assert.strictEqual(r.attemptsUsed, MAX_REPAIR_ATTEMPTS);
    assert.strictEqual(sandbox.seen.length, MAX_REPAIR_ATTEMPTS, 'one run per attempt, and not one more');
    assert.strictEqual(fixer.calls.length, MAX_REPAIR_ATTEMPTS - 1, 'the last attempt is tested, not repaired again for nobody to try');
    assert.match(r.message, /still does not pass/);
});

test('a failed repair never hands back the last broken body as the answer', async () => {
    const sandbox = fakeSandbox([new Error('Code step error: still wrong')]);
    const fixer = fakeFixer([(ev) => `${ev.code}\n// try ${ev.attempt}`]);
    const r = await repairCodeBody(
        { code: 'return tota;' },
        defaultDeps({ runTest: sandbox.runTest, proposeFix: fixer.proposeFix }),
    );
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, null, 'a caller reading .code must never get a body nothing was shown to run');
    // The candidate is still available — under a name that cannot be mistaken
    // for a working body.
    assert.strictEqual(r.lastCandidate, r.attempts[r.attempts.length - 1].code);
    assert.match(r.lastError, /still wrong/);
    assert.ok(r.lastCandidate.includes('// try'), 'the last thing the repairer proposed');
});

test('the caller may ask for fewer attempts; it may not ask for more', async () => {
    const sandbox = fakeSandbox([new Error('Code step error: nope')]);
    const fixer = fakeFixer([(ev) => `${ev.code}\n// ${ev.attempt}`]);
    const one = await repairCodeBody({ code: 'x', maxAttempts: 1 }, defaultDeps({ runTest: sandbox.runTest, proposeFix: fixer.proposeFix }));
    assert.strictEqual(one.attemptsUsed, 1);
    assert.strictEqual(fixer.calls.length, 0, 'one attempt means one run and no repair');

    const many = fakeSandbox([new Error('Code step error: nope')]);
    const manyFixer = fakeFixer([(ev) => `${ev.code}\n// ${ev.attempt}`]);
    const capped = await repairCodeBody({ code: 'x', maxAttempts: 50 }, defaultDeps({ runTest: many.runTest, proposeFix: manyFixer.proposeFix }));
    assert.strictEqual(capped.attemptsUsed, ATTEMPT_CEILING, 'an unclamped bound is an unclamped bill: a model call and an isolate per pass');

    const nonsense = fakeSandbox([new Error('Code step error: nope')]);
    const zero = await repairCodeBody({ code: 'x', maxAttempts: 0 }, defaultDeps({ runTest: nonsense.runTest }));
    assert.strictEqual(zero.attemptsUsed, 1, 'a bound of zero would test nothing and report nothing');
});

// ── The ways a repair stops early ───────────────────────────────────────

test('a repairer that hands back the same body ends the loop instead of repeating it', async () => {
    const sandbox = fakeSandbox([new Error('Code step error: nope')]);
    const fixer = fakeFixer([(ev) => ev.code]);
    const r = await repairCodeBody({ code: 'return tota;' }, defaultDeps({ runTest: sandbox.runTest, proposeFix: fixer.proposeFix }));
    assert.strictEqual(r.reason, 'unchanged');
    assert.strictEqual(sandbox.seen.length, 1, 'running the identical body again would fail identically');
    assert.strictEqual(r.code, null);
    assert.strictEqual(r.attemptsUsed, 1);
});

test('no repairer wired in: the body is still tested, and the report says why nothing was fixed', async () => {
    // The complianceFacts pattern — a collaborator that is null leaves its
    // half of the answer absent, never invented.
    const sandbox = fakeSandbox([new Error('Code step error: nope')]);
    const r = await repairCodeBody({ code: 'return tota;' }, defaultDeps({ runTest: sandbox.runTest }));
    assert.strictEqual(r.reason, 'no_repairer');
    assert.strictEqual(r.attempts.length, 1, 'the evidence is still collected');
    assert.match(r.attempts[0].error, /nope/);
    assert.strictEqual(defaultDeps().proposeFix, null);
});

test('a repairer that returns nothing usable stops the loop', async () => {
    for (const answer of [null, '', '   ', { code: '' }, 42]) {
        const sandbox = fakeSandbox([new Error('Code step error: nope')]);
        const r = await repairCodeBody({ code: 'return tota;' }, defaultDeps({ runTest: sandbox.runTest, proposeFix: async () => answer }));
        assert.strictEqual(r.reason, 'no_proposal', `answer ${JSON.stringify(answer)}`);
        assert.strictEqual(r.code, null);
    }
    // …and the { code } shape is accepted, because that is what a tool-call
    // style answer looks like.
    const ok = fakeSandbox([new Error('Code step error: nope'), ran({ a: 1 })]);
    const r = await repairCodeBody({ code: 'return tota;' }, defaultDeps({ runTest: ok.runTest, proposeFix: async () => ({ code: 'return { a: 1 };' }) }));
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.code, 'return { a: 1 };');
});

test('a repairer that fails is not reported as an unfixable body', async () => {
    const sandbox = fakeSandbox([new Error('Code step error: nope')]);
    const r = await repairCodeBody({ code: 'return tota;' }, defaultDeps({
        runTest: sandbox.runTest,
        proposeFix: async () => { throw new Error('503 from the provider'); },
    }));
    assert.strictEqual(r.reason, 'repairer_failed');
    assert.match(r.message, /503 from the provider/);
    assert.strictEqual(r.code, null);
});

test('a sandbox that is not installed is not the author\'s bug, and no model is asked about it', async () => {
    const unavailable = Object.assign(new Error('Code step disabled: isolated-vm not installed'), { sandboxUnavailable: true });
    const fixer = fakeFixer(['anything']);
    const r = await repairCodeBody({ code: 'return 1;' }, defaultDeps({
        runTest: async () => { throw unavailable; },
        proposeFix: fixer.proposeFix,
    }));
    assert.strictEqual(r.reason, 'sandbox_unavailable');
    assert.strictEqual(fixer.calls.length, 0, 'handing a model a body to "fix" over a missing native module is a repair of nothing');
    assert.deepStrictEqual(r.attempts, []);
});

test('there is nothing to test without a body', async () => {
    const sandbox = fakeSandbox([ran({})]);
    for (const code of [undefined, null, '', '   ', 12]) {
        const r = await repairCodeBody({ code }, defaultDeps({ runTest: sandbox.runTest }));
        assert.strictEqual(r.reason, 'no_code');
    }
    assert.strictEqual(sandbox.seen.length, 0);
});

test('progress is reported per turn, the way _chatLoop emits it', async () => {
    const seen = [];
    const sandbox = fakeSandbox([new Error('Code step error: nope'), ran({ a: 1 })]);
    await repairCodeBody(
        { code: 'return tota;', onProgress: (e) => seen.push(e) },
        defaultDeps({ runTest: sandbox.runTest, proposeFix: async () => 'return { a: 1 };' }),
    );
    assert.deepStrictEqual(seen.map(e => e.type), ['testing', 'failed', 'repairing', 'testing', 'passed']);
    assert.strictEqual(seen[0].detail.of, MAX_REPAIR_ATTEMPTS);
});

// ── The node-shaped entry point ─────────────────────────────────────────

// A custom node: the Step contract plus a body and the manifest.
function nodeDef(body) {
    return {
        schemaVersion: 2,
        trigger: { id: 'trg', type: 'trigger', kind: 'layer_input', params: [{ name: 'amount', type: 'number', required: true }] },
        steps: [
            body,
            { id: 'out', type: 'layer_output', fields: { total: { kind: 'ref', path: 'steps.body.output.result.total' } }, label: 'Return' },
        ],
        edges: [{ from: 'trg', to: 'body' }, { from: 'body', to: 'out' }],
        capabilities: ['tool:gmail_send'],
    };
}

test('a node is tested against what it declares, without the caller restating any of it', async () => {
    const def = nodeDef({ id: 'body', type: 'code', code: 'return { total: tota };', allowedTools: ['gmail_send'], limits: { wallMs: 8000 } });
    const sandbox = fakeSandbox([new Error('Code step error: tota is not defined'), ran({ total: 12.1 })]);
    const r = await repairCustomNode(
        { definition: def, inputs: { amount: 10 } },
        defaultDeps({ runTest: sandbox.runTest, proposeFix: async () => 'return { total: 12.1 };' }),
    );
    assert.strictEqual(r.ok, true);
    // Everything the run needed came off the node itself.
    assert.deepStrictEqual(sandbox.seen[0].allowedTools, ['gmail_send'], 'the manifest is the gate, here too');
    assert.deepStrictEqual(sandbox.seen[0].limits, { wallMs: 8000 });
    assert.deepStrictEqual(sandbox.seen[0].inputs, { amount: 10 });
    // The node comes back with the repaired body in place, and the original
    // is untouched.
    assert.strictEqual(r.definition.steps[0].code, 'return { total: 12.1 };');
    assert.strictEqual(r.definition.steps[0].allowedTools, def.steps[0].allowedTools);
    assert.strictEqual(def.steps[0].code, 'return { total: tota };', 'input not mutated');
    assert.deepStrictEqual(require('./customNode').validateCustomNode(r.definition), [], 'a repaired node still satisfies its contract');
});

test('a node whose body could not be repaired comes back with no definition to save', async () => {
    const def = nodeDef({ id: 'body', type: 'code', code: 'return { total: tota };', allowedTools: ['gmail_send'] });
    const sandbox = fakeSandbox([new Error('Code step error: tota is not defined')]);
    const r = await repairCustomNode(
        { definition: def },
        defaultDeps({ runTest: sandbox.runTest, proposeFix: async (ev) => `${ev.code}\n// ${ev.attempt}` }),
    );
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'not_repaired');
    assert.strictEqual(r.definition, undefined, 'there is no repaired node, so there is none to hand back');
    assert.strictEqual(r.code, null);
});

test('a node with no single body says so rather than testing nothing', async () => {
    const two = nodeDef({ id: 'body', type: 'code', code: 'return 1;' });
    two.steps.splice(1, 0, { id: 'body2', type: 'code', code: 'return 2;' });
    for (const def of [two, nodeDef({ id: 'x', type: 'set', fields: {} }), null]) {
        const r = await repairCustomNode({ definition: def }, defaultDeps({ runTest: async () => { throw new Error('must not run'); } }));
        assert.strictEqual(r.reason, 'no_body');
    }
});

test('a body nested in a layer is repaired where it lives, not left unchanged', async () => {
    // customNode.eachCodeStep looks in nested layers too, so the body of a
    // hand-built node can sit in one. A replacement that only scanned the
    // root would report a repair and hand back the node unchanged — the same
    // lie as returning the last broken body.
    const def = {
        schemaVersion: 2,
        trigger: { id: 'trg', type: 'trigger', kind: 'layer_input', params: [] },
        steps: [{ id: 'out', type: 'layer_output', fields: { total: { kind: 'literal', value: 1 } } }],
        layers: { inner: { title: 'inner', steps: [{ id: 'body', type: 'code', code: 'return { total: tota };', allowedTools: [] }] } },
        capabilities: [],
    };
    const sandbox = fakeSandbox([new Error('Code step error: tota is not defined'), ran({ total: 1 })]);
    const r = await repairCustomNode({ definition: def }, defaultDeps({ runTest: sandbox.runTest, proposeFix: async () => 'return { total: 1 };' }));
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.definition.layers.inner.steps[0].code, 'return { total: 1 };');
    assert.strictEqual(def.layers.inner.steps[0].code, 'return { total: tota };', 'input not mutated');
});

// ── The real isolate ────────────────────────────────────────────────────

test('the real sandbox: a broken body, the author\'s own line number, and a fix that runs', async () => {
    const sandbox = require('./codeSandbox');
    assert.ok(sandbox.isAvailable(), sandbox.loadError() || 'expected the sandbox to be available');
    const def = nodeDef({
        id: 'body', type: 'code', allowedTools: ['gmail_send'],
        code: 'const total = inputs.amount * 1.21;\nreturn { total: tota; };',
    });
    const fixed = 'const total = inputs.amount * 1.21;\nawait ctx.integrations.gmail_send({ to: "boekhouding@example.com" });\nreturn { total };';
    const r = await repairCustomNode(
        { definition: def, inputs: { amount: 10 } },
        defaultDeps({ proposeFix: async () => fixed }),
    );
    assert.strictEqual(r.ok, true, JSON.stringify(r.attempts));
    assert.strictEqual(r.repaired, true);
    // The line number is the AUTHOR'S: the bootstrap that wraps their code is
    // ~30 lines tall, and a syntax error reported at line 32 is close to no
    // error at all.
    assert.match(r.attempts[0].error, /at line 2, column/);
    assert.deepStrictEqual(r.result, { total: 12.1 });
    // Stubbed, recorded, and NOT sent: a rehearsal must not mail the customer.
    assert.deepStrictEqual(r.attempts[1].wouldHaveCalled, [
        { kind: 'tool', name: 'gmail_send', args: { to: 'boekhouding@example.com' } },
    ]);
});

test('the real sandbox: a promoted node can be tested straight off the promotion', async () => {
    // The two halves in one line: what customNodePromote produces is exactly
    // what this loop knows how to run, with nothing restated in between.
    const { promoteCodeStep } = require('./customNodePromote');
    const promotion = promoteCodeStep({
        step: {
            id: 'c_1', type: 'code',
            code: 'return { total: inputs.amount * 1.21 };',
            inputs: { amount: { kind: 'literal', value: 10 } },
            allowedTools: [],
            outputSchema: { type: 'object', properties: { total: { type: 'number' } } },
        },
    });
    assert.strictEqual(promotion.ok, true, JSON.stringify(promotion.issues));
    const r = await repairCustomNode({ definition: promotion.definition, inputs: { amount: 10 } }, defaultDeps());
    assert.strictEqual(r.ok, true, JSON.stringify(r.attempts));
    assert.strictEqual(r.repaired, false);
    assert.deepStrictEqual(r.attempts[0].missingOutputs, [], 'the node declares `total` and the body really returns it');
});
