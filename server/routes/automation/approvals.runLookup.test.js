'use strict';

/**
 * POST /approvals/:id/decide and a run that could not be READ
 * (routes/automation/approvals.js).
 *
 * approvalService.decide treats "no run" as "the run moved on" and closes the
 * approval as cancelled. That is right when the run is really gone. It is wrong
 * when the lookup merely failed (a dropped connection, a timeout): the approval
 * would be cancelled for good while its run still waits for it. So a failed
 * lookup is a 500 the approver can retry, and the decision service is never
 * reached; a run that does not exist is still handed over as null.
 *
 * Run: cd server && node --test routes/automation/approvals.runLookup.test.js
 */

process.env.NODE_ENV = 'test';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const path = require('path');

const SERVER = path.resolve(__dirname, '..', '..');
const { mockModule: mock } = require('../../testUtils/moduleMock');

const decided = [];
let getRun = async () => null;
const APPROVAL = { id: 'ap1', ownerId: 'u1', organizationId: 'org1', status: 'pending', runId: 'run1', stepId: 's1' };

mock(path.join(SERVER, 'stores/automationStore'), {
    getApproval: async (id) => ({ ...APPROVAL, id }),
    getRun: (id) => getRun(id),
});
mock(path.join(SERVER, 'automation/approvalService'), {
    canView: () => true,
    canDecide: () => true,
    decide: async (p) => { decided.push(p); return { code: 200, body: { accepted: true } }; },
});
mock(path.join(SERVER, 'auth/permissions'), { isOrgAdminRole: () => true });
mock(path.join(SERVER, 'core/entitlements/entitlements'), { requireCapability: () => (req, res, next) => next() });
mock(path.join(SERVER, 'modules'), { requireModule: () => (req, res, next) => next() });
mock(path.join(SERVER, 'stores/userStore'), {
    getUser: async (id) => ({ id, organizationId: 'org1', orgRole: 'org_admin', groups: [] }),
    getAllGroups: async () => [],
});

const router = require('./approvals');
const { terminalErrorHandler } = require(path.join(SERVER, 'core/http/terminalErrorHandler'));

function decide() {
    const url = '/approvals/ap1/decide';
    return new Promise((resolve, reject) => {
        const req = {
            method: 'POST', url, originalUrl: url, path: url, query: {}, body: { decision: 'approve' }, headers: {},
            session: { user: { id: 'u1', organizationId: 'org1', orgRole: 'org_admin' }, isAdmin: true },
            get() { return undefined; }, setTimeout() {},
        };
        const res = {
            statusCode: 200, headersSent: false,
            set() { return this; }, setHeader() {},
            status(c) { this.statusCode = c; return this; },
            json(b) { this.body = b; this.headersSent = true; resolve(this); return this; },
            send(b) { this.body = b; this.headersSent = true; resolve(this); return this; },
            end() { this.headersSent = true; resolve(this); return this; },
        };
        router(req, res, (err) => {
            if (!err) return reject(new Error('fell through'));
            terminalErrorHandler(err, req, res, (e) => reject(e));
        });
    });
}

beforeEach(() => { decided.length = 0; });

test('a run lookup that fails is a 500, and the decision service is not reached', async () => {
    getRun = async () => { throw new Error('connection terminated'); };
    const res = await decide();
    assert.strictEqual(res.statusCode, 500);
    assert.deepStrictEqual(decided, [], 'decide() with run:null would cancel the approval for good');
});

test('a run that does not exist is still handed over as null', async () => {
    getRun = async () => null;
    const res = await decide();
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(decided.length, 1);
    assert.strictEqual(decided[0].run, null);
});

test('a run that is found is handed over', async () => {
    getRun = async (id) => ({ id, status: 'awaiting_approval', awaitingStepId: 's1' });
    const res = await decide();
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(decided[0].run.id, 'run1');
});
