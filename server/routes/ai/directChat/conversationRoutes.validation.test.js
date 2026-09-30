/**
 * What a direct-chat conversation route accepts, and what it says when it
 * refuses (routes/ai/directChat/conversationRoutes.js).
 *
 * The routes used to normalise a malformed body instead of refusing it: a
 * numeric title went to the store as a number, a string where a boolean
 * belonged pinned the thread, and a key nobody read was answered with 200 —
 * so a user watched a setting they had typed fail to stick with nothing on
 * screen to explain it. The schemas state the contract now, and what this
 * file pins is the part a caller can act on:
 *
 *   - the 400 NAMES the field (`body.title`), not just "invalid request";
 *   - the store is never reached, so a refused request changes nothing.
 *
 * Run: cd server && node --test --test-force-exit routes/ai/directChat/conversationRoutes.validation.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

// ── Fixtures ────────────────────────────────────────────────────────
// Every store call lands in `touched`. A refused request must leave it empty.
const touched = [];
const note = (what) => (...args) => { touched.push({ what, args }); return true; };

const CONV = { id: 'c1', user_id: 'alice', title: 'Chat', sessionSkills: [{ id: 's1', name: 'Stage' }], messages: [] };

const MOCKS = {
    '../../../stores/agentStore': {
        getDirectConversation: async (id, userId) => {
            touched.push({ what: 'getDirectConversation', args: [id, userId] });
            return id === CONV.id && userId === 'alice' ? { ...CONV } : null;
        },
        updateDirectConversationTitle: note('updateTitle'),
        pinDirectConversation: note('pin'),
        setDirectConversationLabels: note('setLabels'),
        setDirectConversationKnowledgeBases: note('setKbs'),
        updateDirectConversationWorkspace: note('setWorkspace'),
        updateDirectConversation: note('updateConversation'),
        createLabel: async (...a) => { touched.push({ what: 'createLabel', args: a }); return { id: 'l1' }; },
        updateLabel: note('updateLabel'),
        deleteLabel: note('deleteLabel'),
        listLabels: async () => [],
        listDirectConversations: async () => [],
        deleteDirectConversation: note('deleteConversation'),
    },
    '../../../stores/skillStore': {
        createSkill: async (...a) => { touched.push({ what: 'createSkill', args: a }); return { id: 'sk1' }; },
    },
    '../../../stores/userStore': {
        getUser: async () => ({ id: 'alice', organizationId: 'orgA' }),
        getOrganization: async () => ({ name: 'Org' }),
    },
    '../../../support/kbAccess': { usableKbIdsForRequest: async (_req, ids) => ids },
    '../../../auth/permissions': {
        requireAuth: (req, res, next) => (req.session?.user?.id ? next() : res.status(401).json({ error: 'Not authenticated' })),
    },
    './shared': { encryptionOpts: () => ({}) },
    '../../../stores/configStore': { getConfig: async () => ({ standard: { modelId: 'm1' } }) },
    '../../../core/aiAgent': { getProviderForModel: async () => ({ providerType: 'claude', url: '' }) },
    '../../../core/providers': { getAdapter: () => ({}) },
    '../../../core/tools/sessionSkillRuntime': { bootstrapSessionSkills: async () => [] },
    '../../../integrations/workspaceTools': {
        notebookLinkRefusal: async (id, userId) => {
            touched.push({ what: 'notebookLinkRefusal', args: [id, userId] });
            return id === 'nb-viewed' ? { status: 403, error: 'You can view this notebook but not change it, so it cannot be linked to a chat.' } : null;
        },
    },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:conv-routes-validation:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /directChat[\\/]conversationRoutes\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./conversationRoutes');
test.after(() => { Module._resolveFilename = originalResolve; });

// A schema refusal travels as an error to the terminal handler, so the harness
// has to be an app with one.
function dispatch({ method, url, body = {}, session = { user: { id: 'alice' } } }) {
    return new Promise((resolve, reject) => {
        const req = { method, url, body, headers: {}, session, query: {}, get() { return undefined; } };
        const res = {
            statusCode: 200,
            status(c) { this.statusCode = c; return this; },
            json(b) { this.body = b; resolve(this); return this; },
            send(b) { this.body = b; resolve(this); return this; },
            end() { resolve(this); return this; },
        };
        router(req, res, (err) => {
            if (!err) return reject(new Error(`fell through: ${method} ${url}`));
            const status = Number(err.status || err.statusCode) || 500;
            if (status >= 500) return reject(err);
            return res.status(status).json({ error: err.message, code: err.code, details: err.details });
        });
    });
}

test.beforeEach(() => { touched.length = 0; });

/** Assert: refused with 400, the named field is in `details`, nothing stored. */
async function refuses(request, field) {
    const res = await dispatch(request);
    assert.strictEqual(res.statusCode, 400, `${request.method} ${request.url} ${JSON.stringify(request.body)}`);
    assert.strictEqual(res.body.code, 'invalid_request');
    assert.ok(res.body.details.some((d) => d.path === field),
        `the 400 must name ${field}; it said ${JSON.stringify(res.body.details)}`);
    assert.deepStrictEqual(touched, [], 'a refused request must not reach the store');
}

// ═══ PATCH /direct/conversations/:id ════════════════════════════════

test('a title that is not text is refused by name', async () => {
    await refuses({ method: 'PATCH', url: '/direct/conversations/c1', body: { title: 42 } }, 'body.title');
});

