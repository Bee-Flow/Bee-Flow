/**
 * The 'on_expired' edge label (validate/graphEdges.js): a known label, legal
 * only from an approval, at most one per approval, and next to a rejected
 * branch without a conflict.
 *
 * Run: node --test automation/validate.onExpired.test.js
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

test('an approval with a plain, a rejected and an expired branch validates clean', () => {
    const { errors, warnings } = codes({
        trigger: TRIGGER,
        steps: [approval, note('yes'), note('no'), note('late')],
        edges: [{ from: 'trg', to: 'ap' }, { from: 'ap', to: 'yes' }, { from: 'ap', to: 'no', label: 'on_rejected' }, { from: 'ap', to: 'late', label: 'on_expired' }],
    });
    assert.deepStrictEqual(errors, []);
    assert.ok(!warnings.some(c => c.startsWith('edge.') || c.startsWith('approval.')), `warnings: ${warnings.join(', ')}`);
});

test('on_expired is a known label (no edge.label_unknown)', () => {
    const { warnings } = codes({
        trigger: TRIGGER,
        steps: [approval, note('yes'), note('late')],
        edges: [{ from: 'trg', to: 'ap' }, { from: 'ap', to: 'yes' }, { from: 'ap', to: 'late', label: 'on_expired' }],
    });
    assert.ok(!warnings.includes('edge.label_unknown'));
});

test('on_expired from anything but an approval is an error', () => {
    for (const [from, steps] of [
        ['n1', [note('n1'), note('n2')]],
        ['trg', [note('n2')]],
    ]) {
        const { errors } = codes({
            trigger: TRIGGER,
            steps,
            edges: [...(from === 'trg' ? [] : [{ from: 'trg', to: 'n1' }]), { from, to: 'n2', label: 'on_expired' }],
        });
        assert.ok(errors.includes('edge.expired_label_invalid'), `${from}: ${errors.join(', ')}`);
    }
});

test('two expired branches on one approval is an error', () => {
    const { errors } = codes({
        trigger: TRIGGER,
        steps: [approval, note('yes'), note('a'), note('b')],
        edges: [{ from: 'trg', to: 'ap' }, { from: 'ap', to: 'yes' }, { from: 'ap', to: 'a', label: 'on_expired' }, { from: 'ap', to: 'b', label: 'on_expired' }],
    });
    assert.ok(errors.includes('edge.expired_label_duplicate'), errors.join(', '));
});

test('a flow without an expired branch reports exactly what it did before', () => {
    const def = {
        trigger: TRIGGER,
        steps: [approval, note('yes'), note('no')],
        edges: [{ from: 'trg', to: 'ap' }, { from: 'ap', to: 'yes' }, { from: 'ap', to: 'no', label: 'on_rejected' }],
    };
    const { errors, warnings } = codes(def);
    assert.ok(!errors.some(c => c.includes('expired')) && !warnings.some(c => c.includes('expired')));
});
