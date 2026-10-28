// @typecheck
'use strict';

/**
 * automations_run (automation/mcpRunNow.js): a real run through the product's
 * own entry point, only for an automation a person has activated, only with the
 * run scope, audited, rate limited and capped. Collaborators are handed in.
 *
 * Run: cd server && node --test automation/mcpRunNow.test.js
 */

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');

const { makeRunNow, RUN_NOW_AUDIT_ACTION } = require('./mcpRunNow');
const { normalizeScopes, scopeAllowsTool, filterToolsByScope } = require('../auth/mcpAccess/scopes');
const mcpBuilder = require('./mcpBuilder');
const automationsRoute = require('../routes/mcpAutomations');
const { roleSatisfies } = require('./access');

const PRIVATE = 'jan@example.test';

/** @param {Record<string, any>} [o] */
function setup({
    automation = {}, role = 'owner', orgs = ['org_a'], chargeOk = true, runResult = /** @type {any} */ ({ id: 'run_1', status: 'success' }),
    runner = null, notice = { applies: false, seen: false },
    // The definition gate has its own tests below; null = the real validator.
    validate = () => ({ ok: true }),
} = {}) {
    const calls = { run: [], audit: [], charge: [], notice: 0 };
    const stored = {
        id: 'auto_1', userId: 'u1', organizationId: 'org_a', kind: 'automation', isActive: true, version: 3,
        definition: { trigger: { id: 'trg', kind: 'manual' }, steps: [], edges: [] }, ...automation,
    };
    const runNow = makeRunNow({
        store: { getAutomation: async (id) => (id === stored.id ? stored : null) },
        access: { roleFor: async () => ({ role }) },
        roleSatisfies,
        getUser: async (id) => ({ id, organizationId: 'org_a' }),
        resolveOrgs: async () => ({ primary: orgs[0] || null, all: orgs }),
        runner: runner || {
            executeAutomation: async (a, opts) => {
                calls.run.push({ a, opts });
                await opts.onRunCreated({ id: runResult.id });
                return runResult;
            },
        },
        automationForRun: (a) => a,
        entry: require('../core/automationRunner/entryPoint'),
        describeNoticeFor: async () => { calls.notice += 1; return notice; },
        charge: async (name, key, cost, max) => { calls.charge.push({ name, key, cost, max }); return chargeOk ? { ok: true } : { ok: false, retryAfter: 12 }; },
        audit: async (...args) => { calls.audit.push(args); },
        ...(validate ? { validate } : {}),
    });
    return { calls, runNow, stored };
}

const ctx = { userId: 'u1', tokenId: 'tok_1' };
const run = (s, args, c = ctx) => s.runNow.call('automations_run', { automationId: 'auto_1', ...args }, c);

test('starts the run through executeAutomation, as the product does, and returns the runId', async () => {
    const s = setup();
    const out = await run(s, { input: { orderId: 7 } });
    assert.deepEqual([out.runId, out.status, out.automationId], ['run_1', 'started', 'auto_1']);
    assert.equal(s.calls.run.length, 1);
    const { opts } = s.calls.run[0];
    assert.equal(opts.triggerKind, 'manual');
    assert.equal(opts.mode, 'live');
    assert.equal(opts.isTest, false);
    assert.equal(opts.startedByUserId, 'u1');
    assert.deepEqual(opts.triggerPayload, { orderId: 7 });
});

test('an inactive automation is refused and nothing is started, charged or audited', async () => {
    for (const isActive of [false, undefined, null, 'true', 1]) {
        const s = setup({ automation: { isActive } });
        const out = await run(s, {});
        assert.equal(out.code, 'automation_not_active');
        assert.match(out.error, /human decision/);
        assert.equal(s.calls.run.length, 0);
        assert.equal(s.calls.audit.length, 0);
        assert.equal(s.calls.charge.length, 0);
    }
});

