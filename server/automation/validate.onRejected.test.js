/**
 * The 'on_rejected' edge label (validate/graphEdges.js): a known label, legal
 * only from an approval, at most one per approval, and a warning when the
 * approval has a rejected branch but nothing for an approve.
 *
 * Run: node --test automation/validate.onRejected.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const { validateDefinition } = require('./validate');

const TRIGGER = { id: 'trg', kind: 'manual', label: 'Manual' };
const note = (id) => ({ id, type: 'notification', title: id, body: 'x', channels: ['notification'] });
const approval = { id: 'ap', type: 'approval', prompt: 'Send the invoice?' };

function codes(definition) {
    const res = validateDefinition(definition, { stage: 'activate' });
    return { errors: (res.errors || []).map(e => e.code), warnings: (res.warnings || []).map(w => w.code) };
}

test('an approval with a plain and a rejected branch validates clean', () => {
    const { errors, warnings } = codes({
        trigger: TRIGGER,
        steps: [approval, note('yes'), note('no')],
        edges: [{ from: 'trg', to: 'ap' }, { from: 'ap', to: 'yes' }, { from: 'ap', to: 'no', label: 'on_rejected' }],
    });
    assert.deepStrictEqual(errors, []);
    assert.ok(!warnings.some(c => c.startsWith('edge.') || c.startsWith('approval.')), `warnings: ${warnings.join(', ')}`);
});

test('on_rejected is a known label (no edge.label_unknown)', () => {
    const { warnings } = codes({
        trigger: TRIGGER,
        steps: [approval, note('yes'), note('no')],
        edges: [{ from: 'trg', to: 'ap' }, { from: 'ap', to: 'yes' }, { from: 'ap', to: 'no', label: 'on_rejected' }],
    });
    assert.ok(!warnings.includes('edge.label_unknown'));
});

test('on_rejected from anything but an approval is an error', () => {
    for (const [from, steps] of [
        ['n1', [note('n1'), note('n2')]],
        ['trg', [note('n2')]],
    ]) {
        const { errors } = codes({
            trigger: TRIGGER,
            steps,
            edges: [...(from === 'trg' ? [] : [{ from: 'trg', to: 'n1' }]), { from, to: 'n2', label: 'on_rejected' }],
        });
        assert.ok(errors.includes('edge.rejected_label_invalid'), `from ${from}: ${errors.join(', ')}`);
    }
});

test('two rejected branches from one approval are an error', () => {
    const { errors } = codes({
        trigger: TRIGGER,
        steps: [approval, note('yes'), note('no1'), note('no2')],
        edges: [
            { from: 'trg', to: 'ap' }, { from: 'ap', to: 'yes' },
            { from: 'ap', to: 'no1', label: 'on_rejected' }, { from: 'ap', to: 'no2', label: 'on_rejected' },
        ],
    });
    assert.ok(errors.includes('edge.rejected_label_duplicate'), errors.join(', '));
});

test('an approval with only a rejected branch warns that an approve ends the run', () => {
    const { errors, warnings } = codes({
        trigger: TRIGGER,
        steps: [approval, note('no')],
        edges: [{ from: 'trg', to: 'ap' }, { from: 'ap', to: 'no', label: 'on_rejected' }],
    });
    assert.ok(!errors.includes('edge.rejected_label_duplicate'));
    assert.ok(warnings.includes('approval.rejected_only'), warnings.join(', '));
});

test('an on_success edge counts as the approve path', () => {
    const { warnings } = codes({
        trigger: TRIGGER,
        steps: [approval, note('yes'), note('no')],
        edges: [{ from: 'trg', to: 'ap' }, { from: 'ap', to: 'yes', label: 'on_success' }, { from: 'ap', to: 'no', label: 'on_rejected' }],
    });
    assert.ok(!warnings.includes('approval.rejected_only'));
});
