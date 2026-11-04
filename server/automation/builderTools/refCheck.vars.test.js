/**
 * refCheck at ADD time: a binding to a `vars.<name>` that nothing in the draft
 * sets is refused, with the ways out, so the model repairs it in the same turn
 * (owner report 2026-11-04: an answer check read `vars.prioriteitOpties`, which
 * nothing set, and every run failed). Variables come only from the
 * automation's own `vars` (and a flowlet's); no step writes them
 * (validate/varsWriters.mts).
 *
 * Run: cd server && node --test automation/builderTools/refCheck.vars.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateAndFixBindings } = require('./bindings');
const { applyAddAi } = require('./stepBuilders');

const SCHEMA = { type: 'object', properties: { prioriteit: { type: 'string' } } };
const draft = (more = {}) => ({
    trigger: { id: 'trg', type: 'trigger', kind: 'manual' },
    steps: [{ id: 's1', type: 'set', fields: { opties: { kind: 'literal', value: ['Laag', 'Hoog'] } } }],
    edges: [{ from: 'trg', to: 's1' }],
    ...more,
});

function bind(binding, def = draft(), opts = {}) {
    const r = validateAndFixBindings({ v: binding }, def, { draftWrap: { def }, ...opts });
    return { error: r.error || null, notes: (r.notes || []).join('\n'), inputs: r.inputs };
}

test('a ref, a template placeholder and a list ref to an unset variable are refused with the ways out', () => {
    const ref = bind({ kind: 'ref', path: 'vars.apiBase' });
    assert.match(ref.error, /inputs\.v: "vars\.apiBase" reads vars\.apiBase, which nothing in this automation sets/);
    assert.match(ref.error, /kind:"literal"/);
    assert.match(ref.error, /Edit data \(set\) step before this one/);
    const tpl = bind({ kind: 'template', value: 'Hi {{vars.groet}}' });
    assert.match(tpl.error, /vars\.groet, which nothing in this automation sets/);
    const list = bind({ kind: 'ref', path: 'vars.prioriteitOpties' }, draft(), { wantList: true });
    assert.match(list.error, /every answer would fail its check/);
    assert.match(list.error, /steps\.<that step id>\.output\.<field>/);
});

test('a declared variable (the automation\'s own, or a flowlet\'s) binds as before', () => {
    const def = draft({ vars: { apiBase: 'https://x' }, layers: { f: { vars: { regio: 'eu' }, steps: [], edges: [] } } });
    for (const path of ['vars.apiBase', 'vars.regio']) {
        const r = bind({ kind: 'ref', path }, def);
        assert.equal(r.error, null, path);
        assert.equal(r.notes, '', path);
        assert.equal(r.inputs.v.path, path);
    }
});

test('without a draft to look at nothing is said', () => {
    const r = validateAndFixBindings({ v: { kind: 'ref', path: 'vars.apiBase' } }, draft());
    assert.ok(!r.error);
});

test('builder_add_ai_step with an allowedFrom check on an unset variable is refused and adds nothing; on a set step\'s list it is added', () => {
    const d = draft();
    const refused = applyAddAi(d, {
        prompt: 'Beoordeel deze klacht', outputSchema: SCHEMA, afterStepId: 's1',
        checks: [{ kind: 'allowedFrom', field: 'prioriteit', ref: 'vars.prioriteitOpties' }],
    }, { def: d });
    assert.match(refused.error, /checks\[0\]\.ref: "vars\.prioriteitOpties" reads vars\.prioriteitOpties, which nothing in this automation sets/);
    assert.equal(d.steps.length, 1);

    const ok = applyAddAi(d, {
        prompt: 'Beoordeel deze klacht', outputSchema: SCHEMA, afterStepId: 's1',
        checks: [{ kind: 'allowedFrom', field: 'prioriteit', ref: 'steps.s1.output.opties' }],
    }, { def: d });
    assert.equal(ok.error, undefined, ok.error);
    assert.equal(ok.added.checks[0].ref, 'steps.s1.output.opties');
});
