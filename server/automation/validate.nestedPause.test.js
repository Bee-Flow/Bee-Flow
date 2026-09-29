/**
 * Pause steps nested in a loop body / parallel branch.
 *
 * Run: node --test automation/validate.nestedPause.test.js
 *
 * A step that PAUSES the run resumes by replaying the PARENT graph by step id,
 * and sub-step rows carry a parent_step_id the replay deliberately skips. So a
 * pause inside a body is entered at run time and then never addressable again.
 *
 * validate.js has rejected a nested `form_page` for exactly that reason for a
 * while. `approval` pauses through the identical machinery — execApproval
 * throws ApprovalRequiredError, execFormPage throws FormInputRequiredError, and
 * isRunPause treats the two the same — but had NO equivalent rule: the only
 * approval placement check is the contract-scope one, which inspects top-level
 * steps only. A nested approval therefore saved clean, activated green, paused
 * on the first run and could never be approved.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateDefinition, COMPLETENESS_CODES } = require('./validate');

const trigger = () => ({ id: 'trg', kind: 'manual' });
const approval = (id = 'ap1') => ({ id, type: 'approval', title: 'Sign off', body: 'ok?' });

const codesOf = (r) => [...r.errors, ...r.warnings].map(x => x.code);
const findRec = (r, code) => [...r.errors, ...r.warnings].find(x => x.code === code);

const inLoop = (body) => ({
    trigger: trigger(),
    steps: [{ id: 'lp', type: 'loop', overRef: 'trigger.output.items', itemVar: 'item', maxIterations: 10, body }],
    edges: [{ from: 'trg', to: 'lp' }],
});
const inParallel = (branches) => ({
    trigger: trigger(),
    steps: [{ id: 'par', type: 'parallel', branches }],
    edges: [{ from: 'trg', to: 'par' }],
});

test('an approval inside a loop body cannot be activated — the run would pause unapprovably', () => {
    const r = validateDefinition(inLoop([approval()]));
    assert.equal(r.ok, false);
    const rec = r.errors.find(e => e.code === 'approval.nested_forbidden');
    assert.ok(rec, `expected approval.nested_forbidden, got ${JSON.stringify(codesOf(r))}`);
    assert.match(rec.path, /steps\[lp\]\.body\.steps\[ap1\]/, 'path names loop AND child for the canvas badge');
    assert.match(rec.hint, /Move the approval/);
});

test('…and inside a parallel branch, at any depth', () => {
    const flat = validateDefinition(inParallel([[approval()]]));
    assert.ok(codesOf(flat).includes('approval.nested_forbidden'), JSON.stringify(codesOf(flat)));

    // A loop inside a parallel branch is still a body — the walker recurses.
    const deep = validateDefinition(inParallel([[
        { id: 'lp2', type: 'loop', overRef: 'trigger.output.items', itemVar: 'i', maxIterations: 3, body: [approval('deep')] },
    ]]));
    const rec = deep.errors.find(e => e.code === 'approval.nested_forbidden');
    assert.ok(rec, JSON.stringify(codesOf(deep)));
    assert.match(rec.message, /deep/);
});

test('existing routines that already carry one stay SAVEABLE — draft warns, activation blocks', () => {
    // This validated green until now, so stored definitions can contain it.
    // Blocking the draft save would strand them: the canvas would hold a node
    // the stored definition does not, and the next action fails with
    // `runPartial: step … not found in definition`.
    assert.ok(COMPLETENESS_CODES.has('approval.nested_forbidden'));
    const draft = validateDefinition(inLoop([approval()]), { stage: 'draft' });
    assert.equal(draft.ok, true);
    const warned = draft.warnings.find(w => w.code === 'approval.nested_forbidden');
    assert.ok(warned);
    assert.equal(warned.blockedAt, 'activate');
});

test('a top-level approval is untouched — it is the supported placement', () => {
    const r = validateDefinition({
        trigger: trigger(),
        steps: [approval(), { id: 'n1', type: 'notification', title: 'done', body: 'x', channels: ['notification'] }],
        edges: [{ from: 'trg', to: 'ap1' }, { from: 'ap1', to: 'n1' }],
    });
    assert.equal(findRec(r, 'approval.nested_forbidden'), undefined);
    assert.equal(r.ok, true, JSON.stringify(r.errors));
});

test('form_page keeps its own code and its own (harder) stage posture', () => {
    // The frontend and the existing tests key on `form_page.nested_forbidden`;
    // generalising the rule must not rename or soften it.
    const page = { id: 'fp1', type: 'form_page', mode: 'input', form: { title: 'More', fields: [{ name: 'a', type: 'text', label: 'A' }] } };
    const formTrigger = { id: 'trg', kind: 'form', form: { title: 'Start', fields: [{ name: 'n', type: 'text', label: 'N' }] } };

    const def = { ...inLoop([page]), trigger: formTrigger };
    def.edges = [{ from: 'trg', to: 'lp' }];
    assert.ok(codesOf(validateDefinition(def)).includes('form_page.nested_forbidden'));
    assert.equal(COMPLETENESS_CODES.has('form_page.nested_forbidden'), false, 'still blocks at draft too');
    assert.equal(validateDefinition(def, { stage: 'draft' }).ok, false);
});
