'use strict';

/**
 * The apps module's part of "what breaks if I delete this agent?" (./apps.js): its jsonpath scan
 * takes the agent ids as bound parameters, never inside the path (../agentUsage.testkit.js).
 *
 * Run: cd server && node --test stores/agent/usage/apps.test.js
 */

const test = require('node:test');
const { assertPathIsConstant } = require('../agentUsage.testkit');

test('no agent id ever enters the jsonpath — the ids are bound, the path is a constant', () => assertPathIsConstant('app'));
