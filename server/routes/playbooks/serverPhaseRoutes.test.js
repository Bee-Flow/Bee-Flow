// @typecheck
const { test } = require('node:test');
const assert = require('node:assert');
const { register } = require('./serverPhaseRoutes');

test('the design phase reads its spec in the playbook\'s own locale', async () => {
    const specCalls = [];
    const recipe = { description: 'r', phaseSpec: (key, locale) => { specCalls.push([key, locale]); return { goal: 'doel' }; } };
    const pb = {
        id: 'pb1', userId: 'me', version: 1, options: { locale: 'nl' },
        phases: [{ key: 'design', kind: 'design', status: 'ready' }],
    };
    let goal = null;
    const d = {
        now: () => Date.parse('2026-10-01T10:00:00Z'),
        playbookStore: { savePhases: async () => ({ ok: true, version: 2, playbook: pb }) },
        runDesignPhase: async (args) => { goal = args.goal; return { ok: false, code: 'x', error: 'stop here' }; },
    };
    const flow = { resolveRecipe: () => recipe, load: async () => pb, withBrief: () => pb.phases, savePhaseOutcome: async () => ({ ok: true }), phaseTier: async () => 'standard' };
    let handler = null;
    const router = { post: (path, ...fns) => { if (path === '/:id/phases/:key/run') handler = fns[fns.length - 1]; }, get() {}, patch() {}, put() {}, delete() {} };
    register(router, { d, flow, requireManageApps: () => {}, runLimiter: () => {} });
    const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json() { return this; } };
    await handler({ body: {}, params: { id: 'pb1', key: 'design' } }, res);
    assert.deepStrictEqual(specCalls, [['design', 'nl']]);
    assert.strictEqual(goal, 'doel');
});
