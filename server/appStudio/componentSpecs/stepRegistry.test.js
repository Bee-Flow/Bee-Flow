// @typecheck
'use strict';

/**
 * The step registry: the base table answers every question for every base kind, the lists
 * derived from it are the lists the code used to spell out, and a kind added as ONE file
 * (the fixtures next to this test, never shipped) reaches every reader without a hand list.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const registry = require('./stepRegistry');
const { BASE_STEP_META, POLICY_FORMS } = require('./stepMeta');
const kinds = require('./actionSpecsActionKinds');
const STEP_SPECS = /** @type {Record<string, any>} */ (require('./actionSpecs').STEP_SPECS);
const { withErrorEnvelope } = require('./stepEnvelope');
const stepFlow = require('../../shared/appDefinition/stepFlow.mjs');
const { EXTENSION_STEP_KINDS } = require('../../shared/appDefinition/stepKinds.generated.mjs');
const { renderStepKindsFile, STEP_KINDS_FILE } = require('../stepKindsGen.mts');
const { flattenSteps } = require('../actionSequence');
const { redactStep } = require('../publicStepRedaction.mts');
const { executeDataStep, fileStepHandler } = require('../actionExecutor/dispatch');
const { summariseSteps } = require('../builderPrompt/summariseSteps.mts');

const FIXTURES = path.join(__dirname, 'stepRegistry.fixtures');
const fixtures = registry.loadStepKindFiles(path.join(FIXTURES, 'steps'));
const fixtureTable = registry.stepMetaTable(fixtures);

// ── The base table ──────────────────────────────────────────────────────────

test('the base table has one row per base kind, in catalogue order', () => {
    assert.deepEqual(Object.keys(BASE_STEP_META), kinds.BASE_STEP_KINDS);
    assert.equal(kinds.BASE_STEP_KINDS.length, 34);
});

test('every kind has an explicit, valid answer for every execution form', () => {
    for (const [kind, meta] of Object.entries(registry.STEP_META)) {
        assert.deepEqual(Object.keys(meta.policy).sort(), Object.keys(POLICY_FORMS).sort(), `${kind}: one value per execution form`);
        for (const [form, values] of Object.entries(POLICY_FORMS)) {
            assert.ok(values.includes(meta.policy[form]), `${kind}: policy.${form} = ${meta.policy[form]}`);
        }
        assert.equal(typeof meta.retrySafe, 'boolean', `${kind}: retrySafe`);
        assert.ok(['client', 'server', 'control'].includes(meta.side), `${kind}: side`);
        if (meta.side === 'server') {
            assert.ok(['ai', 'heavy', 'light'].includes(meta.budget), `${kind}: budget`);
            assert.ok(['builtin', 'file'].includes(meta.handler), `${kind}: handler`);
            assert.notEqual(meta.policy.click, 'browser', `${kind}: a server kind never runs in the browser`);
        } else {
            assert.ok(!['step', 'stream'].includes(meta.policy.click), `${kind}: only a server kind is posted`);
        }
    }
});

test('a kind nobody declared is refused in every execution form', () => {
    for (const form of Object.keys(POLICY_FORMS)) {
        const expected = form === 'mcpDryRun' ? 'skip' : 'refuse';
        for (const kind of ['never_heard_of', 'constructor', '__proto__', '', null, undefined, 7]) {
            assert.equal(registry.stepPolicy(kind, /** @type {any} */ (form)), expected, `${String(kind)} / ${form}`);
        }
    }
    assert.equal(registry.stepMetaOf('toString'), null);
});

test('a row without a form is refused for that form', () => {
    const table = registry.stepMetaTable([]);
    const lists = registry.policyLists({ ...table, half: { side: 'server', retrySafe: true, policy: /** @type {any} */ ({ click: 'step' }) } });
    for (const [name, list] of Object.entries(lists)) {
        if (name === 'retryUnsafeKinds') continue;
        assert.ok(!list.includes('half'), `${name} must not hold a kind without an answer`);
    }
});

// ── One-time equality: the derived lists are the literals the code spelled out ──

