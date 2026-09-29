/**
 * Routines over MCP — a partial builder_add_steps persists its built prefix.
 *
 * addSteps.js's partial result promises "Entries 0..i-1 are built … and stay
 * built". On this surface the draftWrap is rebuilt from the store on every
 * call, so "stay built" means "were written": reproduced 2026-09-13, the
 * persist was gated on `!result.error`, the prefix was never written, and the
 * next call — obeying resendAs — wired a step from an id that did not exist.
 *
 * persistDraft is stubbed through require.cache (the way execDatatable.test.js
 * stubs its stores) so no database is touched; the store's getAutomation is
 * patched the way mcpBuilder.test.js patches getAutomationsForUser.
 *
 * Run: cd server && node --test --test-force-exit automation/mcpBuilder.partialBatch.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const persisted = [];
const persistencePath = require.resolve(path.join(__dirname, 'builderTools', 'persistence.js'));
require.cache[persistencePath] = {
    id: persistencePath, filename: persistencePath, loaded: true, children: [], paths: [],
    exports: {
        persistDraft: async (draftWrap) => {
            persisted.push({ definition: structuredClone(draftWrap.def), automationId: draftWrap.automationId });
            return { id: draftWrap.automationId || 'auto_1', title: draftWrap.title };
        },
    },
};

const mcpBuilder = require('./mcpBuilder');
const automationStore = require('../stores/automationStore');

const ref = (p) => ({ kind: 'ref', path: p });

// The row as the store answers it; the definition is whatever the last
// persist wrote, so the second call sees exactly what the first saved.
function stubRow(row) {
    const original = automationStore.getAutomation;
    automationStore.getAutomation = async (id) => (id === row.id ? { ...row, definition: persisted.length ? persisted[persisted.length - 1].definition : row.definition } : null);
    return () => { automationStore.getAutomation = original; };
}

test('a partial batch persists the built prefix, says so, and the next call can chain after it by real id', async () => {
    const restore = stubRow({
        id: 'auto_1', userId: 'u1', organizationId: null, title: 'T', description: '',
        definition: { schemaVersion: 1, trigger: { id: 'trg', type: 'trigger', kind: 'manual', output: {} }, steps: [], edges: [] },
    });
    try {
        const { result: r } = await mcpBuilder.callTool('builder_add_steps', {
            automationId: 'auto_1',
            steps: [
                { tempId: 'a', type: 'datetime', spec: { op: 'now' } },
                { tempId: 'b', type: 'set', spec: { fields: { when: ref('steps.$a.output.iso') } } },
                { tempId: 'c', type: 'notification', spec: { title: 'x', body: 'y', afterStepId: '$nope' } },
            ],
        }, { userId: 'u1' });
        assert.ok(r.error, 'entry 2 is refused');
        assert.equal(r.failedIndex, 2);
        assert.equal(r.added.length, 2);
        assert.equal(r.automationId, 'auto_1', 'a partial result echoes the id like every other write');
        // Written once, with the two built steps.
        assert.equal(persisted.length, 1, 'persisted once');
        assert.deepEqual(persisted[0].definition.steps.map(s => s.id), r.added.map(a => a.id));
        assert.match(r._fixHint, /Over MCP a \$tempId lives for THIS CALL only/);
        assert.ok(r._warnings.some(w => w === `Saved the 2 built entries (${r.added.map(a => a.id).join(', ')}) before refusing entry 2.`), JSON.stringify(r._warnings));
        // Obeying resendAs (real ids, anchored) on a fresh call lands on the
        // saved prefix — no dangling edge.
        const resend = structuredClone(r.resendAs.args);
        resend.steps[0].spec.afterStepId = r.lastAppliedId;
        const { result: r2 } = await mcpBuilder.callTool('builder_add_steps', { automationId: 'auto_1', ...resend }, { userId: 'u1' });
        assert.ok(!r2.error, r2.error);
        assert.equal(r2.validationErrors, undefined);
        assert.equal(persisted.length, 2);
        const def = persisted[1].definition;
        assert.equal(def.steps.length, 3);
        assert.ok(def.edges.some(e => e.from === r.lastAppliedId && e.to === r2.added[0].id), 'chained after the saved prefix');
    } finally { restore(); }
});

test('a batch-level refusal (nothing built) still persists nothing', async () => {
    persisted.length = 0;
    const restore = stubRow({
        id: 'auto_2', userId: 'u1', organizationId: null, title: 'T', description: '',
        definition: { schemaVersion: 1, trigger: { id: 'trg', type: 'trigger', kind: 'manual', output: {} }, steps: [], edges: [] },
    });
    try {
        const { result: r } = await mcpBuilder.callTool('builder_add_steps', {
            automationId: 'auto_2',
            steps: [{ tempId: 'a', type: 'datetime', spec: { op: 'now' } }, { tempId: 'a', type: 'wait', spec: { seconds: 1 } }],
        }, { userId: 'u1' });
        assert.match(r.error, /duplicate tempId/);
        assert.equal(r.automationId, undefined);
        assert.equal(persisted.length, 0);
    } finally { restore(); }
});
