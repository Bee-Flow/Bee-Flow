/**
 * The membership registry is the single list three consumers read from: the
 * resources listing, the file-in/out switch, and the delete-time detacher.
 *
 * They used to be three hand-maintained lists, and they drifted: automations
 * shipped a project_id column whose migration was never registered and whose
 * detacher was never written, so the column did not exist and nothing read it.
 * These tests are what makes a half-wired kind a failure here rather than a
 * silent hole in production.
 *
 * The registry only requires its stores lazily, inside the hooks, so loading
 * it touches no database. The filing tests at the end load the three content
 * stores to swap the functions the registry names (testUtils/swaps.js), which
 * proves the wiring without a database or any module mocking.
 *
 * Every setProject / clearProject passes the Solution-stage gate first. For
 * the whole file that gate is swapped (membership.stageGuard) for the real
 * guard (stores/lib/managedParts makeManagedParts) over an in-memory stage
 * table, so the gate itself runs and still no database is touched: `p-uat` is
 * a stage, every other project is not.
 *
 * Run: cd server && node --test projects/membership.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const membership = require('./membership');
const { makeSwaps } = require('../testUtils/swaps');
const { makeManagedParts } = require('../stores/lib/managedParts');

// ── The stage gate, over an in-memory stage table ────────────────────
const STAGES = { 'p-uat': { solutionId: 'p-dev', stage: 'uat', projectId: 'p-uat' } };
const ACTIVE_DEPLOYMENTS = { 'dep-uat': 'p-uat' };
/** Where each item is filed, for the gate's "where does it come from" read. */
const FILED = new Map();
/** Who owns each item, for the gate's "is this the owner" read on a source refusal. */
const OWNERS = new Map();
const fileSwaps = makeSwaps();
test.before(() => {
    const parts = makeManagedParts({
        stageOfProject: async (id) => STAGES[id] || null,
        stageOfProjectFresh: async (id) => STAGES[id] || null,
        isActiveDeployment: async (deploymentId, projectId) => ACTIVE_DEPLOYMENTS[deploymentId] === projectId,
    });
    fileSwaps.swap(membership.stageGuard, 'managedParts', () => parts);
    fileSwaps.swap(membership.stageGuard, 'projectIdIn', async (_table, id) => FILED.get(id) || null);
    fileSwaps.swap(membership.stageGuard, 'ownerIdIn', async (_table, _col, id) => OWNERS.get(id) || null);
});
test.after(fileSwaps.restore);

const isManaged = (err) => err?.status === 409 && err.code === 'managed_part' && err.details?.stage === 'uat';

const COLUMN_BACKED = ['notebook', 'document', 'meeting', 'automation', 'app', 'webpage', 'datatable', 'agent', 'skill', 'document_template'];

test('every kind declares an identity and a way to be listed', () => {
    const kinds = membership.listKinds();
    assert.ok(kinds.length >= 10, 'every registered kind is present');
    for (const k of kinds) {
        assert.strictEqual(typeof k.kind, 'string', `${k.kind}: has a kind`);
        assert.ok(k.kind.length, `${k.kind}: kind is non-empty`);
        assert.strictEqual(typeof k.section, 'string', `${k.kind}: has a response section`);
        assert.strictEqual(typeof k.list, 'function', `${k.kind}: can be listed`);
        assert.strictEqual(typeof k.detaches, 'boolean', `${k.kind}: says whether it detaches`);
    }
});

test('kinds and sections are both unique', () => {
    const kinds = membership.listKinds();
    assert.strictEqual(new Set(kinds.map(k => k.kind)).size, kinds.length, 'no duplicate kind');
    assert.strictEqual(new Set(kinds.map(k => k.section)).size, kinds.length, 'no duplicate section');
});

test('the column-backed resource kinds are all movable and all detachable', () => {
    for (const kind of COLUMN_BACKED) {
        const entry = membership.getKind(kind);
        assert.ok(entry, `${kind} is registered`);
        assert.strictEqual(typeof entry.setProject, 'function', `${kind} can be filed in and out`);
        assert.strictEqual(entry.detaches, true, `${kind} survives its project`);
        assert.strictEqual(typeof entry.clearProject, 'function', `${kind} has the detacher to do it with`);
    }
});

test('approvals are records: neither movable nor detachable', () => {
    const approval = membership.getKind('approval');
    assert.ok(approval, 'approvals are registered');
    // Stamped at INSERT and never re-filed — re-filing an automation moves its
    // FUTURE approvals, not decisions already taken. Absent rather than a stub
    // that throws, so the route rejects the kind up front.
    assert.strictEqual(approval.setProject, undefined, 'no setProject at all');
    assert.strictEqual(approval.detaches, false, 'a deleted project does not erase where a decision happened');
    assert.strictEqual(approval.clearProject, undefined, 'and so it needs no detacher');
});

