/**
 * Validator rules for the reliability settings of an ai_step: temperature,
 * enumFrom (allowed values), checks, fallback, askOnce on an AI step, and
 * forEach.concurrency.
 *
 * What the rules must get right:
 *   - a shape problem points at the field that has it and names what is allowed;
 *   - a check that names a field the step does not answer is a WARNING (the
 *     definition is valid, the check just never finds anything to look at);
 *   - the references the settings read are scoped like every other binding, so a
 *     list that came from a deleted or later step is flagged, and an import
 *     that renames the steps takes them along;
 *   - tools never turn any of this into an error: the checks still apply.
 *
 * Run: cd server && node --test automation/validate.aiStepReliability.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');

const { validateDefinition } = require('./validate');
const { rekeyDefinition } = require('./portability');

const SCHEMA = {
    type: 'object',
    properties: {
        category: { type: 'string' },
        summary: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        count: { type: 'number' },
    },
};

const LIST = { id: 's1', type: 'integration_action', tool: 'gmail_search', inputs: { query: { kind: 'literal', value: 'x' } } };

/** trigger -> s1 (a list source) -> ai (the step under test). */
function def(ai = {}, { steps = [LIST], schema = SCHEMA } = {}) {
    return {
        trigger: { id: 'trg', kind: 'manual' },
        steps: [...steps, { id: 'ai', type: 'ai_step', prompt: 'Pick the category', ...(schema ? { outputSchema: schema } : {}), ...ai }],
        edges: [{ from: 'trg', to: steps[0].id }, ...steps.slice(1).map((s, i) => ({ from: steps[i].id, to: s.id })), { from: steps[steps.length - 1].id, to: 'ai' }],
    };
}

function findings(definition) {
    const res = validateDefinition(definition, {});
    return { errors: res.errors || [], warnings: res.warnings || [] };
}
const codes = (list) => list.map((f) => f.code);
const ofAi = (list) => list.filter((f) => /^(ai_step\.|foreach\.concurrency)/.test(f.code));
const GOOD = {
    temperature: 0.4,
    enumFrom: [{ field: 'category', ref: 'steps.s1.output.rows', value: 'name' }],
    checks: [
        { kind: 'numbersFrom', field: 'summary', ref: 'steps.s1.output.totals' },
        { kind: 'script', field: 'summary', script: 'latin', minRatio: 0.9 },
        { kind: 'items', field: 'tags', minItems: 1, maxItems: 5 },
    ],
    fallback: { kind: 'value', fields: Object.fromEntries(Object.keys(SCHEMA.properties).map((name) => [name, { kind: 'literal', value: name === 'category' ? 'Other' : null }])) },
};

// ── a valid configuration says nothing ───────────────────────────────────────

test('a complete, valid configuration raises no ai_step finding', () => {
    const { errors, warnings } = findings(def(GOOD));
    assert.deepStrictEqual(codes(ofAi(errors)), []);
    assert.deepStrictEqual(codes(ofAi(warnings)).filter((c) => c !== 'ai_step.output_schema_inferred'), []);
});

test('a plain ai_step with none of the settings is untouched', () => {
    const { errors, warnings } = findings(def({}));
    assert.deepStrictEqual(codes(ofAi(errors)), []);
    assert.deepStrictEqual(codes(ofAi(warnings)), []);
});

// ── temperature ──────────────────────────────────────────────────────────────

test('temperature outside 0..2 or not a number is an error at the field', () => {
    for (const temperature of [-0.1, 2.5, 'warm', NaN]) {
        const { errors } = findings(def({ temperature }));
        const hit = errors.find((e) => e.code === 'ai_step.temperature_range');
        assert.ok(hit, `${String(temperature)} must be refused`);
        assert.strictEqual(hit.path, 'steps[ai].temperature');
        assert.match(hit.message, /0 to 2/);
    }
});