const OLD = {
    STEP_KINDS: [
        'navigate', 'toast', 'open_url', 'open_modal', 'close_modal', 'reset_form', 'download_file', 'confirm', 'set_variable', 'refresh',
        'run_automation', 'create_record', 'update_record', 'delete_record', 'request_approval',
        'ai_extract', 'ai_generate', 'kb_query', 'send_email', 'generate_file', 'fill_document', 'generate_presentation', 'redact_pdf', 'file_intake', 'dataset_query', 'ai_browse', 'copy_document', 'kb_log_query', 'kb_log_review',
        'condition', 'loop', 'switch', 'call_action', 'transaction',
    ],
    DATA_MUTATING_STEP_KINDS: ['run_automation', 'create_record', 'update_record', 'delete_record', 'request_approval', 'ai_extract', 'ai_generate', 'kb_query', 'send_email', 'generate_file', 'fill_document', 'generate_presentation', 'redact_pdf', 'file_intake', 'dataset_query', 'ai_browse', 'copy_document', 'kb_log_query', 'kb_log_review', 'transaction'],
    HOOK_STEP_KINDS: [
        'create_record', 'update_record',
        'ai_extract', 'ai_generate', 'kb_query',
        'dataset_query', 'file_intake',
        'generate_file', 'fill_document', 'generate_presentation', 'redact_pdf',
        'transaction',
    ],
    HOOK_CONTROL_KINDS: ['condition', 'switch'],
    BACKGROUND_REFUSED_KINDS: ['navigate', 'open_url', 'open_modal', 'close_modal', 'reset_form', 'download_file', 'ai_browse'],
    BACKGROUND_DEFERRED_KINDS: ['toast', 'refresh'],
    DRY_RUN_KINDS: ['ai_extract', 'ai_generate', 'kb_query', 'dataset_query', 'kb_log_query'],
    MOCKABLE_KINDS: ['ai_extract', 'ai_generate', 'kb_query', 'dataset_query'],
    RECORD_WRITES: ['create_record', 'update_record', 'delete_record'],
    HEAVY_STEP_KINDS: ['run_automation', 'ai_extract', 'ai_generate', 'kb_query', 'send_email', 'generate_file', 'fill_document', 'generate_presentation', 'redact_pdf', 'file_intake', 'copy_document'],
    AI_STEP_KINDS: ['ai_extract', 'ai_generate', 'kb_query', 'redact_pdf'],
    PUBLIC_DENIED_STEP_KINDS: ['kb_log_query', 'kb_log_review'],
    RETRY_UNSAFE_KINDS: ['send_email', 'run_automation', 'request_approval', 'ai_browse', 'copy_document'],
};

test('the kind lists of the catalogue equal the old literals (the registry ships no kind that changes them)', () => {
    const base = registry.extendKindLists(kinds.BASE_STEP_KINDS, kinds.BASE_DATA_MUTATING_STEP_KINDS, []);
    assert.deepEqual(base.STEP_KINDS, OLD.STEP_KINDS);
    assert.deepEqual(base.DATA_MUTATING_STEP_KINDS, OLD.DATA_MUTATING_STEP_KINDS);
    assert.deepEqual(kinds.CLIENT_STEP_KINDS.filter((k) => OLD.STEP_KINDS.includes(k)), OLD.STEP_KINDS.filter((k) => !OLD.DATA_MUTATING_STEP_KINDS.includes(k)));
    // `side` says the same as the server list.
    assert.deepEqual(OLD.STEP_KINDS.filter((k) => BASE_STEP_META[k].side === 'server'), OLD.DATA_MUTATING_STEP_KINDS);
});

