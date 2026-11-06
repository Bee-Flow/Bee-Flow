'use strict';
/**
 * The KB query-log option of a Studio AI step: a click logs under the viewer, a dry run (app_run_action's
 * default and every saved app test) logs nothing.
 *
 * Run: cd server && node --test appStudio/actionExecutor/aiSteps.queryLog.test.js
 */

process.env.NODE_ENV = 'test';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { queryLogFor } = require('./aiSteps');

const app = { id: 'app1', organizationId: 'org1' };

test('a click logs under the viewer', () => {
    assert.deepEqual(queryLogFor('studio_kb_query', app, { viewerId: 'v1', actionId: 'a1' }),
        { channel: 'studio_kb_query', channelRef: { appId: 'app1', actionId: 'a1' }, orgId: 'org1', userId: 'v1' });
});

test('a dry run or a test passes no log option', () => {
    assert.equal(queryLogFor('studio_ai_generate', app, { viewerId: 'owner', actionId: 'a1', dryRun: true }), null);
});
