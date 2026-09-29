'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

// These pure helpers back the executions-table keyset pagination + server-side
// filtering. They don't touch the DB, so they're unit-testable directly.
const { encodeRunCursor, decodeRunCursor, buildRunFilterWhere } = require('./automationStore');

test('run cursor round-trips (started_at, id)', () => {
    const row = { started_at: '2026-06-27T10:00:00.000Z', id: 'run-123' };
    const cur = encodeRunCursor(row);
    assert.equal(typeof cur, 'string');
    const back = decodeRunCursor(cur);
    assert.equal(back.startedAt, '2026-06-27T10:00:00.000Z');
    assert.equal(back.id, 'run-123');
});

test('encodeRunCursor returns null without a started_at (queued rows)', () => {
    assert.equal(encodeRunCursor({ id: 'x', started_at: null }), null);
    assert.equal(encodeRunCursor(null), null);
});

test('decodeRunCursor tolerates garbage → null (falls back to page 1)', () => {
    assert.equal(decodeRunCursor('not-base64!!'), null);
    assert.equal(decodeRunCursor(''), null);
    assert.equal(decodeRunCursor(undefined), null);
    // Valid base64 but wrong shape:
    assert.equal(decodeRunCursor(Buffer.from('{"nope":1}').toString('base64url')), null);
});

test('buildRunFilterWhere scopes to the user and parameterises', () => {
    const w = buildRunFilterWhere({ user: { userId: 'user-1' } }, {}, 1);
    assert.match(w.clause, /r\.user_id = \$1/);
    assert.deepEqual(w.params, ['user-1']);
    assert.equal(w.nextIdx, 2);
    // The user scope reads automation_runs.user_id and nothing else, so it must
    // NOT ask its callers for the users join: an extra join there would drop a
    // run whose owner row has since been deleted out of that owner's own list.
    assert.equal(w.joinUsers, false);
});

test('buildRunFilterWhere org scope: COALESCE over the routine AND its owner, with the users join', () => {
    const w = buildRunFilterWhere({ org: { orgId: 'org-9' } }, {}, 1);
    // `a.organization_id = $1` alone would silently drop every routine created
    // before that column started being written (stores/automationStore/forms.js
    // documents the same trap). The COALESCE is the whole scope.
    assert.match(w.clause, /COALESCE\(a\.organization_id, u\."organizationId"\) = \$1/);
    assert.ok(!/r\.user_id/.test(w.clause), 'the org scope must not also filter by the caller');
    assert.deepEqual(w.params, ['org-9']);
    assert.equal(w.joinUsers, true);
});

test('buildRunFilterWhere fails CLOSED for every scope it cannot prove', () => {
    // A filter that scopes to nobody must return nothing, not everything. Each
    // of these is one missing null-check upstream away from being "every run in
    // the database", so the builder refuses rather than guesses.
    const denied = [
        undefined,
        null,
        {},
        { user: {} },
        { org: {} },
        { user: { userId: null }, org: { orgId: null } },
        { org: { orgId: '' } },
        { user: { userId: '' } },
        // Both at once is a caller bug — and the dangerous reading of it would
        // be "org wins", which is the widening one.
        { user: { userId: 'u1' }, org: { orgId: 'org-9' } },
    ];
    for (const scope of denied) {
        const w = buildRunFilterWhere(scope, {}, 1);
        assert.match(w.clause, /^FALSE AND /, `scope ${JSON.stringify(scope)} must match nothing`);
        assert.deepEqual(w.params, [], 'a refused scope binds no parameters');
    }
});

test('buildRunFilterWhere builds ANY() for array filters + scalar clauses', () => {
    const w = buildRunFilterWhere({ user: { userId: 'u' } }, {
        status: ['error', 'success'],
        triggerKind: 'manual',
        automationId: 'a1',
        kind: 'block',
        sinceTs: '2026-06-26T00:00:00Z',
        untilTs: '2026-06-27T00:00:00Z',
        mode: ['live'],
    }, 1);
    // The status a person filters on is the JOURNEY's — the outcome of its last
    // leg — not the head row's, which reads 'success' the moment it hands off to
    // the run that continues it. Filtering on r.status would drop a still-paused
    // form out of 'Awaiting' and file it under 'Success'.
    assert.match(w.clause, /COALESCE\(j\.status, r\.status\) = ANY\(\$2\)/);
    assert.match(w.clause, /r\.trigger_kind = ANY\(\$3\)/);
    assert.match(w.clause, /r\.mode = ANY\(\$4\)/);
    assert.match(w.clause, /r\.automation_id = \$5/);
    assert.match(w.clause, /a\.kind = \$6/);
    assert.match(w.clause, /r\.started_at >= \$7/);
    assert.match(w.clause, /r\.started_at < \$8/);
    // user + 7 filters = 8 params, all positional and in order. status/trigger/
    // mode are normalised to arrays for ANY(); scalars stay scalar.
    assert.deepEqual(w.params, ['u', ['error', 'success'], ['manual'], ['live'], 'a1', 'block', '2026-06-26T00:00:00Z', '2026-06-27T00:00:00Z']);
});