test('temperature 0, 1 and 2 are fine; above 1 warns that answers vary more', () => {
    for (const temperature of [0, 1, 2]) {
        assert.ok(!codes(findings(def({ temperature })).errors).includes('ai_step.temperature_range'));
    }
    assert.ok(!codes(findings(def({ temperature: 1 })).warnings).includes('ai_step.temperature_high'));
    const w = findings(def({ temperature: 1.5 })).warnings.find((x) => x.code === 'ai_step.temperature_high');
    assert.ok(w);
    assert.match(w.message, /vary more between runs/);
});

// ── enumFrom ─────────────────────────────────────────────────────────────────

test('enumFrom: every shape problem is an error that names the entry', () => {
    const bad = [
        [{ field: 'a[', ref: 'steps.s1.output.rows' }, 'enumFrom[0].field'],
        [{ field: 'category' }, 'enumFrom[0].ref'],
        [{ field: 'category', ref: 'steps.s1.output.{{x}}' }, 'enumFrom[0].ref'],
        [{ field: 'category', ref: 'steps.s1.output.rows', value: '{{name}}' }, 'enumFrom[0].value'],
        [{ field: 'category', ref: 'steps.s1.output.rows', ignoreCase: 'yes' }, 'enumFrom[0].ignoreCase'],
        ['category', 'enumFrom[0]'],
    ];
    for (const [entry, path] of bad) {
        const { errors } = findings(def({ enumFrom: [entry] }));
        const hit = errors.find((e) => e.code === 'ai_step.enum_from_invalid');
        assert.ok(hit, JSON.stringify(entry));
        assert.strictEqual(hit.path, `steps[ai].${path}`);
        assert.ok(hit.hint);
    }
});

test('enumFrom: not a list, or more than 10 entries', () => {
    assert.ok(codes(findings(def({ enumFrom: { field: 'category' } })).errors).includes('ai_step.enum_from_invalid'));
    const eleven = Array.from({ length: 11 }, (_, i) => ({ field: `f${i}`, ref: 'steps.s1.output.rows' }));
    const hit = findings(def({ enumFrom: eleven })).errors.find((e) => e.code === 'ai_step.enum_from_invalid' && e.path === 'steps[ai].enumFrom');
    assert.ok(hit);
    assert.match(hit.message, /at most 10/);
});

test('enumFrom: a key nothing reads is a warning, two lists for one field too', () => {
    const { warnings, errors } = findings(def({
        enumFrom: [
            { field: 'category', ref: 'steps.s1.output.rows', colour: 'red' },
            { field: 'category', ref: 'steps.s1.output.other' },
        ],
    }));
    assert.deepStrictEqual(codes(ofAi(errors)), []);
    assert.ok(codes(warnings).includes('ai_step.enum_from_key_ignored'));
    assert.ok(codes(warnings).includes('ai_step.enum_from_duplicate_field'));
});

test('a reference root other than trigger/steps/vars/loop is an error, secrets by name', () => {
    for (const ref of ['secrets.api_key', 'item.rows', 'rows']) {
        const hit = findings(def({ enumFrom: [{ field: 'category', ref }] })).errors.find((e) => e.code === 'ai_step.ref_root_invalid');
        assert.ok(hit, ref);
        assert.strictEqual(hit.path, 'steps[ai].enumFrom[0].ref');
    }
    const secret = findings(def({ checks: [{ kind: 'allowedFrom', field: 'category', ref: 'secrets.k' }] })).errors.find((e) => e.code === 'ai_step.ref_root_invalid');
    assert.match(secret.message, /secrets/);
});

// ── checks ───────────────────────────────────────────────────────────────────

