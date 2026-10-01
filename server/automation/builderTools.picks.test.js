/**
 * The AI builder writes picks and composes (M5), and what it writes holds up:
 * every step builder that stores bindings is driven the way the model drives
 * it — compact picks (`{pick:"steps.x.output.items.email", take:"all"}`) in
 * the bindings, `{{ }}` placeholders and compact composes in the text fields
 * — and the draft it builds
 *
 *   - stores only VALID v1 picks and composes, each pick with a label;
 *   - validates (mappingRules and every other rule): no error, and no
 *     mapping.* warning;
 *   - resolves, through the runtime's own bind.js, against a run whose data
 *     is nested (objects in objects, lists of objects holding lists) to the
 *     values the bindings name.
 *
 * Legacy refs the model still writes are accepted and kept as refs.
 *
 * REGRESSION (confirmed bug "Text mixed with a list or an object renders as
 * raw JSON"): a list placed in a notification body by the AI builder renders
 * as lines of text.
 *
 * Run: cd server && node --test automation/builderTools.picks.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { applyToolCall, emptyDefinition } = require('./builderTools');
const { validateDefinition } = require('./validate');
const { resolveInputs, resolveDeep, resolveValue, interpolateTemplate } = require('./bind');
const { isPick, isCompose, picksIn } = require('../shared/mapping/index.mjs');

const STRING = { type: 'string' };
const SCHEMAS = {
    crm_lookup: { type: 'object', properties: { email: STRING, city: STRING, skus: { type: 'array', items: STRING }, orderCount: { type: 'number' }, firstSku: STRING }, required: ['email'] },
    crm_note: { type: 'object', properties: { contactId: STRING, text: STRING }, required: ['contactId'] },
};
const TABLE = {
    id: 'tbl_klant', key: 'klanten', name: 'Klanten', canWrite: true,
    columns: [{ key: 'naam', name: 'Naam', type: 'text' }, { key: 'plaats', name: 'Plaats', type: 'text' }],
};

function freshWrap() {
    return {
        userId: 'u_test',
        def: emptyDefinition(),
        _inputSchemasByTool: { ...SCHEMAS },
        _availableToolNames: new Set(Object.keys(SCHEMAS)),
        _inspectedTools: new Set(Object.keys(SCHEMAS)),
        _allowedModelTiers: new Set(['auto', 'fast']),
        _datatables: [TABLE],
    };
}

/** The run the bindings resolve against: nested objects, lists of objects holding lists. */
function runStateFor(def, ids) {
    return {
        trigger: {
            output: {
                klant: { naam: 'Jan Jansen', email: 'jan@voorbeeld.nl', adres: { plaats: 'Utrecht', postcode: '3511 AB' } },
                orders: [
                    { nummer: 'A1', lines: [{ sku: 'S-1', aantal: 2 }, { sku: 'S-2', aantal: 1 }] },
                    { nummer: 'A2', lines: [{ sku: 'S-3', aantal: 5 }] },
                ],
            },
        },
        steps: {
            [ids.look]: { status: 'success', output: { contact: { id: 'c-42', name: 'Jan J.' }, tags: ['vip', 'nl'] } },
            [ids.ai]: { status: 'success', output: { digest: 'Twee orders.' } },
        },
        vars: {}, secrets: {}, loop: {},
    };
}

function allPicks(def) {
    return picksIn(def.steps).concat(...Object.values(def.layers || {}).map(l => picksIn(l.steps)));
}

