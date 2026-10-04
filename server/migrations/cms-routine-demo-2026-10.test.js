/**
 * cms-routine-demo-2026-10: stored website pages embed and link the renamed demo.
 *
 * Run: cd server && node --test migrations/cms-routine-demo-2026-10.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { renameDemo } = require('./cms-routine-demo-2026-10');

test('a feature-demo block and a demo link follow the rename; everything else stays', () => {
    const changed = { n: 0 };
    const page = {
        blocks: [
            { id: 'b1', type: 'feature-demo', data: { feature: 'routines', title: 'Try our routines' } },
            { id: 'b2', type: 'cta', data: { href: '/demo/routines?theme=dark', label: 'See it' } },
            { id: 'b3', type: 'feature-demo', data: { feature: 'agents' } },
            { id: 'b4', type: 'text', data: { body: 'Routines are now automations.' } },
        ],
    };
    const out = renameDemo(page, changed);
    assert.equal(out.blocks[0].data.feature, 'automations');
    assert.equal(out.blocks[0].data.title, 'Try our routines', 'copy a person wrote is theirs');
    assert.equal(out.blocks[1].data.href, '/demo/automations?theme=dark');
    assert.equal(out.blocks[2].data.feature, 'agents');
    assert.equal(out.blocks[3].data.body, 'Routines are now automations.');
    assert.equal(changed.n, 2);
});

test('a second pass changes nothing, and a longer slug is not cut', () => {
    const changed = { n: 0 };
    const once = renameDemo({ data: { feature: 'routines', href: '/demo/routines-legacy' } });
    assert.equal(once.data.href, '/demo/routines-legacy');
    assert.deepEqual(renameDemo(once, changed), once);
    assert.equal(changed.n, 0, 'the -legacy link holds the substring but is no match');
});
