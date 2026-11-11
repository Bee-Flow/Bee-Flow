/**
 * The `parallel` step kind in the validator, the canonicalizer, the schema version and the
 * readers of an action's step tree. A definition without it validates, canonicalizes and is
 * versioned exactly as before (the compat corpus holds that).
 *
 * Run: cd server && node --test appStudio/validate/parallelChecks.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { validateAppDefinition } = require('../validate');
const { canonicalizeAppDefinition } = require('../canonicalize');
const { SECTION_STYLE_DEFAULTS, LIMITS } = require('../componentSpecs');
const { hookActionProblems, hookAllSteps } = require('../mailboxHookPolicy.mts');
const { automationsInAction } = require('../automationRefs');
const { collectVariableWrites } = require('../collectVariableRefs');
const { countSteps } = require('../actionStepCounts');
const { summariseSteps } = require('../builderPrompt/summariseSteps.mts');
const { redactStep } = require('../publicStepRedaction.mts');
const { repairAction } = require('../builderTools/actionNormalise');
const rules = require('../../shared/appDefinition/parallelRules.mjs');

const codes = (recs, code) => recs.filter((r) => r.code === code);

function app(steps, more = {}) {
    return {
        schemaVersion: 2,
        meta: { name: 'Side by side' },
        theme: {},
        homeScreenId: 'scr_main01',
        variables: [{ name: 'a', type: 'number', default: 0 }, { name: 'b', type: 'number', default: 0 }],
        screens: [{
            id: 'scr_main01', name: 'Home',
            sections: [{ id: 'sec_main01', style: { ...SECTION_STYLE_DEFAULTS }, children: [
                { id: 'cmp_btn001', type: 'button', props: { label: 'Go' }, onClick: 'act_main01' },
            ] }],
        }],
        actions: { act_main01: { kind: 'sequence', steps }, ...more },
    };
}
const validate = (steps, more) => validateAppDefinition(app(steps, more), {});
const setVar = (name, expr) => ({ kind: 'set_variable', name, value: { kind: 'formula', expr } });
const toast = { kind: 'toast', message: 'x', tone: 'info' };
const parallel = (branches, extra = {}) => ({ kind: 'parallel', branches: branches.map((steps) => ({ steps })), ...extra });
const inBranch = (step) => parallel([[toast], [step]]);

const FULL = [
    parallel([[setVar('a', '1'), toast], [{ kind: 'condition', expr: 'vars.b > 0', then: [setVar('b', '2')], else: [] }]], { failFast: true }),
    parallel([[toast]]),
];

test('a parallel step validates clean, and canonicalizes to itself with schemaVersion 3', () => {
    const once = canonicalizeAppDefinition(app(FULL));
    assert.deepEqual(validateAppDefinition(once.def, {}).errors, []);
    assert.deepEqual(validateAppDefinition(once.def, {}).warnings.filter((w) => w.code.startsWith('action.parallel')), []);
    assert.equal(once.def.schemaVersion, 3);
    assert.deepEqual(once.def.actions.act_main01.steps, FULL, 'nothing added, nothing dropped');
    const twice = canonicalizeAppDefinition(JSON.parse(JSON.stringify(once.def)));
    assert.equal(JSON.stringify(twice.def), JSON.stringify(once.def), 'a second pass changes nothing');
});

test('the canonicalizer keeps only the steps of a branch and writes no default', () => {
    const raw = { kind: 'parallel', branches: [{ steps: [toast], label: 'left', value: 1 }, { steps: [] }] };
    const out = canonicalizeAppDefinition(app([raw])).def.actions.act_main01.steps[0];
    assert.deepEqual(out, { kind: 'parallel', branches: [{ steps: [toast] }, { steps: [] }] });
    assert.ok(!('failFast' in out), 'failFast is written only when the step carries it');
});

test('branches must be a list of 1 to the limit of { steps } objects', () => {
    assert.equal(rules.MAX_PARALLEL_BRANCHES, LIMITS.MAX_PARALLEL_BRANCHES);
    assert.equal(codes(validate([{ kind: 'parallel' }]).errors, 'action.step_field_required').length, 1);
    assert.equal(codes(validate([{ kind: 'parallel', branches: 'x' }]).errors, 'action.step_field_invalid').length, 1);
    assert.equal(codes(validate([{ kind: 'parallel', branches: [] }]).errors, 'action.parallel_branch_count').length, 1);
    const many = parallel(Array.from({ length: LIMITS.MAX_PARALLEL_BRANCHES + 1 }, () => [toast]));
    assert.equal(codes(validate([many]).errors, 'action.parallel_branch_count').length, 1);
    assert.equal(codes(validate([parallel(Array.from({ length: LIMITS.MAX_PARALLEL_BRANCHES }, () => [toast]))]).errors, 'action.parallel_branch_count').length, 0);
    const bad = validate([{ kind: 'parallel', branches: [{ steps: [toast] }, 'nope', { steps: 'nope' }] }]).errors;
    assert.deepEqual(codes(bad, 'action.step_field_invalid').map((e) => e.path), ['actions.act_main01.steps[0].branches[1]']);
    assert.deepEqual(codes(bad, 'action.steps_invalid').map((e) => e.path), ['actions.act_main01.steps[0].branches[2].steps']);
});

test('the steps inside a branch are validated like any step, and count toward the action', () => {
    const errors = validate([inBranch({ kind: 'navigate_nowhere' })]).errors;
    assert.ok(errors.some((e) => e.path === 'actions.act_main01.steps[0].branches[1].steps[0].kind' || e.path === 'actions.act_main01.steps[0].branches[1].steps[0]'), JSON.stringify(errors));
    assert.equal(countSteps([inBranch(toast)]), 3);
});

test('the kinds that may not run inside a branch are errors, also behind a condition', () => {
    for (const step of [{ kind: 'navigate', screenId: 'scr_main01' }, { kind: 'confirm', message: 'Sure?' }, { kind: 'open_modal', modalId: 'x' }, { kind: 'transaction', steps: [] }, { kind: 'send_email' }, parallel([[toast]]), { kind: 'return' }]) {
        const direct = codes(validate([inBranch(step)]).errors, 'action.step_in_parallel');
        assert.deepEqual(direct.map((e) => e.path), ['actions.act_main01.steps[0].branches[1].steps'], step.kind);
        assert.ok(direct[0].message.includes(`"${step.kind}"`), step.kind);
        const nested = codes(validate([inBranch({ kind: 'condition', expr: 'true', then: [step], else: [] })]).errors, 'action.step_in_parallel');
        assert.equal(nested.length, 1, `${step.kind} behind a condition`);
    }
    assert.equal(codes(validate([parallel([[toast], [setVar('a', '1')]]), { kind: 'navigate', screenId: 'scr_main01' }, { kind: 'return' }]).errors, 'action.step_in_parallel').length, 0, 'after the step they are fine');
});

test('a forbidden kind in an action a branch calls is an error; a return there is fine', () => {
    const call = { kind: 'call_action', actionId: 'act_sub001' };
    const withNav = { act_sub001: { kind: 'sequence', steps: [{ kind: 'navigate', screenId: 'scr_main01' }] } };
    assert.equal(codes(validate([inBranch(call)], withNav).errors, 'action.step_in_parallel').length, 1);
    const withReturn = { act_sub001: { kind: 'sequence', steps: [toast, { kind: 'return' }] } };
    assert.equal(codes(validate([inBranch(call)], withReturn).errors, 'action.step_in_parallel').length, 0);
});

test('a break in a branch cannot leave a loop around the parallel step', () => {
    const loop = (steps) => ({ kind: 'loop', source: { kind: 'static', value: [1, 2] }, steps });
    const outside = validate([loop([inBranch({ kind: 'break' })])]).errors;
    assert.equal(codes(outside, 'action.step_outside_loop').length, 1);
    const inside = validate([inBranch(loop([{ kind: 'continue' }]))]).errors;
    assert.equal(codes(inside, 'action.step_outside_loop').length, 0);
});

test('two branches writing the same variable is a warning, once per name', () => {
    const ai = (resultVar) => ({ kind: 'set_variable', name: resultVar, value: { kind: 'static', value: 1 } });
    const shared = validate([parallel([[ai('a')], [ai('b'), ai('a')], [ai('a')]])]).warnings;
    const told = codes(shared, 'action.parallel_same_variable');
    assert.equal(told.length, 1);
    assert.equal(told[0].path, 'actions.act_main01.steps[0].branches[1].steps');
    assert.match(told[0].message, /Branches 1 and 2 .*"a"/);
    assert.equal(codes(validate([parallel([[ai('a')], [ai('b')]])]).warnings, 'action.parallel_same_variable').length, 0);
    // A loop's itemVar is restored after the loop: two branches may both call their row "row".
    const loop = (v) => ({ kind: 'loop', source: { kind: 'static', value: [1] }, itemVar: 'row', steps: [ai(v)] });
    assert.equal(codes(validate([parallel([[loop('a')], [loop('b')]])]).warnings, 'action.parallel_same_variable').length, 0);
    // Through a called action too.
    const sub = { act_sub001: { kind: 'sequence', steps: [ai('a')] } };
    assert.equal(codes(validate([parallel([[ai('a')], [{ kind: 'call_action', actionId: 'act_sub001' }]])], sub).warnings, 'action.parallel_same_variable').length, 1);
});

test('a parallel step is refused in a mailbox hook action', () => {
    const problems = hookActionProblems({ kind: 'sequence', steps: [parallel([[toast]])] });
    assert.ok(problems.length > 0, 'the hook policy names it');
});

test('send_email in a branch inside a loop is still the loop\'s mail error', () => {
    const errors = validate([{ kind: 'loop', source: { kind: 'static', value: [1] }, steps: [inBranch({ kind: 'send_email' })] }]).errors;
    assert.equal(codes(errors, 'action.send_email_in_loop').length, 1);
});

test('the readers of a step tree see the steps of a branch', () => {
    const steps = [inBranch({ kind: 'run_automation', automationId: 'auto_branch' }), inBranch({ kind: 'ai_generate', resultVar: 'draft' })];
    const action = { kind: 'sequence', steps };
    assert.deepEqual(automationsInAction(action).ids, ['auto_branch']);
    assert.ok(collectVariableWrites({ actions: { act_a: action } }).names.has('draft'));
    assert.deepEqual(hookAllSteps(action).map((s) => s.kind), ['parallel', 'toast', 'run_automation', 'parallel', 'toast', 'ai_generate']);
    assert.equal(summariseSteps(steps), 'steps[2]{parallel{2} → parallel{2}}');
});

test('the public redaction keeps the branches and reduces their server steps', () => {
    const step = redactStep(inBranch({ kind: 'ai_generate', prompt: { kind: 'static', value: 'secret prompt' }, resultVar: 'draft' }));
    assert.equal(step.kind, 'parallel');
    assert.deepEqual(step.branches.map((b) => b.steps.map((s) => s.kind)), [['toast'], ['ai_generate']]);
    assert.equal(step.branches[1].steps[0].resultVar, 'draft');
    assert.ok(!JSON.stringify(step).includes('secret prompt'));
});

test('the builder\'s action repair walks into the branches', () => {
    const raw = { kind: 'sequence', steps: [parallel([[toast], [{ kind: 'navigate', screenId: { kind: 'static', value: 'scr_main01' } }]])] };
    const { action } = repairAction(raw, {});
    assert.equal(action.steps[0].branches[1].steps[0].screenId, 'scr_main01', 'a step in a branch is repaired like one in a condition branch');
});
