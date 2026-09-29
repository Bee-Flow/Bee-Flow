/**
 * The knowledge-base adapter: the one member kind with no `project_id`.
 *
 * The route-level behaviour is pinned in routes/projects.resources.test.js.
 * This file covers the edges that never reach a route — the refusals a caller
 * is not supposed to be able to reach, which is exactly where a fail-open
 * default would hide:
 *
 *   - no request to check against, or no project to write to → REFUSED, never
 *     "probably fine";
 *   - a project row whose `version` cannot be read → REFUSED, because a
 *     whole-array replace without a compare-and-swap deletes whatever a
 *     colleague added a second earlier and answers success;
 *   - a list that would exceed the cap → refused with a status the route can
 *     turn into a real answer.
 *
 * Run: cd server && node --test --test-force-exit projects/knowledgeBaseMembership.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

const fx = {
    project: null,
    kbs: {},
    readable: [],
    writes: [],
    conflicts: 0,
    getKBThrows: false,
};

const MOCKS = {
    '../stores/projectStore': {
        getProject: async (id) => (fx.project ? { id, ...fx.project } : null),
        updateProject: async (id, updates, opts) => {
            fx.writes.push({ id, updates, expectedVersion: opts?.expectedVersion ?? null });
            if (fx.conflicts > 0) { fx.conflicts -= 1; fx.project.version += 1; return { conflict: true }; }
            if (updates.knowledgeBaseIds !== undefined) fx.project.knowledgeBaseIds = updates.knowledgeBaseIds;
            fx.project.version += 1;
            return { id, ...fx.project };
        },
    },
    '../stores/knowledgeBases': {
        getKB: async (id) => {
            if (fx.getKBThrows) throw new Error('knowledge base store down');
            return fx.kbs[id] || null;
        },
    },
    '../support/kbAccess': {
        partitionAccessibleKBIds: async (_req, ids) => ({
            allowed: ids.filter(id => fx.readable.includes(id)),
            denied: ids.filter(id => !fx.readable.includes(id)),
        }),
    },
};
const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:kbMembership:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /projects[\\/]knowledgeBaseMembership\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const adapter = require('./knowledgeBaseMembership');
test.after(() => { Module._resolveFilename = originalResolve; });

const REQ = { session: { user: { id: 'alice', organizationId: 'org1' } } };

function reset() {
    fx.project = { name: 'P', organizationId: 'org1', knowledgeBaseIds: ['kb1'], version: 7 };
    fx.kbs = { kb1: { id: 'kb1', name: 'A', organization_id: 'org1' }, kb2: { id: 'kb2', name: 'B', organization_id: 'org1' } };
    fx.readable = ['kb1', 'kb2'];
    fx.writes.length = 0;
    fx.conflicts = 0;
    fx.getKBThrows = false;
}

const ctx = (over = {}) => ({ req: REQ, projectId: 'p1', ...over });

// ═══ Refusals that must never become "allowed" ═══════════════════════

test('attaching with no request to check against is refused', async () => {
    reset();
    const ok = await adapter.setKnowledgeBaseProject('kb2', 'alice', 'p1', ctx({ req: null }));
    assert.strictEqual(ok, false);
    assert.strictEqual(fx.writes.length, 0, 'unresolvable caller is not an authorised caller');
});

test('a move with no project to write to is refused, in BOTH directions', async () => {
    reset();
    assert.strictEqual(await adapter.setKnowledgeBaseProject('kb2', 'alice', 'p1', { req: REQ }), false);
    // Detaching especially: without the project id there is no list to remove
    // from, and "removed" would be a claim about nothing.
    assert.strictEqual(await adapter.setKnowledgeBaseProject('kb1', 'alice', null, { req: REQ }), false);
    assert.strictEqual(fx.writes.length, 0);
});

test('a project that is gone is a refusal, not a create', async () => {
    reset();
    fx.project = null;
    assert.strictEqual(await adapter.setKnowledgeBaseProject('kb2', 'alice', 'p1', ctx()), false);
    assert.strictEqual(await adapter.setKnowledgeBaseProject('kb1', 'alice', null, ctx()), false);
});

test('a project row with no readable version refuses the write', async () => {
    // Without a version there is no compare-and-swap, and the column is
    // replaced WHOLE — so writing anyway would silently delete a base somebody
    // else just added.
    reset();
    fx.project.version = undefined;
    await assert.rejects(
        () => adapter.setKnowledgeBaseProject('kb2', 'alice', 'p1', ctx()),
        (err) => err.status === 409 && err.code === 'no_version',
    );
    assert.strictEqual(fx.writes.length, 0);
});

test('a list that would exceed the cap is refused with a 400', async () => {
    reset();
    fx.project.knowledgeBaseIds = Array.from({ length: adapter.MAX_KB_IDS }, (_, i) => `kb_${i}`);
    fx.kbs.kb_new = { id: 'kb_new', name: 'N', organization_id: 'org1' };
    fx.readable.push('kb_new');

    await assert.rejects(
        () => adapter.setKnowledgeBaseProject('kb_new', 'alice', 'p1', ctx()),
        (err) => err.status === 400 && err.code === 'too_many_knowledge_bases',
    );
    assert.strictEqual(fx.writes.length, 0);
});

test('the cap does not block REMOVING one from an over-full list', async () => {
    reset();
    fx.project.knowledgeBaseIds = Array.from({ length: adapter.MAX_KB_IDS + 5 }, (_, i) => `kb_${i}`);
    const ok = await adapter.setKnowledgeBaseProject('kb_3', 'alice', null, ctx());
    assert.strictEqual(ok, true, 'a cap must never trap someone in a state they want to leave');
    assert.ok(!fx.project.knowledgeBaseIds.includes('kb_3'));
});

// ═══ The listing ═════════════════════════════════════════════════════

test('a store that cannot be read throws through, so the section reads "unavailable"', async () => {
    // Swallowing this would render "Nothing here yet" — telling somebody their
    // project has no knowledge bases when the truth is that nobody looked.
    reset();
    fx.getKBThrows = true;
    await assert.rejects(() => adapter.listProjectKnowledgeBases('p1'), /store down/);
});

test('a project with no bases lists nothing and reads no rows', async () => {
    reset();
    fx.project.knowledgeBaseIds = [];
    assert.deepStrictEqual(await adapter.listProjectKnowledgeBases('p1'), []);
});

test('a project that does not exist lists nothing', async () => {
    reset();
    fx.project = null;
    assert.deepStrictEqual(await adapter.listProjectKnowledgeBases('p1'), []);
    assert.deepStrictEqual(await adapter.listProjectKnowledgeBases(null), []);
});

test('non-string entries in the stored column are ignored, not looked up', async () => {
    reset();
    fx.project.knowledgeBaseIds = ['kb1', null, 42, '', { id: 'kb2' }];
    const list = await adapter.listProjectKnowledgeBases('p1');
    assert.deepStrictEqual(list.map(k => k.id), ['kb1']);
});

// ═══ The validator, in its new home ══════════════════════════════════

test('an empty list is valid and costs nothing', async () => {
    reset();
    assert.deepStrictEqual(await adapter.validateKnowledgeBaseIds(REQ, [], 'org1'), { ok: true, invalid: [] });
});

test('too many ids is its own answer, not a list of invalid ones', async () => {
    reset();
    const ids = Array.from({ length: adapter.MAX_KB_IDS + 1 }, (_, i) => `kb_${i}`);
    const result = await adapter.validateKnowledgeBaseIds(REQ, ids, 'org1');
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.tooMany, true);
});

test('an org-less project matches only org-less bases', async () => {
    // The bug this pins: the guard used to be `if (projectOrg && kb.org && ...)`,
    // and projects.organization_id defaults to '' — so an org-less project
    // accepted literally any base.
    reset();
    fx.kbs.kb_orgless = { id: 'kb_orgless', name: 'X', organization_id: null };
    fx.readable.push('kb_orgless');

    assert.strictEqual((await adapter.validateKnowledgeBaseIds(REQ, ['kb_orgless'], '')).ok, true);
    assert.strictEqual((await adapter.validateKnowledgeBaseIds(REQ, ['kb1'], '')).ok, false,
        'an org base is not fair game for an org-less project');
});

test('a base whose row cannot be read counts as invalid', async () => {
    reset();
    fx.getKBThrows = true;
    const result = await adapter.validateKnowledgeBaseIds(REQ, ['kb1'], 'org1');
    assert.strictEqual(result.ok, false, 'could not check is never allowed');
    assert.deepStrictEqual(result.invalid, ['kb1']);
});