test('checks: each kind has its own error, pointing at the key', () => {
    const bad = [
        [{ kind: 'nope', field: 'summary' }, 'checks[0].kind'],
        [{ kind: 'allowedFrom', field: 'category' }, 'checks[0].ref'],
        [{ kind: 'numbersFrom', field: 'summary', ref: 'steps.s1.output.totals', tolerance: -1 }, 'checks[0].tolerance'],
        [{ kind: 'numbersFrom', field: 'summary', ref: 'steps.s1.output.totals', ignoreUpTo: 1.5 }, 'checks[0].ignoreUpTo'],
        [{ kind: 'numbersFrom', field: 'summary', ref: 'steps.s1.output.totals', percent: 'no' }, 'checks[0].percent'],
        [{ kind: 'script', field: 'summary', script: 'klingon' }, 'checks[0].script'],
        [{ kind: 'script', field: 'summary', script: 'latin', minRatio: 2 }, 'checks[0].minRatio'],
        [{ kind: 'items', field: 'tags' }, 'checks[0]'],
        [{ kind: 'items', field: 'tags', minItems: 5, maxItems: 2 }, 'checks[0].minItems'],
        [{ kind: 'items', field: 'tags', minItems: 20000 }, 'checks[0].minItems'],
        [{ kind: 'items', field: 'tags', sameCountAs: 'secrets.list' }, 'checks[0].sameCountAs'],
    ];
    for (const [check, path] of bad) {
        const { errors } = findings(def({ checks: [check] }));
        const hit = errors.find((e) => (e.code === 'ai_step.check_invalid' || e.code === 'ai_step.ref_root_invalid') && e.path === `steps[ai].${path}`);
        assert.ok(hit, `${JSON.stringify(check)} -> ${path}; got ${errors.map((e) => `${e.code}@${e.path}`).join(', ')}`);
    }
});

test('checks: a list over 20 and a key nothing reads', () => {
    const many = Array.from({ length: 21 }, () => ({ kind: 'script', field: 'summary', script: 'latin' }));
    assert.ok(findings(def({ checks: many })).errors.some((e) => e.code === 'ai_step.check_invalid' && e.path === 'steps[ai].checks'));
    const { warnings } = findings(def({ checks: [{ kind: 'script', field: 'summary', script: 'latin', ref: 'steps.s1.output.rows' }] }));
    assert.ok(codes(warnings).includes('ai_step.check_key_ignored'));
});

test('a check that names a field the output does not have is a warning with a pointer to the schema', () => {
    const { errors, warnings } = findings(def({ checks: [{ kind: 'script', field: 'headline', script: 'latin' }] }));
    assert.deepStrictEqual(codes(ofAi(errors)), []);
    const hit = warnings.find((w) => w.code === 'ai_step.check_field_unknown');
    assert.ok(hit);
    assert.strictEqual(hit.path, 'steps[ai].checks[0].field');
    assert.match(hit.message, /headline/);
    assert.match(hit.message, /category/, 'lists the fields it does have');
    assert.match(hit.hint, /Structured output/);
});

test('the first segment decides: nested and list paths into a declared field are fine', () => {
    const { warnings } = findings(def({
        checks: [{ kind: 'items', field: 'tags[]', minItems: 1 }, { kind: 'script', field: 'tags[]', script: 'latin' }],
    }));
    assert.ok(!codes(warnings).includes('ai_step.check_field_unknown'));
});

test('the flat {name: "string"} schema is read too', () => {
    const flat = { category: 'string', count: 'number' };
    assert.ok(!codes(findings(def({ checks: [{ kind: 'script', field: 'category', script: 'latin' }] }, { schema: flat })).warnings).includes('ai_step.check_field_unknown'));
    assert.ok(codes(findings(def({ checks: [{ kind: 'script', field: 'nope', script: 'latin' }] }, { schema: flat })).warnings).includes('ai_step.check_field_unknown'));
});

test('without a declared schema the checks have nothing to look at: one warning, not one per check', () => {
    const { warnings } = findings(def({ checks: [{ kind: 'script', field: 'summary', script: 'latin' }, { kind: 'script', field: 'category', script: 'latin' }] }, { schema: null }));
    assert.strictEqual(warnings.filter((w) => w.code === 'ai_step.checks_without_schema').length, 1);
    assert.ok(!codes(warnings).includes('ai_step.check_field_unknown'));
    const hit = warnings.find((w) => w.code === 'ai_step.checks_without_schema');
    assert.match(hit.message, /named output fields/);
});