test('every detachable kind actually has a detacher, and vice versa', () => {
    for (const k of membership.listKinds()) {
        assert.strictEqual(
            typeof k.clearProject === 'function', k.detaches,
            `${k.kind}: detaches and clearProject must agree — this is the exact pair that drifted before`,
        );
    }
});

test('movableKinds and detachableKinds are consistent with the registry', () => {
    const movable = membership.movableKinds().map(k => k.kind);
    const detachable = membership.detachableKinds().map(k => k.kind);
    assert.deepStrictEqual(movable, [...COLUMN_BACKED, 'knowledge_base']);
    // Knowledge bases are movable but NOT detachable, and that is not an
    // oversight: their link is an entry in the project's own
    // `knowledge_base_ids`, so deleting the project deletes the reference with
    // it. The base is in another table and is untouched.
    assert.deepStrictEqual(detachable, COLUMN_BACKED);
    assert.ok(!movable.includes('approval'), 'approvals never appear as movable');
    assert.ok(!detachable.includes('approval'), 'nor as detachable');
});

test('a knowledge base is filed in and out, but never detached', () => {
    const kb = membership.getKind('knowledge_base');
    assert.ok(kb, 'knowledge bases are registered');
    assert.strictEqual(typeof kb.setProject, 'function', 'it can be filed in and out');
    assert.strictEqual(kb.detaches, false);
    // The pair that must agree: declaring `detaches: true` here would promise a
    // detacher that cannot exist, because there is no column to clear.
    assert.strictEqual(kb.clearProject, undefined);
});

test('every column-backed kind can be TALLIED across a list of projects', () => {
    // The overview draws a card per Solution with a count on it. Without a
    // `countIn` that becomes one query per kind per project, reading whole rows
    // to throw all but their number away — and the kind that lacks the hook is
    // exactly the one nobody notices is slow.
    for (const kind of COLUMN_BACKED) {
        assert.strictEqual(typeof membership.getKind(kind).countIn, 'function',
            `${kind} can be counted for a whole list at once`);
    }
    assert.deepStrictEqual(membership.countableKinds().map(k => k.kind), COLUMN_BACKED);
});

test('the two kinds without a countIn are absent on purpose, not unfinished', () => {
    // Knowledge bases: the link is an array on the PROJECT row, so whoever has
    // the project already has the number and a query would be a second answer
    // to the same question.
    assert.strictEqual(membership.getKind('knowledge_base').countIn, undefined);
    // Approvals: viewer-scoped. A count that ignored the viewer would tell a
    // project member how many decisions they are NOT allowed to see, which is
    // the one fact the scoping exists to withhold.
    assert.strictEqual(membership.getKind('approval').countIn, undefined);
    assert.ok(!membership.countableKinds().some(k => k.kind === 'approval'));
});

test('every kind that can be filed in can also be listed and identified', () => {
    // The half-wired shape this registry exists to prevent: a kind with a
    // setProject and no way to see the result.
    for (const k of membership.movableKinds()) {
        assert.strictEqual(typeof k.list, 'function', `${k.kind}: listable`);
        assert.ok(k.section, `${k.kind}: has a response section`);
    }
});

test('getKind returns nothing for an unregistered kind', () => {
    assert.strictEqual(membership.getKind('spaceship'), undefined);
    assert.strictEqual(membership.getKind(''), undefined);
    assert.strictEqual(membership.getKind(undefined), undefined);
});

test('the approvals listing refuses to run without a viewer', async () => {
    // The scope contract in one assertion: projectId NARROWS a viewer's own
    // scope. With no viewer there is no scope to narrow, and the correct answer
    // is nothing — not everything in the project.
    const approval = membership.getKind('approval');
    assert.deepStrictEqual(await approval.list('p1', null), []);
    assert.deepStrictEqual(await approval.list('p1', {}), []);
    assert.deepStrictEqual(await approval.list('p1', { userId: null }), []);
});

// ═══ Containers: what a workspace holds, and what a Solution holds ════

test('every kind says which containers it may live in, and only real ones', () => {
    for (const k of membership.listKinds()) {
        assert.ok(Array.isArray(k.containers) && k.containers.length > 0, `${k.kind}: declares its containers`);
        for (const c of k.containers) {
            assert.ok(membership.CONTAINER_KINDS.includes(c), `${k.kind}: ${c} is a container kind`);
        }
    }
});

test('a workspace holds the collaboration content; a Solution the builder\'s bundle', () => {
    assert.deepStrictEqual(membership.sectionsFor('workspace'),
        ['notebooks', 'documents', 'meetings', 'knowledgeBases']);
    assert.deepStrictEqual(membership.sectionsFor('solution'),
        ['notebooks', 'automations', 'apps', 'webpages', 'datatables', 'agents', 'skills', 'documentTemplates',
            'knowledgeBases', 'approvals']);
});

