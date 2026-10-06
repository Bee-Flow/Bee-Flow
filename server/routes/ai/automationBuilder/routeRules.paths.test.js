/**
 * /route-rules verification of a field with an awkward name.
 *
 * The editor sends each field as its path, and a key with a space or a
 * symbol is spelled with brackets there (`item["Story Points"]`, shared
 * grammar). The verifier read an expression's paths as `head.name` only, so
 * `item["Story Points"] > 3` counted as a rule over the whole row (`item`) and
 * was dropped, and a bare key was declared as `item.Story Points` — a
 * spelling no expression can have. Fields with such names could never get a
 * suggested rule.
 *
 * Run: cd server && node --test routes/ai/automationBuilder/routeRules.paths.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { verifyRouteRules, collectFieldPaths } = require('./routeRules');
const { parseExpr } = require('../../../automation/expr');

const names = (rules) => rules.map(r => r.name);

test('a bracketed field read is a field path, in the canonical spelling', () => {
    const paths = (src) => [...collectFieldPaths(parseExpr(src))].sort();
    assert.deepStrictEqual(paths('item["Story Points"] > 3'), ['item["Story Points"]']);
    assert.deepStrictEqual(paths("item['content-type'] == 'pdf'"), ['item["content-type"]']);
    assert.deepStrictEqual(paths('item["name"] == "x"'), ['item.name']);
    // An index into the row itself is still a rule about the whole row.
    assert.deepStrictEqual(paths('item[0] == 1'), ['item']);
});

test('a scoped key in brackets declares that field, in either quote style', () => {
    const fields = [{ key: 'item["Story Points"]', name: 'Story Points', type: 'number' }];
    const rules = verifyRouteRules([
        { name: 'Big', expr: 'item["Story Points"] > 8' },
        { name: 'Small', expr: "item['Story Points'] <= 3" },
        { name: 'Typo', expr: 'item["Story Pointz"] > 1' },
    ], { fields });
    assert.deepStrictEqual(names(rules), ['Big', 'Small']);
});

test('a bare key with a space is declared under the item scope with brackets', () => {
    const fields = [{ key: 'Story Points', name: 'Story Points', type: 'number' }];
    assert.deepStrictEqual(names(verifyRouteRules([{ name: 'Big', expr: 'row["Story Points"] > 8' }], { fields, itemVar: 'row' })), ['Big']);
    assert.deepStrictEqual(names(verifyRouteRules([{ name: 'Big', expr: 'item["Story Points"] > 8' }], { fields, itemVar: 'row' })), ['Big']);
});

test('the dotted cases keep working exactly as before', () => {
    const fields = [{ key: 'name' }, { key: 'item.size' }];
    const rules = verifyRouteRules([
        { name: 'PDF', expr: 'endsWith(item.name, ".pdf")' },
        { name: 'Big', expr: 'item.size > 10' },
        { name: 'Nested', expr: 'item.size.bytes > 10' },
        { name: 'Other', expr: 'item.owner == "me"' },
    ], { fields });
    assert.deepStrictEqual(names(rules), ['PDF', 'Big', 'Nested']);
});
