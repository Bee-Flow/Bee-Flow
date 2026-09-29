/**
 * The code step's `limits` block, end to end — and the three other contracts
 * `execCode` reads that nobody could see.
 *
 * codeSandbox.clampLimits has always taken memoryMb / cpuMs / wallMs /
 * httpBudget and clamped them to a deliberate table, with a comment explaining
 * that code steps run IN-PROCESS and an oversized limit is a shared-host
 * exhaustion vector. But applyAddCode hardcoded `{cpuMs:1000, memoryMb:64,
 * wallMs:5000}` and threw away whatever the caller asked for, the AI tool
 * schema did not mention the block at all, `limits` was not patchable, and the
 * validator checked only the code string and the language. So the clamp table
 * was reachable by NO ONE: the ceiling was real, the dial did not exist, and a
 * step that needed eight seconds of wall clock for a slow API had no way to
 * say so.
 *
 * These tests pin the whole chain — schema → applyAddCode → validator → patch
 * — and, above all, they pin the clamp as the AUTHORITY: the bounds the
 * validator and the builder refuse on are read back out of codeSandbox.js
 * itself, so the day someone raises MAX_LIMITS.memoryMb this file fails and
 * names both numbers, instead of the two tables drifting apart in silence.
 *
 * Run: cd server && node --test --test-force-exit automation/codeStepLimits.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { applyToolCall, emptyDefinition, TOOL_SCHEMAS } = require('./builderTools');
const { validateDefinition } = require('./validate');
const { CODE_LIMIT_BOUNDS } = require('./validate/stepRules/dataShapingRules');
const { sanitizeCodeLimits } = require('./builderTools/stepBuilders/dataSteps');
const { PATCHABLE_FIELDS } = require('./builderTools/stepEditing');

function freshWrap() {
    return { userId: 'u_test', def: emptyDefinition() };
}

const CODE = 'async function main(inputs, ctx) { return { ok: true }; }';

/** Add one code step and hand back {dw, step}. */
async function addCode(args = {}) {
    const dw = freshWrap();
    const res = await applyToolCall('builder_add_code_step', { code: CODE, ...args }, dw);
    return { dw, res };
}

function codesOf(def, opts) {
    const r = validateDefinition(def, opts);
    return {
        errors: (r.errors || []).map(e => e.code),
        warnings: (r.warnings || []).map(e => e.code),
        all: [...(r.errors || []), ...(r.warnings || [])],
    };
}

// ─────────────────────────────────────────────────────────────────────
// 1. THE CLAMP IS THE AUTHORITY
// ─────────────────────────────────────────────────────────────────────

const SANDBOX_SRC = fs.readFileSync(path.join(__dirname, 'codeSandbox.js'), 'utf8');

/** A `const NAME = { k: 123, … }` numeric literal out of the sandbox source. */
function sandboxTable(name) {
    const m = new RegExp(`const ${name} = \\{([^}]*)\\}`).exec(SANDBOX_SRC);
    assert.ok(m, `${name} was not found in codeSandbox.js — this scan has gone stale, fix the scan before trusting the pin`);
    const out = {};
    for (const part of m[1].split(',')) {
        const kv = /([A-Za-z]\w*)\s*:\s*([\d_]+)/.exec(part);
        if (kv) out[kv[1]] = Number(kv[2].replace(/_/g, ''));
    }
    assert.ok(Object.keys(out).length >= 3, `${name} parsed to ${JSON.stringify(out)} — the scan has gone stale`);
    return out;
}

/** The MINIMUM clampLimits passes for `key` (a literal in the clamp call). */
function sandboxMin(key) {
    const m = new RegExp(`${key}: clampLimit\\(limits\\.${key},[^,]+,\\s*([\\d_]+),`).exec(SANDBOX_SRC);
    assert.ok(m, `clampLimits no longer clamps ${key} the way this scan expects — fix the scan`);
    return Number(m[1].replace(/_/g, ''));
}