test('the policy lists derived from the base table equal the old literals exactly', () => {
    const lists = registry.policyLists(registry.stepMetaTable([]));
    assert.deepEqual([...lists.hookControlKinds], OLD.HOOK_CONTROL_KINDS);
    assert.deepEqual([...lists.backgroundRefusedKinds], OLD.BACKGROUND_REFUSED_KINDS);
    assert.deepEqual([...lists.backgroundDeferredKinds], OLD.BACKGROUND_DEFERRED_KINDS);
    assert.deepEqual([...lists.mcpDryRunKinds], OLD.DRY_RUN_KINDS);
    assert.deepEqual([...lists.mcpMockableKinds], OLD.MOCKABLE_KINDS);
    assert.deepEqual([...lists.recordWriteKinds], OLD.RECORD_WRITES);
    assert.deepEqual([...lists.heavyStepKinds], OLD.HEAVY_STEP_KINDS);
    assert.deepEqual([...lists.aiStepKinds], OLD.AI_STEP_KINDS);
    assert.deepEqual([...lists.publicDeniedKinds], OLD.PUBLIC_DENIED_STEP_KINDS);
    // Membership tests only: these two were never read in order.
    assert.deepEqual([...lists.mcpLiveKinds].sort(), [...OLD.HOOK_STEP_KINDS, 'delete_record'].sort());
    assert.deepEqual([...lists.retryUnsafeKinds].sort(), [...OLD.RETRY_UNSAFE_KINDS].sort());
    assert.deepEqual([...stepFlow.RETRY_UNSAFE_KINDS], OLD.RETRY_UNSAFE_KINDS);
});

test('the exported policy constants equal the old literals, order included', { skip: registry.EXTENSION_STEP_ENTRIES.length > 0 && 'the registry holds kinds; the base equality above still runs' }, () => {
    const hook = require('../mailboxHookPolicy.mts');
    const background = require('../backgroundRunPolicy.mts');
    const mcp = require('../mcpRunActionPolicy.mts');
    const budget = require('../../routes/studioAppStepBudget.mts');
    assert.deepEqual([...hook.HOOK_STEP_KINDS], OLD.HOOK_STEP_KINDS);
    assert.deepEqual([...hook.HOOK_CONTROL_KINDS], OLD.HOOK_CONTROL_KINDS);
    assert.deepEqual([...background.BACKGROUND_REFUSED_KINDS], OLD.BACKGROUND_REFUSED_KINDS);
    assert.deepEqual([...background.BACKGROUND_DEFERRED_KINDS], OLD.BACKGROUND_DEFERRED_KINDS);
    assert.deepEqual([...mcp.MOCKABLE_KINDS], OLD.MOCKABLE_KINDS);
    assert.deepEqual([...mcp.RECORD_WRITES], OLD.RECORD_WRITES);
    assert.deepEqual([...budget.HEAVY_STEP_KINDS], OLD.HEAVY_STEP_KINDS);
    assert.deepEqual([...budget.AI_STEP_KINDS], OLD.AI_STEP_KINDS);
});

test('the flags of the base kinds say what the code did by name', () => {
    const flagged = (/** @type {string} */ flag) => Object.keys(BASE_STEP_META).filter((k) => BASE_STEP_META[k][flag]);
    assert.deepEqual(flagged('noLoop'), ['send_email']);
    assert.deepEqual(flagged('inLoop').sort(), ['fill_document', 'generate_file', 'generate_presentation']);
    assert.deepEqual(flagged('writesVars'), ['set_variable', 'loop']);
    assert.equal(summariseSteps([
        { kind: 'confirm' }, { kind: 'create_record', tableId: 'tbl_x', retry: { times: 2 }, onError: { steps: [] } },
        { kind: 'navigate', screenId: 'scr_a' }, { kind: 'run_automation' }, { kind: 'call_action', actionId: 'act_b' },
        { kind: 'transaction', steps: [{}, {}] }, { kind: 'loop' },
    ]), 'steps[7]{confirm → create_record(tbl_x)↻2!onError → navigate→scr_a → run_automation(null) → call_action→act_b → transaction{2} → …}');
    assert.equal(summariseSteps([{ kind: 'condition' }, { kind: 'delete_record' }, { kind: 'mystery' }, {}]), 'steps[4]{condition{…} → delete_record(?) → mystery → ?}');
});

// ── The shipped registry and its generated projection ───────────────────────

