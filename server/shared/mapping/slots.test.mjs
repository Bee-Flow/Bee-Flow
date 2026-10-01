import { test } from 'node:test';
import assert from 'node:assert/strict';

import { slotShape, STEP_SLOTS, SLOT_KINDS } from './slots.mjs';
import { STEP_SITES } from './sites.mjs';

test('a tool input: its schema decides', () => {
    assert.deepStrictEqual(slotShape({ type: 'string' }, { field: 'subject' }), { as: 'text', multiLine: false });
    assert.deepStrictEqual(slotShape({ type: 'string' }, { field: 'body' }), { as: 'text', multiLine: true });
    assert.deepStrictEqual(slotShape({ type: 'string', 'x-multiline': true }, { field: 'x' }), { as: 'text', multiLine: true });
    assert.deepStrictEqual(slotShape({ type: 'string', format: 'date' }), { as: 'date', multiLine: false });
    assert.deepStrictEqual(slotShape({ type: 'integer' }), { as: 'number', multiLine: false });
    assert.deepStrictEqual(slotShape({ type: 'boolean' }), { as: 'yesno', multiLine: false });
    assert.deepStrictEqual(slotShape({ type: 'array', items: { type: 'string' } }), { as: 'list', multiLine: false, items: 'single' });
    assert.deepStrictEqual(slotShape({ type: 'array', items: { type: 'object' } }), { as: 'list', multiLine: false, items: 'object' });
    assert.deepStrictEqual(slotShape({ type: 'object' }), { as: 'native', multiLine: false });
});

test('a step config field: STEP_SLOTS decides; anything unknown is native', () => {
    assert.deepStrictEqual(slotShape(undefined, { stepType: 'notification', field: 'body' }), { as: 'text', multiLine: true });
    assert.deepStrictEqual(slotShape(undefined, { stepType: 'notification', field: 'title' }), { as: 'text', multiLine: false });
    assert.deepStrictEqual(slotShape(undefined, { stepType: 'http_request', field: 'body' }), { as: 'json', multiLine: true });
    assert.deepStrictEqual(slotShape(undefined, { stepType: 'notification', field: 'nope' }), { as: 'native', multiLine: false });
    assert.deepStrictEqual(slotShape(undefined), { as: 'native', multiLine: false });
    assert.deepStrictEqual(slotShape(undefined, { stepType: 'x', field: 'constructor' }), { as: 'native', multiLine: false });
});

test('every STEP_SLOTS text field is a text site of its step type in sites.mjs', () => {
    for (const [key, slot] of Object.entries(STEP_SLOTS)) {
        assert.ok(SLOT_KINDS.includes(slot.as), key);
        const [type, ...rest] = key.split('.');
        const field = rest.join('.');
        const texts = (STEP_SITES[type] && STEP_SITES[type].text || []).map(t => t.field);
        assert.ok(texts.includes(field), `${key} is not a text site of ${type}`);
    }
});