test('allowed values are text: an enumFrom on a number field warns', () => {
    const { warnings, errors } = findings(def({ enumFrom: [{ field: 'count', ref: 'steps.s1.output.rows' }, { field: 'tags[]', ref: 'steps.s1.output.rows' }] }));
    assert.deepStrictEqual(codes(ofAi(errors)), []);
    const hits = warnings.filter((w) => w.code === 'ai_step.enum_from_type');
    assert.strictEqual(hits.length, 1, 'the list of text (tags[]) is fine');
    assert.strictEqual(hits[0].path, 'steps[ai].enumFrom[0].field');
});

// ── fallback ─────────────────────────────────────────────────────────────────

test('fallback: an empty field map, a bad kind and a non-binding are errors', () => {
    const cases = [
        [{ kind: 'value', fields: {} }, 'fallback.fields'],
        [{ kind: 'value' }, 'fallback.fields'],
        [{ kind: 'maybe' }, 'fallback.kind'],
        [{ kind: 'value', fields: { category: 'Other' } }, 'fallback.fields.category'],
        [{ kind: 'value', fields: { 'a.b': { kind: 'literal', value: 1 } } }, 'fallback.fields.a.b'],
        ['fail', 'fallback'],
    ];
    for (const [fallback, path] of cases) {
        const hit = findings(def({ fallback })).errors.find((e) => e.code === 'ai_step.fallback_invalid');
        assert.ok(hit, JSON.stringify(fallback));
        assert.strictEqual(hit.path, `steps[ai].${path}`);
    }
});

test('fallback {kind:"fail"} is valid; a value that fills a field the output lacks warns', () => {
    const ok = findings(def({ fallback: { kind: 'fail' } }));
    assert.deepStrictEqual(codes(ofAi(ok.errors)), []);
    const { warnings } = findings(def({ fallback: { kind: 'value', fields: { label: { kind: 'literal', value: 'x' } } } }));
    const hit = warnings.find((w) => w.code === 'ai_step.fallback_field_unknown');
    assert.ok(hit);
    assert.strictEqual(hit.path, 'steps[ai].fallback.fields.label');
});

test('a value fallback that leaves out declared output fields warns, naming them', () => {
    const { warnings } = findings(def({ fallback: { kind: 'value', fields: { category: { kind: 'literal', value: 'Other' } } } }));
    const hit = warnings.find((w) => w.code === 'ai_step.fallback_fields_missing');
    assert.ok(hit);
    assert.strictEqual(hit.path, 'steps[ai].fallback.fields');
    assert.match(hit.message, /"summary"/);
    assert.doesNotMatch(hit.message, /"category"/);
});

test('a value fallback that covers every declared field raises no missing-fields warning', () => {
    const fields = Object.fromEntries(Object.keys(SCHEMA.properties).map((name) => [name, { kind: 'literal', value: null }]));
    const { warnings } = findings(def({ fallback: { kind: 'value', fields } }));
    assert.deepStrictEqual(codes(warnings).filter((c) => c === 'ai_step.fallback_fields_missing'), []);
});

// ── tools do not turn it into an error ───────────────────────────────────────

test('settings on a step that may call tools are fine: the checks still apply', () => {
    const { errors } = findings(def({ ...GOOD, allowTools: true, tools: ['gmail_search'] }));
    assert.deepStrictEqual(codes(ofAi(errors)), []);
});

// ── loop references ──────────────────────────────────────────────────────────

test('loop. with no forEach and no loop around is a warning in plain words', () => {
    const { warnings } = findings(def({ enumFrom: [{ field: 'category', ref: 'loop.batch' }] }));
    const hit = warnings.find((w) => w.code === 'ai_step.loop_ref_unbound');
    assert.ok(hit);
    assert.strictEqual(hit.path, 'steps[ai].enumFrom[0].ref');
});

