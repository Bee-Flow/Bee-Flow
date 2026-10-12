/**
 * What the agent version routes accept, and what a restore writes back
 * (routes/versions.js).
 *
 * The bodies: pre-refine, restore and delete act on what the path names, so
 * each takes an empty body, and a key is refused by name before anything is
 * read or written.
 *
 * The restore itself, three things that used to go wrong under a 200:
 *
 *   - A snapshot is the raw Postgres row, so its on/off settings are true or
 *     false. The restore read them as `x !== 0`, and `false !== 0` is true:
 *     every restore switched ON whatever the version had off. workspace and
 *     embed are off by default, so restoring any ordinary agent made it
 *     embeddable and gave it a workspace.
 *
 *   - The org and the shared groups were written back from the snapshot.
 *     Those are access decisions and they are live, so a version from before
 *     the agent was narrowed to one group (`[]` = the whole organisation)
 *     widened who could see it the moment the restore landed.
 *
 *   - updateAgent matches on the owner it is handed. The restore handed it the
 *     snapshot's owner, so after the agent changed hands no row matched,
 *     nothing was restored, and the answer was still `{ success: true }`.
 *
 * Run: cd server && node --test --test-force-exit routes/versions.validation.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

const pass = (req, res, next) => next();

// Every store write lands in `touched`. A refused request must leave it empty.
const touched = [];
const fx = { agents: {}, versions: {}, updateResult: null };

const MOCKS = {
    '../stores/versionStore': {
        getVersions: async () => [],
        getVersion: async (id) => fx.versions[id] || null,
        deleteVersion: async (id) => { touched.push({ what: 'deleteVersion', args: [id] }); return true; },
    },
    '../stores/agentStore': {
        getAgent: async (id) => fx.agents[id] || null,
        updateAgent: async (...args) => { touched.push({ what: 'updateAgent', args }); return fx.updateResult || { ok: true, rev: 2 }; },
        snapshotAgent: async (...args) => { touched.push({ what: 'snapshotAgent', args }); return { id: 'v-pre', version_number: 9, kind: 'pre_refine' }; },
    },
    '../auth': { requireAuth: pass },
    '../utils/routeHelpers': { getEffectiveUserId: (req) => req.session?.user?.id },
    './agents/crud': { canModifyAgent: async () => true },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:versions-validation:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /routes[\\/]versions\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./versions');
test.after(() => { Module._resolveFilename = originalResolve; });

const { dispatcher } = require('../core/http/routeHarness');

const dispatch = dispatcher(router, { session: () => ({ user: { id: 'editor' }, isAuthenticated: true }) });

// The positions updateAgent takes its arguments in (stores/agent/agentCrud.js).
const ARG = { owner: 4, threads: 8, copy: 9, workspace: 10, embed: 12, org: 13, groups: 14 };

// A raw Postgres row as snapshotAgent / updateAgent store it: BOOLEAN columns
// are true/false, shared_groups is JSON text.
function rawRow(overrides = {}) {
    return {
        id: 'a1', name: 'Helpdesk', description: '', system_prompt: 'old prompt', owner_id: 'editor',
        model: 'tier:fast', starter_prompts: '[]', avatar: null, config: '{}',
        threads_enabled: true, copy_enabled: true, workspace_enabled: false, embed_enabled: false,
        organization_id: 'orgA', shared_groups: '[]',
        ...overrides,
    };
}

function restoreCall() {
    const call = touched.find((t) => t.what === 'updateAgent');
    assert.ok(call, 'the restore wrote the agent');
    return call.args;
}

test.beforeEach(() => {
    touched.length = 0;
    fx.updateResult = null;
    fx.agents = {
        a1: {
            id: 'a1', owner_id: 'editor', organization_id: 'orgA', shared_groups: ['hr'],
            threads_enabled: true, copy_enabled: true, workspace_enabled: false, embed_enabled: false,
        },
    };
    fx.versions = {
        v1: { id: 'v1', agent_id: 'a1', agent_type: 'agent', version_number: 3, snapshot: rawRow() },
    };
});

// ── Bodies ────────────────────────────────────────────────────────────

test('a restore of part of a version is refused by name, instead of restoring all of it', async () => {
    const res = await dispatch({ method: 'POST', url: '/a1/v1/restore', body: { fields: ['system_prompt'] } });
    assert.strictEqual(res.statusCode, 400);
    assert.match(res.body.error, /'fields'/, 'the sentence names the key it would have ignored');
    assert.ok(res.body.details.some((d) => d.path === 'body'));
    assert.deepStrictEqual(touched, []);
});

test('a pre-refine snapshot with a summary is refused by name, and takes no snapshot', async () => {
    const res = await dispatch({ method: 'POST', url: '/a1/pre-refine', body: { changeSummary: 'mine' } });
    assert.strictEqual(res.statusCode, 400);
    assert.match(res.body.error, /'changeSummary'/);
    assert.deepStrictEqual(touched, []);
});

test('a delete with a body is refused, and deletes nothing', async () => {
    const res = await dispatch({ method: 'DELETE', url: '/a1/v1', body: { versionIds: ['v1', 'v2'] } });
    assert.strictEqual(res.statusCode, 400);
    assert.match(res.body.error, /'versionIds'/);
    assert.deepStrictEqual(touched, []);
});

test('the editor\'s calls, which send no body, still go through', async () => {
    assert.strictEqual((await dispatch({ method: 'POST', url: '/a1/pre-refine' })).statusCode, 200);
    assert.strictEqual((await dispatch({ method: 'POST', url: '/a1/v1/restore' })).statusCode, 200);
    assert.strictEqual((await dispatch({ method: 'DELETE', url: '/a1/v1', body: {} })).statusCode, 200);
});

// ── What a restore writes ─────────────────────────────────────────────

test('a setting that was off in the version stays off after the restore', async () => {
    const res = await dispatch({ method: 'POST', url: '/a1/v1/restore' });
    assert.strictEqual(res.statusCode, 200);
    const args = restoreCall();
    assert.strictEqual(args[ARG.embed], false, 'embed was off in the version; `false !== 0` switched it on');
    assert.strictEqual(args[ARG.workspace], false, 'the workspace was off in the version');
    assert.strictEqual(args[ARG.threads], true);
    assert.strictEqual(args[ARG.copy], true);
});

test('threads and copy switched off in the version are restored off', async () => {
    fx.versions.v1.snapshot = rawRow({ threads_enabled: false, copy_enabled: false });
    await dispatch({ method: 'POST', url: '/a1/v1/restore' });
    const args = restoreCall();
    assert.strictEqual(args[ARG.threads], false);
    assert.strictEqual(args[ARG.copy], false);
});

test('a snapshot from the integer era is read the same way', async () => {
    fx.versions.v1.snapshot = rawRow({ threads_enabled: 0, embed_enabled: 1 });
    await dispatch({ method: 'POST', url: '/a1/v1/restore' });
    const args = restoreCall();
    assert.strictEqual(args[ARG.threads], false);
    assert.strictEqual(args[ARG.embed], true);
});

test('a snapshot without a setting keeps what the agent has now', async () => {
    const snap = rawRow();
    delete snap.embed_enabled;
    fx.versions.v1.snapshot = snap;
    fx.agents.a1.embed_enabled = false;
    await dispatch({ method: 'POST', url: '/a1/v1/restore' });
    assert.strictEqual(restoreCall()[ARG.embed], false, 'a missing setting is not "on"');
});

test('a version from before the agent was narrowed to a group does not hand it back to the whole org', async () => {
    // The agent is shared with 'hr' only; the version predates that and
    // carries `[]` — which reads as "everyone in the organisation".
    fx.versions.v1.snapshot = rawRow({ shared_groups: '[]' });
    const res = await dispatch({ method: 'POST', url: '/a1/v1/restore' });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(restoreCall()[ARG.groups], undefined, 'undefined = preserve the groups the agent has now');
});

test('a version from before the agent had an org does not take it out of the org', async () => {
    fx.versions.v1.snapshot = rawRow({ organization_id: null });
    await dispatch({ method: 'POST', url: '/a1/v1/restore' });
    assert.strictEqual(restoreCall()[ARG.org], undefined, 'undefined = preserve the org the agent has now');
});

test('an agent that changed hands is restored under its current owner', async () => {
    // The version was taken while 'leaver' owned the agent; it was handed to
    // 'editor' when 'leaver' left the org.
    fx.versions.v1.snapshot = rawRow({ owner_id: 'leaver' });
    await dispatch({ method: 'POST', url: '/a1/v1/restore' });
    assert.strictEqual(restoreCall()[ARG.owner], 'editor');
});

test('a restore that wrote no row is not answered with success', async () => {
    fx.updateResult = { ok: false, notFound: true };
    const res = await dispatch({ method: 'POST', url: '/a1/v1/restore' });
    assert.strictEqual(res.statusCode, 409);
    assert.strictEqual(res.body.code, 'restore_not_applied');
    assert.notStrictEqual(res.body.success, true);
});