test('every step builder stores valid, labelled picks; the draft validates and resolves against nested data', async () => {
    const dw = freshWrap();
    assert.ok(!(await applyToolCall('builder_propose_trigger', { kind: 'webhook' }, dw)).error);

    const batch = await applyToolCall('builder_add_steps', {
        steps: [
            {
                tempId: 'look', type: 'integration_action', spec: {
                    tool: 'crm_lookup', label: 'Klant opzoeken',
                    inputs: {
                        email: { pick: 'trigger.output.klant.email' },
                        city: { pick: 'trigger.klant.adres.plaats' },             // .output missing: repaired
                        skus: { pick: 'trigger.output.orders.lines.sku', take: 'all' },
                        orderCount: { pick: 'trigger.output.orders', take: 'count' },
                        firstSku: { pick: 'trigger.output.orders[0].lines[0].sku' },
                    },
                },
            },
            {
                tempId: 'ai', type: 'ai_step', spec: {
                    prompt: 'Vat de orders samen: {{orders}}', outputSchema: { digest: 'string' },
                    inputs: { orders: { pick: 'trigger.output.orders', take: 'all' }, naam: { kind: 'ref', path: 'trigger.output.klant.naam' } },
                },
            },
            { tempId: 'note', type: 'integration_action', spec: { tool: 'crm_note', inputs: { contactId: { pick: 'steps.$look.output.contact.id' }, text: { compose: ['Samenvatting: ', { pick: 'steps.$ai.output.digest' }] } } } },
            { tempId: 'set', type: 'set', spec: { fields: { naam: { pick: 'steps.$look.output.contact.name' }, tags: { pick: 'steps.$look.output.tags', take: 'all', as: 'list' } } } },
            { tempId: 'ex', type: 'data_extraction', spec: { source: { pick: 'steps.$ai.output.digest' }, fields: [{ name: 'aantal', type: 'number', description: 'Hoeveel orders' }] } },
            { tempId: 'row', type: 'datatable', spec: { op: 'add_row', datatableId: 'tbl_klant', datatableKey: 'klanten', values: { naam: { pick: 'trigger.output.klant.naam' }, plaats: { pick: 'trigger.output.klant.adres.plaats' } } } },
            { tempId: 'tell', type: 'notification', spec: { title: 'Orders van {{trigger.output.klant.naam}}', body: 'Regels:\n{{trigger.output.orders[*].lines[*].sku}}' } },
        ],
    }, dw);
    assert.ok(!batch.error, batch.error);
    const ids = batch.idMap;

    // A flowlet: its outputs and the call's inputs are picks too.
    const layer = await applyToolCall('builder_create_layer', { title: 'Verrijk', params: [{ name: 'email', type: 'string', required: true }] }, dw);
    const contract = await applyToolCall('builder_set_layer_contract', { layerKey: layer.layerKey, outputs: { email: { pick: 'trigger.output.email' } } }, dw);
    assert.ok(!contract.error, contract.error);
    const call = await applyToolCall('builder_add_call_layer', { layerKey: layer.layerKey, inputs: { email: { pick: 'trigger.output.klant.email' } } }, dw);
    assert.ok(!call.error, call.error);

    // A loop body arrives whole; its bindings and its text fields get the same form.
    const loop = await applyToolCall('builder_add_loop', {
        overRef: 'trigger.output.orders', itemVar: 'o', afterStepId: ids.tell,
        body: [
            { type: 'condition', expr: 'loop.o.nummer == "A1"' },
            { type: 'notification', title: 'Order {{loop.o.nummer}}', body: 'SKU: {{loop.o.lines[*].sku}}' },
        ],
    }, dw);
    assert.ok(!loop.error, loop.error);

    // builder_update_step: a patched binding is a pick like an added one, and
    // a patched text field becomes a compose; the user's other inputs stay.
    const upd = await applyToolCall('builder_update_step', { stepId: ids.look, patch: { inputs: { city: { pick: 'trigger.output.klant.adres.postcode' } } } }, dw);
    assert.ok(!upd.error, upd.error);
    const updTell = await applyToolCall('builder_update_step', { stepId: ids.tell, patch: { title: 'Klant {{trigger.output.klant.naam}}' } }, dw);
    assert.ok(!updTell.error, updTell.error);

    const def = dw.def;
    const byId = Object.fromEntries(def.steps.map(s => [s.id, s]));

    // ── stored: valid v1 picks, each labelled ──
    const picks = allPicks(def);
    assert.ok(picks.length >= 18, `the draft holds the picks (${picks.length})`);
    for (const p of picks) {
        assert.equal(typeof p.label, 'string', `a pick without a label: ${JSON.stringify(p)}`);
        assert.ok(p.label.length > 0);
    }
    const walkBindings = (v, out = []) => {
        if (!v || typeof v !== 'object') return out;
        if (Array.isArray(v)) { v.forEach(x => walkBindings(x, out)); return out; }
        if (v.kind === 'pick' || v.kind === 'compose') { out.push(v); return out; }
        Object.values(v).forEach(x => walkBindings(x, out));
        return out;
    };
    for (const b of walkBindings(def)) assert.ok(isPick(b) || isCompose(b), `an invalid v2 binding was stored: ${JSON.stringify(b)}`);
    const look = byId[ids.look];
    assert.deepEqual(look.inputs.email, { kind: 'pick', v: 1, from: { root: 'trigger', path: ['klant', 'email'] }, take: 'one', as: 'native', label: 'Email' });
    assert.deepEqual(look.inputs.city.from, { root: 'trigger', path: ['klant', 'adres', 'postcode'] }, 'the patch landed');
    assert.deepEqual(look.inputs.skus.from, { root: 'trigger', path: ['orders', 'lines', 'sku'] });
    assert.equal(byId[ids.ai].inputs.naam.kind, 'ref', 'a ref the model wrote stays a ref');
    assert.equal(byId[ids.ai].prompt, 'Vat de orders samen: {{orders}}', 'an ai_step prompt reads its inputs by name and stays a template');
    assert.ok(isCompose(byId[ids.tell].title) && isCompose(byId[ids.tell].body), 'notification texts are composes');
    assert.equal(byId[ids.tell].body.parts[1].take, 'all', 'a [*] placeholder takes all of the list');
    assert.equal(byId[ids.tell].body.parts[1].join, 'lines', 'one per line in a multi-line field');
    const loopStep = def.steps.find(s => s.type === 'loop');
    assert.ok(isCompose(loopStep.body[1].body), 'a loop body step\'s text is a compose');

    // ── validates ──
    const v = validateDefinition(def);
    assert.deepEqual(v.errors, [], JSON.stringify(v.errors));
    assert.deepEqual(v.warnings.filter(w => /^mapping\.|^repeat\./.test(w.code)), [], JSON.stringify(v.warnings));

    // ── resolves against nested data ──
    const state = runStateFor(def, ids);
    assert.deepEqual(resolveInputs(look.inputs, state), {
        email: 'jan@voorbeeld.nl',
        city: '3511 AB',
        skus: ['S-1', 'S-2', 'S-3'],
        orderCount: 2,
        firstSku: 'S-1',
    });
    const ai = resolveInputs(byId[ids.ai].inputs, state);
    assert.equal(ai.orders.length, 2);
    assert.equal(ai.naam, 'Jan Jansen');
    assert.deepEqual(resolveInputs(byId[ids.note].inputs, state), { contactId: 'c-42', text: 'Samenvatting: Twee orders.' });
    assert.deepEqual(resolveDeep(byId[ids.set].fields, state), { naam: 'Jan J.', tags: ['vip', 'nl'] });
    assert.equal(resolveValue(byId[ids.ex].source, state), 'Twee orders.');
    assert.deepEqual(resolveDeep(byId[ids.row].values, state), { naam: 'Jan Jansen', plaats: 'Utrecht' });
    assert.equal(interpolateTemplate(byId[ids.tell].title, state), 'Klant Jan Jansen');
    // REGRESSION: the list reads as lines, not as ["S-1","S-2","S-3"].
    assert.equal(interpolateTemplate(byId[ids.tell].body, state), 'Regels:\nS-1\nS-2\nS-3');
    assert.deepEqual(resolveInputs(byId[call.added.id].inputs, state), { email: 'jan@voorbeeld.nl' });
    const out = def.layers[layer.layerKey].steps.find(s => s.type === 'layer_output');
    assert.deepEqual(resolveDeep(out.fields, { trigger: { output: { email: 'x@y.nl' } }, steps: {} }), { email: 'x@y.nl' });
    const inLoop = { ...state, loop: { o: state.trigger.output.orders[0] } };
    assert.equal(interpolateTemplate(loopStep.body[1].title, inLoop), 'Order A1');
    assert.equal(interpolateTemplate(loopStep.body[1].body, inLoop), 'SKU: S-1\nS-2');
});