test('loop. is fine on a step that runs once per item, and inside a loop body', () => {
    const perItem = findings(def({
        forEach: { overRef: 'steps.s1.output.results', itemVar: 'batch' },
        enumFrom: [{ field: 'category', ref: 'loop.batch.options' }],
    }));
    assert.ok(!codes(perItem.warnings).includes('ai_step.loop_ref_unbound'));
    assert.ok(!codes(perItem.errors).includes('ref.loop_unbound'));

    const inLoop = findings({
        trigger: { id: 'trg', kind: 'manual' },
        steps: [LIST, {
            id: 'lp', type: 'loop', overRef: 'steps.s1.output.results', itemVar: 'batch', maxIterations: 5,
            body: [{ id: 'in', type: 'ai_step', prompt: 'p', outputSchema: SCHEMA, enumFrom: [{ field: 'category', ref: 'loop.batch.options' }] }],
        }],
        edges: [{ from: 'trg', to: 's1' }, { from: 's1', to: 'lp' }],
    });
    assert.ok(!codes(inLoop.warnings).includes('ai_step.loop_ref_unbound'));
    assert.ok(!codes(inLoop.errors).includes('ref.loop_unbound'));
});

// ── nested steps are checked like top-level ones ─────────────────────────────

test('a step in a loop body gets the same rules', () => {
    const { errors, warnings } = findings({
        trigger: { id: 'trg', kind: 'manual' },
        steps: [LIST, {
            id: 'lp', type: 'loop', overRef: 'steps.s1.output.results', itemVar: 'row', maxIterations: 5,
            body: [{ id: 'in', type: 'ai_step', prompt: 'p', outputSchema: SCHEMA, temperature: 9, checks: [{ kind: 'script', field: 'nope', script: 'latin' }] }],
        }],
        edges: [{ from: 'trg', to: 's1' }, { from: 's1', to: 'lp' }],
    });
    const err = errors.find((e) => e.code === 'ai_step.temperature_range');
    assert.ok(err, 'temperature checked inside the body');
    assert.strictEqual(err.path, 'steps[lp].body.steps[in].temperature');
    assert.ok(codes(warnings).includes('ai_step.check_field_unknown'));
});

// ── references are scoped like every other binding ───────────────────────────

test('a list from a step that does not exist is flagged, wherever the settings read it', () => {
    const { errors } = findings(def({
        enumFrom: [{ field: 'category', ref: 'steps.ghost.output.rows' }],
        checks: [{ kind: 'allowedFrom', field: 'category', ref: 'steps.ghost2.output.rows' }, { kind: 'items', field: 'tags', sameCountAs: 'steps.ghost3.output.rows' }],
        fallback: { kind: 'value', fields: { category: { kind: 'ref', path: 'steps.ghost4.output.value' } } },
    }));
    const unknown = errors.filter((e) => e.code === 'ref.unknown_step').map((e) => e.message).join(' | ');
    for (const id of ['ghost', 'ghost2', 'ghost3', 'ghost4']) assert.match(unknown, new RegExp(`"${id}"`), id);
});

test('a list from a step further down the flow warns that it has not run yet', () => {
    const later = { id: 'late', type: 'integration_action', tool: 'gmail_search', inputs: { query: { kind: 'literal', value: 'y' } } };
    const definition = def({ enumFrom: [{ field: 'category', ref: 'steps.late.output.rows' }] });
    definition.steps.push(later);
    definition.edges.push({ from: 'ai', to: 'late' });
    const { warnings } = findings(definition);
    assert.ok(warnings.some((w) => w.code === 'ref.forward' && /late/.test(w.message)));
});

test('an import that renames the steps takes the settings along', () => {
    const original = def({ ...GOOD, fallback: { kind: 'value', fields: { category: { kind: 'ref', path: 'steps.s1.output.first' } } }, checks: [...GOOD.checks, { kind: 'items', field: 'tags', sameCountAs: 'steps.s1.output.rows' }] });
    const { definition, renameMap } = rekeyDefinition(structuredClone(original));
    const newId = renameMap.root.s1;
    assert.ok(newId && newId !== 's1');
    const ai = definition.steps.find((s) => s.type === 'ai_step');
    assert.strictEqual(ai.enumFrom[0].ref, `steps.${newId}.output.rows`);
    assert.strictEqual(ai.checks[0].ref, `steps.${newId}.output.totals`);
    assert.strictEqual(ai.checks[3].sameCountAs, `steps.${newId}.output.rows`);
    assert.deepStrictEqual(ai.fallback.fields.category, { kind: 'ref', path: `steps.${newId}.output.first` });
    assert.strictEqual(ai.enumFrom[0].value, 'name', 'an item path is not a step id');
    assert.ok(!codes(findings(definition).errors).includes('ref.unknown_step'), 'the renamed definition still resolves');
});

