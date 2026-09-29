'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normaliseAddComponentsArgs, normaliseEntry } = require('./componentNormalise');

// ── 2026-09-13: the two shapes the invoice-tracker trace grew ──────────────

test('a container given a title is read as a card, its look mapped, and the title kept for the hoist', () => {
    const notes = [];
    const out = normaliseEntry({ type: 'container', props: { look: 'panel', title: 'Add New Supplier' }, style: { span: 12 }, children: [] }, 'components[0]', notes);
    assert.equal(out.type, 'card');
    assert.deepEqual(out.props, { look: 'default', title: 'Add New Supplier' });
    assert.match(notes[0], /components\[0\]: a container with a title read as card \(container has no title; look panel → default\)/);
    for (const [from, to] of [['tinted', 'tinted'], ['outlined', 'flat'], ['plain', 'flat']]) {
        const n = [];
        assert.equal(normaliseEntry({ type: 'container', props: { look: from, title: 'x' } }, 'c', n).props.look, to, from);
    }
    // A stray title beside props, a description, an unknown look: still a card.
    const stray = [];
    const s = normaliseEntry({ type: 'container', title: 'Beside props', props: { look: 'weird' } }, 'c', stray);
    assert.equal(s.type, 'card');
    assert.equal(s.props.title, 'Beside props', 'the generic hoist moved it because card declares title');
    assert.equal(s.props.look, undefined, 'an unknown look is dropped rather than guessed');
    const d = normaliseEntry({ type: 'container', props: { description: 'Sub' } }, 'c', []);
    assert.equal(d.type, 'card');
    // A container WITHOUT a title stays a container.
    const plain = [];
    assert.equal(normaliseEntry({ type: 'container', props: { look: 'panel' }, children: [] }, 'c', plain).type, 'container');
    assert.deepEqual(plain, []);
});

test('entry-shaped keys at the root beside `components` are dropped and SAID; the children alias still works when components is absent', () => {
    const { args, notes } = normaliseAddComponentsArgs({
        parentId: 'sec_1',
        components: [{ type: 'heading', props: { text: 'x' } }],
        type: 'section',
        children: [{ type: 'heading', props: { text: 'x' } }],
        style: { span: 12 },
    });
    assert.deepEqual(Object.keys(args).sort(), ['components', 'parentId']);
    assert.equal(args.components.length, 1, 'the duplicate tree under `children` never becomes a second batch');
    assert.match(notes[0], /^root keys type, style, children ignored — component entries belong in components\[\]/);
    const alias = normaliseAddComponentsArgs({ parentId: 'sec_1', children: [{ type: 'heading', props: { text: 'y' } }] });
    assert.equal(alias.args.components.length, 1);
    assert.match(alias.notes[0], /"children" read as components/);
    assert.deepEqual(normaliseAddComponentsArgs({ parentId: 'sec_1', components: [] }).notes, [], 'a clean call has no notes');
});