test('the bounds table is the sandbox clamp, number for number', () => {
    const max = sandboxTable('MAX_LIMITS');
    const def = sandboxTable('DEFAULT_LIMITS');
    const httpDefault = Number(/const HTTP_BUDGET_DEFAULT = (\d+)/.exec(SANDBOX_SRC)[1]);

    assert.deepStrictEqual(
        Object.keys(CODE_LIMIT_BOUNDS).sort(), Object.keys(max).sort(),
        'CODE_LIMIT_BOUNDS and MAX_LIMITS no longer describe the same set of limits',
    );
    for (const [key, b] of Object.entries(CODE_LIMIT_BOUNDS)) {
        assert.strictEqual(b.max, max[key], `${key}: the validator allows up to ${b.max}, the sandbox clamps at ${max[key]}`);
        assert.strictEqual(b.min, sandboxMin(key), `${key}: the validator's floor is ${b.min}, the sandbox clamps at ${sandboxMin(key)}`);
        const sandboxDefault = key === 'httpBudget' ? httpDefault : def[key];
        assert.strictEqual(b.def, sandboxDefault, `${key}: the builder writes ${b.def} by default, the sandbox would have used ${sandboxDefault}`);
    }
});

test('the bounds are never WIDER than the clamp — narrower would only be strict, wider would be a lie', () => {
    const max = sandboxTable('MAX_LIMITS');
    for (const [key, b] of Object.entries(CODE_LIMIT_BOUNDS)) {
        assert.ok(b.max <= max[key], `${key}: authoring would accept ${b.max} but the isolate is built with at most ${max[key]}`);
        assert.ok(b.def >= b.min && b.def <= b.max, `${key}: the default ${b.def} is itself outside ${b.min}..${b.max}`);
    }
});

test('builderPrompt\'s prose copy of the table still says the same numbers', () => {
    // The lean prompt teaches the model what a code step costs, and its source
    // comment restates DEFAULT_LIMITS/MAX_LIMITS verbatim. That is a THIRD
    // copy of this table, and three copies is exactly how a clamp drifts — so
    // it gets pinned here rather than discovered later by a model that was
    // taught the wrong ceiling.
    // Numeric separators out (10_000 → 10000) and the comment's own line
    // wrapping flattened, so the sentence can be matched as one string.
    //
    // Bewust brontekst, en dat kan niet anders: de PROMPT die het model
    // echt leest (codeStepMenuEntry, hierboven) rondt bewust af tot proza
    // ("about 1s of CPU… ceilings of 10s and 30s") — geen exacte cijfers om
    // op te draaien voor het model. Precies daarom staan de exacte cijfers
    // in een `//`-ontwikkelaarscommentaar ernaast: dat commentaar draagt geen
    // enkel runtime-gedrag, dus aanroepen kan de aanwezigheid van dit getal
    // niet waarnemen. De tekst IS hier de eigenschap.
    const prompt = fs.readFileSync(path.join(__dirname, 'builderPrompt.js'), 'utf8')
        .replace(/(\d)_(\d)/g, '$1$2')
        .replace(/\n\s*(\/\/|\*)?\s*/g, ' ');
    const b = CODE_LIMIT_BOUNDS;
    assert.ok(
        prompt.includes(`DEFAULT_LIMITS {memoryMb:${b.memoryMb.def}, cpuMs:${b.cpuMs.def}, wallMs:${b.wallMs.def}}`),
        'builderPrompt.js no longer states the sandbox defaults this table holds',
    );
    assert.ok(
        prompt.includes(`MAX_LIMITS {${b.memoryMb.max}, ${b.cpuMs.max}, ${b.wallMs.max}, httpBudget:${b.httpBudget.max}}`),
        'builderPrompt.js states different ceilings than the sandbox clamps to',
    );
    assert.ok(
        prompt.includes(`HTTP_BUDGET_DEFAULT ${b.httpBudget.def}`),
        'builderPrompt.js states a different default http budget',
    );
});

// ─────────────────────────────────────────────────────────────────────
// 2. THE TOOL SCHEMA CAN EXPRESS THEM
// ─────────────────────────────────────────────────────────────────────

test('builder_add_code_step advertises limits, closed, with every bound named', () => {
    const fn = TOOL_SCHEMAS.find(t => t.function?.name === 'builder_add_code_step').function;
    const limits = fn.parameters.properties.limits;
    assert.ok(limits, 'the schema has no `limits` parameter — the model cannot ask for what the sandbox honours');
    assert.strictEqual(limits.additionalProperties, false, 'an open limits object lets a grammar-constrained model invent keys the runtime never reads');
    assert.deepStrictEqual(Object.keys(limits.properties).sort(), Object.keys(CODE_LIMIT_BOUNDS).sort());
    for (const [key, b] of Object.entries(CODE_LIMIT_BOUNDS)) {
        const d = limits.properties[key].description;
        assert.match(d, new RegExp(`${b.min}\\.\\.${b.max}`), `${key}'s description does not name its real range — the model's code first runs in the USER's dry run, so it cannot learn a ceiling by hitting it`);
        assert.match(d, new RegExp(`default ${b.def}\\b`), `${key}'s description does not name its default`);
    }
    assert.match(fn.description, /limits/, 'the tool description does not point at the limits parameter');
});