test('a legacy project (no kind yet) shows every section; an unknown kind shows none', () => {
    const all = membership.listKinds().map(k => k.section);
    assert.deepStrictEqual(membership.sectionsFor(null), all);
    assert.deepStrictEqual(membership.sectionsFor(undefined), all);
    // The column is CHECK-constrained, so this is a bug somewhere: fail closed.
    assert.deepStrictEqual(membership.sectionsFor('spaceship'), []);
    assert.deepStrictEqual(membership.kindsFor('spaceship'), []);
    assert.deepStrictEqual(membership.kindsFor('workspace').map(k => k.kind),
        ['notebook', 'document', 'meeting', 'knowledge_base']);
});

test('isAllowedIn answers the filing question the same way the listing does', () => {
    // Collaboration content goes into a workspace, never into a Solution that
    // would carry it into an export.
    assert.strictEqual(membership.isAllowedIn('document', 'workspace'), true);
    assert.strictEqual(membership.isAllowedIn('document', 'solution'), false);
    assert.strictEqual(membership.isAllowedIn('meeting', 'workspace'), true);
    assert.strictEqual(membership.isAllowedIn('meeting', 'solution'), false);
    // The builder's pieces go into a Solution, never into a workspace.
    for (const kind of ['automation', 'app', 'webpage', 'datatable', 'agent', 'skill', 'document_template', 'approval']) {
        assert.strictEqual(membership.isAllowedIn(kind, 'solution'), true, `${kind} in a Solution`);
        assert.strictEqual(membership.isAllowedIn(kind, 'workspace'), false, `${kind} not in a workspace`);
    }
    // Both.
    for (const kind of ['notebook', 'knowledge_base']) {
        assert.strictEqual(membership.isAllowedIn(kind, 'workspace'), true);
        assert.strictEqual(membership.isAllowedIn(kind, 'solution'), true);
    }
    // A legacy project takes every registered kind; nothing takes an unknown one.
    for (const k of membership.listKinds()) assert.strictEqual(membership.isAllowedIn(k.kind, null), true);
    assert.strictEqual(membership.isAllowedIn('spaceship', null), false);
    assert.strictEqual(membership.isAllowedIn('spaceship', 'workspace'), false);
    assert.strictEqual(membership.isAllowedIn('document', 'spaceship'), false);
    // And the two answers agree for every kind and container.
    for (const container of [null, 'workspace', 'solution']) {
        const sections = membership.sectionsFor(container);
        for (const k of membership.listKinds()) {
            assert.strictEqual(membership.isAllowedIn(k.kind, container), sections.includes(k.section),
                `${k.kind} in ${container}`);
        }
    }
});

// ═══ Filing owned content: documents, meeting notes, notebooks ═══════

const STORES = {
    document: { module: '../stores/documentStore', attach: 'setDocumentProject', detach: 'detachDocumentFromProject' },
    meeting: { module: '../stores/transcriptionStore', attach: 'setTranscriptionProject', detach: 'detachTranscriptionFromProject' },
    notebook: { module: '../stores/notebookStore', attach: 'setNotebookProject', detach: 'detachNotebookFromProject' },
};

/** Swap a content store's filing functions for recorders; `owner` owns item 'x'. */
function recordFiling(swap, spec, { owner = 'alice', filedIn = 'p1' } = {}) {
    const calls = [];
    const store = require(spec.module);
    // The filing path reads the caller's organisations (auth/orgScope) for the stores' check.
    swap(require('../stores/userStore'), 'getUser', async (id) => ({ id, organizationId: '', groups: '[]' }));
    swap(store, spec.attach, async (id, userId, projectId) => {
        calls.push(['attach', id, userId, projectId]);
        return userId === owner;
    });
    swap(store, spec.detach, async (id, projectId, userId) => {
        calls.push(['detach', id, projectId, userId]);
        return projectId === filedIn && (userId === null || userId === owner);
    });
    return calls;
}

const asRole = (projectRole, projectId = 'p1') => ({ req: { projectRole }, projectId });

