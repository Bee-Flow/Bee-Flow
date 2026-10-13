/**
 * projectStore — GOLDEN characterisation, pinned before the split into
 * stores/project/*. Drives the REAL factory (`makeProjectStore`) over a
 * recording fake of db.js's facade and snapshots, per scenario, every
 * outbound call in order (method, whitespace-normalised SQL, params with
 * random UUIDs masked) plus the returned value. Also pins the exported key
 * sets of the module and of a built store, in order.
 *
 * Regenerate only when a behaviour change is intended:
 *   cd server && UPDATE_GOLDEN=1 node --test stores/projectStore.characterisation.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const projectStore = require('./projectStore');
const { makeProjectStore } = projectStore;

const GOLDEN_PATH = path.join(__dirname, 'projectStore.characterisation.golden.json');
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

function mask(value) {
    return JSON.parse(JSON.stringify(value === undefined ? null : value, (_k, v) => (typeof v === 'string' ? v.replace(UUID, '<uuid>') : v)));
}

const norm = (sql) => String(sql).replace(/\s+/g, ' ').trim();

/**
 * A fake facade: each call is recorded and answered by the first matching
 * responder ([regex, answer]); the answer is a value or a function of params.
 */
function fakeDb(responders = []) {
    const calls = [];
    const answer = (method, sql, params) => {
        calls.push([method, norm(sql), params === undefined ? null : params]);
        for (const [re, ans] of responders) {
            if (re.test(norm(sql))) {
                const out = typeof ans === 'function' ? ans(params, method) : ans;
                if (out instanceof Error) throw out;
                return out;
            }
        }
        return undefined;
    };
    const db = {
        run: async (sql, params) => answer('run', sql, params) ?? { rowCount: 0, rows: [] },
        getOne: async (sql, params) => answer('getOne', sql, params) ?? null,
        getAll: async (sql, params) => answer('getAll', sql, params) ?? [],
        getClient: async () => ({
            query: async (sql, params) => answer('client.query', sql, params) ?? { rows: [] },
            release: () => { calls.push(['client.release']); },
        }),
    };
    return { db, calls };
}

const PROJECT_ROW = {
    id: 'p1', name: 'Alpha', description: 'd', custom_instructions: 'ci', knowledge_base_ids: '["kb1"]',
    color: '#111', icon: 'x', owner_id: 'u1', organization_id: 'o1', extract_memories: true,
    editors_can_invite: null, archived_at: null, archived_by: null, version: 3, kind: 'workspace',
    kind_guessed: false, files_kb_id: null, installed_from_blueprint_id: null, installed_from_org_id: null,
    installed_version: null, stage: null, stage_of: null, created_at: 't0', updated_at: 't1',
};

const ready = () => { readyCalls.n += 1; return Promise.resolve(); };
const readyCalls = { n: 0 };

