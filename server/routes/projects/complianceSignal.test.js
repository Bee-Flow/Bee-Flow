/**
 * routes/projects/complianceSignal.js — the PROJECT_CHANGED signal the project
 * routes raise: ids only, the org-less bucket, and silence when the compliance
 * module is not installed or the project is unknown.
 *
 * Run: cd server && node --test routes/projects/complianceSignal.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { signalProjectChanged } = require('./complianceSignal');
const { EVENTS } = require('../../compliance/events');

const recorder = () => {
    const sent = [];
    return { sent, emit: (name, payload) => sent.push([name, payload]), moduleAvailable: () => true };
};

test('the signal carries ids and the reason only', () => {
    const r = recorder();
    const project = { id: 'p1', organizationId: 'org1', name: 'Launch plan', ownerId: 'u1' };
    assert.strictEqual(signalProjectChanged(project, 'members', r), true);
    assert.deepStrictEqual(r.sent, [[EVENTS.PROJECT_CHANGED, { orgId: 'org1', projectId: 'p1', reason: 'members' }]]);
    assert.ok(!JSON.stringify(r.sent).includes('Launch plan'), 'never the project name');
});

test('an org-less project is judged in the checks\' default bucket', () => {
    const r = recorder();
    signalProjectChanged({ id: 'p2', organizationId: '' }, 'files', r);
    assert.deepStrictEqual(r.sent[0][1], { orgId: 'default', projectId: 'p2', reason: 'files' });
});

test('nothing is sent without the compliance module, a project or a reason', () => {
    const r = recorder();
    assert.strictEqual(signalProjectChanged({ id: 'p1', organizationId: 'o' }, 'ai_mode', { ...r, moduleAvailable: () => false }), false);
    assert.strictEqual(signalProjectChanged(null, 'members', r), false);
    assert.strictEqual(signalProjectChanged({ id: 'p1' }, undefined, r), false);
    assert.deepStrictEqual(r.sent, []);
});

test('a bus that throws never reaches the caller', () => {
    const boom = { emit: () => { throw new Error('bus down'); }, moduleAvailable: () => true };
    assert.strictEqual(signalProjectChanged({ id: 'p1', organizationId: 'o' }, 'members', boom), false);
});