for (const [kind, spec] of Object.entries(STORES)) {
    test(`${kind}: the owner files it in, and nobody else can`, async (t) => {
        const { swap, restore } = makeSwaps();
        t.after(restore);
        const calls = recordFiling(swap, spec);
        const entry = membership.getKind(kind);
        assert.strictEqual(await entry.setProject('x', 'alice', 'p1', asRole('editor')), true);
        assert.strictEqual(await entry.setProject('x', 'bob', 'p1', asRole('owner')), false,
            'owning the PROJECT does not let you file someone else\'s item into it');
        assert.deepStrictEqual(calls, [['attach', 'x', 'alice', 'p1'], ['attach', 'x', 'bob', 'p1']]);
    });

    test(`${kind}: taking it out is the item owner's, or the project owner's, and scoped to this project`, async (t) => {
        const { swap, restore } = makeSwaps();
        t.after(restore);
        const calls = recordFiling(swap, spec);
        const entry = membership.getKind(kind);

        assert.strictEqual(await entry.setProject('x', 'alice', null, asRole('editor')), true, 'the item owner');
        assert.deepStrictEqual(calls.at(-1), ['detach', 'x', 'p1', 'alice']);

        calls.length = 0;
        assert.strictEqual(await entry.setProject('x', 'bob', null, asRole('editor')), false, 'an editor, not the owner');
        assert.deepStrictEqual(calls, [['detach', 'x', 'p1', 'bob']], 'and no second, wider attempt');

        calls.length = 0;
        assert.strictEqual(await entry.setProject('x', 'bob', null, asRole('owner')), true, 'the project owner');
        assert.deepStrictEqual(calls.at(-1), ['detach', 'x', 'p1', null]);

        calls.length = 0;
        assert.strictEqual(await entry.setProject('x', 'bob', null, asRole('owner', 'p2')), false,
            'a project owner cannot take it out of ANOTHER project');
        assert.ok(calls.every(c => c[2] === 'p2'), 'every removal is scoped to the project being edited');

        calls.length = 0;
        assert.strictEqual(await entry.setProject('x', 'alice', null, undefined), false,
            'no project context: nothing to scope the removal to');
        assert.deepStrictEqual(calls, []);
    });
}

test('notebook: a removal through a stale page of project A never takes it out of project B', async (t) => {
    // The notebook has moved from p1 to p2 (another tab, or its owner) while
    // p1's list was still open. The owner's "Remove from project" on p1 must
    // not un-file it from p2: that used to be an unscoped setNotebookProject
    // (id, owner, null), which cleared whatever project it was in.
    const { swap, restore } = makeSwaps();
    t.after(restore);
    const store = require('../stores/notebookStore');
    const calls = recordFiling(swap, STORES.notebook, { owner: 'alice', filedIn: 'p2' });
    swap(store, 'setNotebookProject', async (id, userId, projectId) => {
        calls.push(['set', id, userId, projectId]);
        return userId === 'alice';
    });
    const entry = membership.getKind('notebook');

    assert.strictEqual(await entry.setProject('nb', 'alice', null, asRole('editor', 'p1')), false,
        'not filed in p1, so nothing to take out of p1');
    assert.deepStrictEqual(calls, [['detach', 'nb', 'p1', 'alice']], 'scoped to p1 and to the owner');
    assert.ok(!calls.some(c => c[0] === 'set' && c[3] === null), 'never the unscoped clear');

    calls.length = 0;
    assert.strictEqual(await entry.setProject('nb', 'alice', null, asRole('editor', 'p2')), true,
        'through p2, where it is, it comes out');
    assert.deepStrictEqual(calls, [['detach', 'nb', 'p2', 'alice']]);
});

test('the registry names store functions that exist', () => {
    const documents = require('../stores/documentStore');
    const meetings = require('../stores/transcriptionStore');
    const notebooks = require('../stores/notebookStore');
    for (const [store, names] of [
        [documents, ['setDocumentProject', 'detachDocumentFromProject', 'listProjectDocuments', 'countProjectDocuments', 'clearProjectFromDocuments']],
        [meetings, ['setTranscriptionProject', 'detachTranscriptionFromProject', 'listProjectMeetings', 'countProjectMeetings', 'clearProjectFromTranscriptions']],
        [notebooks, ['setNotebookProject', 'detachNotebookFromProject', 'listProjectNotebooks', 'countProjectNotebooks', 'clearProjectFromNotebooks']],
    ]) {
        for (const name of names) assert.strictEqual(typeof store[name], 'function', name);
    }
});

test('listing, counting and detaching reach the content stores', async (t) => {
    const { swap, restore } = makeSwaps();
    t.after(restore);
    const seen = [];
    const record = (label, value) => async (arg) => { seen.push([label, arg]); return value; };
    swap(require('../stores/documentStore'), 'listProjectDocuments', record('listDocuments', []));
    swap(require('../stores/documentStore'), 'countProjectDocuments', record('countDocuments', new Map()));
    swap(require('../stores/documentStore'), 'clearProjectFromDocuments', record('clearDocuments', 0));
    swap(require('../stores/transcriptionStore'), 'listProjectMeetings', record('listMeetings', []));
    swap(require('../stores/transcriptionStore'), 'countProjectMeetings', record('countMeetings', new Map()));
    swap(require('../stores/transcriptionStore'), 'clearProjectFromTranscriptions', record('clearMeetings', 0));
    for (const kind of ['document', 'meeting']) {
        const entry = membership.getKind(kind);
        await entry.list('p1', { userId: 'u1' });
        await entry.countIn(['p1', 'p2']);
        await entry.clearProject('p1');
    }
    assert.deepStrictEqual(seen, [
        ['listDocuments', 'p1'], ['countDocuments', ['p1', 'p2']], ['clearDocuments', 'p1'],
        ['listMeetings', 'p1'], ['countMeetings', ['p1', 'p2']], ['clearMeetings', 'p1'],
    ]);
});

