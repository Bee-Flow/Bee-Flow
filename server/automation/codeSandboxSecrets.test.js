/**
 * ctx.secrets tells the truth now.
 *
 * THE FAILURE THIS PINS. codeSandbox.js's header promised "ctx.secrets(name):
 * returns only secrets explicitly listed in step.inputs.secretKeys", and
 * builderTools/schemas.js advertised ctx.secrets to the model that writes code
 * steps. Neither was true. The only source execCode ever read from is
 * `runState.secrets`, which execution.js initialises to `{}` and which NOTHING
 * in server/ ever assigns to. So every declared key resolved to `null`, the
 * sandbox handed that null to user code, and a step written from the tool
 * description — `ctx.secrets('stripe_key')` — authenticated to a third party
 * with nothing at all and still finished green. An advertised capability that
 * silently yields null is strictly worse than an absent one: the author has no
 * way to discover the hole, and the first evidence is a 401 in someone else's
 * logs.
 *
 * So the capability now fails loudly at both ends:
 *   1. ctx.secrets(name) inside the isolate throws a named, catchable
 *      SecretsNotConfiguredError instead of returning null/undefined.
 *   2. execCode refuses a step that DECLARES inputs.secretKeys before any code
 *      runs, rather than filling the declaration with nulls.
 *   3. builder_add_code_step no longer advertises ctx.secrets to the model.
 *
 * This is NOT a secret store. Wiring one needs a store, a migration and a
 * permission decision; that is deliberately out of scope. What is in scope is
 * that the product stops claiming a capability it does not have.
 *
 * Run: node --test --test-force-exit server/automation/codeSandboxSecrets.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const sandbox = require('./codeSandbox');
const {
    runCode, isAvailable, loadError,
    SECRETS_NOT_CONFIGURED_NAME, SECRETS_NOT_CONFIGURED_MESSAGE,
} = sandbox;

// isolated-vm is a HARD dependency (server/package.json) — if it is missing the
// sandbox half of this file cannot assert anything, and silently passing would
// hide exactly the kind of hole this file exists to close. Fail instead.
test('isolated-vm is present — the sandbox assertions below are real', () => {
    assert.ok(isAvailable(), `isolated-vm must be installed: ${loadError()}`);
});

// ── 1. The bridge throws, loudly and by name ────────────────────────────

test('an uncaught ctx.secrets() stops the step with a legible message', async () => {
    await assert.rejects(
        () => runCode({
            code: `async function main(inputs, ctx) {
                return { key: ctx.secrets('stripe_key') };
            }`,
        }),
        (err) => {
            // runCode wraps in-isolate throws as "Code step error: <message>";
            // what matters is that the author sees the key they asked for AND
            // the reason, not an undefined that reads like an empty secret.
            assert.match(err.message, /stripe_key/, 'the refusal names the key that was asked for');
            assert.ok(err.message.includes(SECRETS_NOT_CONFIGURED_MESSAGE),
                `refusal must carry the shared explanation, got: ${err.message}`);
            return true;
        },
    );
});

test('the error is catchable by name inside the sandbox', async () => {
    // A handler that genuinely wants to degrade gracefully must be able to
    // recognise this specific failure rather than string-matching a message.
    // The Error is constructed INSIDE the isolate for exactly this reason: a
    // host-thrown error crossing the isolated-vm boundary is re-created there
    // and loses a custom constructor name, so `e.name` would not survive.
    const { result } = await runCode({
        code: `async function main(inputs, ctx) {
            try {
                const v = ctx.secrets('stripe_key');
                return { reached: true, value: v };
            } catch (e) {
                return { reached: false, name: e.name, secretName: e.secretName, message: e.message };
            }
        }`,
    });
    assert.strictEqual(result.reached, false, 'ctx.secrets must never return — old behaviour returned null here');
    assert.strictEqual(result.name, SECRETS_NOT_CONFIGURED_NAME);
    assert.strictEqual(result.secretName, 'stripe_key', 'the error carries the key that was asked for');
    assert.ok(result.message.includes(SECRETS_NOT_CONFIGURED_MESSAGE));
});

test('a populated bridges.secrets cannot revive the capability by accident', async () => {
    // The bridge is accepted and ignored — webpageApiRuntime still passes one
    // (an empty object); execCode passes none. If someone later populates it
    // and expects code steps to start seeing values, this test is what tells
    // them the wiring is a deliberate follow-up and not a one-liner: the
    // throw is unconditional, so a half-wired store can never leak a
    // credential into a sandbox that was never given a permission model.
    const { result, logs, http } = await runCode({
        code: `async function main(inputs, ctx) {
            try { ctx.log('secret was', ctx.secrets('stripe_key')); return { leaked: 'unreachable' }; }
            catch (e) { return { leaked: null, name: e.name }; }
        }`,
        bridges: { secrets: { stripe_key: 'sk_live_LEAK_CANARY' } },
    });
    assert.strictEqual(result.leaked, null, 'a bridge value must not reach user code');
    assert.strictEqual(result.name, SECRETS_NOT_CONFIGURED_NAME);
    // Sweep the WHOLE run envelope, not just the return value. Checking only
    // `result.leaked` would still pass if the value reached user code by some
    // other route and was logged — and run logs are surfaced in the step
    // output, so a canary in `logs` is a leak with an audience. Cheap, and it
    // is the assertion that keeps meaning something if this bridge is ever
    // half-wired again.
    assert.ok(!JSON.stringify({ result, logs, http }).includes('sk_live_LEAK_CANARY'),
        'no part of the run envelope (return value, logs, http record) may carry the bridge value');
});

test('the rest of ctx is untouched — only secrets changed', async () => {
    // Regression guard for the jail.set removal: dropping __hostSecret must not
    // disturb the log/http/integrations bridges that share the bootstrap.
    let fetched = null;
    const { result, logs, http } = await runCode({
        code: `async function main(inputs, ctx) {
            ctx.log('hello', { n: inputs.n });
            const r = await ctx.http('https://example.test/x');
            return { n: inputs.n * 2, status: r.status };
        }`,
        inputs: { n: 21 },
        bridges: {
            fetchHttp: async (url) => { fetched = url; return { status: 200, body: 'ok' }; },
        },
    });
    assert.deepStrictEqual(result, { n: 42, status: 200 });
    assert.deepStrictEqual(logs, ['hello {"n":21}']);
    assert.strictEqual(http.calls, 1);
    assert.strictEqual(fetched, 'https://example.test/x');
});

// ── 2. The documentation no longer lies ─────────────────────────────────

test('codeSandbox header no longer promises secretKeys resolution', () => {
    // Assert the BULLET LINE, not the header as a whole: the prose below the
    // bullets quotes the old promise verbatim to explain what was wrong, so a
    // whole-header regex would be satisfied by the very sentence it should
    // catch. The bullet is the line a developer skims to learn what ctx offers.
    const src = require('fs').readFileSync(require.resolve('./codeSandbox'), 'utf8');
    const bullet = src.split('\n').find(l => l.includes('- ctx.secrets(name)'));
    assert.ok(bullet, 'the header must still document ctx.secrets — silence is its own lie');
    assert.ok(!/returns only/.test(bullet),
        `the bullet must not repeat the promise the runner cannot keep: ${bullet}`);
    assert.match(bullet, /NOT WIRED|throws/, 'the bullet states plainly that ctx.secrets is dead');
});

test('builder_add_code_step does not advertise ctx.secrets to the model', () => {
    const { TOOL_SCHEMAS } = require('./builderTools/schemas');
    const tool = (TOOL_SCHEMAS || []).find(t => t?.function?.name === 'builder_add_code_step');
    assert.ok(tool, 'builder_add_code_step must still exist');
    const d = tool.function.description;
    assert.ok(!/ctx\.secrets\)/.test(d) && !/ctx\.secrets,/.test(d),
        'ctx.secrets must not appear in the list of things ctx offers');
    assert.match(d, /NO secret access/i, 'the model is told outright that code steps have no secrets');
});

// ── 3. execCode refuses a declared-but-unfillable secretKeys ────────────

test('execCode refuses a step that declares secretKeys instead of filling them with null', async () => {
    const configStore = require('../stores/configStore');
    const realGetConfig = configStore.getConfig;
    // Only the platform kill-switch needs to pass; ctx has no orgId so the
    // per-org beta gate is skipped and no DB is touched.
    configStore.getConfig = async (key) => (key === 'automation_code_step_enabled' ? true : realGetConfig(key));
    try {
        const { execCode } = require('../core/automationRunner/execOutbound');
        const step = {
            id: 's1', type: 'code',
            code: 'async function main() { return 1; }',
            inputs: { secretKeys: { value: ['stripe_key'] } },
        };
        await assert.rejects(
            () => execCode(step, { userId: 1 }, { steps: {}, vars: {}, secrets: {} }, 'run'),
            (err) => {
                assert.match(err.message, /stripe_key/, 'the author is told which key cannot be filled');
                assert.ok(err.message.includes(SECRETS_NOT_CONFIGURED_MESSAGE));
                return true;
            },
            'old behaviour resolved this to { stripe_key: null } and ran the code anyway',
        );

        // The bare-array spelling of the same declaration is refused too — both
        // shapes were read by the old resolution loop.
        await assert.rejects(
            () => execCode({ ...step, inputs: { secretKeys: ['a', 'b'] } },
                { userId: 1 }, { steps: {}, vars: {}, secrets: {} }, 'run'),
            /a, b/,
        );
    } finally {
        configStore.getConfig = realGetConfig;
    }
});

test('a code step that declares no secretKeys is unaffected', async () => {
    // The refusal must be scoped to the declaration. Steps that never mentioned
    // secrets are the overwhelming majority and must keep running untouched.
    const configStore = require('../stores/configStore');
    const realGetConfig = configStore.getConfig;
    configStore.getConfig = async (key) => (key === 'automation_code_step_enabled' ? true : realGetConfig(key));
    try {
        const { execCode } = require('../core/automationRunner/execOutbound');
        const out = await execCode(
            { id: 's2', type: 'code', code: 'async function main(inputs) { return inputs.n + 1; }', inputs: { n: 41 } },
            { userId: 1 }, { steps: {}, vars: {}, secrets: {} }, 'run',
        );
        assert.strictEqual(out.output.result, 42);
    } finally {
        configStore.getConfig = realGetConfig;
    }
});

test('execCode hands the sandbox no secrets bridge at all', async () => {
    // The sandbox ignores `bridges.secrets`, so this is belt-and-braces — but
    // the two halves of the fix must not drift: if a later edit re-adds a
    // `secrets` entry at this call site while the in-isolate throw stays, the
    // runner is once again carrying credential-shaped state into a sandbox
    // that has no permission model for it, and nothing else would notice.
    // Pinned at the call site because that is where the old null-map was born.
    const configStore = require('../stores/configStore');
    const realGetConfig = configStore.getConfig;
    const realRunCode = sandbox.runCode;
    let seenBridges = null;
    configStore.getConfig = async (key) => (key === 'automation_code_step_enabled' ? true : realGetConfig(key));
    sandbox.runCode = async (opts) => { seenBridges = opts.bridges; return { result: 1, logs: [], http: { calls: 0 } }; };
    try {
        const { execCode } = require('../core/automationRunner/execOutbound');
        await execCode(
            { id: 's3', type: 'code', code: 'async function main() { return 1; }', inputs: { n: 1 } },
            { userId: 1 }, { steps: {}, vars: {}, secrets: { stripe_key: 'sk_live_LEAK_CANARY' } }, 'run',
        );
    } finally {
        sandbox.runCode = realRunCode;
        configStore.getConfig = realGetConfig;
    }
    assert.ok(seenBridges, 'execCode must have reached the sandbox');
    assert.ok(!('secrets' in seenBridges),
        'old behaviour passed a `secrets` map built from runState.secrets — it must be gone');
    // The bridges that DO exist are untouched: this test must not quietly
    // become a check that execCode stopped wiring anything.
    assert.strictEqual(typeof seenBridges.executeTool, 'function');
    assert.strictEqual(typeof seenBridges.fetchHttp, 'function');
});
