/**
 * Validator rules for the `knowledge_write` step.
 *
 * The two that are safety rather than tidiness:
 *   - a base and some text are BOTH required, but only at activation. A blank
 *     node is the normal state of a draft (the builder PUTs the whole
 *     definition on every edit), so blocking the save is how an afternoon's
 *     work gets lost — and a live automation that stores nothing every night is
 *     the failure nobody notices until an agent cannot answer.
 *   - `nearDuplicateStrategy` is closed. An unrecognised value is NOT a
 *     half-typed field, so it blocks at draft stage too: at run time it would
 *     silently fall through to whatever branch happened to be last.
 *
 * Everything about WHO may write to the base is elsewhere — that needs a
 * database, and this file is the pure pass. See core/kb/automationKbCheck (the
 * route pass, at save and at activate) and core/kb/kbWriteAccess (run time).
 */

const { test } = require('node:test');
const assert = require('node:assert');

const { validateDefinition } = require('./validate');
const { VALID_STEP_TYPES, KNOWLEDGE_WRITE_DUPLICATE_STRATEGIES } = require('./validate/constants');
const { COMPLETENESS_CODES } = require('./validate/completenessCodes');

const TRIGGER = { id: 'trg', kind: 'manual' };

function def(step, extra = {}) {
    return {
        trigger: TRIGGER,
        steps: [{ id: 's1', ...step }],
        edges: [{ from: 'trg', to: 's1' }],
        ...extra,
    };
}
function codesOf(definition, stage) {
    const res = validateDefinition(definition, stage ? { stage } : undefined);
    return [...(res.errors || []), ...(res.warnings || [])].map(e => e.code);
}
function errorCodes(definition, stage) {
    return (validateDefinition(definition, stage ? { stage } : undefined).errors || []).map(e => e.code);
}

const OK = {
    type: 'knowledge_write',
    knowledgeBaseId: 'kb_aaaaaa',
    // Bound to the TRIGGER, so the fixture itself carries no dangling ref —
    // the ref tests below introduce one deliberately.
    content: '{{trigger.output.text}}',
    sourceUri: 'ticket:{{trigger.output.id}}',
    label: 'Save the article',
};

// ── vocabulary ──────────────────────────────────────────────────────────────

test('knowledge_write is a known step type', () => {
    assert.ok(VALID_STEP_TYPES.has('knowledge_write'));
    assert.ok(!codesOf(def(OK)).includes('step.unknown_type'));
});

test('a fully configured write validates at every stage', () => {
    for (const stage of ['draft', 'activate']) {
        assert.deepStrictEqual(errorCodes(def(OK), stage), [], stage);
    }
});

// ── the two blanks ──────────────────────────────────────────────────────────

test('a base is required — a warning while building, an error on activate', () => {
    const d = def({ ...OK, knowledgeBaseId: '' });
    assert.deepStrictEqual(errorCodes(d, 'draft'), [], 'a blank node must stay saveable');
    assert.ok(codesOf(d, 'draft').includes('knowledge_write.kb_required'));
    assert.deepStrictEqual(errorCodes(d, 'activate'), ['knowledge_write.kb_required']);
});

test('content is required, on the same ladder', () => {
    for (const content of [undefined, null, '', '   ']) {
        const d = def({ ...OK, content });
        assert.deepStrictEqual(errorCodes(d, 'draft'), [], JSON.stringify(content));
        assert.ok(errorCodes(d, 'activate').includes('knowledge_write.content_required'), JSON.stringify(content));
    }
});

test('both blanks are completeness codes, so the ladder is not an accident', () => {
    // If either were left off that list it would block the save instead, which
    // is the bug the stage ladder exists to prevent.
    assert.ok(COMPLETENESS_CODES.has('knowledge_write.kb_required'));
    assert.ok(COMPLETENESS_CODES.has('knowledge_write.content_required'));
});

// ── the closed vocabulary ───────────────────────────────────────────────────

test('every declared near-duplicate strategy is accepted', () => {
    for (const s of KNOWLEDGE_WRITE_DUPLICATE_STRATEGIES) {
        assert.deepStrictEqual(errorCodes(def({ ...OK, nearDuplicateStrategy: s }), 'activate'), [], s);
    }
});

test('an unknown strategy blocks at DRAFT stage too', () => {
    // Not a half-typed field: at run time it falls through to a branch nobody
    // chose, so it is wrong the moment it is written.
    const d = def({ ...OK, nearDuplicateStrategy: 'obliterate' });
    assert.deepStrictEqual(errorCodes(d, 'draft'), ['knowledge_write.strategy_invalid']);
    assert.ok(!COMPLETENESS_CODES.has('knowledge_write.strategy_invalid'));
});