// ═══ The Solution-stage gate ═════════════════════════════════════════

test('every movable kind can say where an item comes from, so the stage gate knows its source', () => {
    for (const k of membership.movableKinds()) {
        assert.ok(typeof k.projectOf === 'function' || k.linkOnProject === true,
            `${k.kind}: declares projectOf (a column on its row) or linkOnProject (the link lives on the project)`);
    }
    for (const kind of COLUMN_BACKED) {
        assert.strictEqual(typeof membership.getKind(kind).projectOf, 'function', `${kind} reads its own project_id`);
    }
    assert.strictEqual(membership.getKind('knowledge_base').linkOnProject, true);
});

test('a column-backed item is not filed into or out of a stage without a deploy', async (t) => {
    const { swap, restore } = makeSwaps();
    t.after(restore);
    const calls = [];
    swap(require('../stores/agentStore'), 'setAgentProject', async (id, userId, projectId) => { calls.push([id, projectId]); return true; });
    FILED.set('a-loose', 'p1');
    FILED.set('a-staged', 'p-uat');
    OWNERS.set('a-staged', 'alice');
    t.after(() => { FILED.delete('a-loose'); FILED.delete('a-staged'); OWNERS.delete('a-staged'); });
    const agent = membership.getKind('agent');

    await assert.rejects(agent.setProject('a-loose', 'alice', 'p-uat', { projectId: 'p-uat' }), isManaged, 'into a stage');
    await assert.rejects(agent.setProject('a-staged', 'alice', 'p1', { projectId: 'p1' }), isManaged, 'out of a stage, into another project');
    await assert.rejects(agent.setProject('a-staged', 'alice', null, { projectId: 'p-uat' }), isManaged, 'taken out of a stage');
    await assert.rejects(agent.setProject('a-loose', 'alice', 'p-uat', { managedWrite: { deploymentId: 'dep-elsewhere' } }), isManaged,
        'a deployment of another stage is no capability here');
    assert.deepStrictEqual(calls, [], 'no refused move reached the store');

    assert.strictEqual(await agent.setProject('a-loose', 'alice', 'p-uat', { managedWrite: { deploymentId: 'dep-uat' } }), true, 'a deploy may');
    assert.strictEqual(await agent.setProject('a-loose', 'alice', 'p2', { projectId: 'p2' }), true, 'between ordinary projects nothing changes');
    assert.deepStrictEqual(calls, [['a-loose', 'p-uat'], ['a-loose', 'p2']]);
});

test('a deploy filing an automation hands its capability on to the automation store', async (t) => {
    // The automation store refuses filing into a stage by itself; a move the
    // gate let through on a capability must not then be refused there.
    const { swap, restore } = makeSwaps();
    t.after(restore);
    const writes = [];
    const automationStore = require('../stores/automationStore');
    swap(automationStore, 'getAutomation', async (id) => ({ id, userId: 'alice' }));
    swap(automationStore, 'updateAutomation', async (id, updates, userId, opts) => {
        writes.push([id, updates.projectId, userId, opts?.managedWrite || null]);
        return { id };
    });
    FILED.set('r-loose', 'p1');
    t.after(() => FILED.delete('r-loose'));
    const automation = membership.getKind('automation');
    const managedWrite = { deploymentId: 'dep-uat' };

    assert.strictEqual(await automation.setProject('r-loose', 'alice', 'p-uat', { managedWrite }), true);
    assert.strictEqual(await automation.setProject('r-loose', 'alice', 'p2', { projectId: 'p2' }), true);
    assert.deepStrictEqual(writes, [
        ['r-loose', 'p-uat', 'alice', managedWrite],
        ['r-loose', 'p2', 'alice', null],
    ]);
});