// ─────────────────────────────────────────────────────────────────────
// 3. applyAddCode STOPS DISCARDING THEM
// ─────────────────────────────────────────────────────────────────────

test('the author\'s limits survive the add — this is the hardcode that is gone', async () => {
    const { res } = await addCode({ limits: { wallMs: 20000, httpBudget: 12 } });
    assert.ok(!res.error, res.error);
    // Named keys kept verbatim; the rest filled from the sandbox's own
    // defaults, so the stored step always states all four.
    assert.deepStrictEqual(res.added.limits, {
        memoryMb: 64, cpuMs: 1000, wallMs: 20000, httpBudget: 12,
    });
});

test('a step that names nothing still stores the whole block, httpBudget included', async () => {
    const { res } = await addCode();
    assert.deepStrictEqual(res.added.limits, { memoryMb: 64, cpuMs: 1000, wallMs: 5000, httpBudget: 5 });
});

test('every limit is settable across its whole legal range', async () => {
    for (const [key, b] of Object.entries(CODE_LIMIT_BOUNDS)) {
        for (const v of [b.min, b.max]) {
            const { res } = await addCode({ limits: { [key]: v } });
            assert.ok(!res.error, `${key}=${v} was refused: ${res.error}`);
            assert.strictEqual(res.added.limits[key], v);
        }
    }
});

test('over the ceiling is REFUSED, not clamped, and the refusal names the real bound', async () => {
    const { res } = await addCode({ limits: { memoryMb: 4096 } });
    assert.ok(res.error, 'a 4 GB isolate was accepted');
    assert.match(res.error, /4096/);
    assert.match(res.error, /8\.\.256 MB/, 'the refusal does not name the real bound');
    assert.match(res.error, /256 or less/);
});

test('under the floor, a fraction, a string and an unknown key are each refused by name', async () => {
    const under = await addCode({ limits: { cpuMs: 10 } });
    assert.match(under.res.error, /50\.\.10000 ms/);

    const fractional = await addCode({ limits: { wallMs: 1500.5 } });
    assert.match(fractional.res.error, /whole number/);

    const stringy = await addCode({ limits: { memoryMb: '128' } });
    assert.match(stringy.res.error, /whole number/);

    const invented = await addCode({ limits: { timeoutMs: 9000 } });
    assert.match(invented.res.error, /timeoutMs is not a limit the sandbox reads/);
    assert.match(invented.res.error, /memoryMb, cpuMs, wallMs, httpBudget/);

    const notAnObject = await addCode({ limits: 5000 });
    assert.match(notAnObject.res.error, /limits must be an object/);
});

test('a limit named after an Object.prototype member is refused like any other invention', async () => {
    // The unknown-key rule used to ask `CODE_LIMIT_BOUNDS[key]` and trust the
    // answer, so `constructor`, `toString`, `valueOf`, `hasOwnProperty` and
    // `isPrototypeOf` each found a truthy "bounds object" on the prototype
    // chain, skipped the refusal, and then compared their value against a min
    // and max of undefined — false both ways, so they were ACCEPTED and
    // written onto the step. JSON.parse produces exactly these from an
    // imported definition, and a stored `limits.hasOwnProperty = 9999` breaks
    // the next caller that does step.limits.hasOwnProperty(…).
    for (const key of ['constructor', 'toString', 'valueOf', 'hasOwnProperty', 'isPrototypeOf', '__proto__']) {
        const raw = JSON.parse(`{"${key}": 9999}`);

        const built = sanitizeCodeLimits(raw);
        assert.ok(built.error, `limits.${key} was accepted by the builder`);
        assert.match(built.error, new RegExp(`limits\\.${key.replace(/[$]/g, '')} is not a limit the sandbox reads`));

        const { errors, warnings } = codesOf(defWithCode({ limits: raw }));
        assert.deepStrictEqual(errors, [], `limits.${key} must warn, not block a routine — same as any other invented key`);
        assert.ok(warnings.includes('code.limits_unknown_key'), `limits.${key} passed the validator in silence`);
    }

    // And nothing of the sort can reach a stored step: the block the builder
    // writes only ever carries the four keys the sandbox reads.
    const { res } = await addCode({ limits: { cpuMs: 2000 } });
    assert.deepStrictEqual(Object.keys(res.added.limits).sort(), Object.keys(CODE_LIMIT_BOUNDS).sort());
});

