/**
 * controlFlowSteps.mjs: what a Condition hands the steps after it (node-audit C24).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { computeUpstreamGroups } from './index.mjs';

test('condition offers branch, value AND expr', () => {
    const def = {
        trigger: { id: 'trg', type: 'trigger', kind: 'manual' },
        steps: [{ id: 'c1', type: 'condition', expr: 'true' }, { id: 'n1', type: 'notification', title: 't' }],
        edges: [{ from: 'trg', to: 'c1' }, { from: 'c1', to: 'n1', label: 'then' }],
    };
    const keys = computeUpstreamGroups(def, 'n1', null).find(g => g.id === 'c1').fields.map(f => f.key);
    for (const k of ['branch', 'value', 'expr']) assert.ok(keys.includes(k), k);
});