test('the generated step-kind file is what the registry says today', () => {
    assert.equal(fs.readFileSync(STEP_KINDS_FILE, 'utf8'), renderStepKindsFile(), 'run `node server/appStudio/stepKindsGen.mts`, then `npm run gen:shared`');
    assert.deepEqual(EXTENSION_STEP_KINDS, registry.stepFlowProjection(registry.EXTENSION_STEP_ENTRIES));
});

test('every shipped registry kind is new vocabulary: since 3 or later, on its spec entry too', () => {
    for (const entry of registry.EXTENSION_STEP_ENTRIES) {
        assert.ok(entry.since >= 3, entry.kind);
        assert.equal(STEP_SPECS[entry.kind].since, entry.since);
    }
    for (const kind of kinds.BASE_STEP_KINDS) assert.equal(STEP_SPECS[kind].since, undefined, `${kind} is frozen base: no since`);
});

test('no fixture kind is in the shipped catalogue', () => {
    for (const entry of fixtures) {
        assert.ok(!kinds.STEP_KINDS.includes(entry.kind));
        assert.equal(registry.stepMetaOf(entry.kind), null);
        assert.equal(STEP_SPECS[entry.kind], undefined);
    }
    assert.ok(fs.readdirSync(registry.STEPS_DIR).every((f) => !f.startsWith('zz_')));
});

// ── One file is enough (fixture kinds) ──────────────────────────────────────

test('a registry file joins the kind lists after the base kinds', () => {
    assert.deepEqual(fixtures.map((e) => e.kind), ['zz_guarded', 'zz_probe']);
    const lists = registry.extendKindLists(kinds.BASE_STEP_KINDS, kinds.BASE_DATA_MUTATING_STEP_KINDS, fixtures);
    assert.deepEqual(lists.STEP_KINDS, [...OLD.STEP_KINDS, 'zz_guarded', 'zz_probe']);
    assert.deepEqual(lists.DATA_MUTATING_STEP_KINDS, [...OLD.DATA_MUTATING_STEP_KINDS, 'zz_probe']);
    assert.deepEqual(Object.keys(fixtureTable), lists.STEP_KINDS);
});

test('its policy rows put it in the derived lists, and nowhere it did not ask for', () => {
    const lists = registry.policyLists(fixtureTable);
    const holding = (/** @type {string} */ kind) => Object.keys(lists).filter((name) => lists[name].includes(kind)).sort();
    assert.deepEqual(holding('zz_probe'), ['aiStepKinds', 'backgroundRefusedKinds', 'heavyStepKinds', 'hookStepKinds', 'mcpDryRunKinds', 'mcpLiveKinds', 'mcpMockableKinds', 'publicDeniedKinds', 'recordWriteKinds', 'retryUnsafeKinds']);
    assert.deepEqual(holding('zz_guarded'), ['hookControlKinds']);
});

test('its spec entry carries since, and the envelope follows retrySafe', () => {
    const specs = /** @type {Record<string, any>} */ (withErrorEnvelope(registry.stepSpecsOf(fixtures)));
    assert.equal(specs.zz_probe.since, 3);
    assert.equal(specs.zz_probe.mutatesData, true);
    assert.deepEqual(Object.keys(specs.zz_probe.fields), ['tableId', 'input', 'resultVar', 'onError']);
    assert.equal(specs.zz_guarded.mutatesData, false);
    assert.deepEqual(Object.keys(specs.zz_guarded.fields), ['expr', 'body', 'branches', 'note']);
});