test('a stranger naming an item in a stage reads "not yours", never which Solution holds it', async (t) => {
    const { swap, restore } = makeSwaps();
    t.after(restore);
    const calls = [];
    swap(require('../stores/agentStore'), 'setAgentProject', async (id, userId, projectId) => { calls.push([id, projectId]); return false; });
    FILED.set('a-theirs', 'p-uat');
    OWNERS.set('a-theirs', 'bob');
    t.after(() => { FILED.delete('a-theirs'); OWNERS.delete('a-theirs'); });
    const agent = membership.getKind('agent');

    // Mallory edits her own project p1 and names bob's staged agent.
    assert.strictEqual(await agent.setProject('a-theirs', 'mallory', 'p1', { projectId: 'p1' }), false);
    // Bob, the owner, is told why.
    await assert.rejects(agent.setProject('a-theirs', 'bob', 'p1', { projectId: 'p1' }), isManaged);
    // The stage being edited is known to the caller, so its refusal stands.
    await assert.rejects(agent.setProject('a-theirs', 'mallory', null, { projectId: 'p-uat' }), isManaged);
    assert.deepStrictEqual(calls, [], 'no refused move reached the store');
});

test('owned content cannot be taken out of a stage through the stage\'s own page', async (t) => {
    const { swap, restore } = makeSwaps();
    t.after(restore);
    const calls = recordFiling(swap, STORES.notebook, { owner: 'alice', filedIn: 'p-uat' });
    FILED.set('nb-staged', 'p-uat');
    t.after(() => FILED.delete('nb-staged'));
    const notebook = membership.getKind('notebook');
    await assert.rejects(notebook.setProject('nb-staged', 'alice', null, asRole('owner', 'p-uat')), isManaged);
    await assert.rejects(notebook.setProject('nb-free', 'alice', 'p-uat', asRole('editor', 'p-uat')), isManaged);
    assert.deepStrictEqual(calls, []);
});

test('a knowledge base is not linked to or unlinked from a stage without a deploy, and the capability travels on', async (t) => {
    const { swap, restore } = makeSwaps();
    t.after(restore);
    const seen = [];
    swap(require('./knowledgeBaseMembership'), 'setKnowledgeBaseProject', async (id, userId, projectId, ctx) => {
        seen.push([id, projectId, ctx.managedWrite || null]);
        return true;
    });
    const kb = membership.getKind('knowledge_base');
    await assert.rejects(kb.setProject('kb1', 'alice', 'p-uat', { projectId: 'p-uat', req: {} }), isManaged);
    await assert.rejects(kb.setProject('kb1', 'alice', null, { projectId: 'p-uat', req: {} }), isManaged);
    assert.deepStrictEqual(seen, []);
    const managedWrite = { deploymentId: 'dep-uat' };
    assert.strictEqual(await kb.setProject('kb1', 'alice', 'p-uat', { projectId: 'p-uat', req: {}, managedWrite }), true);
    assert.strictEqual(await kb.setProject('kb2', 'alice', 'p1', { projectId: 'p1', req: {} }), true);
    assert.deepStrictEqual(seen, [['kb1', 'p-uat', managedWrite], ['kb2', 'p1', null]]);
});

test('a stage project\'s items are detached only with a deploy\'s capability', async (t) => {
    const { swap, restore } = makeSwaps();
    t.after(restore);
    const cleared = [];
    swap(require('../stores/agentStore'), 'clearProjectFromAgents', async (projectId) => { cleared.push(projectId); return 1; });
    for (const k of membership.detachableKinds()) {
        await assert.rejects(k.clearProject('p-uat'), isManaged, `${k.kind}: refused`);
    }
    const agent = membership.getKind('agent');
    assert.strictEqual(await agent.clearProject('p-uat', { managedWrite: { deploymentId: 'dep-uat' } }), 1);
    assert.strictEqual(await agent.clearProject('p1'), 1);
    assert.deepStrictEqual(cleared, ['p-uat', 'p1']);
});

test('a kind that cannot say where its item is is refused, never let through', async () => {
    // withStageGuard wraps every entry, so a later kind that forgets projectOf
    // fails closed instead of skipping the source check.
    let reached = false;
    const guarded = membership.withStageGuard({
        kind: 'mystery', detaches: false, list: async () => [],
        setProject: async () => { reached = true; return true; },
    });
    await assert.rejects(guarded.setProject('x', 'alice', 'p1', { projectId: 'p1' }), /cannot tell which project/);
    assert.strictEqual(reached, false);
});

// ═══ Skills and document templates (design section 2, D21) ═══════════

