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
 * Run: cd server && node --test projects/membership.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const membership = require('./membership');
const { makeSwaps } = require('../testUtils/swaps');

const COLUMN_BACKED = ['notebook', 'document', 'meeting', 'automation', 'app', 'webpage', 'datatable', 'agent'];

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
        ['notebooks', 'automations', 'apps', 'webpages', 'datatables', 'agents', 'knowledgeBases', 'approvals']);
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
    for (const kind of ['automation', 'app', 'webpage', 'datatable', 'agent', 'approval']) {
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