test('an incomplete registry file fails the load, with the reason', () => {
    const good = fixtures[1];
    const problems = (/** @type {Record<string, unknown>} */ change, name = 'zz_probe') => registry.stepKindProblems({ ...good, ...change }, name);
    assert.deepEqual(problems({}), []);
    assert.match(problems({ policy: undefined }).join('\n'), /policy/);
    assert.match(problems({ policy: { ...good.policy, unattended: undefined } }).join('\n'), /policy\.unattended/);
    assert.match(problems({ policy: { ...good.policy, mailboxHook: 'maybe' } }).join('\n'), /policy\.mailboxHook/);
    assert.match(problems({ policy: { ...good.policy, webhook: 'run' } }).join('\n'), /policy\.webhook is not an execution form/);
    assert.match(problems({ policy: { ...good.policy, click: 'browser' } }).join('\n'), /cannot run in the browser/);
    assert.match(problems({ since: 2 }).join('\n'), /since/);
    assert.match(problems({ since: undefined }).join('\n'), /since/);
    assert.match(problems({ budget: undefined }).join('\n'), /budget/);
    assert.match(problems({ handler: undefined }).join('\n'), /handler/);
    assert.match(problems({ retrySafe: undefined }).join('\n'), /retrySafe/);
    assert.match(problems({ childSlots: undefined }).join('\n'), /childSlots/);
    assert.match(problems({ kind: 'other' }).join('\n'), /file name/);
    assert.match(problems({ kind: 'toast' }, 'toast').join('\n'), /base step kind/);
    assert.match(problems({ kind: '../x' }, '../x').join('\n'), /file name/);
    // A field that holds steps must be a declared slot; a server kind keeps its children.
    assert.match(problems({ fields: { ...good.fields, body: { type: 'steps' } } }).join('\n'), /"body" holds steps but is not in childSlots/);
    assert.match(problems({ fields: { ...good.fields, body: { type: 'steps' } }, childSlots: [{ field: 'body' }] }).join('\n'), /walked: false/);
    assert.deepEqual(problems({ fields: { ...good.fields, body: { type: 'steps' } }, childSlots: [{ field: 'body', walked: false }] }), []);
    assert.match(registry.stepKindProblems({ ...fixtures[0], budget: 'light' }, 'zz_guarded').join('\n'), /only a server kind/);
    assert.match(registry.stepKindProblems({ ...fixtures[0], policy: { ...fixtures[0].policy, click: 'step' } }, 'zz_guarded').join('\n'), /only a server kind is posted/);
    assert.match(registry.stepKindProblems(null, 'zz_x').join('\n'), /must export an object/);
});

// ── Child slots: one table for ordinals, the walkers and the public redaction ──

const projection = registry.stepFlowProjection(fixtures);
const withFixtures = (/** @type {() => unknown} */ fn) => stepFlow.withExtensionStepKinds(projection, fn);

/** A sequence that uses the container fixture around base kinds. */
function guardedSequence() {
    return [
        { kind: 'toast', message: 'a' },
        {
            kind: 'zz_guarded', expr: 'true', note: 'n',
            body: [{ kind: 'create_record', tableId: 'tbl_secret', values: { a: 1 }, onError: { steps: [{ kind: 'toast', message: 'failed' }] } }, { kind: 'condition', expr: 'x', then: [{ kind: 'send_email', to: 'someone' }] }],
            branches: [{ label: 'one', steps: [{ kind: 'zz_probe', tableId: 'tbl_probe', input: { kind: 'static', value: 'private' }, resultVar: 'probe' }] }, null, { label: 'two' }],
            // Not a slot of the kind: nothing numbers these and no visitor may read them.
            shadow: [{ kind: 'send_email', to: 'hidden@example.org' }],
            nested: { deeper: [{ list: [{ kind: 'update_record', tableId: 'tbl_hidden' }] }] },
        },
        { kind: 'navigate', screenId: 'scr_done' },
    ];
}

test('the projection of the fixtures is what stepFlow reads', () => {
    assert.deepEqual(projection, {
        zz_guarded: { childSlots: [{ field: 'body' }, { field: 'branches', each: 'steps' }], retrySafe: true, server: false },
        zz_probe: { childSlots: [], retrySafe: false, server: true },
    });
    withFixtures(() => {
        assert.deepEqual(stepFlow.childSlotSpecs('zz_guarded'), projection.zz_guarded.childSlots);
        assert.deepEqual(stepFlow.extensionServerKinds(), ['zz_probe']);
        assert.equal(stepFlow.isRetryUnsafeKind('zz_probe'), true);
        assert.deepEqual(stepFlow.retryPlanOf({ kind: 'zz_probe', retry: { times: 3 } }), { times: 0, delayMs: 0 });
        assert.deepEqual(stepFlow.childStepSlots(guardedSequence()[1]).map((s) => s.suffix), ['.body', '.branches[0].steps', '.branches[1].steps', '.branches[2].steps']);
    });
    // Outside the seam nothing of it remains.
    assert.deepEqual(stepFlow.childSlotSpecs('zz_guarded'), []);
    assert.equal(stepFlow.isRetryUnsafeKind('zz_probe'), false);
});