test('a forEach step binds its item with a pick: the loop var and the fan-out envelope are checked as for a ref', async () => {
    const dw = freshWrap();
    await applyToolCall('builder_propose_trigger', { kind: 'webhook' }, dw);
    const list = await applyToolCall('builder_add_action', { tool: 'crm_lookup', inputs: { email: { pick: 'trigger.output.email' } } }, dw);
    assert.ok(!list.error, list.error);
    // A pick of an unbound loop var is refused like a ref of one.
    const unbound = await applyToolCall('builder_add_action', { tool: 'crm_note', inputs: { contactId: { pick: 'loop.c.id' } } }, dw);
    assert.match(unbound.error || '', /reads? "loop\.c\.id", but this step has no forEach/);
    const wrongVar = await applyToolCall('builder_add_action', {
        tool: 'crm_note', inputs: { contactId: { pick: 'loop.c.id' } },
        forEach: { overRef: `steps.${list.added.id}.output.contacts`, itemVar: 'x' },
    }, dw);
    assert.match(wrongVar.error || '', /iterates as loop\.x/);
    // With its own forEach it is fine, and a model may give overRef as a pick.
    const each = await applyToolCall('builder_add_action', {
        tool: 'crm_note', inputs: { contactId: { pick: 'loop.c.id' }, text: { compose: ['Hoi ', { pick: 'loop.c.name' }] } },
        forEach: { overRef: { pick: `steps.${list.added.id}.output.contacts` }, itemVar: 'c' },
    }, dw);
    assert.ok(!each.error, each.error);
    assert.equal(each.added.forEach.overRef, `steps.${list.added.id}.output.contacts`);
    assert.deepEqual(each.added.inputs.contactId.from, { root: 'loop', id: 'c', path: ['id'] });
    const v = validateDefinition(dw.def);
    assert.deepEqual(v.errors, [], JSON.stringify(v.errors));
    const state = { trigger: { output: {} }, steps: {}, vars: {}, secrets: {}, loop: { c: { id: 'c-1', name: 'Ada' } } };
    assert.deepEqual(resolveInputs(each.added.inputs, state), { contactId: 'c-1', text: 'Hoi Ada' });

    // Chained fan-out: a pick that skipped the {index, item, output, status}
    // envelope gets the check a ref gets — here the item's own half is not
    // known, so it is named rather than guessed (a data_extraction source,
    // where both halves are known, is repaired: builderTools.test.js).
    const sum = await applyToolCall('builder_add_ai_step', {
        prompt: 'Vat {{c}} samen.', inputs: { c: { pick: 'loop.c.name' } }, outputSchema: { summary: 'string' },
        forEach: { overRef: `steps.${list.added.id}.output.contacts`, itemVar: 'c' },
    }, dw);
    assert.ok(!sum.error, sum.error);
    const chained = await applyToolCall('builder_add_action', {
        tool: 'crm_note', inputs: { contactId: { pick: 'loop.r.item.id' }, text: { pick: 'loop.r.summary' } },
        forEach: { overRef: `steps.${sum.added.id}.output.results`, itemVar: 'r' },
    }, dw);
    assert.ok(!chained.error, chained.error);
    assert.equal(chained.added.inputs.text.kind, 'pick');
    assert.ok((chained._warnings || []).some(w => /^input "text" reads loop\.r\.summary but the forEach item .* is \{index, item, output, status\}; output has: summary/.test(w)), JSON.stringify(chained._warnings));
});

