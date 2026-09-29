/**
 * subscription_plans write paths — the column plumbing must stay complete.
 *
 * updatePlan() builds an `updateMap` and hands it to dynamicUpdate() together
 * with a `colMap` whitelist. A key that is in updateMap but missing from colMap
 * is SILENTLY DROPPED: the route returns 200, the audit log records the change,
 * and the value never reaches the database. Adding nc_only cost exactly that —
 * the toggle saved, the plan came back unchanged, and nothing anywhere failed.
 *
 * createPlan() has the matching hazard: its INSERT lists columns and $n
 * placeholders in two separate strings, so adding a column to one and not the
 * other shifts every value after it into the wrong column.
 *
 * Both are checked against the source text rather than a live DB, so this runs
 * in the DB-free suite.
 *
 * Run: cd server && node --test stores/userStore.planColumns.test.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test } = require('node:test');

const SRC = fs.readFileSync(path.join(__dirname, 'user', 'plans.js'), 'utf8');

function bodyOf(fnName) {
    const start = SRC.indexOf(`async function ${fnName}(`);
    assert.notStrictEqual(start, -1, `${fnName} not found — did it get renamed?`);
    const next = SRC.indexOf('\nasync function ', start + 1);
    return SRC.slice(start, next === -1 ? SRC.length : next);
}

test('every field updatePlan maps is present in its colMap whitelist', () => {
    const body = bodyOf('updatePlan');

    const assigned = [...body.matchAll(/updateMap\.([A-Za-z0-9_]+)\s*=/g)].map(m => m[1]);
    assert.ok(assigned.length > 20, `expected the full plan field list, found ${assigned.length}`);

    const colMapLiteral = body.match(/const colMap = \{([\s\S]*?)\};/);
    assert.ok(colMapLiteral, 'colMap literal not found in updatePlan');
    const mapped = new Set([...colMapLiteral[1].matchAll(/([A-Za-z0-9_]+)\s*:/g)].map(m => m[1]));

    const dropped = [...new Set(assigned)].filter(k => !mapped.has(k));
    assert.deepStrictEqual(dropped, [], `these fields would be silently discarded on update: ${dropped.join(', ')}`);
});

test('createPlan INSERT lists as many placeholders as columns', () => {
    const body = bodyOf('createPlan');

    const insert = body.match(/INSERT INTO subscription_plans \(([^)]+)\)\s*\n\s*VALUES \(([^)]+)\)/);
    assert.ok(insert, 'the subscription_plans INSERT was not found');

    const columns = insert[1].split(',').map(s => s.trim()).filter(Boolean);
    const placeholders = insert[2].split(',').map(s => s.trim()).filter(Boolean);

    assert.strictEqual(placeholders.length, columns.length,
        `${columns.length} columns vs ${placeholders.length} placeholders — every value after the gap lands in the wrong column`);
    assert.strictEqual(placeholders[placeholders.length - 1], `$${columns.length}`,
        'placeholders must run $1..$N in order');
});

test('a plan field that can be updated can also be set at creation', () => {
    const insertColumns = new Set(
        bodyOf('createPlan')
            .match(/INSERT INTO subscription_plans \(([^)]+)\)/)[1]
            .split(',').map(s => s.trim())
    );
    const colMapLiteral = bodyOf('updatePlan').match(/const colMap = \{([\s\S]*?)\};/)[1];
    const updatable = [...colMapLiteral.matchAll(/([A-Za-z0-9_]+)\s*:/g)].map(m => m[1]);

    const missing = updatable.filter(c => !insertColumns.has(c));
    assert.deepStrictEqual(missing, [], `updatable but not insertable: ${missing.join(', ')}`);
});

test('the visibility flags are carried end to end', () => {
    // The three audience flags the admin Visibility step writes. Each has to
    // survive parse → create → update or the toggle is cosmetic.
    for (const flag of ['is_public', 'is_default', 'nc_recommended', 'nc_only']) {
        assert.ok(new RegExp(`${flag}: !!p\\.${flag}`).test(SRC), `parsePlan does not expose ${flag}`);
        assert.ok(bodyOf('createPlan').includes(`!!data.${flag}`), `createPlan does not insert ${flag}`);
        assert.ok(bodyOf('updatePlan').includes(`updateMap.${flag} = !!data.${flag}`), `updatePlan does not map ${flag}`);
    }
});
