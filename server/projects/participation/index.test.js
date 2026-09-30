/**
 * projects/participation/index.js — the public face: one engine per process,
 * the team chat surface registered, other surfaces checked at registration.
 *
 * Run: cd server && node --test projects/participation/index.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const participation = require('./index');

test('the chat surface is there; a surface must bring what the engine needs', () => {
    assert.ok(participation.surfaceNames().includes('chat'));
    assert.throws(() => participation.registerSurface('comment', { lockType: 'project_comment' }), /loadContext/);
    assert.throws(() => participation.registerSurface('comment', { lockType: 'project_comment', loadContext: async () => null }), /answer\(\) or postAnswer\(\)/);
    assert.throws(() => participation.registerSurface('email', { lockType: 'x', loadContext: async () => null, postAnswer: async () => ({}) }), /Unknown participation surface/);
    participation.registerSurface('comment', { lockType: 'project_comment', loadContext: async () => null, postAnswer: async () => ({ messageId: 'x' }) });
    assert.deepStrictEqual(participation.surfaceNames().sort(), ['chat', 'comment']);
    assert.strictEqual(participation.defaultEngine(), participation.defaultEngine(), 'one engine per process');
});

test('an unknown surface is not an error on the post path', async () => {
    assert.deepStrictEqual(
        await participation.defaultEngine().onHumanMessage({ surface: 'nothing', containerId: 'c', messageId: 'm', authorUserId: 'u' }),
        { watched: false, reason: 'surface_unavailable' },
    );
});