test('httpBudget 0 is a real answer, not a missing one — code that must not reach the network', async () => {
    const { res } = await addCode({ limits: { httpBudget: 0 } });
    assert.ok(!res.error, res.error);
    assert.strictEqual(res.added.limits.httpBudget, 0);
});

// ─────────────────────────────────────────────────────────────────────
// 4. THE VALIDATOR AGREES WITH THE CLAMP
// ─────────────────────────────────────────────────────────────────────

/** A definition carrying one hand-written code step (the import path). */
function defWithCode(extra) {
    return {
        trigger: { id: 'trg', kind: 'manual' },
        steps: [{ id: 'c1', type: 'code', language: 'javascript', code: CODE, inputs: {}, allowedTools: [], ...extra }],
        edges: [{ from: 'trg', to: 'c1' }],
    };
}

test('a builder-built code step validates clean', async () => {
    const { dw } = await addCode({ limits: { cpuMs: 8000 } });
    assert.deepStrictEqual(validateDefinition(dw.def).errors, []);
});

test('an imported step over the ceiling is an error that names the bound, at draft stage too', () => {
    const { errors, all } = codesOf(defWithCode({ limits: { memoryMb: 512 } }));
    assert.ok(errors.includes('code.limits_out_of_range'), `got ${errors.join(', ')}`);
    const e = all.find(x => x.code === 'code.limits_out_of_range');
    assert.match(e.message, /8\.\.256 MB \(isolate heap\)/);
    assert.strictEqual(e.path, 'steps[c1].limits.memoryMb');
    // Out of range is an INTEGRITY problem, never "not finished typing" — so
    // it must still block while the flow is a draft.
    const draft = codesOf(defWithCode({ limits: { memoryMb: 512 } }), { stage: 'draft' });
    assert.ok(draft.errors.includes('code.limits_out_of_range'), 'a 512 MB isolate slipped through at draft stage');
});

test('a limit that is not a whole number, and a limits block that is not an object', () => {
    assert.ok(codesOf(defWithCode({ limits: { cpuMs: '2000' } })).errors.includes('code.limits_not_a_number'));
    assert.ok(codesOf(defWithCode({ limits: [1, 2] })).errors.includes('code.limits_shape'));
});

test('an invented limit key is a warning — it does nothing, but it must not block a routine', () => {
    const { errors, warnings, all } = codesOf(defWithCode({ limits: { cpuMs: 2000, retries: 3 } }));
    assert.deepStrictEqual(errors, []);
    assert.ok(warnings.includes('code.limits_unknown_key'), `got ${warnings.join(', ')}`);
    assert.match(all.find(x => x.code === 'code.limits_unknown_key').message, /does nothing/);
});

test('the validator accepts exactly what the builder accepts — the two never disagree', () => {
    for (const [key, b] of Object.entries(CODE_LIMIT_BOUNDS)) {
        for (const v of [b.min - 1, b.min, b.def, b.max, b.max + 1]) {
            const builderOk = !sanitizeCodeLimits({ [key]: v }).error;
            const validatorOk = !codesOf(defWithCode({ limits: { [key]: v } })).errors.some(c => c.startsWith('code.limits'));
            assert.strictEqual(builderOk, validatorOk, `${key}=${v}: builder says ${builderOk ? 'yes' : 'no'}, validator says ${validatorOk ? 'yes' : 'no'}`);
        }
    }
});

// ─────────────────────────────────────────────────────────────────────
// 5. A PATCH CAN CHANGE THEM
// ─────────────────────────────────────────────────────────────────────

test('limits is patchable', () => {
    assert.ok(PATCHABLE_FIELDS.code.includes('limits'));
});

test('builder_update_step rewrites the block, and the omitted keys go back to the defaults', async () => {
    const { dw, res } = await addCode({ limits: { memoryMb: 256, wallMs: 20000 } });
    const upd = await applyToolCall('builder_update_step', {
        stepId: res.added.id, patch: { limits: { cpuMs: 9000 } },
    }, dw);
    assert.ok(!upd.error, upd.error);
    // Rebuilt, never merged: the seam only sees the VALUE, never the step. The
    // add path always writes all four keys, so a partial block is always the
    // model's own invention — and this is what it costs.
    assert.deepStrictEqual(upd.updated.limits, { memoryMb: 64, cpuMs: 9000, wallMs: 5000, httpBudget: 5 });
    assert.deepStrictEqual(validateDefinition(dw.def).errors, []);
});

