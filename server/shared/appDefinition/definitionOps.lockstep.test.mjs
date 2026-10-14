/**
 * Lockstep proof, server half: the server facade (server/appStudio/
 * definitionOps.js) returns exactly what it returned before the shared ops
 * moved here (lockstep.golden.json, recorded from the two hand-kept copies),
 * and the ops both sides share agree between the server and editor goldens.
 * The editor half is agent-hub/.../state/definitionOps.lockstep.test.ts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

import { runScenario, CASES, SHARED_OPS } from './lockstep.fixture.mjs';
import * as shared from './definitionOps.mjs';

const require = createRequire(import.meta.url);
const golden = JSON.parse(fs.readFileSync(new URL('./lockstep.golden.json', import.meta.url), 'utf8'));

test('the server facade returns what the server copy returned before the move', () => {
    const facade = require('../../appStudio/definitionOps.js');
    assert.deepEqual(runScenario(facade), golden.server);
});

test('the shared module returns the golden result for every shared op', () => {
    const actual = runScenario(shared);
    const cases = CASES.filter(([, op]) => SHARED_OPS.includes(op)).map(([name]) => name);
    assert.ok(cases.length > 30);
    for (const name of cases) {
        assert.deepEqual(actual[name], golden.server[name], name);
        if (name in golden.client) assert.deepEqual(golden.client[name], golden.server[name], `${name}: server and editor goldens disagree`);
    }
});