test('the org scope INTERSECTS its filters — automationId narrows, it never replaces', () => {
    // The one shape that would turn a narrowing filter into an alternative
    // scope: ask for one routine and get it whether or not it is this
    // organisation's. The org predicate has to still be in the clause, and the
    // automation filter has to be ANDed onto it.
    const w = buildRunFilterWhere({ org: { orgId: 'org-9' } }, { automationId: 'a1' }, 1);
    assert.match(w.clause, /COALESCE\(a\.organization_id, u\."organizationId"\) = \$1/);
    assert.match(w.clause, /r\.automation_id = \$2/);
    assert.ok(w.clause.includes(' AND '), 'filters are ANDed onto the scope');
    assert.deepEqual(w.params, ['org-9', 'a1']);
});

test('buildRunFilterWhere ignores empty/blank filter values', () => {
    const w = buildRunFilterWhere({ user: { userId: 'u' } }, { status: [], triggerKind: '', automationId: null }, 1);
    assert.equal(w.clause, "r.user_id = $1 AND (r.root_run_id IS NULL OR r.root_run_id = r.id) AND a.deleted_at IS NULL");
    assert.deepEqual(w.params, ['u']);
});

test('buildRunFilterWhere leaves out runs of routines in the trash, except in the one-routine scope', () => {
    assert.match(buildRunFilterWhere({ user: { userId: 'u' } }, {}, 1).clause, /a\.deleted_at IS NULL/);
    assert.match(buildRunFilterWhere({ org: { orgId: 'o' } }, {}, 1).clause, /a\.deleted_at IS NULL/);
    assert.doesNotMatch(buildRunFilterWhere({ automation: { automationId: 'a1' } }, {}, 1).clause, /deleted_at/);
});

test('buildRunFilterWhere lists journey heads only, whatever else is filtered', () => {
    // A form that pauses continues in a child run. Both are real rows, but the
    // history shows the journey once — so the head predicate is unconditional
    // and takes no parameter, and it must survive every filter combination and
    // BOTH scopes.
    const scopes = [{ user: { userId: 'u' } }, { org: { orgId: 'org-9' } }];
    for (const scope of scopes) {
        for (const filters of [{}, { status: ['error'] }, { automationId: 'a1', triggerKind: 'form' }]) {
            const w = buildRunFilterWhere(scope, filters, 1);
            assert.match(w.clause, /\(r\.root_run_id IS NULL OR r\.root_run_id = r\.id\)/);
        }
    }
});

// ── The org scope must not lose runs to a missing users row ──────────
//
// The org branch reaches into `users` for one thing: the COALESCE fallback that
// answers "whose organisation is this run in" when the automation row does not
// say. As an INNER join that reach doubled as a filter — a routine whose owner
// has no users row left dropped out of the organisation's log even with
// `a.organization_id` set and matching. A log that quietly loses entries is
// worse than one that errors, because nothing looks wrong.
//
// Genuinely textual, because the alternative is a Postgres fixture for a join
// type; the integration suite covers the query running at all. This pins the
// one word.
test('the org scope joins users LEFT — it reads a column, it does not decide who is in', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const src = fs.readFileSync(path.join(__dirname, 'automationStore', 'runs.js'), 'utf8');

    assert.match(src, /const ORG_SCOPE_JOIN = ' LEFT JOIN users u ON u\.id = a\.user_id';/,
        'an INNER join here silently narrows which runs the organisation may see');

    // And the reason the join is allowed to be LEFT: `u` is read in exactly one
    // place. If a later change starts selecting from `u`, this assertion fails
    // and whoever made it has to think about the NULL row again.
    const uses = src.match(/\bu\.(?:"[A-Za-z_]+"|[A-Za-z_]+)/g) || [];
    const outsideJoin = uses.filter(x => x !== 'u.id');
    assert.deepStrictEqual([...new Set(outsideJoin)], ['u."organizationId"'],
        'the users row is read for the COALESCE and nothing else — a new read needs a NULL story');
});