test('a reusable Step (kind block) is not an automation to run', async () => {
    const s = setup({ automation: { kind: 'block' } });
    assert.equal((await run(s, {})).code, 'not_found');
    assert.equal(s.calls.run.length, 0);
});

test('authorisation is the product\'s: owner or a role that may run; anything else reads as not found', async () => {
    // The product's own rule (automation/access.js mayStartRun): the run role and edit and
    // up start it; a view share reads it but does not (its own test below).
    for (const role of ['owner', 'edit', 'run']) {
        const s = setup({ role });
        assert.equal((await run(s, {})).status, 'started', role);
    }
    for (const role of [null, 'unknown']) {
        const s = setup({ role });
        const out = await run(s, {});
        assert.equal(out.code, 'not_found', String(role));
        assert.equal(s.calls.run.length, 0);
        assert.equal(s.calls.audit.length, 0);
    }
    const missing = await setup().runNow.call('automations_run', { automationId: 'auto_404' }, ctx);
    assert.equal(missing.code, 'not_found');
});

test('an automation of an organisation the caller is not in is not found, and a failed org lookup denies', async () => {
    const s = setup({ orgs: ['org_other'] });
    assert.equal((await run(s, {})).code, 'not_found');
    assert.equal(s.calls.run.length, 0);

    const failing = makeRunNow({
        store: { getAutomation: async () => ({ id: 'auto_1', userId: 'u1', organizationId: 'org_a', isActive: true }) },
        access: { roleFor: async () => ({ role: 'owner' }) },
        roleSatisfies,
        getUser: async () => ({ id: 'u1', organizationId: '', groups: ['g1'] }),
        resolveOrgs: async () => { throw new Error('groups unreadable'); },
        runner: { executeAutomation: async () => { throw new Error('must not run'); } },
    });
    assert.equal((await failing.call('automations_run', { automationId: 'auto_1' }, ctx)).code, 'not_found');
});

test('a group-only member (no home organisation) reaches the automation of a group organisation', async () => {
    const s = makeRunNow({
        store: { getAutomation: async () => ({ id: 'auto_1', userId: 'u2', organizationId: 'org_g', isActive: true, definition: { trigger: { id: 't', kind: 'manual' } } }) },
        access: { roleFor: async () => ({ role: 'run' }) },
        roleSatisfies,
        getUser: async () => ({ id: 'u1', organizationId: '', groups: ['g1'] }),
        resolveOrgs: async () => ({ primary: 'org_g', all: ['org_g'] }),
        runner: { executeAutomation: async (a, o) => { await o.onRunCreated({ id: 'r9' }); return { id: 'r9', status: 'success' }; } },
        automationForRun: (a) => a,
        entry: require('../core/automationRunner/entryPoint'),
        describeNoticeFor: async () => ({ applies: false }),
        charge: async () => ({ ok: true }),
        audit: async () => {},
        validate: () => ({ ok: true }),
    });
    assert.equal((await s.call('automations_run', { automationId: 'auto_1' }, ctx)).runId, 'r9');
});

test('the audit row names who started which run via which token, and never the input', async () => {
    const s = setup();
    await run(s, { input: { email: PRIVATE, n: 1 } });
    assert.equal(s.calls.audit.length, 1);
    const [action, targetType, targetId, actor, before, after, orgId] = s.calls.audit[0];
    assert.equal(action, RUN_NOW_AUDIT_ACTION);
    assert.deepEqual([targetType, targetId, actor, before, orgId], ['automation', 'auto_1', 'u1', null, 'org_a']);
    assert.equal(after.via, 'mcp');
    assert.equal(after.tokenId, 'tok_1');
    assert.equal(after.inputKeys, 2);
    assert.ok(!JSON.stringify(s.calls.audit).includes(PRIVATE));
});

test('the audit row is written before the run starts', async () => {
    const order = [];
    const s = setup({
        runner: { executeAutomation: async (a, o) => { order.push('run'); await o.onRunCreated({ id: 'r1' }); return { id: 'r1', status: 'success' }; } },
    });
    const orig = s.calls.audit.push.bind(s.calls.audit);
    s.calls.audit.push = (...a) => { order.push('audit'); return orig(...a); };
    await run(s, {});
    assert.deepEqual(order, ['audit', 'run']);
});

