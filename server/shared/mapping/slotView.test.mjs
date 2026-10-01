/**
 * slotView.mjs: what a value field shows about a pick, shared by the web and
 * the phone (they used to keep a copy each, and the copies had drifted).
 *
 * Run: cd server && node --test shared/mapping/slotView.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    countAt, crossesList, groupLabelOf, isStale, makePick, manyForOne, shapeAt, sourceBasePath,
} from './index.mjs';

const SAMPLE = {
    trigger: { output: { subject: 'Hoi' } },
    steps: { s1: { output: { total: 3, orders: [{ product: 'Stoel' }, { product: 'Tafel' }], tags: ['a', 'b'] } } },
};
const S = (...path) => ({ root: 'steps', id: 's1', path });
const NUMBER = { as: 'number', multiLine: false };
const TEXT = { as: 'text', multiLine: false };

test('shapeAt: the sample first, then a drag hint, then missing / unknown', () => {
    assert.equal(shapeAt(S('orders'), SAMPLE), 'table');
    assert.equal(shapeAt(S('tags'), SAMPLE), 'list');
    assert.equal(shapeAt(S('total'), SAMPLE), 'single');
    assert.equal(shapeAt(S('nope'), SAMPLE), 'missing');
    assert.equal(shapeAt(S('nope'), SAMPLE, 'list'), 'list');
    assert.equal(shapeAt(S('nope'), SAMPLE, 'scalar'), 'single');
    assert.equal(shapeAt(S('total'), null), 'unknown');
});

test('countAt and makePick', () => {
    assert.equal(countAt(S('tags'), SAMPLE), 2);
    assert.equal(countAt(S('orders', 'product'), SAMPLE), 2);
    assert.equal(countAt(S('total'), SAMPLE), null);
    assert.equal(countAt(S('tags'), null), null);
    assert.deepEqual(makePick(S('total'), { take: 'one', as: 'native' }), { kind: 'pick', v: 1, from: S('total'), take: 'one', as: 'native' });
    assert.equal(makePick(S('tags'), { take: 'all', as: 'text', join: 'comma' }).join, 'comma');
});

test('manyForOne: every take but count of a list into a number, date or yes/no field', () => {
    for (const take of ['one', 'first', 'last', 'all']) assert.equal(manyForOne({ take }, 'list', NUMBER), true, take);
    assert.equal(manyForOne({ take: 'count' }, 'list', NUMBER), false);
    assert.equal(manyForOne({ take: 'one' }, 'table', TEXT), true);
    assert.equal(manyForOne({ take: 'first' }, 'list', TEXT), false);
    assert.equal(manyForOne({ take: 'one' }, 'single', NUMBER), false);
    assert.equal(manyForOne({ take: 'first' }, 'list'), false, 'without a slot only `one` of a list');
});

test('groupLabelOf and sourceBasePath', () => {
    const groups = [{ label: 'Orders ophalen', basePath: 'steps.s1.output' }, { label: 'Start', basePath: 'trigger.output' }];
    assert.equal(sourceBasePath(S()), 'steps.s1.output');
    assert.equal(sourceBasePath({ root: 'run', path: ['id'] }), 'trigger.output');
    assert.equal(groupLabelOf(S('total'), groups), 'Orders ophalen');
    assert.equal(groupLabelOf({ root: 'trigger', path: [] }, groups), 'Start');
    assert.equal(groupLabelOf({ root: 'steps', id: 's9', path: [] }, groups, new Map([['s9', 'Elders']])), 'Elders');
    assert.equal(groupLabelOf({ root: 'vars', path: ['x'] }, groups), '');
});

test('isStale: a gone step, a renamed field on real data, an unknown trigger key', () => {
    const groups = [{ basePath: 'steps.s1.output', hasRealData: true }, { basePath: 'trigger.output' }];
    assert.equal(isStale({ root: 'steps', id: 'gone', path: ['x'] }, groups, SAMPLE), true);
    assert.equal(isStale(S('renamed'), groups, SAMPLE), true);
    assert.equal(isStale(S('total'), groups, SAMPLE), false);
    assert.equal(isStale({ root: 'trigger', path: ['other'] }, groups, SAMPLE), false, 'no real data: never cries wolf');
    assert.equal(isStale({ root: 'steps', id: 'gone', path: [] }, [], SAMPLE), false, 'without the steps: nothing said');
    assert.equal(isStale({ root: 'run', path: ['nope'] }, [], SAMPLE), true);
    assert.equal(isStale({ root: 'run', path: ['firedAt'] }, [], SAMPLE), false);
});

test('crossesList', () => {
    assert.equal(crossesList(S('orders', 'product'), SAMPLE), true);
    assert.equal(crossesList(S('total'), SAMPLE), false);
    assert.equal(crossesList(S('nope', 'x'), SAMPLE), undefined);
    assert.equal(crossesList(S('total'), null), undefined);
});
