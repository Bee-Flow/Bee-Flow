'use strict';

/**
 * The automation module's part of "what breaks if I delete this agent?" (./automation.js): its jsonpath scan
 * takes the agent ids as bound parameters, never inside the path (../agentUsage.testkit.js).
 *
 * Run: cd server && node --test stores/agent/usage/automation.test.js
 */

const test = require('node:test');
const { assertPathIsConstant } = require('../agentUsage.testkit');

test('no agent id ever enters the jsonpath — the ids are bound, the path is a constant', () => assertPathIsConstant('automation'));