test('a pick whose path reads nothing is refused with the shape to use; a bare trigger field is rooted', async () => {
    const dw = freshWrap();
    await applyToolCall('builder_propose_trigger', { kind: 'app_event', appProvider: 'gmail', appEvent: 'mail.new' }, dw);
    const ok = await applyToolCall('builder_add_action', { tool: 'crm_lookup', inputs: { email: { pick: 'from' } } }, dw);
    assert.ok(!ok.error, ok.error);
    assert.deepEqual(ok.added.inputs.email.from, { root: 'trigger', path: ['from'] }, 'a known trigger field is read from trigger.output');
    const bad = await applyToolCall('builder_add_action', { tool: 'crm_lookup', inputs: { email: { pick: 'nowhere.x' } } }, dw);
    assert.match(bad.error || '', /the pick binding is not valid/);
    assert.match(bad.error || '', /A pick is \{"pick": "steps\.<id>\.output\.<field>"/);
});

test('a $tempId inside a full pick\'s Source is resolved in a batch, like one in a path', async () => {
    const dw = freshWrap();
    await applyToolCall('builder_propose_trigger', { kind: 'webhook' }, dw);
    const r = await applyToolCall('builder_add_steps', {
        steps: [
            { tempId: 'look', type: 'integration_action', spec: { tool: 'crm_lookup', inputs: { email: { pick: 'trigger.output.email' } } } },
            { tempId: 'note', type: 'integration_action', spec: { tool: 'crm_note', inputs: { contactId: { kind: 'pick', v: 1, from: { root: 'steps', id: '$look', path: ['contact', 'id'] }, take: 'one', as: 'native' } } } },
        ],
    }, dw);
    assert.ok(!r.error, r.error);
    const note = dw.def.steps.find(s => s.id === r.idMap.note);
    assert.equal(note.inputs.contactId.from.id, r.idMap.look);
    assert.deepEqual(validateDefinition(dw.def).errors, []);
});

test('removing a step reports the steps whose picks read it', async () => {
    const dw = freshWrap();
    await applyToolCall('builder_propose_trigger', { kind: 'webhook' }, dw);
    const a = await applyToolCall('builder_add_action', { tool: 'crm_lookup', inputs: { email: { pick: 'trigger.output.email' } } }, dw);
    const b = await applyToolCall('builder_add_notification', { title: 'Contact {{steps.' + a.added.id + '.output.contact.name}}' }, dw);
    assert.ok(isCompose(b.added.title));
    const rm = await applyToolCall('builder_remove_step', { stepId: a.added.id }, dw);
    assert.ok(!rm.error, rm.error);
    assert.ok(JSON.stringify(rm).includes(b.added.id), `the dangling reader is named: ${JSON.stringify(rm)}`);
});

test('the step echo names a v2 repeat the way it names a forEach', () => {
    const { summariseDraftSteps } = require('./builderTools/modelPayload');
    const list = summariseDraftSteps({
        trigger: { id: 'trg', kind: 'manual' },
        steps: [{ id: 'a1', type: 'integration_action', tool: 't', repeat: { over: { root: 'steps', id: 's', path: ['rows'] } } }],
        edges: [],
    });
    assert.equal(list.find(x => x.id === 'a1').repeat, 'over steps.s.output.rows');
});

// Review M5a: a path written as text keeps what its `[*]` meant. A Source
// holds no `[*]` (a key on a list maps over it), so these used to lose it.
test('forEach.overRef given as a pick keeps its [*]: the loop reads it with the legacy walk', () => {
    const { sanitizeForEach } = require('./builderTools/bindings');
    const { walkPath } = require('./bind');
    const graph = { trigger: { id: 't', kind: 'manual' }, steps: [{ id: 'x', type: 'integration_action', tool: 'crm_lookup' }], edges: [] };
    const { forEach, error } = sanitizeForEach({ overRef: { pick: 'steps.x.output.results[*].attachments' }, itemVar: 'f' }, graph);
    assert.ok(!error, error);
    assert.equal(forEach.overRef, 'steps.x.output.results[*].attachments');
    const state = { steps: { x: { output: { results: [{ attachments: ['a', 'b'] }, { attachments: ['c'] }] } } } };
    assert.deepEqual(walkPath(forEach.overRef, state), ['a', 'b', 'c']);
    // A spelling the pick repair reads is repaired the same way here.
    assert.equal(sanitizeForEach({ overRef: { pick: 'steps.x.output.items.0.files' }, itemVar: 'f' }, graph).forEach.overRef, 'steps.x.output.items[0].files');
});

test('a data_extraction source given as a bare path reads what the ref read', () => {
    const { sanitizeDataExtractionSource, deriveDataExtractionSource } = require('./builderTools/stepBuilders');
    const draft = { trigger: { id: 't', kind: 'manual' }, steps: [{ id: 'x', type: 'integration_action', tool: 'crm_lookup' }], edges: [] };
    const state = { steps: { x: { output: { items: [{ text: 'aaa' }, { text: 'bbb' }], body: 'hello' } } } };
    const ref = (path) => resolveValue({ kind: 'ref', path }, state);

    const wild = sanitizeDataExtractionSource('steps.x.output.items[*].text', draft).source;
    assert.ok(isPick(wild), JSON.stringify(wild));
    assert.equal(wild.take, 'all');
    assert.deepEqual(resolveValue(wild, state), ref('steps.x.output.items[*].text'));
    assert.deepEqual(resolveValue(wild, state), ['aaa', 'bbb']);

    // `.length` is no key a pick reads: the source stays the ref it was.
    const len = sanitizeDataExtractionSource('steps.x.output.body.length', draft).source;
    assert.deepEqual(len, { kind: 'ref', path: 'steps.x.output.body.length' });
    assert.equal(resolveValue(len, state), 5);

    const plain = sanitizeDataExtractionSource('steps.x.output.body', draft).source;
    assert.ok(isPick(plain));
    assert.equal(resolveValue(plain, state), 'hello');

    // Derived from the one placeholder in the prompt, by the same rule.
    const derived = deriveDataExtractionSource({ promptRefs: ['steps.x.output.items[*].text'] });
    assert.deepEqual(derived.source, { pick: 'steps.x.output.items[*].text', take: 'all' });
    assert.match(derived.note, /source:\{pick:"steps\.x\.output\.items\[\*\]\.text", take:"all"\}/);
    const viaSanitizer = sanitizeDataExtractionSource(derived.source, draft).source;
    assert.deepEqual(resolveValue(viaSanitizer, state), ['aaa', 'bbb']);
    assert.deepEqual(deriveDataExtractionSource({ promptRefs: ['steps.x.output.body.length'] }).source, { kind: 'ref', path: 'steps.x.output.body.length' });
});
