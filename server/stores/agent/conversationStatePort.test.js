// @typecheck strict
/**
 * The store port boot/lateBoundPorts.js fills: deleting a conversation reaches
 * core/dlp's cleaner without the store requiring it. (The GitHub auto-sync port
 * that module "int_saas" fills on the same channel:
 * conversationStatePort.int_saas.test.js.)
 *
 * Run: cd server && node --test stores/agent/conversationStatePort.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');

test('lateBoundPorts installs the DLP cleaner on the store port', () => {
    const dlpRunner = require('../../core/dlp/dlpRunner');
    /** @type {unknown[][]} */
    const calls = [];
    const original = { clear: dlpRunner.clearConversationState };
    dlpRunner.clearConversationState = (/** @type {unknown[]} */ ...args) => { calls.push(['clear', ...args]); };
    try {
        require('../../boot/lateBoundPorts');
        require('./conversationStatePort').clearConversationState('conv-1');
        assert.deepStrictEqual(calls, [['clear', 'conv-1']]);
    } finally {
        dlpRunner.clearConversationState = original.clear;
    }
});
