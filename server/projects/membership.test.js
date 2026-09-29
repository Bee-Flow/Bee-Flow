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
 * Pure — the registry only requires its stores lazily, inside the hooks, so
 * loading it touches no database.
 *
 * Run: cd server && node --test projects/membership.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const membership = require('./membership');

test('every kind declares an identity and a way to be listed', () => {
    const kinds = membership.listKinds();
    assert.ok(kinds.length >= 8, 'every registered kind is present');
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
    for (const kind of ['notebook', 'automation', 'app', 'webpage', 'datatable', 'agent']) {
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
    assert.deepStrictEqual(movable,
        ['notebook', 'automation', 'app', 'webpage', 'datatable', 'agent', 'knowledge_base']);
    // Knowledge bases are movable but NOT detachable, and that is not an
    // oversight: their link is an entry in the project's own
    // `knowledge_base_ids`, so deleting the project deletes the reference with
    // it. The base is in another table and is untouched.
    assert.deepStrictEqual(detachable,
        ['notebook', 'automation', 'app', 'webpage', 'datatable', 'agent']);
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
    for (const kind of ['notebook', 'automation', 'app', 'webpage', 'datatable', 'agent']) {
        assert.strictEqual(typeof membership.getKind(kind).countIn, 'function',
            `${kind} can be counted for a whole list at once`);
    }
    assert.deepStrictEqual(
        membership.countableKinds().map(k => k.kind),
        ['notebook', 'automation', 'app', 'webpage', 'datatable', 'agent'],
    );
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
