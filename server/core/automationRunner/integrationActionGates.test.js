// @typecheck
/**
 * Characterisation of the permission gate execIntegrationAction runs before
 * any dispatch (integrationActionGates.assertStepToolPermitted): the catalog
 * lookup is cached on ctx, a lookup failure fails closed for side effects and
 * open (sentinel null) for read-only tools, and a tool outside the allowed set
 * is refused with the built-in-step message or the admin message.
 * The lending swap and the durable tier are pinned in execAi.cache.test.js.
 */

const { test, beforeEach, after } = require('node:test');
// The runner reaches automation/, integrations/ and services/ through
// core/automationRunner/featurePorts.js; boot registers these for the server.
require('../../automation/runnerPorts');
require('../../integrations/runnerPorts');
require('../../services/runnerPorts');
const assert = require('node:assert');

const { installResolveStub } = require('../../testUtils/stubRequire');

const lookups = [];
let catalog = () => ({ tools: [{ function: { name: 'gmail_search' } }] });

const restore = installResolveStub({
    '../integrations/integrationTools': {
        async getIntegrationTools(opts) { lookups.push(opts); return catalog(); },
    },
    '../../automation/builtinStepTools': { isBuiltinStepType: (t) => t === 'ai_step' },
});
after(() => restore());

const { assertStepToolPermitted } = require('./integrationActionGates');
// What execAi.js hands over in production: the lazy getter for the catalog.
// The require string is the one execAi.js uses, so the stub above answers it.
const DEPS = { integrationTools: () => require('../integrations/integrationTools') };

beforeEach(() => {
    lookups.length = 0;
    catalog = () => ({ tools: [{ function: { name: 'gmail_search' } }] });
});

test('an allowed tool passes and the catalog is cached on ctx', async () => {
    const ctx = { userId: 'u1', session: { isAdmin: true } };
    await assertStepToolPermitted({ id: 's1', tool: 'gmail_search' }, ctx, false, DEPS);
    await assertStepToolPermitted({ id: 's2', tool: 'gmail_search' }, ctx, false, DEPS);
    assert.strictEqual(lookups.length, 1);
    assert.deepStrictEqual(lookups[0], {
        userId: 'u1', session: { isAdmin: true }, isAdmin: true,
        automationStep: true, connectionPolicy: null,
    });
    assert.ok(ctx.allowedToolNames.has('gmail_search'));
});

test('a distinct resource owner asks the catalog with the lending policy', async () => {
    const ctx = { userId: 'u1', resourceOwnerUserId: 'owner', automationId: 'a1', session: {} };
    await assertStepToolPermitted({ id: 's1', tool: 'gmail_search' }, ctx, false, DEPS);
    assert.deepStrictEqual(lookups[0].connectionPolicy,
        { ownerUserId: 'owner', resourceType: 'automation', resourceId: 'a1' });
    assert.strictEqual(lookups[0].isAdmin, false);
});

test('a tool outside the allowed set is refused with the admin message', async () => {
    const ctx = { userId: 'u1', session: {} };
    await assert.rejects(assertStepToolPermitted({ id: 's1', tool: 'gmail_send' }, ctx, true, DEPS),
        /You no longer have permission to use "gmail_send"/);
});

test('a built-in step type named as a tool gets the step-type message', async () => {
    const ctx = { userId: 'u1', session: {} };
    await assert.rejects(assertStepToolPermitted({ id: 's9', tool: 'ai_step' }, ctx, false, DEPS),
        /Step "s9" is an integration action calling "ai_step", but "ai_step" is a built-in step type/);
});

test('a failed lookup fails closed for a side effect', async () => {
    catalog = () => { throw new Error('down'); };
    const ctx = { userId: 'u1', session: {} };
    await assert.rejects(assertStepToolPermitted({ id: 's1', tool: 'gmail_send' }, ctx, true, DEPS),
        /Could not verify your permission for this tool/);
});

test('a failed lookup lets a read-only tool through and skips later checks', async () => {
    catalog = () => { throw new Error('down'); };
    const ctx = { userId: 'u1', session: {} };
    await assertStepToolPermitted({ id: 's1', tool: 'anything' }, ctx, false, DEPS);
    assert.strictEqual(ctx.allowedToolNames, null);
    await assertStepToolPermitted({ id: 's2', tool: 'other' }, ctx, false, DEPS);
    assert.strictEqual(lookups.length, 2, 'null sentinel is falsy, so the lookup is retried');
});
