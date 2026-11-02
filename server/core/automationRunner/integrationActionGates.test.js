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
const permitAsks = [];
/** @type {(opts?: unknown) => boolean} */
let permitted = () => true;

const restore = installResolveStub({
    '../integrations/integrationTools': {
        async getIntegrationTools(opts) { lookups.push(opts); return catalog(); },
        async isIntegrationPermittedForUser(opts) { permitAsks.push(opts); return permitted(opts); },
    },
    '../../automation/builtinStepTools': { isBuiltinStepType: (t) => t === 'ai_step' },
});
after(() => restore());

// The tool -> app lookup goes through core/featureModules (boot registers the real registry).
const { registerFeatureModules } = require('../featureModules');
registerFeatureModules({
    'automation/toolRegistry': () => ({
        findOwnerOfTool: (name) => (name.startsWith('nextcloud_') ? { app: 'nextcloud' } : name.startsWith('gmail_') ? { app: 'gmail' } : null),
    }),
});

const { assertStepToolPermitted } = require('./integrationActionGates');
// What execAi.js hands over in production: the lazy getter for the catalog.
// The require string is the one execAi.js uses, so the stub above answers it.
const DEPS = { integrationTools: () => require('../integrations/integrationTools') };

beforeEach(() => {
    lookups.length = 0;
    permitAsks.length = 0;
    permitted = () => true;
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
        (/** @type {any} */ e) => /You no longer have permission to use "gmail_send"/.test(e.message) && e.stepErrorCode === 'tool_not_permitted');
    assert.deepStrictEqual(permitAsks, [], 'only a Nextcloud step asks the design-time gate');
});

// BFSF-490: the owner's headless session had no Nextcloud binding, so no NC
// tool was offered and the run sent the user to an admin who could not help.
test('a Nextcloud tool missing because the owner has no Nextcloud connection says so, not "ask your admin"', async () => {
    const ctx = { userId: 'owner', session: { user: { id: 'owner' } } };
    await assert.rejects(assertStepToolPermitted({ id: 'up', tool: 'nextcloud_upload_file' }, ctx, true, DEPS), (/** @type {any} */ e) => {
        assert.strictEqual(e.stepErrorCode, 'nextcloud_not_connected');
        assert.doesNotMatch(e.message, /Ask your organisation admin/);
        assert.match(e.message, /Nextcloud is not connected for the owner of this automation/);
        return true;
    });
    assert.deepStrictEqual(permitAsks, [{ userId: 'owner', appId: 'nextcloud', session: { user: { id: 'owner' } }, isAdmin: false }]);
});

test('a Nextcloud tool the app gate denies keeps the admin message', async () => {
    permitted = () => false;
    const ctx = { userId: 'owner', session: {} };
    await assert.rejects(assertStepToolPermitted({ id: 'up', tool: 'nextcloud_upload_file' }, ctx, true, DEPS),
        (/** @type {any} */ e) => /You no longer have permission to use "nextcloud_upload_file"/.test(e.message) && e.stepErrorCode === 'tool_not_permitted');
});

test('a Nextcloud tool missing while other Nextcloud tools are offered is a real denial', async () => {
    catalog = () => ({ tools: [{ function: { name: 'nextcloud_list_files' } }] });
    const ctx = { userId: 'owner', session: {} };
    await assert.rejects(assertStepToolPermitted({ id: 'up', tool: 'nextcloud_upload_file' }, ctx, true, DEPS),
        (/** @type {any} */ e) => e.stepErrorCode === 'tool_not_permitted');
    assert.deepStrictEqual(permitAsks, [], 'connected: the design-time gate is not even asked');
});

test('a failing design-time lookup, or a caller-only run, keeps the admin message', async () => {
    permitted = () => { throw new Error('store down'); };
    await assert.rejects(assertStepToolPermitted({ id: 'up', tool: 'nextcloud_upload_file' }, { userId: 'owner', session: {} }, true, DEPS),
        (/** @type {any} */ e) => e.stepErrorCode === 'tool_not_permitted');
    permitted = () => true;
    permitAsks.length = 0;
    const callerCtx = { userId: 'owner', session: {}, callerOnly: { userId: 'caller', orgId: 'o', session: {} } };
    await assert.rejects(assertStepToolPermitted({ id: 'up', tool: 'nextcloud_upload_file' }, callerCtx, true, DEPS),
        (/** @type {any} */ e) => e.stepErrorCode === 'tool_not_permitted');
    assert.deepStrictEqual(permitAsks, []);
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