test('flattenSteps numbers the children of a registry container in pre-order, handlers last', () => {
    const order = withFixtures(() => flattenSteps(guardedSequence()).map((s) => s.kind));
    assert.deepEqual(order, ['toast', 'zz_guarded', 'create_record', 'condition', 'send_email', 'zz_probe', 'navigate', 'toast']);
    // Without the registry entry the same tree is one opaque step: no hand list knows the kind.
    assert.deepEqual(flattenSteps(guardedSequence()).map((s) => s.kind), ['toast', 'zz_guarded', 'navigate']);
});

test('flattenSteps numbers the base kinds from the same table as before', () => {
    const steps = /** @type {any[]} */ ([
        { kind: 'loop', steps: [{ kind: 'switch', cases: [null, { steps: [{ kind: 'create_record' }] }, { value: 1 }], default: [{ kind: 'condition', then: [{ kind: 'ai_browse' }], else: [{ kind: 'toast' }] }] }] },
        null, 7, [],
        { kind: 'condition', then: 'x', else: [{ kind: 'send_email' }] },
        { kind: 'transaction', steps: [{ kind: 'create_record' }, { kind: 'delete_record' }], onError: { steps: [{ kind: 'refresh' }] } },
        { kind: 'kb_query', onError: [{ kind: 'confirm', onError: { steps: [{ kind: 'set_variable' }] } }] },
        { kind: 'toast', then: [{ kind: 'navigate' }], steps: [{ kind: 'navigate' }] },
    ]);
    assert.deepEqual(flattenSteps(steps).map((s) => (Array.isArray(s) ? 'array' : s.kind)), [
        'loop', 'switch', 'create_record', 'condition', 'ai_browse', 'toast', 'array', 'condition', 'send_email', 'transaction', 'kb_query', 'toast',
        'refresh', 'confirm', 'set_variable',
    ]);
});

test('the public redaction walks the table: declared slots are redacted in place, anything else that holds steps is dropped', () => {
    const steps = guardedSequence();
    const redacted = withFixtures(() => steps.map(redactStep));
    assert.deepEqual(redacted, [
        { kind: 'toast', message: 'a' },
        {
            kind: 'zz_guarded', expr: 'true', note: 'n',
            body: [{ kind: 'create_record', onError: { steps: [{ kind: 'toast', message: 'failed' }] } }, { kind: 'condition', expr: 'x', then: [{ kind: 'send_email' }] }],
            branches: [{ label: 'one', steps: [{ kind: 'zz_probe', resultVar: 'probe' }] }, null, { label: 'two' }],
        },
        { kind: 'navigate', screenId: 'scr_done' },
    ]);
    // Ordinals survive the redaction step for step.
    withFixtures(() => assert.deepEqual(flattenSteps(redacted).map((s) => s.kind), flattenSteps(steps).map((s) => s.kind)));
    const text = JSON.stringify(redacted);
    for (const secret of ['tbl_secret', 'tbl_probe', 'tbl_hidden', 'hidden@example.org', 'someone', 'private']) assert.ok(!text.includes(secret), secret);
});