test('rate limits: per user and per automation, one unit per start, charged only for an authorised call', async () => {
    const s = setup();
    await run(s, {});
    assert.deepEqual(s.calls.charge.map((c) => [c.name, c.key, c.cost]), [
        ['mcp-run-user', 'user:u1', 1],
        ['mcp-run-automation', 'automation:auto_1', 1],
    ]);
    const limited = setup({ chargeOk: false });
    const out = await run(limited, {});
    assert.equal(out.code, 'rate_limited');
    assert.equal(limited.calls.run.length, 0);
    assert.equal(limited.calls.audit.length, 0);
    const forbidden = setup({ role: null });
    await run(forbidden, {});
    assert.equal(forbidden.calls.charge.length, 0);
});

test('input: must be an object, and is capped (env, 0 = unlimited)', async () => {
    const was = process.env.AUTOMATION_MCP_RUN_INPUT_MAX_BYTES;
    try {
        assert.equal((await run(setup(), { input: [1] })).code, 'invalid_input');
        assert.equal((await run(setup(), { input: 'x' })).code, 'invalid_input');
        process.env.AUTOMATION_MCP_RUN_INPUT_MAX_BYTES = '50';
        const s = setup();
        const out = await run(s, { input: { big: 'x'.repeat(100) } });
        assert.equal(out.code, 'input_too_large');
        assert.equal(s.calls.run.length, 0);
        process.env.AUTOMATION_MCP_RUN_INPUT_MAX_BYTES = '0';
        assert.equal((await run(setup(), { input: { big: 'x'.repeat(100000) } })).status, 'started');
    } finally {
        if (was === undefined) delete process.env.AUTOMATION_MCP_RUN_INPUT_MAX_BYTES; else process.env.AUTOMATION_MCP_RUN_INPUT_MAX_BYTES = was;
    }
});

test('an app-event trigger needs the event as input', async () => {
    const def = { trigger: { id: 'trg', kind: 'app_event', appEvent: { provider: 'gmail', event: 'mail.new' } } };
    const s = setup({ automation: { definition: def } });
    assert.equal((await run(s, {})).code, 'input_required');
    assert.equal(s.calls.run.length, 0);
    assert.equal((await run(setup({ automation: { definition: def } }), { input: { subject: 's' } })).status, 'started');
});

test('the caller notice of a run on the caller\'s own connections must be acknowledged first', async () => {
    const s = setup({ role: 'run', notice: { applies: true, seen: false } });
    const out = await run(s, {});
    assert.equal(out.code, 'caller_notice_required');
    assert.equal(s.calls.run.length, 0);
    assert.equal((await run(setup({ role: 'run', notice: { applies: true, seen: true } }), {})).status, 'started');
});

test('wait: returns the final status; a run that is still going comes back as running and keeps going', async () => {
    const done = setup({ runResult: { id: 'run_1', status: 'error', errorClass: 'http_failed' } });
    const out = await run(done, { wait: true });
    assert.deepEqual([out.status, out.errorClass, out.runId], ['error', 'http_failed', 'run_1']);

    const was = process.env.AUTOMATION_MCP_RUN_WAIT_MAX_SECONDS;
    process.env.AUTOMATION_MCP_RUN_WAIT_MAX_SECONDS = '1';
    try {
        /** @type {(v?: any) => void} */
        let finish = () => {};
        const slow = setup({
            runner: {
                executeAutomation: async (a, o) => {
                    await o.onRunCreated({ id: 'run_slow' });
                    await new Promise((resolve) => { finish = resolve; });
                    return { id: 'run_slow', status: 'success' };
                },
            },
        });
        const t0 = Date.now();
        const res = await run(slow, { wait: true, waitSeconds: 600 });
        assert.ok(Date.now() - t0 < 3000, 'bounded by the instance cap, not by what was asked');
        assert.deepEqual([res.status, res.waitTimedOut, res.runId], ['running', true, 'run_slow']);
        finish();
    } finally {
        if (was === undefined) delete process.env.AUTOMATION_MCP_RUN_WAIT_MAX_SECONDS; else process.env.AUTOMATION_MCP_RUN_WAIT_MAX_SECONDS = was;
    }
    assert.equal((await run(setup(), { wait: 'yes' })).code, 'invalid_wait');
});