test('a pin that is not a boolean is refused by name', async () => {
    await refuses({ method: 'PATCH', url: '/direct/conversations/c1', body: { pinned: 'yes' } }, 'body.pinned');
});

test('labels must be a list of ids, and the blank entry is named by index', async () => {
    await refuses({ method: 'PATCH', url: '/direct/conversations/c1', body: { labels: 'work' } }, 'body.labels');
    await refuses({ method: 'PATCH', url: '/direct/conversations/c1', body: { labels: ['ok', ''] } }, 'body.labels.1');
});

test('a key the route does not read is refused rather than answered with 200', async () => {
    // Silently ignoring it is how a rename that never happened looks like a
    // success to the person who typed it.
    const res = await dispatch({ method: 'PATCH', url: '/direct/conversations/c1', body: { titel: 'Nieuw' } });
    assert.strictEqual(res.statusCode, 400);
    assert.deepStrictEqual(touched, []);
});

test('the same knowledge base twice is one question, not two', async () => {
    const res = await dispatch({
        method: 'PATCH', url: '/direct/conversations/c1',
        body: { knowledgeBaseIds: ['kb-a', ' kb-a ', 'kb-b'] },
    });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body.knowledgeBaseIds, ['kb-a', 'kb-b']);
});

// ═══ Labels ═════════════════════════════════════════════════════════

test('a label with no name is refused in words, and nothing is created', async () => {
    const res = await dispatch({ method: 'POST', url: '/labels', body: { color: '#fff' } });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'A label needs a name.', 'the caller reads this sentence');
    assert.ok(res.body.details.some((d) => d.path === 'body.name'));
    assert.deepStrictEqual(touched, []);
});

test('a blank name is refused with the same sentence as a missing one', async () => {
    const res = await dispatch({ method: 'POST', url: '/labels', body: { name: '   ' } });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'A label needs a name.');
});

test('a label without a colour gets the default, from the schema', async () => {
    const res = await dispatch({ method: 'POST', url: '/labels', body: { name: 'Work' } });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(touched[0], { what: 'createLabel', args: ['alice', 'Work', '#6366f1'] });
});

test('renaming a label does not have to resend its colour', async () => {
    const res = await dispatch({ method: 'PATCH', url: '/labels/l1', body: { name: 'Home' } });
    assert.strictEqual(res.statusCode, 200);
});

// ═══ Workspace ══════════════════════════════════════════════════════

test('workspace content that is not a string is refused by name, before the read', async () => {
    // It used to reach the store, throw INVALID_WORKSPACE_CONTENT and come
    // back as a 500 the client swallowed — every save silently lost its text.
    await refuses({ method: 'PUT', url: '/direct/conversations/c1/workspace', body: { content: 42 } }, 'body.content');
});

test('an absent workspace body clears the content rather than refusing', async () => {
    const res = await dispatch({ method: 'PUT', url: '/direct/conversations/c1/workspace', body: {} });
    assert.strictEqual(res.statusCode, 200);
    const write = touched.find((t) => t.what === 'setWorkspace');
    assert.deepStrictEqual(write.args, ['c1', '', null, 'alice']);
});

test('linking a notebook the caller cannot change is refused, and nothing is linked', async () => {
    // The chat's notebook tools write through the link, into a notebook that may be co-edited.
    const refused = await dispatch({ method: 'PUT', url: '/direct/conversations/c1/workspace', body: { content: 'x', notebookId: 'nb-viewed' } });
    assert.strictEqual(refused.statusCode, 403);
    assert.deepStrictEqual(touched.find((t) => t.what === 'notebookLinkRefusal').args, ['nb-viewed', 'alice']);
    assert.strictEqual(touched.find((t) => t.what === 'setWorkspace'), undefined);

    const linked = await dispatch({ method: 'PUT', url: '/direct/conversations/c1/workspace', body: { content: 'x', notebookId: 'nb-mine' } });
    assert.strictEqual(linked.statusCode, 200);
    assert.deepStrictEqual(touched.find((t) => t.what === 'setWorkspace').args, ['c1', 'x', 'nb-mine', 'alice']);
});

// ═══ Importing a session skill ══════════════════════════════════════

test('a skill name that is not text is refused by name, and no skill is created', async () => {
    await refuses({ method: 'POST', url: '/direct/conversations/c1/session-skills/s1/import', body: { name: 42 } }, 'body.name');
});

test('the import defaults live in the schema: private, dynamically activated', async () => {
    const res = await dispatch({ method: 'POST', url: '/direct/conversations/c1/session-skills/s1/import', body: {} });
    assert.strictEqual(res.statusCode, 200);
    const created = touched.find((t) => t.what === 'createSkill').args[0];
    assert.strictEqual(created.isShared, false);
    assert.strictEqual(created.dynamicActivation, true);
    assert.strictEqual(created.name, 'Stage', 'no name given means the session skill keeps its own');
});

// ═══ Regenerating session skills ════════════════════════════════════

test('a regenerate body with a key nobody reads is refused', async () => {
    await refuses({ method: 'POST', url: '/direct/conversations/c1/session-skills/regenerate', body: { tz: 'Europe/Amsterdam' } }, 'body');
});

test('a blank timezone means UTC, not a refusal — no zone was claimed', async () => {
    const res = await dispatch({
        method: 'POST', url: '/direct/conversations/c1/session-skills/regenerate', body: { timezone: '' },
    });
    assert.strictEqual(res.statusCode, 200);
});