test('a patched step is byte-identical to a freshly-added one', async () => {
    const fresh = await addCode({ limits: { memoryMb: 128, cpuMs: 2000, wallMs: 9000, httpBudget: 1 } });
    const { dw, res } = await addCode();
    const upd = await applyToolCall('builder_update_step', {
        stepId: res.added.id, patch: { limits: { memoryMb: 128, cpuMs: 2000, wallMs: 9000, httpBudget: 1 } },
    }, dw);
    assert.strictEqual(JSON.stringify(upd.updated.limits), JSON.stringify(fresh.res.added.limits));
});

test('an unusable patch is left standing for the validator, never quietly repaired', async () => {
    const { dw, res } = await addCode();
    const upd = await applyToolCall('builder_update_step', {
        stepId: res.added.id, patch: { limits: { cpuMs: 99999 } },
    }, dw);
    assert.ok(!upd.error);
    // Passed through as sent — handing back a number the author never asked
    // for is the failure this whole change exists to end. The save refuses it.
    assert.deepStrictEqual(upd.updated.limits, { cpuMs: 99999 });
    assert.ok(codesOf(dw.def).errors.includes('code.limits_out_of_range'));
});

test('patching limits to null resets the whole block to the sandbox defaults', async () => {
    const { dw, res } = await addCode({ limits: { memoryMb: 256 } });
    const upd = await applyToolCall('builder_update_step', { stepId: res.added.id, patch: { limits: null } }, dw);
    assert.deepStrictEqual(upd.updated.limits, { memoryMb: 64, cpuMs: 1000, wallMs: 5000, httpBudget: 5 });
});

// ─────────────────────────────────────────────────────────────────────
// 6. THE OTHER TWO CONTRACTS execCode READS
// ─────────────────────────────────────────────────────────────────────

test('a step that declares secretKeys is refused at authoring time — it could never run', () => {
    // execCode throws on it outright. Both shapes it reads must be caught, or
    // the check passes on exactly the shape that fails at 03:00.
    for (const inputs of [
        { secretKeys: ['stripe_key'] },
        { secretKeys: { kind: 'literal', value: ['stripe_key'] } },
    ]) {
        const { errors, all } = codesOf(defWithCode({ inputs }));
        assert.ok(errors.includes('code.secret_keys_unsupported'), `got ${errors.join(', ')}`);
        const e = all.find(x => x.code === 'code.secret_keys_unsupported');
        assert.match(e.message, /stripe_key/);
        // One wording, imported from the sandbox, not a fourth copy of it.
        const { SECRETS_NOT_CONFIGURED_MESSAGE } = require('./codeSandbox');
        assert.ok(e.message.endsWith(SECRETS_NOT_CONFIGURED_MESSAGE));
    }
    assert.deepStrictEqual(codesOf(defWithCode({ inputs: { secretKeys: [] } })).errors, [], 'an empty declaration is not a declaration');
});

test('allowedTools that is not a list of names is an error — a bare string becomes a set of LETTERS', () => {
    assert.ok(codesOf(defWithCode({ allowedTools: 'gmail_search' })).errors.includes('code.allowed_tools_shape'));
    assert.ok(codesOf(defWithCode({ allowedTools: [''] })).errors.includes('code.allowed_tools_shape'));
    assert.deepStrictEqual(codesOf(defWithCode({ allowedTools: ['gmail_search'] })).errors, []);
});

test('a tool outside the catalog is a warning, not a refusal — it can only ever narrow the step', () => {
    const opts = { availableTools: new Set(['gmail_search']) };
    const ok = codesOf(defWithCode({ allowedTools: ['gmail_search'] }), opts);
    assert.deepStrictEqual(ok.warnings.filter(c => c === 'code.allowed_tool_unknown'), []);

    const miss = codesOf(defWithCode({ allowedTools: ['slack_post'] }), opts);
    assert.deepStrictEqual(miss.errors, []);
    assert.ok(miss.warnings.includes('code.allowed_tool_unknown'));
    assert.match(miss.all.find(x => x.code === 'code.allowed_tool_unknown').message, /slack_post/);
});
