/**
 * The save-time path checks in referenceScoping (via the shared core's
 * checkRefPath), and the ai_step input-name rule in modelStepRules.
 *
 * The confirmed bugs behind them:
 *   - a path the editor accepts and previews (`items.0.name`) resolved to
 *     undefined at run time, and the validator, which only looked at the
 *     root and the step id, saved it without a word;
 *   - `trigger.subject` (no `.output`) looked like a valid chip and was
 *     undefined at run time; referenceScoping let every trigger.* path pass;
 *   - an ai_step input named `trigger` hid the trigger from its prompt.
 *
 * All of these are WARNINGS with a fix: nothing a stored automation does
 * today may start failing to save.
 *
 * Run: cd server && node --test automation/validate/stepRules/referenceScoping.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateDefinition } = require('../../validate');
const { TRIGGER_RUN_KEYS } = require('../../../shared/mapping/index.mjs');
const { TRIGGER_META_KEYS } = require('../../../core/automationRunner/triggerState');

const GMAIL = { id: 'trg', kind: 'app_event', appEvent: { provider: 'gmail', event: 'mail.new' } };

function def(steps, trigger = GMAIL) {
    const ids = steps.map(s => s.id);
    return {
        trigger,
        steps,
        edges: [{ from: 'trg', to: ids[0] }, ...ids.slice(1).map((id, i) => ({ from: ids[i], to: id }))],
    };
}
const note = (id, body) => ({ id, type: 'notification', title: id, body, channels: ['notification'] });
const set = (id, fields) => ({ id, type: 'set', fields });
const warningsOf = (r, code) => r.warnings.filter(w => w.code === code);

test('a path the run cannot read warns, with the spelling it can', () => {
    const r = validateDefinition(def([
        set('s1', { items: { kind: 'literal', value: [{ name: 'a' }] } }),
        set('s2', {
            a: { kind: 'ref', path: 'steps.s1.output.items.0.name' },
            b: { kind: 'template', value: 'x {{steps.s1.output.items.0.name}} {{trigger.output.body.content-type}}' },
        }),
    ]));
    assert.deepStrictEqual(r.errors, []);
    const w = warningsOf(r, 'ref.path_syntax');
    assert.deepStrictEqual(w.map(x => x.fix), [
        { from: 'steps.s1.output.items.0.name', to: 'steps.s1.output.items[0].name' },
        { from: 'trigger.output.body.content-type', to: 'trigger.output.body["content-type"]' },
    ], 'one warning per path, however often the step repeats it');
    assert.match(w[0].message, /is not a path the run can read/);
    assert.match(w[0].hint, /Write it as "steps\.s1\.output\.items\[0\]\.name"/);
});

test('a placeholder that is no path at all warns without a fix', () => {
    const r = validateDefinition(def([note('n1', 'total {{steps.x + 1}}')]));
    const w = warningsOf(r, 'ref.path_syntax');
    assert.equal(w.length, 1);
    assert.equal(w[0].fix, undefined);
});

test('trigger.<field> without .output warns; trigger metadata does not', () => {
    const r = validateDefinition(def([
        set('s1', {
            a: { kind: 'ref', path: 'trigger.subject' },
            b: { kind: 'ref', path: 'trigger.kind' },
            c: { kind: 'ref', path: 'trigger.output.subject' },
            d: { kind: 'expr', value: 'upper(trigger.from)' },
        }),
    ]));
    assert.deepStrictEqual(r.errors, []);
    const w = warningsOf(r, 'ref.trigger_without_output');
    assert.deepStrictEqual(w.map(x => x.fix), [
        { from: 'trigger.subject', to: 'trigger.output.subject' },
        { from: 'trigger.from', to: 'trigger.output.from' },
    ], 'refs and the paths inside an expr alike');
});

test('a metadata key the trigger payload declares too warns that it reads the metadata', () => {
    // google-sheets spreadsheet.new declares `id`; trigger.id is the trigger
    // node's id at run time, not the spreadsheet's.
    const sheets = { id: 'trg', kind: 'app_event', appEvent: { provider: 'google-sheets', event: 'spreadsheet.new' } };
    const r = validateDefinition(def([set('s1', { a: { kind: 'ref', path: 'trigger.id' }, b: { kind: 'ref', path: 'trigger.kind' } })], sheets));
    assert.deepStrictEqual(r.errors, []);
    const w = warningsOf(r, 'ref.trigger_without_output');
    assert.deepStrictEqual(w.map(x => x.fix), [{ from: 'trigger.id', to: 'trigger.output.id' }], 'kind is not declared by this trigger: plain metadata');
    assert.match(w[0].message, /reads the trigger's own id \(run metadata\), not the "id" field the trigger received/);
    // Gmail declares no `id`: trigger.id stays a quiet metadata read.
    assert.deepStrictEqual(warningsOf(validateDefinition(def([set('s1', { a: { kind: 'ref', path: 'trigger.id' } })])), 'ref.trigger_without_output'), []);
});

test('a condition expression is checked for the same mistakes', () => {
    const r = validateDefinition({
        trigger: GMAIL,
        steps: [{ id: 'c1', type: 'condition', expr: 'trigger.subject == "x"' }, note('yes', 'ok'), note('no', 'ok')],
        edges: [{ from: 'trg', to: 'c1' }, { from: 'c1', to: 'yes', label: 'then' }, { from: 'c1', to: 'no', label: 'else' }],
    });
    assert.deepStrictEqual(warningsOf(r, 'ref.trigger_without_output').map(w => w.fix?.to), ['trigger.output.subject']);
});

test('a field the source is known not to produce warns, with the closest one', () => {
    const r = validateDefinition(def([
        { id: 'ai', type: 'ai_step', prompt: 'p', outputSchema: { type: 'object', properties: { total: { type: 'number' }, vendor: { type: 'string' } } } },
        set('s1', { x: { kind: 'literal', value: 1 } }),
        set('s2', {
            a: { kind: 'ref', path: 'trigger.output.subjet' },
            b: { kind: 'ref', path: 'steps.ai.output.totl' },
            c: { kind: 'ref', path: 'steps.s1.output.y' },
            ok1: { kind: 'ref', path: 'trigger.output.attachments[0].filename' },
            ok2: { kind: 'ref', path: 'steps.ai.output.vendor' },
            ok3: { kind: 'template', value: '{{trigger.output.hasAttachment}} {{steps.s1.output.x}}' },
        }),
    ]));
    assert.deepStrictEqual(r.errors, []);
    const w = warningsOf(r, 'ref.unknown_field');
    assert.deepStrictEqual(w.map(x => [x.message.match(/"([^"]+)" reads/)[1], x.fix?.to]), [
        ['trigger.output.subjet', 'trigger.output.subject'],
        ['steps.ai.output.totl', 'steps.ai.output.total'],
        ['steps.s1.output.y', undefined],
    ]);
    assert.match(w[2].message, /it has: x\)/);
});

test('no unknown_field where the fields are not known', () => {
    const r = validateDefinition(def([
        { id: 'ai', type: 'ai_step', prompt: 'p' },
        { id: 'http', type: 'http_request', method: 'GET', url: 'https://example.org' },
        set('s2', {
            a: { kind: 'ref', path: 'trigger.output.anything' },
            b: { kind: 'ref', path: 'steps.ai.output.whatever' },
            c: { kind: 'ref', path: 'steps.http.output.body' },
        }),
    ], { id: 'trg', kind: 'webhook' }));
    assert.deepStrictEqual(warningsOf(r, 'ref.unknown_field'), []);
});

test('every new check is a warning: the draft and the activation stage both stay clean', () => {
    const d = def([set('s1', { a: { kind: 'ref', path: 'trigger.subject' }, b: { kind: 'ref', path: 'trigger.output.attachments.0.filename' } })]);
    assert.equal(validateDefinition(d).ok, true);
    assert.equal(validateDefinition(d, { stage: 'draft' }).ok, true);
});

test('an ai_step input named after a data root warns', () => {
    const r = validateDefinition(def([
        { id: 'ai', type: 'ai_step', prompt: 'S={{trigger.output.subject}}', inputs: { trigger: { kind: 'literal', value: 'x' }, from: { kind: 'ref', path: 'trigger.output.from' } } },
    ]));
    assert.deepStrictEqual(r.errors, []);
    const w = warningsOf(r, 'ai_step.input_shadows_root');
    assert.equal(w.length, 1);
    assert.match(w[0].path, /\.inputs\.trigger$/);
    assert.match(w[0].message, /"trigger" has the name of a data root/);
});

test('the core\'s trigger run keys are the runner\'s: payload, headers and the metadata', () => {
    assert.deepStrictEqual([...TRIGGER_RUN_KEYS].sort(), ['output', 'headers', ...TRIGGER_META_KEYS].sort());
});