test('an omitted strategy is fine — the default is the safe one', () => {
    const { nearDuplicateStrategy, ...rest } = { ...OK, nearDuplicateStrategy: 'skip' };
    assert.deepStrictEqual(errorCodes(def(rest), 'activate'), []);
});

// ── idempotency ─────────────────────────────────────────────────────────────

test('no source reference is a WARNING, never an error', () => {
    // Writing a genuinely new document every run is a real, if rare, intent.
    // The warning says the consequence; it does not refuse.
    const d = def({ ...OK, sourceUri: '' });
    assert.deepStrictEqual(errorCodes(d, 'activate'), []);
    assert.ok(codesOf(d, 'activate').includes('knowledge_write.no_source_uri'));
});

test('a source reference silences the warning', () => {
    assert.ok(!codesOf(def(OK), 'activate').includes('knowledge_write.no_source_uri'));
});

// ── bindings ────────────────────────────────────────────────────────────────

test('a reference to a step that does not exist is caught', () => {
    // Otherwise it resolves to nothing at run time and the step stores an
    // empty document — or, worse, skips and looks like it had nothing to say.
    for (const field of ['content', 'title', 'sourceUri']) {
        const codes = codesOf(def({ ...OK, [field]: '{{steps.nope.output.text}}' }), 'activate');
        assert.ok(codes.some(c => c.startsWith('ref.')), `${field}: ${codes.join(', ')}`);
    }
});

test('a reference to a LATER step is caught, not just an unknown one', () => {
    const d = {
        trigger: TRIGGER,
        steps: [
            { id: 's1', ...OK, content: '{{steps.s2.output.text}}' },
            { id: 's2', type: 'ai_step', prompt: 'write it' },
        ],
        edges: [{ from: 'trg', to: 's1' }, { from: 's1', to: 's2' }],
    };
    assert.ok(codesOf(d, 'activate').some(c => c.startsWith('ref.')));
});

test('a binding OBJECT is understood too — a definition is data', () => {
    const d = def({ ...OK, content: { kind: 'ref', path: 'steps.nope.output.text' } });
    assert.ok(codesOf(d, 'activate').some(c => c.startsWith('ref.')));
});

test('a kind:literal carrying {{…}} is linted, because it ships verbatim', () => {
    const d = def({ ...OK, content: { kind: 'literal', value: 'see {{steps.x.output.text}}' } });
    assert.ok(codesOf(d, 'activate').includes('literal.uninterpolated'));
});

// ── iteration ───────────────────────────────────────────────────────────────

test('forEach is allowed — one article per resolved ticket is the shape', () => {
    const d = {
        trigger: TRIGGER,
        steps: [
            { id: 's0', type: 'ai_step', prompt: 'find them', outputSchema: { type: 'object', properties: { rows: { type: 'array' } } } },
            { id: 's1', ...OK, content: '{{loop.t.article}}', sourceUri: 'ticket:{{loop.t.id}}', forEach: { overRef: 'steps.s0.output.rows', itemVar: 't' } },
        ],
        edges: [{ from: 'trg', to: 's0' }, { from: 's0', to: 's1' }],
    };
    assert.deepStrictEqual(errorCodes(d, 'activate').filter(c => c.startsWith('foreach.')), []);
});

// ── one vocabulary, three places ────────────────────────────────────────
test('the builder catalog, the tool schema and the validator agree on the strategies', () => {
    // Three surfaces name these: the node editor's dropdown (from the builder
    // catalog), the AI builder's tool schema, and this validator. A strategy in
    // one but not another is either a dropdown entry the save refuses or a
    // value the editor can never produce — both silent, both only found by
    // somebody trying it.
    const fs = require('node:fs');
    const path = require('node:path');
    const here = path.resolve(__dirname, '..');

    const catalogSrc = fs.readFileSync(path.join(here, 'routes/automation/catalog.js'), 'utf8');
    const block = catalogSrc.slice(catalogSrc.indexOf('knowledgeWriteStrategies:'));
    const fromCatalog = [...block.slice(0, block.indexOf(']')).matchAll(/value: '([a-z]+)'/g)].map(m => m[1]);
    assert.deepStrictEqual(fromCatalog, [...KNOWLEDGE_WRITE_DUPLICATE_STRATEGIES],
        'the editor dropdown offers exactly what the validator accepts, in the same order');

    const { KB_INGEST_TOOLS } = require('../integrations/kbIngestTools');
    const toolEnum = KB_INGEST_TOOLS[0].function.parameters.properties.nearDuplicateStrategy.enum;
    assert.deepStrictEqual([...toolEnum].sort(), [...KNOWLEDGE_WRITE_DUPLICATE_STRATEGIES].sort(),
        'and the ingest tool implements exactly those');
});
