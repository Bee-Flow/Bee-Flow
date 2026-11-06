'use strict';
/**
 * The asker the agent's kb_search tool logs: the turn's explicit asker (also null) wins over a synthetic user id.
 *
 * Run: cd server && node --test core/kb/queryLog/hook.test.js
 */

process.env.NODE_ENV = 'test';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { agentToolLog } = require('./hook.mts');

const carrier = {};
const ctx = (queryLog) => ({ queryLog, agentId: 'a1', orgId: 'org1', askerUserId: 'support-ai:inbox:t1', userId: 'operator' });

test('without an explicit asker the context asker is logged', () => {
    assert.equal(agentToolLog(ctx({ carrier, channel: 'agent_chat_sync' })).log.userId, 'support-ai:inbox:t1');
});

test('the support responder names its requester, or nobody for an external one, never the synthetic id', () => {
    assert.equal(agentToolLog(ctx({ carrier, channel: 'agent_chat_sync', asker: 'u-requester' })).log.userId, 'u-requester');
    assert.equal(agentToolLog(ctx({ carrier, channel: 'agent_chat_sync', asker: null })).log.userId, null);
});

test('no turn, no log option', () => {
    assert.deepEqual(agentToolLog(ctx(null)), {});
});