test('a run that fails to start is an error, not a runId', async () => {
    const s = setup({ runner: { executeAutomation: async () => { throw new Error('db down'); } } });
    const out = await run(s, {});
    assert.equal(out.code, 'start_failed');
    assert.ok(!out.runId);
});

// ── The scope ───────────────────────────────────────────────────────────────

test('scope: automations.run is its own switch, off by default, never in a plain write token', () => {
    assert.deepEqual(normalizeScopes({ automations: { level: 'write' } }), { automations: { level: 'write' } });
    assert.deepEqual(normalizeScopes({ automations: { level: 'write', run: true } }), { automations: { level: 'write', run: true } });
    assert.deepEqual(normalizeScopes({ automations: { level: 'write', run: false } }), { automations: { level: 'write' } });
    assert.throws(() => normalizeScopes({ automations: { level: 'read', run: true } }), /write/);
    assert.throws(() => normalizeScopes({ automations: { level: 'write', run: 'yes' } }), /true or false/);
    assert.throws(() => normalizeScopes({ studio: { level: 'write', run: true } }), /not a valid setting/);

    assert.equal(scopeAllowsTool({ automations: { level: 'write' } }, 'automations', 'automations_run'), false);
    assert.equal(scopeAllowsTool({ automations: { level: 'write', run: true } }, 'automations', 'automations_run'), true);
    assert.equal(scopeAllowsTool({ automations: { level: 'read', run: true } }, 'automations', 'automations_run', { readOnly: true }), true,
        'level read cannot be combined with run at creation; a stored odd scope still needs readOnly');
    assert.equal(scopeAllowsTool({ automations: { level: 'write', run: true, tools: ['automations_list'] } }, 'automations', 'automations_run'), false);
});

test('scope: the legacy token has no run right', () => {
    const { LEGACY_SCOPES } = require('../auth/mcpAccess/scopes');
    assert.equal(scopeAllowsTool(LEGACY_SCOPES, 'automations', 'automations_run'), false);
});

test('scope on the MCP surface: missing scope hides and refuses the tool; the scope shows and reaches it', async () => {
    const entitled = async () => true;
    const names = async (scopes) => (await automationsRoute.handleRpc({ id: 1, method: 'tools/list' }, 'u1', { token: { id: 't', name: 'n', scopes } }, { entitled })).result.tools.map((t) => t.name);
    assert.ok(!(await names({ automations: { level: 'write' } })).includes('automations_run'));
    assert.ok((await names({ automations: { level: 'write', run: true } })).includes('automations_run'));
    assert.ok(!(await names({ automations: { level: 'read' } })).includes('automations_run'));

    const res = await automationsRoute.handleRpc(
        { id: 2, method: 'tools/call', params: { name: 'automations_run', arguments: { automationId: 'auto_1' } } },
        'u1', { token: { id: 't', name: 'n', scopes: { automations: { level: 'write' } } } }, { entitled });
    assert.equal(res.result.isError, true);
    assert.match(res.result.content[0].text, /not available to this token/);
});

test('automations_run is advertised as a writing tool, with the automationId in its schema', () => {
    const tool = mcpBuilder.buildToolList().find((t) => t.name === 'automations_run');
    assert.ok(tool);
    assert.equal(tool.annotations.readOnlyHint, false);
    assert.ok(tool.inputSchema.required.includes('automationId'));
    assert.deepEqual(filterToolsByScope({ automations: { level: 'write' } }, 'automations', [tool]), []);
});

