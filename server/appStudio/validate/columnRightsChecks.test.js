/**
 * The validator's advice about column rights (validate/columnRightsChecks.mts): a reference to a
 * field some role may not read or write is a warning that names the roles, never an error, and
 * a model without column rights gets no finding at all.
 *
 * Run: node --test appStudio/validate/columnRightsChecks.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { validateAppDefinition } = require('../validate');
const { buildRestrictedFields } = require('./columnRightsChecks.mts');

const corpus = JSON.parse(fs.readFileSync(path.join(__dirname, '../compat/corpus/column-rights.json'), 'utf8'));
const restricted = (result) => [...result.errors, ...result.warnings].filter((f) => f.code.endsWith('.field_restricted'));

test('the corpus app: the aggregate over the hidden field is advice, with the roles it is refused for', () => {
    const result = validateAppDefinition(corpus.definition, { dataModel: corpus.dataModel });
    assert.deepEqual(result.errors, []);
    const findings = restricted(result);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, 'warning');
    assert.equal(findings[0].code, 'binding.field_restricted');
    assert.match(findings[0].path, /aggregates\[0\]\.field$/);
    assert.match(findings[0].message, /uses field "budget", which "member", "auditor", "public" may not read: for them this whole read is refused/);
});

test('the map: who may not read and who may not write, computed fields following what they name', () => {
    const map = buildRestrictedFields(corpus.dataModel);
    const fields = map.get('tbl_tasks01');
    assert.deepEqual(fields.get('budget'), { read: ['member', 'auditor', 'public'], write: ['member', 'auditor', 'public'] });
    assert.deepEqual(fields.get('review'), { read: ['member', 'public'], write: ['member', 'auditor', 'public'] });
    assert.deepEqual(fields.get('budget_note').read, ['member', 'auditor', 'public']);
    assert.equal(fields.get('title'), undefined);
    assert.equal(fields.get('shout'), undefined);
    assert.equal(map.get('tasks'), fields, 'by key too');
});

test('a step that writes a field some role may not write, and a projection that only leaves it out', () => {
    const def = structuredClone(corpus.definition);
    const list = def.screens[0].sections[0].children.find((n) => n.id === 'cmp_taskl1');
    list.props.source.fields = ['title', 'review'];
    def.actions = { act_setrev1: { kind: 'sequence', steps: [{ kind: 'update_record', tableId: 'tbl_tasks01', recordId: { kind: 'static', value: 'r1' }, values: { review: { kind: 'static', value: 'ok' }, title: { kind: 'static', value: 't' } } }] } };
    const findings = restricted(validateAppDefinition(def, { dataModel: corpus.dataModel }));
    const byCode = (code) => findings.filter((f) => f.code === code);
    assert.equal(byCode('step.field_restricted').length, 1);
    assert.match(byCode('step.field_restricted')[0].message, /writes field "review", which "member", "auditor", "public" may not write/);
    const projected = byCode('binding.field_restricted').find((f) => /fields\[1\]$/.test(f.path));
    assert.match(projected.message, /names field "review", which "member", "public" may not read: it is left out for them/);
});

test('without column rights in the model: no map, no finding, for every corpus app that sets none', () => {
    const dir = path.join(__dirname, '../compat/corpus');
    // The corpus apps of templates built on schema 3 may set column rights (field.access) too.
    const setsRights = (model) => (model?.tables || []).some((t) => (t.fields || []).some((f) => f && f.access));
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.json'))) {
        const app = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
        if (setsRights(app.dataModel)) assert.notEqual(buildRestrictedFields(app.dataModel), null, file);
        else assert.equal(buildRestrictedFields(app.dataModel), null, file);
    }
    assert.equal(buildRestrictedFields(undefined), null);
    assert.equal(buildRestrictedFields(null), null);
});

test('the AI builder: app_upsert_table carries access, keeps it when a field evolves, and null clears it', () => {
    const { buildField } = require('../builderTools/dataToolsFields');
    const { fieldRuleBits } = require('../builderPrompt/computedMarks');
    const model = { tables: [] };
    const access = { read: ['lead'], write: [] };
    const made = buildField({ key: 'budget', type: 'number', access }, null, 'fields[0]', model).field;
    assert.deepEqual(made.access, access);
    assert.deepEqual(fieldRuleBits(made), ['access={"read":["lead"],"write":[]}'], 'app_get_data_model shows it');
    assert.deepEqual(buildField({ key: 'budget', type: 'number' }, made, 'fields[0]', model).field.access, access, 'kept');
    assert.deepEqual(buildField({ key: 'budget', type: 'text' }, made, 'fields[0]', model).field.access, access, 'kept through a type change: the rights are about who');
    assert.equal('access' in buildField({ key: 'budget', type: 'number', access: null }, made, 'fields[0]', model).field, false, 'null clears');
    assert.equal('access' in buildField({ key: 'title', type: 'text' }, null, 'fields[1]', model).field, false, 'never written by default');
});
