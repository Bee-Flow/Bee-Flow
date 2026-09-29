'use strict';

/**
 * Builder tools — the trace corpus, replayed.
 *
 * Every `traces/*.json` is ONE builder_add_steps call a real model sent and
 * the server rejected, copied verbatim off the rejected-call log line
 * ([AutomationBuilder] rejected <tool> session=<id>: <error> args=<json>).
 * The corpus exists because the fixes in stepBuilders/addSteps were each
 * written for a failure that was measured once and then only remembered in a
 * comment: a later edit could reopen the loop the fix ended and nothing would
 * say so. Replaying the recorded call through today's code, with the same
 * catalog the route attached that turn, is what says so.
 *
 * Fixture shape:
 *   name          — equals the file name (minus .json); the test's name
 *   session       — the builder session the line came from
 *   recordedAt    — when
 *   brief         — the user's brief (Dutch), so the args can be read against
 *                   what was asked
 *   tool, args    — the call, verbatim
 *   rejectedWith  — the error the server gave AT THE TIME (history, not an
 *                   expectation — the expectation is `expect`)
 *   repeats       — how many times the model sent this exact call before it
 *                   moved on; a byte-identical resend is the failure mode
 *                   these fixtures guard against
 *   context       — setup: builder calls that ran first (the trigger)
 *                   inspected: tools the §B3 gate treats as seen
 *                   datatables: a key of traces/_fixtures/datatables.js
 *   expect        — outcome 'applied' | 'rejected', plus per-outcome checks
 *                   (see the assertions below) and `why`: the reasoning in
 *                   one sentence, for the reader, not the test
 *
 * The input schemas come from the DB-free Nextcloud tool definitions; the
 * inspected set, tool availability, datatable catalog and model tiers are
 * the per-turn wrap fields the route sets (see builderTools/inspection.js
 * and stepBuilders.js), so the replay hits the same gates a live turn does.
 *
 * Run: node --test --test-force-exit automation/builderTools/builderTools.traces.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { applyToolCall, emptyDefinition } = require('../builderTools');
const { validateDefinition } = require('../validate');
// integrations/nextcloudTools.js opens a DB on require; toolDefinitions.js is
// the declaration list alone, which is all the inspect gate reads.
const { NEXTCLOUD_TOOLS } = require('../../integrations/nextcloudFiles/toolDefinitions');
const DATATABLES = require('./traces/_fixtures/datatables');

const TRACES_DIR = path.join(__dirname, 'traces');
const OUTCOMES = new Set(['applied', 'rejected']);

const fixtures = fs.readdirSync(TRACES_DIR, { withFileTypes: true })
    .filter(d => d.isFile() && d.name.endsWith('.json') && !d.name.startsWith('_'))
    .map(d => d.name)
    .sort()
    .map(file => ({ file, fixture: JSON.parse(fs.readFileSync(path.join(TRACES_DIR, file), 'utf8')) }));

function inputSchemasByTool() {
    return Object.fromEntries(NEXTCLOUD_TOOLS.map(t => [t.function.name, t.function.parameters]));
}

function wrapFor(fixture) {
    const schemas = inputSchemasByTool();
    return {
        userId: 'u_test',
        def: emptyDefinition(),
        _resultDetail: 'full',
        _inputSchemasByTool: schemas,
        _availableToolNames: new Set(Object.keys(schemas)),
        _inspectedTools: new Set(fixture.context.inspected || []),
        _datatables: DATATABLES[fixture.context.datatables],
        _allowedModelTiers: new Set(['auto', 'fast']),
    };
}

function isPlainObject(v) {
    return !!v && typeof v === 'object' && !Array.isArray(v);
}

test('every fixture parses', () => {
    assert.ok(fixtures.length > 0, 'the corpus is not empty');
    const names = new Set();
    for (const { file, fixture } of fixtures) {
        const at = `traces/${file}`;
        assert.strictEqual(typeof fixture.name, 'string', `${at}: name is a string`);
        assert.strictEqual(`${fixture.name}.json`, file, `${at}: name equals the file name`);
        assert.ok(!names.has(fixture.name), `${at}: name "${fixture.name}" is unique`);
        names.add(fixture.name);
        assert.strictEqual(typeof fixture.session, 'string', `${at}: session is a string`);
        // null is what scripts/builder-trace-from-log.mjs writes when it is run
        // without --brief-file; a fixture without a brief is poorer, not invalid.
        assert.ok(fixture.brief === null || typeof fixture.brief === 'string', `${at}: brief is a string or null`);
        assert.strictEqual(typeof fixture.tool, 'string', `${at}: tool is a string`);
        assert.ok(isPlainObject(fixture.args), `${at}: args is an object`);
        assert.strictEqual(typeof fixture.rejectedWith, 'string', `${at}: rejectedWith is a string`);
        assert.ok(Number.isInteger(fixture.repeats) && fixture.repeats >= 1, `${at}: repeats is a positive integer`);
        assert.ok(isPlainObject(fixture.context), `${at}: context is an object`);
        assert.ok(Array.isArray(fixture.context.setup), `${at}: context.setup is an array`);
        assert.ok(Array.isArray(fixture.context.inspected), `${at}: context.inspected is an array`);
        assert.ok(Array.isArray(DATATABLES[fixture.context.datatables]), `${at}: context.datatables "${fixture.context.datatables}" names a catalog in traces/_fixtures/datatables.js`);
        assert.ok(isPlainObject(fixture.expect), `${at}: expect is an object`);
        assert.ok(OUTCOMES.has(fixture.expect.outcome), `${at}: expect.outcome is applied|rejected`);
        if (fixture.tool === 'builder_add_steps') {
            assert.ok(Array.isArray(fixture.args.steps) && fixture.args.steps.length > 0, `${at}: args.steps is a non-empty array`);
        }
    }
});

for (const { fixture } of fixtures) {
    test(fixture.name, async () => {
        const wrap = wrapFor(fixture);
        for (const call of fixture.context.setup) {
            const s = await applyToolCall(call.tool, structuredClone(call.args), wrap);
            assert.ok(!s.error, `setup ${call.tool} failed: ${s.error}`);
        }
        // structuredClone: the builders repair args in place in places, and the
        // length check below reads the fixture's own copy.
        const r = await applyToolCall(fixture.tool, structuredClone(fixture.args), wrap);
        const expect = fixture.expect;

        if (expect.outcome === 'rejected') {
            assert.ok(r.error, `expected a rejection, got: ${JSON.stringify(r)}`);
            for (const s of expect.errorIncludes || []) {
                assert.ok(r.error.includes(s), `error lacks "${s}":\n${r.error}`);
            }
            for (const k of expect.requires || []) {
                assert.ok(Object.hasOwn(r, k) && r[k] !== undefined, `result lacks "${k}": ${JSON.stringify(r)}`);
            }
            // The doctrine every rejection follows (see applyToolCall): a hint
            // that does not open with the reject reason is the generic
            // "invalid input binding" stamp, or a hint the model cannot act on.
            if (typeof r._fixHint === 'string') {
                assert.ok(r._fixHint.startsWith('Reject reason: '), `_fixHint does not start with "Reject reason: ": ${r._fixHint}`);
            }
            return;
        }

        assert.ok(!r.error, `expected the call to apply, got: ${r.error}\n${r._fixHint || ''}`);
        assert.ok(Array.isArray(r.added), `result carries added[]: ${JSON.stringify(r)}`);
        const sent = Array.isArray(fixture.args.steps) ? fixture.args.steps.length : 1;
        assert.strictEqual(r.added.length, sent, `every entry sent was added (${r.added.length} of ${sent})`);
        const notes = (r._warnings || []).join('\n');

        if (expect.stepTypes) {
            assert.deepStrictEqual(r.added.map(a => a.type), expect.stepTypes, 'step types in order');
        }
        const byId = Object.fromEntries((wrap.def.steps || []).map(s => [s.id, s]));
        for (const a of r.added) assert.ok(byId[a.id], `added ${a.id} is in the draft`);

        if (expect.forEachChain) {
            // Each fan-out step iterates the list the step before it emitted —
            // the chain list → read → extract → save the brief describes. A
            // forEach that points anywhere else is the fan-out mistaken for a
            // chain that the wiring echo exists to prevent.
            for (let k = 1; k < r.added.length; k++) {
                const step = byId[r.added[k].id];
                if (!step.forEach) continue;
                const prev = r.added[k - 1].id;
                assert.ok(
                    typeof step.forEach.overRef === 'string' && step.forEach.overRef.startsWith(`steps.${prev}.output.`),
                    `step ${step.id} iterates ${step.forEach.overRef}, expected steps.${prev}.output.*`,
                );
            }
        }
        if (expect.datatableId !== undefined) {
            const dt = r.added.map(a => byId[a.id]).find(s => s.type === 'datatable');
            assert.ok(dt, 'a datatable step was added');
            assert.strictEqual(dt.datatableId, expect.datatableId, 'the datatable step is bound to the catalog id');
        }
        for (const s of expect.notesInclude || []) {
            assert.ok(notes.includes(s), `_warnings lack "${s}":\n${notes || '(no warnings)'}`);
        }
        if (expect.validates) {
            const v = validateDefinition(wrap.def);
            assert.deepStrictEqual(v.errors, [], `the definition validates: ${JSON.stringify(v.errors)}`);
        }
    });
}