test('a kind the table does not know is never a way around the redaction', () => {
    // No registry entry: an unknown kind is reduced like a server step, whatever its fields hold.
    const out = redactStep(guardedSequence()[1]);
    assert.deepEqual(out, { kind: 'zz_guarded' });
    assert.deepEqual(redactStep({ kind: 'not_a_kind', prompt: 'private', resultVar: 'r', onError: [{ kind: 'create_record', tableId: 't' }] }), { kind: 'not_a_kind', resultVar: 'r', onError: [{ kind: 'create_record' }] });
    assert.deepEqual(JSON.parse(JSON.stringify(redactStep({ prompt: 'private' }))), {});
    // The same for a stray step list on a base kind, and for a slot that is not a list.
    assert.deepEqual(redactStep({ kind: 'toast', message: 'm', then: [{ kind: 'send_email', to: 'x' }], extra: [1, 2] }), { kind: 'toast', message: 'm', extra: [1, 2] });
    assert.deepEqual(redactStep({ kind: 'condition', expr: 'a', then: { kind: 'send_email', to: 'x' }, else: 'nope' }), { kind: 'condition', expr: 'a', else: 'nope' });
    assert.deepEqual(redactStep({ kind: 'switch', expr: 'a', cases: [{ value: 1, steps: [{ kind: 'send_email', to: 'x' }], other: [{ kind: 'delete_record', tableId: 't' }] }, [{ kind: 'send_email' }], 3], default: [] }),
        { kind: 'switch', expr: 'a', cases: [{ value: 1, steps: [{ kind: 'send_email' }] }, null, 3], default: [] });
});

test('the public redaction of base kinds is what it was', () => {
    const step = {
        kind: 'condition', expr: 'vars.a', then: [{ kind: 'loop', source: { kind: 'static', value: [] }, steps: [{ kind: 'update_record', tableId: 't', values: { a: 1 }, resultVar: 'r', retry: { times: 2, delayMs: 5 }, onError: [{ kind: 'toast', message: 'x' }] }] }],
        else: [{ kind: 'transaction', steps: [{ kind: 'create_record', tableId: 't' }], resultVar: 'tx', onError: { steps: [{ kind: 'delete_record', tableId: 't' }], stop: true } }],
        onError: { toast: { message: 'kept as written' } },
    };
    assert.deepEqual(redactStep(step), {
        kind: 'condition', expr: 'vars.a',
        then: [{ kind: 'loop', source: { kind: 'static', value: [] }, steps: [{ kind: 'update_record', resultVar: 'r', retry: { times: 2, delayMs: 5 }, onError: [{ kind: 'toast', message: 'x' }] }] }],
        else: [{ kind: 'transaction', resultVar: 'tx', onError: { steps: [{ kind: 'delete_record' }], stop: true } }],
        onError: { toast: { message: 'kept as written' } },
    });
    assert.deepEqual(Object.keys(/** @type {object} */ (redactStep(step))), Object.keys(step));
    assert.equal(redactStep('text'), 'text');
    assert.equal(redactStep(null), null);
});

// ── Dispatch ────────────────────────────────────────────────────────────────

test('a registry kind with a file handler runs its own module', async () => {
    const metaOf = (/** @type {string} */ kind) => (Object.hasOwn(fixtureTable, kind) ? fixtureTable[kind] : null);
    const run = fileStepHandler('zz_probe', metaOf, path.join(FIXTURES, 'handlers'));
    assert.equal(typeof run, 'function');
    assert.deepEqual(await /** @type {Function} */ (run)({ id: 'app_1' }, null, { kind: 'zz_probe', tableId: 'tbl_a' }, { marker: 'm' }), { ok: true, result: { appId: 'app_1', tableId: 'tbl_a', marker: 'm' } });
    // Not a server kind, a base kind, an unknown kind: no file is ever looked for.
    for (const kind of ['zz_guarded', 'create_record', 'toast', 'nope', '../handlers/zz_probe', 'constructor']) {
        assert.equal(fileStepHandler(kind, metaOf, path.join(FIXTURES, 'handlers')), null, kind);
    }
});

test('outside the registry the dispatcher refuses the kind as before', async () => {
    const app = { id: 'app_1', userId: 'u_1' };
    assert.deepEqual(await executeDataStep(app, null, { kind: 'zz_probe', tableId: 't' }, {}), { ok: false, error: 'Step "zz_probe" is not a server step' });
    assert.deepEqual(await executeDataStep(app, null, { kind: 'toast' }, {}), { ok: false, error: 'Step "toast" is not a server step' });
    assert.equal(fileStepHandler('zz_probe'), null);
});