/** Each scenario: (store, db-responders) → result. */
const scenarios = {
    createProject: {
        responders: [],
        run: (s) => s.createProject({ name: 'N', ownerId: 'u1', organizationId: 'o1', knowledgeBaseIds: ['k'], installedFromBlueprintId: 'bp', installedVersion: 2, kind: 'solution' }),
    },
    createProjectBadKind: {
        responders: [],
        run: (s) => s.createProject({ name: 'N', ownerId: 'u1', kind: 'nope' }),
    },
    getProject: {
        responders: [[/FROM projects WHERE id/, PROJECT_ROW]],
        run: (s) => s.getProject('p1'),
    },
    getProjectMissing: { responders: [], run: (s) => s.getProject('nope') },
    listUserProjectsGroupsSolution: {
        responders: [[/SELECT DISTINCT p\.\*/, [{ ...PROJECT_ROW, user_permission: 'editor' }]]],
        run: (s) => s.listUserProjects('u1', ['g1', 'g2'], { kind: 'solution' }),
    },
    listUserProjectsStagesArchived: {
        responders: [[/SELECT DISTINCT p\.\*/, [{ ...PROJECT_ROW, user_permission: null }]]],
        run: (s) => s.listUserProjects('u1', [], { kind: 'solution', onlyStages: true, includeArchived: true }),
    },
    listUserProjectsBadOnlyStages: { responders: [], run: (s) => s.listUserProjects('u1', [], { onlyStages: true }) },
    setArchived: {
        responders: [[/SELECT \* FROM projects WHERE id/, { ...PROJECT_ROW, archived_at: 'ta', archived_by: 'u1' }]],
        run: (s) => s.setArchived('p1', 'u1'),
    },
    restoreArchived: {
        responders: [[/SELECT \* FROM projects WHERE id/, PROJECT_ROW]],
        run: (s) => s.setArchived('p1', null),
    },
    setProjectKind: {
        responders: [
            [/has_stages/, { stage_of: null, has_stages: false }],
            [/FROM solution_stages/, Object.assign(new Error('no table'), { code: '42P01' })],
            [/UPDATE projects SET kind/, { rowCount: 1 }],
            [/SELECT \* FROM projects WHERE id/, PROJECT_ROW],
        ],
        run: (s) => s.setProjectKind('p1', 'solution'),
    },
    setProjectKindOnStage: {
        responders: [[/has_stages/, { stage_of: 'dev1', has_stages: false }]],
        run: (s) => s.setProjectKind('p1', 'workspace'),
    },
    setProjectKindHasStages: {
        responders: [[/has_stages/, { stage_of: null, has_stages: true }]],
        run: (s) => s.setProjectKind('p1', 'workspace'),
    },
    countChatHoldings: {
        responders: [
            [/FROM direct_conversations/, { n: '2' }],
            [/FROM agent_conversations/, Object.assign(new Error('x'), { code: '42703' })],
            [/FROM project_chats/, { n: 4 }],
        ],
        run: (s) => s.countChatHoldings('p1'),
    },
    setFilesKbId: {
        responders: [[/SELECT files_kb_id/, { files_kb_id: 'kb9' }]],
        run: (s) => s.setFilesKbId('p1', 'kb1', { expected: 'kb0' }),
    },
    countSharedThreads: {
        responders: [[/shared_scope = 'project'/, { n: '3' }]],
        run: (s) => s.countSharedThreads('p1'),
    },
    listSharedThreads: {
        responders: [[/UNION ALL/, [{ id: 'c1', user_id: 'u2', type: 'agent' }, { id: 'c2', user_id: 'u3', type: 'x' }]]],
        run: (s) => s.listSharedThreads('p1', { limit: 500 }),
    },
    getOwnConversationFiling: {
        responders: [[/FROM agent_conversations WHERE id/, { project_id: 'p1', shared_scope: 'project' }]],
        run: (s) => s.getOwnConversationFiling('c1', 'u1', 'agent_conversations'),
    },
    updateProjectConflict: {
        responders: [
            [/SELECT id, owner_id, version/, { id: 'p1', owner_id: 'u1', version: 5, stage_of: null, knowledge_base_ids: '[]' }],
            [/SELECT \* FROM projects WHERE id/, PROJECT_ROW],
        ],
        run: (s) => s.updateProject('p1', { name: 'X' }, { expectedVersion: 4 }),
    },
    updateProjectVersioned: {
        responders: [
            [/SELECT id, owner_id, version/, { id: 'p1', owner_id: 'u1', version: 4, stage_of: null, knowledge_base_ids: '[]' }],
            [/^UPDATE "?projects/, { rowCount: 1 }],
            [/SELECT \* FROM projects WHERE id/, PROJECT_ROW],
        ],
        run: (s) => s.updateProject('p1', { name: 'X', knowledgeBaseIds: ['a'], editorsCanInvite: false, bogus: 1 }, { expectedVersion: 4 }),
    },
    updateProjectStageKbGuarded: {
        responders: [
            [/SELECT id, owner_id, version/, { id: 'p1', owner_id: 'u1', version: 4, stage_of: 'dev', knowledge_base_ids: '["a"]' }],
            [/^UPDATE "?projects/, { rowCount: 1 }],
            [/SELECT \* FROM projects WHERE id/, PROJECT_ROW],
        ],
        run: (s) => s.updateProject('p1', { knowledgeBaseIds: ['b'] }, { managedWrite: { deploymentId: 'd1' } }),
    },
    deleteProject: { responders: [[/DELETE FROM projects/, { rowCount: 1 }]], run: (s) => s.deleteProject('p1') },
    shareProject: {
        responders: [[/INSERT INTO project_shares/, { id: 'share-existing' }]],
        run: (s) => s.shareProject('p1', 'user', 'u2', 'edit', 'u1'),
    },
    getShareById: {
        responders: [[/FROM project_shares WHERE id/, { id: 's1', project_id: 'p1', shared_with_type: 'user', shared_with_id: 'u2', permission: 'editor', invited_by: 'u1', created_at: 't' }]],
        run: (s) => s.getShareById('s1'),
    },
    updateMemberRole: { responders: [[/UPDATE project_shares/, { rowCount: 1 }]], run: (s) => s.updateMemberRole('s1', 'bogus') },
    handOverProject: {
        responders: [[/has_stages/, { stage_of: null, has_stages: false }], [/WITH heir/, { rows: [{ owner_id: 'u7' }] }]],
        run: (s) => s.handOverProject('p1', 'u1'),
    },
    transferOwner: {
        responders: [[/has_stages/, null], [/WITH moved/, { rows: [] }]],
        run: (s) => s.transferOwner({ projectId: 'p1', fromUserId: 'u1', toUserId: 'u2', keepFromAs: 'viewer' }),
    },
    unshareProject: { responders: [[/DELETE FROM project_shares/, { rowCount: 0 }]], run: (s) => s.unshareProject('s1') },
    getProjectShares: {
        responders: [[/FROM project_shares WHERE project_id/, [{ id: 's1', project_id: 'p1', shared_with_type: 'group', shared_with_id: 'g', permission: 'viewer', created_at: 't' }]]],
        run: (s) => s.getProjectShares('p1'),
    },
    assignConversation: { responders: [[/SET project_id = \$1/, { rowCount: 1 }]], run: (s) => s.assignConversation('c1', 'p1', 'u1', 'evil; DROP') },
    unassignConversation: { responders: [], run: (s) => s.unassignConversation('c1', null) },
    getProjectRoleShared: {
        responders: [[/SELECT owner_id FROM projects/, { owner_id: 'u9' }], [/SELECT permission FROM project_shares/, { permission: 'editor' }]],
        run: (s) => s.getProjectRole('u1', 'p1', []),
    },
    userHasAccessOwner: {
        responders: [[/SELECT owner_id FROM projects/, { owner_id: 'u1' }]],
        run: (s) => s.userHasAccess('u1', 'p1', ['g']),
    },
    logActivity: {
        responders: [[/INSERT INTO project_activity/, { rowCount: 1 }]],
        run: (s) => s.logActivity('p1', 'u1', 'renamed', { targetType: 'project', targetId: 'p1', from: 'a' }),
    },
    logActivityFails: {
        responders: [[/INSERT INTO project_activity/, new Error('boom')]],
        run: (s) => s.logActivity('p1', 'u1', 'renamed'),
    },
    listActivity: {
        responders: [[/FROM project_activity/, [{ id: 'a1', project_id: 'p1', actor_id: 'u1', action: 'x', target_type: null, target_id: null, details: '{}', created_at: 't' }]]],
        run: (s) => s.listActivity('p1', 10, 5),
    },
    appendProjectEvent: {
        responders: [[/RETURNING event_seq/, { rows: [{ event_seq: '7' }] }]],
        run: (s) => s.appendProjectEvent('p1', { kind: 'k', actorId: 'u1', payload: { a: 1 } }),
    },
    appendProjectEventVanished: {
        responders: [[/RETURNING event_seq/, { rows: [] }]],
        run: (s) => s.appendProjectEvent('p1', { kind: 'k' }),
    },
    listProjectEventsTruncated: {
        responders: [[/LEFT JOIN LATERAL/, [
            { head_seq: '9', id: 'e1', seq: '5', kind: 'k', actor_id: 'u', target_type: null, target_id: null, payload: null, created_at: 't' },
        ]]],
        run: (s) => s.listProjectEvents('p1', 2, 1000),
    },
    listProjectEventsResync: {
        responders: [[/LEFT JOIN LATERAL/, [{ head_seq: '9', id: null }]]],
        run: (s) => s.listProjectEvents('p1', 3),
    },
    getProjectEventSeq: { responders: [[/SELECT event_seq/, { event_seq: '12' }]], run: (s) => s.getProjectEventSeq('p1') },
    pruneProjectEvents: { responders: [[/DELETE FROM project_events/, { rowCount: 2 }]], run: (s) => s.pruneProjectEvents(0) },
    stageOfProjectCached: {
        responders: [[/SELECT id, stage, stage_of/, { id: 'p1', stage: 'uat', stage_of: 'dev' }]],
        run: async (s) => [await s.stageOfProject('p1'), await s.stageOfProject('p1'), await s.stageOfProjectFresh('p1'), await s.stageOfProject('')],
    },
    createStageProject: {
        responders: [[/INSERT INTO projects/, (p) => ({ rows: [{ ...PROJECT_ROW, id: p[0], name: p[1], stage: p[6], stage_of: p[7], kind: 'solution' }] })]],
        run: (s) => s.createStageProject(null, { devProject: { id: 'dev', name: 'Dev', organization_id: 'o1' }, stage: 'prd', ownerId: 'u1' }),
    },
    detachStageWithClient: {
        responders: [
            [/SELECT id, stage, stage_of FROM projects WHERE id = \$1$/, { id: 'p1', stage: 'uat', stage_of: 'dev' }],
            [/WITH old AS/, { rows: [{ stage: 'uat', stage_of: 'dev' }] }],
        ],
        run: async (s, db) => {
            const before = await s.stageOfProject('p1');
            const client = await db.getClient();
            const out = await s.detachStage('p1', { client, actorId: 'u1' });
            return [before, out];
        },
    },
    setInstalledVersion: { responders: [[/installed_version/, { rowCount: 1 }]], run: (s) => s.setInstalledVersion('p1', 1.5) },
};

async function runAll() {
    const out = {};
    for (const [name, sc] of Object.entries(scenarios)) {
        const { db, calls } = fakeDb(sc.responders);
        const guardCalls = [];
        const managedParts = { assertManagedWrite: async (arg) => { guardCalls.push(arg); } };
        readyCalls.n = 0;
        const store = makeProjectStore(db, { ready, managedParts });
        let result;
        let error = null;
        try {
            result = await sc.run(store, db);
        } catch (err) {
            error = { name: err.name, message: err.message, status: err.status ?? null, code: err.code ?? null, details: err.details ?? null };
        }
        out[name] = mask({ calls, guardCalls, readyCalls: readyCalls.n, result: result === undefined ? null : result, error });
    }
    return out;
}

test('projectStore surface: exported keys, in order', () => {
    const { db } = fakeDb();
    const golden = loadGolden();
    const surface = {
        module: Object.keys(projectStore),
        store: Object.keys(makeProjectStore(db)),
        PROJECT_KINDS: projectStore.PROJECT_KINDS,
        EVENT_REPLAY_LIMIT: projectStore.EVENT_REPLAY_LIMIT,
        normalizePermission: ['view', 'edit', 'viewer', 'editor', 'owner', undefined].map(projectStore.normalizePermission),
    };
    if (process.env.UPDATE_GOLDEN) { golden.surface = surface; saveGolden(golden); return; }
    assert.deepStrictEqual(surface, golden.surface);
});

test('projectStore golden: calls and results per scenario', async () => {
    const actual = await runAll();
    const golden = loadGolden();
    if (process.env.UPDATE_GOLDEN) { golden.scenarios = actual; saveGolden(golden); return; }
    assert.deepStrictEqual(Object.keys(actual), Object.keys(golden.scenarios));
    for (const name of Object.keys(golden.scenarios)) {
        assert.deepStrictEqual(actual[name], golden.scenarios[name], `scenario ${name}`);
    }
});

test('applyProjectSchema golden: statements in order', async () => {
    const stmts = [];
    await projectStore.applyProjectSchema({
        exec: async (sql) => { stmts.push(['exec', norm(sql)]); },
        runDdl: async (tag, statements) => { stmts.push(['runDdl', tag, statements.map((s) => (typeof s === 'string' ? norm(s) : mask(s)))]); },
    });
    const golden = loadGolden();
    if (process.env.UPDATE_GOLDEN) { golden.schema = stmts; saveGolden(golden); return; }
    assert.deepStrictEqual(stmts, golden.schema);
});

function loadGolden() {
    try { return JSON.parse(fs.readFileSync(GOLDEN_PATH, 'utf8')); } catch (_) { return {}; }
}
function saveGolden(g) {
    fs.writeFileSync(GOLDEN_PATH, JSON.stringify(g, null, 1) + '\n');
}
