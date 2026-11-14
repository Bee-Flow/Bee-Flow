// @typecheck strict
/**
 * The two store ports boot/lateBoundPorts.js fills: deleting a conversation
 * reaches core/dlp's cleaner, and an auto-synced agent or skill change reaches
 * the GitHub sync service, without the stores requiring either.
 *
 * Run: cd server && node --test stores/agent/conversationStatePort.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');

test('lateBoundPorts installs the DLP cleaner and the GitHub auto-sync on the store ports', () => {
    const dlpRunner = require('../../core/dlp/dlpRunner');
    const githubSync = require('../../services/githubSyncService');
    /** @type {unknown[][]} */
    const calls = [];
    const original = { clear: dlpRunner.clearConversationState, push: githubSync.autoSyncResource };
    dlpRunner.clearConversationState = (/** @type {unknown[]} */ ...args) => { calls.push(['clear', ...args]); };
    githubSync.autoSyncResource = (/** @type {unknown[]} */ ...args) => { calls.push(['push', ...args]); };
    try {
        require('../../boot/lateBoundPorts');
        require('./conversationStatePort').clearConversationState('conv-1');
        require('../resourceSyncPort').autoSyncResource('org-1', 'skill', 'skill-1', 'deleted');
        assert.deepStrictEqual(calls, [['clear', 'conv-1'], ['push', 'org-1', 'skill', 'skill-1', 'deleted']]);
    } finally {
        dlpRunner.clearConversationState = original.clear;
        githubSync.autoSyncResource = original.push;
    }
});