// ── forEach.concurrency ──────────────────────────────────────────────────────

const withConcurrency = (concurrency, ai = {}) => def({ forEach: { overRef: 'steps.s1.output.results', itemVar: 'r', concurrency }, ...ai });

test('forEach.concurrency must be a whole number from 1 to 1000', () => {
    for (const c of [0, -1, 1001, 2.5, '4', NaN]) {
        const hit = findings(withConcurrency(c)).errors.find((e) => e.code === 'foreach.concurrency_range');
        assert.ok(hit, String(c));
        assert.strictEqual(hit.path, 'steps[ai].forEach.concurrency');
    }
    for (const c of [1, 4, 1000]) {
        const { errors, warnings } = findings(withConcurrency(c));
        assert.ok(!codes(errors).includes('foreach.concurrency_range'), String(c));
        assert.ok(!codes(warnings).includes('foreach.concurrency_ignored'), `${c} on an AI step without tools is honoured`);
    }
});

test('forEach.concurrency on data extraction is honoured', () => {
    const definition = {
        trigger: { id: 'trg', kind: 'manual' },
        steps: [LIST, { id: 'ex', type: 'data_extraction', source: { kind: 'ref', path: 'loop.r.snippet' }, fields: [{ name: 'vendor', type: 'string', description: 'Supplier' }], forEach: { overRef: 'steps.s1.output.results', itemVar: 'r', concurrency: 3 } }],
        edges: [{ from: 'trg', to: 's1' }, { from: 's1', to: 'ex' }],
    };
    const { errors, warnings } = findings(definition);
    assert.ok(!codes(errors).includes('foreach.concurrency_range'));
    assert.ok(!codes(warnings).includes('foreach.concurrency_ignored'));
});

test('forEach.concurrency that does nothing is a warning, never silent', () => {
    const tools = findings(withConcurrency(4, { allowTools: true, tools: ['gmail_search'] })).warnings.find((w) => w.code === 'foreach.concurrency_ignored');
    assert.ok(tools, 'an AI step that may call tools');
    assert.match(tools.message, /one item at a time/);
    assert.match(tools.message, /tool may change things/);

    const agent = findings(withConcurrency(4, { agentId: 'agt_1', agentPermissions: { useTools: true } })).warnings;
    assert.ok(codes(agent).includes('foreach.concurrency_ignored'), 'an agent that may use its tools');

    const skills = findings(withConcurrency(4, { skillIds: ['sk_1'] })).warnings;
    assert.ok(codes(skills).includes('foreach.concurrency_ignored'), 'a skill counts as a tool, as at run time');
    const starts = findings(withConcurrency(4, { agentId: 'agt_1', agentPermissions: { startAutomations: true } })).warnings;
    assert.ok(codes(starts).includes('foreach.concurrency_ignored'), 'an agent that may start automations');

    const code = {
        trigger: { id: 'trg', kind: 'manual' },
        steps: [LIST, { id: 'c', type: 'code', code: 'return {}', forEach: { overRef: 'steps.s1.output.results', itemVar: 'r', concurrency: 4 } }],
        edges: [{ from: 'trg', to: 's1' }, { from: 's1', to: 'c' }],
    };
    assert.ok(codes(findings(code).warnings).includes('foreach.concurrency_ignored'), 'a code step runs one item at a time');
});

