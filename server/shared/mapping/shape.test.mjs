import { test } from 'node:test';
import assert from 'node:assert/strict';

import { shapeOf, shapeOfSchema } from './shape.mjs';
import { walkMany } from './walk.mjs';

test('shapeOf: by the value the run (or the sample) holds', () => {
    assert.equal(shapeOf(undefined), 'missing');
    assert.equal(shapeOf(null), 'single');
    assert.equal(shapeOf('x'), 'single');
    assert.equal(shapeOf(0), 'single');
    assert.equal(shapeOf({ a: 1 }), 'object');
    assert.equal(shapeOf([1, 2]), 'list');
    assert.equal(shapeOf([{ a: 1 }, null, { b: 2 }]), 'table');
    assert.equal(shapeOf([{ a: 1 }, 'x']), 'list');
    // An empty list is never a table: before a run there is no row to look at.
    assert.equal(shapeOf([]), 'list');
    assert.equal(shapeOf(walkMany([{ a: { x: 1 } }, { a: { x: 2 } }], ['a'])), 'table');
    assert.equal(shapeOf(walkMany([{ a: 1 }], ['a'])), 'list');
});

test('shapeOfSchema: what a JSON schema promises', () => {
    assert.equal(shapeOfSchema(undefined), 'unknown');
    assert.equal(shapeOfSchema({}), 'unknown');
    assert.equal(shapeOfSchema({ type: 'string' }), 'single');
    assert.equal(shapeOfSchema({ type: ['integer', 'null'] }), 'single');
    assert.equal(shapeOfSchema({ type: 'object' }), 'object');
    assert.equal(shapeOfSchema({ properties: { a: {} } }), 'object');
    assert.equal(shapeOfSchema({ type: 'array' }), 'list');
    assert.equal(shapeOfSchema({ type: 'array', items: { type: 'string' } }), 'list');
    assert.equal(shapeOfSchema({ type: 'array', items: { type: 'object' } }), 'table');
    assert.equal(shapeOfSchema({ type: 'array', items: { properties: { a: {} } } }), 'table');
    assert.equal(shapeOfSchema({ items: { type: 'object' } }), 'table');
});