test('skills and document templates are Solution-only, detachable and countable', () => {
    for (const [kind, section] of [['skill', 'skills'], ['document_template', 'documentTemplates']]) {
        const entry = membership.getKind(kind);
        assert.ok(entry, `${kind} is registered`);
        assert.strictEqual(entry.section, section);
        assert.deepStrictEqual(entry.containers, ['solution'], `${kind}: SOLUTION_ONLY`);
        assert.strictEqual(entry.detaches, true);
        assert.strictEqual(typeof entry.setProject, 'function');
        assert.strictEqual(typeof entry.clearProject, 'function');
        assert.strictEqual(typeof entry.countIn, 'function');
        assert.strictEqual(typeof entry.projectOf, 'function');
        assert.strictEqual(typeof entry.ownerOf, 'function');
        assert.strictEqual(membership.isAllowedIn(kind, 'solution'), true);
        assert.strictEqual(membership.isAllowedIn(kind, 'workspace'), false);
        assert.ok(!membership.sectionsFor('workspace').includes(section));
        assert.ok(membership.sectionsFor('solution').includes(section));
    }
    // The workspace `document` kind is untouched.
    assert.deepStrictEqual(membership.getKind('document').containers, ['workspace']);
});

test('the registry names the skill and template store functions that exist', () => {
    const skills = require('../stores/skillStore');
    for (const name of ['listProjectSkills', 'countProjectSkills', 'setSkillProject', 'clearProjectFromSkills', 'writeManagedSkill']) {
        assert.strictEqual(typeof skills[name], 'function', name);
    }
    const templates = require('../stores/document/solutionTemplates');
    for (const name of ['listSolutionTemplates', 'countSolutionTemplates', 'setTemplateSolution',
        'clearTemplateSolution', 'clearSolutionFromTemplates']) {
        assert.strictEqual(typeof templates[name], 'function', name);
    }
});

test('a skill is filed through the skill store, and a deploy\'s capability travels on', async (t) => {
    const { swap, restore } = makeSwaps();
    t.after(restore);
    const calls = [];
    const skills = require('../stores/skillStore');
    swap(skills, 'setSkillProject', async (id, userId, projectId, opts) => { calls.push(['set', id, userId, projectId, opts.managedWrite || null]); return true; });
    swap(skills, 'clearProjectFromSkills', async (projectId, opts) => { calls.push(['clear', projectId, opts?.managedWrite || null]); return 2; });
    swap(skills, 'listProjectSkills', async (projectId) => { calls.push(['list', projectId]); return []; });
    swap(skills, 'countProjectSkills', async (ids) => { calls.push(['count', ids]); return new Map(); });
    FILED.set('s1', 'p1');
    t.after(() => FILED.delete('s1'));
    const skill = membership.getKind('skill');
    const managedWrite = { deploymentId: 'dep-uat' };

    assert.strictEqual(await skill.setProject('s1', 'alice', 'p2', { projectId: 'p2' }), true);
    assert.strictEqual(await skill.setProject('s1', 'alice', 'p-uat', { managedWrite }), true);
    await assert.rejects(skill.setProject('s1', 'alice', 'p-uat', { projectId: 'p-uat' }), isManaged, 'into a stage without a deploy');
    assert.strictEqual(await skill.clearProject('p-uat', { managedWrite }), 2);
    await assert.rejects(skill.clearProject('p-uat'), isManaged);
    await skill.list('p1');
    await skill.countIn(['p1']);
    assert.deepStrictEqual(calls, [
        ['set', 's1', 'alice', 'p2', null],
        ['set', 's1', 'alice', 'p-uat', managedWrite],
        ['clear', 'p-uat', managedWrite],
        ['list', 'p1'],
        ['count', ['p1']],
    ]);
});