test('forEach.concurrency on an app action is flagged as ignored: the runner sets its own pace', () => {
    const definition = {
        trigger: { id: 'trg', kind: 'manual' },
        steps: [LIST, { id: 'a2', type: 'integration_action', tool: 'gmail_search', inputs: { query: { kind: 'ref', path: 'loop.r.subject' } }, forEach: { overRef: 'steps.s1.output.results', itemVar: 'r', concurrency: 4 } }],
        edges: [{ from: 'trg', to: 's1' }, { from: 's1', to: 'a2' }],
    };
    const { errors, warnings } = findings(definition);
    assert.ok(!codes(errors).includes('foreach.concurrency_range'));
    const hit = warnings.find((w) => w.code === 'foreach.concurrency_ignored');
    assert.ok(hit);
    assert.strictEqual(hit.path, 'steps[a2].forEach.concurrency');
});

// ── askOnce on an AI step ────────────────────────────────────────────────────

test('askOnce on an AI step is a reader now: no "does nothing" warning', () => {
    for (const askOnce of [true, { ttlSeconds: 60 }, {}]) {
        const { errors, warnings } = findings(def({ askOnce }));
        assert.deepStrictEqual(codes(errors).filter((c) => c.startsWith('ai_step.ask_once')), []);
        assert.deepStrictEqual(codes(warnings).filter((c) => c.startsWith('ai_step.ask_once') || c.endsWith('ask_once_unsupported')), []);
    }
});

test('askOnce on an AI step that may call tools warns that nothing is reused', () => {
    const { warnings, errors } = findings(def({ askOnce: true, allowTools: true, tools: ['gmail_search'] }));
    const hit = warnings.find((w) => w.code === 'ai_step.ask_once_with_tools');
    assert.ok(hit);
    assert.match(hit.message, /not reused when the step may call tools/);
    assert.deepStrictEqual(codes(errors).filter((c) => c.startsWith('ai_step.ask_once')), []);
    const viaAgent = findings(def({ askOnce: true, agentId: 'agt_1', agentPermissions: { useTools: true } })).warnings;
    assert.ok(codes(viaAgent).includes('ai_step.ask_once_with_tools'));
    const viaSkill = findings(def({ askOnce: true, skillIds: ['sk_1'] })).warnings;
    assert.ok(codes(viaSkill).includes('ai_step.ask_once_with_tools'), 'a skill counts as a tool');
    const noTools = findings(def({ askOnce: true, allowTools: false, tools: [] })).warnings;
    assert.ok(!codes(noTools).includes('ai_step.ask_once_with_tools'));
});

test('askOnce on an AI step: the ttl range and the across-runs type are errors', () => {
    for (const ttlSeconds of [0, 901, -5, 'soon']) {
        assert.ok(codes(findings(def({ askOnce: { ttlSeconds } })).errors).includes('ai_step.ask_once_ttl_range'), String(ttlSeconds));
    }
    for (const ttlSeconds of [1, 900, 60]) {
        assert.ok(!codes(findings(def({ askOnce: { ttlSeconds } })).errors).includes('ai_step.ask_once_ttl_range'), String(ttlSeconds));
    }
    assert.ok(codes(findings(def({ askOnce: { acrossRuns: 'yes' } })).errors).includes('ai_step.ask_once_across_runs_type'));
});

test('askOnce across runs on an AI step says it depends on the organisation setting', () => {
    const { warnings, errors } = findings(def({ askOnce: { acrossRuns: true } }));
    const hit = warnings.find((w) => w.code === 'ai_step.ask_once_across_runs_org_gated');
    assert.ok(hit);
    assert.match(hit.message, /organisation allows it under "Answers from AI steps"/);
    assert.deepStrictEqual(codes(errors).filter((c) => c.startsWith('ai_step.ask_once')), []);
    assert.ok(!codes(findings(def({ askOnce: { acrossRuns: false } })).warnings).includes('ai_step.ask_once_across_runs_org_gated'));
});

test('askOnce still does nothing on a step the runner never reads it on', () => {
    const definition = {
        trigger: { id: 'trg', kind: 'manual' },
        steps: [{ id: 'c', type: 'code', code: 'return {}', askOnce: true }],
        edges: [{ from: 'trg', to: 'c' }],
    };
    assert.ok(codes(findings(definition).warnings).includes('code.ask_once_unsupported'));
});
