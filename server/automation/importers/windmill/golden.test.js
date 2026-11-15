/**
 * Windmill converter goldens: every fixture in fixtures/ converts to exactly
 * its *.golden.json, and every converted automation passes the import
 * pipeline's own gates (portability.sanitizeImport, rekeyDefinition and the
 * validator at the draft stage) without an error.
 *
 * A golden that changes on purpose is rewritten with
 *   node automation/importers/windmill/regenGolden.mjs
 *
 * Run: cd server && node --test automation/importers/windmill/golden.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const { readFileSync } = require('node:fs');

const { fixtureNames, goldenOf, goldenPath } = require('./goldenFixtures.mjs');
const { sanitizeImport, rekeyDefinition } = require('../../portability');
const { validateDefinition } = require('../../validate');

for (const name of fixtureNames()) {
    test(`${name} converts to its golden file`, async () => {
        const actual = JSON.parse(JSON.stringify(await goldenOf(name)));
        const expected = JSON.parse(readFileSync(goldenPath(name), 'utf8'));
        assert.deepStrictEqual(actual, expected);
    });

    test(`${name} passes the import pipeline without an error`, async () => {
        const golden = await goldenOf(name);
        assert.ok(golden.flows.length > 0, 'at least one flow');
        for (const flow of golden.flows) {
            const envelope = { format: 'beeflow.automation', schemaVersion: 1, automation: { ...flow.automation, definition: flow.definition } };
            const { automation, errors } = sanitizeImport(envelope);
            assert.deepStrictEqual(errors, [], flow.flowPath);
            const { definition } = rekeyDefinition(automation.definition);
            const result = validateDefinition(definition, { stage: 'draft' });
            assert.deepStrictEqual(result.errors.map((e) => `${e.code}: ${e.message}`), [], flow.flowPath);
        }
    });
}

test('every module of every fixture is accounted for in its report', async () => {
    for (const name of fixtureNames()) {
        for (const flow of (await goldenOf(name)).flows) {
            for (const m of flow.report.modules) {
                assert.ok(['mapped', 'pattern', 'shim', 'ai', 'unsupported', 'dropped'].includes(m.status), `${name} ${m.wmId}`);
                assert.ok(m.reason, `${name} ${m.wmId} has a reason`);
            }
            const placeholders = flow.definition.steps.filter((s) => s.type === 'stop_error' && String(s.label).startsWith('Windmill:'));
            for (const p of placeholders) {
                assert.ok(flow.report.aiChecklist.some((a) => a.stepId === p.id), `${name}: placeholder ${p.id} has a checklist item`);
            }
        }
    }
});
