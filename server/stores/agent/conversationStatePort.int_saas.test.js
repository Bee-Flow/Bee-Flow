// @typecheck strict
/**
 * The store port module "int_saas" fills on boot/lateBoundPorts' channel: an
 * auto-synced agent or skill change reaches the GitHub sync service without the
 * stores requiring it. (The DLP cleaner on the same channel: conversationStatePort.test.js.)
 *
 * Run: cd server && node --test stores/agent/conversationStatePort.int_saas.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');

test('lateBoundPorts installs the GitHub auto-sync on the store port', () => {
    const githubSync = require('../../services/githubSyncService');
    /** @type {unknown[][]} */
    const calls = [];
    const original = { push: githubSync.autoSyncResource };
    githubSync.autoSyncResource = (/** @type {unknown[]} */ ...args) => { calls.push(['push', ...args]); };
    try {
        require('../../boot/lateBoundPorts');
        require('../resourceSyncPort').autoSyncResource('org-1', 'skill', 'skill-1', 'deleted');
        assert.deepStrictEqual(calls, [['push', 'org-1', 'skill', 'skill-1', 'deleted']]);
    } finally {
        githubSync.autoSyncResource = original.push;
    }
});