test('the guide and the instructions keep activation a human decision', async () => {
    assert.match(automationsRoute.INSTRUCTIONS, /Activation is a human decision/);
    assert.match(automationsRoute.INSTRUCTIONS, /refuses an inactive automation/);
    const section = require('./mcpRunTools').guideSection();
    assert.match(section, /Activation is still a human decision/);
    assert.match(section, /never activates, publishes or edits/);
});

test('a view share is refused with automation_run_forbidden; edit and run shares start it', async () => {
    const viewer = setup({ role: 'view' });
    const out = await run(viewer, {});
    assert.equal(out.code, 'automation_run_forbidden');
    assert.equal(viewer.calls.run.length, 0);
    assert.equal(viewer.calls.audit.length, 0, 'a refusal writes no run audit row');
    assert.equal((await run(setup({ role: 'edit' }), {})).status, 'started');
    assert.equal((await run(setup({ role: 'run' }), {})).status, 'started');
});

// ── #200: the copy the run executes must validate ──────────────────────────

/** A saved working copy with an expr binding that does not parse (an object literal). */
const brokenDef = () => ({
    trigger: { id: 'trg', kind: 'manual' },
    steps: [{
        id: 'a1', type: 'integration_action', tool: 'nextcloud_tables_create_row',
        inputs: { tableId: { kind: 'literal', value: 1 }, values: { kind: 'expr', value: '({ Name: trigger.output.name })' } },
    }],
    edges: [{ from: 'trg', to: 'a1' }],
});

test('an active automation whose working copy has validation errors is refused, with the errors, and nothing starts', async () => {
    const s = setup({ automation: { definition: brokenDef(), isDraft: true }, validate: null });
    const out = await run(s, {});
    assert.equal(out.code, 'automation_invalid');
    assert.match(out.error, /does not validate/);
    assert.ok(Array.isArray(out.validationErrors) && out.validationErrors.length > 0);
    assert.ok(out.validationErrors.some((e) => e.code === 'expr.parse'));
    assert.ok(out.validationErrors.every((e) => typeof e.code === 'string' && typeof e.message === 'string'));
    assert.equal(s.calls.run.length, 0);
    assert.equal(s.calls.audit.length, 0);
    assert.equal(s.calls.charge.length, 0);
});

test('a definition that validates runs through the real validator', async () => {
    const s = setup({ validate: null });
    assert.equal((await run(s, {})).status, 'started');
});

test('the gate validates the copy the run executes, not the stored working copy', async () => {
    const seen = [];
    const live = { trigger: { id: 'trg', kind: 'manual' }, steps: [], edges: [] };
    const s = setup({
        automation: { definition: brokenDef() },
        validate: (def) => { seen.push(def); return { ok: true }; },
    });
    // automationForRun picks the live copy; the stub in setup returns the row itself,
    // so swap it for one that hands back the live definition.
    const runNow = makeRunNow({
        store: { getAutomation: async () => s.stored },
        access: { roleFor: async () => ({ role: 'owner' }) },
        roleSatisfies,
        getUser: async (id) => ({ id, organizationId: 'org_a' }),
        resolveOrgs: async () => ({ primary: 'org_a', all: ['org_a'] }),
        runner: { executeAutomation: async (a, o) => { await o.onRunCreated({ id: 'r2' }); return { id: 'r2', status: 'success' }; } },
        automationForRun: (a) => ({ ...a, definition: live, runsLiveVersion: true }),
        entry: require('../core/automationRunner/entryPoint'),
        describeNoticeFor: async () => ({ applies: false }),
        charge: async () => ({ ok: true }),
        audit: async () => {},
        validate: (def) => { seen.push(def); return { ok: true }; },
    });
    assert.equal((await runNow.call('automations_run', { automationId: 'auto_1' }, ctx)).runId, 'r2');
    assert.deepEqual(seen, [live]);
});