test('a document template is filed through solution_project_id, owner-only, scoped when taken out', async (t) => {
    const { swap, restore } = makeSwaps();
    t.after(restore);
    const calls = [];
    const store = require('../stores/document/solutionTemplates');
    const documents = require('../stores/documentStore');
    swap(require('../stores/userStore'), 'getUser', async (id) => ({ id, organizationId: '', groups: '[]' }));
    swap(store, 'setTemplateSolution', async (id, userId, projectId, opts) => { calls.push(['set', id, userId, projectId, opts.managedWrite || null]); return userId === 'alice'; });
    swap(store, 'clearTemplateSolution', async (id, projectId, userId, opts) => {
        calls.push(['clear', id, projectId, userId, opts.managedWrite || null]);
        return projectId === 'p1' && (userId === null || userId === 'alice');
    });
    swap(store, 'listSolutionTemplates', async (projectId) => { calls.push(['list', projectId]); return []; });
    swap(store, 'countSolutionTemplates', async (ids) => { calls.push(['count', ids]); return new Map(); });
    swap(store, 'clearSolutionFromTemplates', async (projectId) => { calls.push(['detach', projectId]); return 1; });
    // The workspace document hooks must stay out of it.
    for (const name of ['setDocumentProject', 'detachDocumentFromProject', 'listProjectDocuments', 'countProjectDocuments', 'clearProjectFromDocuments']) {
        swap(documents, name, async () => { throw new Error(`${name} must not be reached by a template`); });
    }
    FILED.set('t1', 'p1');
    t.after(() => FILED.delete('t1'));
    const entry = membership.getKind('document_template');

    assert.strictEqual(await entry.setProject('t1', 'alice', 'p2', asRole('editor', 'p2')), true);
    assert.strictEqual(await entry.setProject('t1', 'bob', 'p2', asRole('owner', 'p2')), false, 'owning the project does not file another person\'s template');
    assert.strictEqual(await entry.setProject('t1', 'alice', null, asRole('editor', 'p1')), true, 'the template owner takes it out');
    assert.strictEqual(await entry.setProject('t1', 'bob', null, asRole('editor', 'p1')), false, 'an editor does not');
    assert.strictEqual(await entry.setProject('t1', 'bob', null, asRole('owner', 'p1')), true, 'the project owner does');
    assert.strictEqual(await entry.setProject('t1', 'bob', null, asRole('owner', 'p3')), false, 'only out of the project being edited');
    assert.strictEqual(await entry.setProject('t1', 'alice', null, undefined), false, 'no project context');
    await entry.list('p1');
    await entry.countIn(['p1', 'p2']);
    await entry.clearProject('p1');
    assert.deepStrictEqual(calls, [
        ['set', 't1', 'alice', 'p2', null],
        ['set', 't1', 'bob', 'p2', null],
        ['clear', 't1', 'p1', 'alice', null],
        ['clear', 't1', 'p1', 'bob', null],
        ['clear', 't1', 'p1', 'bob', null],
        ['clear', 't1', 'p1', null, null],
        ['clear', 't1', 'p3', 'bob', null],
        ['clear', 't1', 'p3', null, null],
        ['list', 'p1'], ['count', ['p1', 'p2']], ['detach', 'p1'],
    ]);
});

test('a document template is not filed into or out of a stage without a deploy, and its source is solution_project_id', async (t) => {
    const { swap, restore } = makeSwaps();
    t.after(restore);
    const calls = [];
    const store = require('../stores/document/solutionTemplates');
    swap(store, 'setTemplateSolution', async (id, userId, projectId, opts) => { calls.push([id, projectId, opts.managedWrite || null]); return true; });
    const seen = [];
    // The gate asks for the template's own filing column, not project_id.
    const projectOf = membership.getKind('document_template').projectOf;
    swap(membership.stageGuard, 'projectIdIn', async (table, id, column) => { seen.push([table, column]); return FILED.get(id) || null; });
    FILED.set('t-loose', 'p1');
    t.after(() => FILED.delete('t-loose'));
    await projectOf('t-loose');
    assert.deepStrictEqual(seen, [['studio_documents', 'solution_project_id']]);

    const entry = membership.getKind('document_template');
    await assert.rejects(entry.setProject('t-loose', 'alice', 'p-uat', { projectId: 'p-uat' }), isManaged);
    assert.strictEqual(await entry.setProject('t-loose', 'alice', 'p-uat', { managedWrite: { deploymentId: 'dep-uat' } }), true);
    assert.deepStrictEqual(calls, [['t-loose', 'p-uat', { deploymentId: 'dep-uat' }]]);
});

test('a filed template does not appear in listProjectDocuments, and a Solution lists it as a template', async (t) => {
    // Against a real Postgres (pglite): the filing column is the only link.
    const { usePglitePool } = require('../testUtils/pglitePool');
    const { pg, close } = usePglitePool();
    t.after(close);
    await pg.exec(`CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, "organizationId" TEXT);
                   INSERT INTO users VALUES ('alice','org1');`);
    const projectStore = require('../stores/projectStore');
    const documentStore = require('../stores/documentStore');
    await projectStore.initDB();
    await documentStore.initDB();
    const dev = await projectStore.createProject({ name: 'Quotes', ownerId: 'alice', organizationId: 'org1', kind: 'solution' });
    const doc = await documentStore.createDocument({ userId: 'alice', name: 'Offer', kind: 'template', bodyHtml: '<p>x</p>', settings: { houseStyle: false } });
    const entry = membership.getKind('document_template');
    assert.strictEqual(await entry.setProject(doc.id, 'alice', dev.id, { projectId: dev.id, req: { projectRole: 'owner' } }), true);

    assert.deepStrictEqual(await documentStore.listProjectDocuments(dev.id), [], 'not project content');
    assert.deepStrictEqual((await entry.list(dev.id)).map((c) => c.id), [doc.id]);
    assert.strictEqual((await entry.countIn([dev.id])).get(dev.id), 1);
    assert.strictEqual(await membership.getKind('document').countIn([dev.id]).then((m) => m.get(dev.id) || 0), 0);

    assert.strictEqual(await entry.clearProject(dev.id), 1);
    assert.deepStrictEqual(await entry.list(dev.id), []);
});
