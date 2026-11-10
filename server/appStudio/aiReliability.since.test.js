'use strict';
/**
 * The AI step reliability fields (temperature, checks, repairRounds on ai_generate / ai_extract)
 * as extension entries of the catalogue, in the style of schemaSince.families.test.js: a
 * definition that uses one needs schema version 3 and canonicalize stamps it, one that does not
 * keeps the version it had; the fields are listed in the extension index, served in full by
 * app_inspect_catalog and accepted by the builder tools, while the base catalogue text (and so
 * the pinned prompt bytes) does not mention them.
 *
 * Run: node --test appStudio/aiReliability.since.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { emptyDefinition, SCHEMA_VERSION_BASE } = require('./componentSpecs');
const since = require('./schemaSince.mts');
const { canonicalizeAppDefinition } = require('./canonicalize');
const { extensionItems } = require('./catalogTiers.mts');
const { renderCatalogText, renderCompactCatalogText } = require('./builderPrompt/catalogRender');
const { renderExtensionIndex, gloss, GLOSS_MAX_CHARS } = require('./builderPrompt/extensionIndex.mts');
const { applyInspectCatalog } = require('./builderTools/inspectionTools');
const { applyToolCall } = require('./builderTools');
const { TOOL_SCHEMAS } = require('./builderTools/schemas');

const KINDS = ['ai_generate', 'ai_extract'];
const FIELDS = ['temperature', 'checks', 'repairRounds'];
const CHECKS = [{ kind: 'allowedFrom', field: 'category', ref: 'vars.categories' }];
const VALUES = { temperature: 0.2, checks: CHECKS, repairRounds: 2 };

const generate = (extra = {}) => ({ kind: 'ai_generate', prompt: 'Classify', output: 'structured', schema: [{ name: 'category', type: 'string' }], resultVar: 'r', ...extra });
const extract = (extra = {}) => ({ kind: 'ai_extract', source: { kind: 'formula', expr: 'form.file' }, schema: [{ name: 'category', type: 'string' }], resultVar: 'rows', ...extra });

/** A canonical app with one sequence holding the step, and the step as a bare action. */
function appWith(step) {
    const def = emptyDefinition('Reliability');
    def.actions = { act_seq00001: { kind: 'sequence', steps: [step] }, act_bare0001: { ...step } };
    return def;
}

test('a definition with none of the fields keeps the base version', () => {
    for (const make of [generate, extract]) {
        const out = canonicalizeAppDefinition(appWith(make())).def;
        assert.equal(out.schemaVersion, SCHEMA_VERSION_BASE);
        assert.equal(since.requiredSchemaVersion(out), SCHEMA_VERSION_BASE);
        for (const f of FIELDS) assert.equal(f in out.actions.act_seq00001.steps[0], false, `${f} is not written out`);
    }
});

test('each field, on a step and on a bare action, needs version 3 and canonicalize stamps it', () => {
    for (const make of [generate, extract]) {
        for (const field of FIELDS) {
            for (const where of ['step', 'action']) {
                const def = emptyDefinition('Reliability');
                def.actions = where === 'step'
                    ? { act_seq00001: { kind: 'sequence', steps: [make({ [field]: VALUES[field] })] } }
                    : { act_bare0001: make({ [field]: VALUES[field] }) };
                const what = `${make().kind}.${field} on a ${where}`;
                assert.equal(since.requiredSchemaVersion(def), 3, what);
                const out = canonicalizeAppDefinition(def).def;
                assert.equal(out.schemaVersion, 3, `${what}: canonicalize stamps 3`);
                assert.equal(JSON.stringify(canonicalizeAppDefinition(out).def), JSON.stringify(out), `${what}: a second pass changes nothing`);
            }
        }
    }
});

test('the fields are extension items of both step and action families, each with a gloss that fits', () => {
    const items = extensionItems();
    for (const family of ['stepFields', 'actionFields']) {
        for (const kind of KINDS) {
            for (const field of FIELDS) {
                const item = items.find((i) => i.family === family && i.name === `${kind}.${field}`);
                assert.ok(item, `${family} ${kind}.${field}`);
                const g = gloss(item.description);
                assert.ok(g.length > 20 && g.length <= GLOSS_MAX_CHARS && !g.endsWith('…'), `${kind}.${field}: a whole first sentence (${g})`);
                assert.ok(!item.description.includes(';'), `${kind}.${field}: no ';' in the description`);
            }
        }
    }
    const index = renderExtensionIndex();
    for (const field of FIELDS) assert.ok(index.includes(`ai_generate.${field} — `), `index lists ai_generate.${field}`);
});

test('the base catalogue text, full and compact, does not name the fields', () => {
    for (const text of [renderCatalogText(), renderCompactCatalogText()]) {
        for (const field of FIELDS) assert.ok(!new RegExp(`\\b${field}:`).test(text), field);
    }
});

test('app_inspect_catalog serves the full entry, with the description that teaches the field', () => {
    const r = applyInspectCatalog({ extensions: KINDS.flatMap((k) => FIELDS.map((f) => `${k}.${f}`)) });
    assert.ok(!r.error, JSON.stringify(r));
    for (const kind of KINDS) {
        assert.match(r.extensions[`${kind}.temperature`], /temperature: number .*from 0 to 2/);
        assert.match(r.extensions[`${kind}.checks`], /checks: aiChecks .*allowedFrom.*numbersFrom.*script.*items/);
        assert.match(r.extensions[`${kind}.repairRounds`], /repairRounds: int 0\.\.3 .*only read when the step has checks/);
    }
    const family = applyInspectCatalog({ family: 'stepFields' });
    assert.ok(Object.keys(family.extensions || {}).includes('ai_generate.checks'));
});

test('the builder tools take the fields: app_set_action stores them and the draft becomes version 3', async () => {
    const setAction = TOOL_SCHEMAS.find((t) => t.function.name === 'app_set_action').function.parameters.properties.action;
    assert.notEqual(setAction.additionalProperties, false, 'the action object takes fields beyond its listed properties');
    assert.notEqual(setAction.properties.steps.items.additionalProperties, false, 'so does each step');

    const wrap = { userId: 'u1', orgId: null, appId: null, version: null, builderSessionId: 'bs_test', def: emptyDefinition('Reliability') };
    const seq = await applyToolCall('app_set_action', { action: { kind: 'sequence', steps: [generate(VALUES)] } }, wrap);
    assert.ok(!seq.error, JSON.stringify(seq));
    const bare = await applyToolCall('app_set_action', { action: extract(VALUES) }, wrap);
    assert.ok(!bare.error, JSON.stringify(bare));
    const step = wrap.def.actions[seq.actionId].steps[0];
    for (const s of [step, wrap.def.actions[bare.actionId]]) {
        assert.equal(s.temperature, 0.2);
        assert.deepEqual(s.checks, CHECKS);
        assert.equal(s.repairRounds, 2);
    }
    assert.equal(canonicalizeAppDefinition(wrap.def).def.schemaVersion, 3);
});
