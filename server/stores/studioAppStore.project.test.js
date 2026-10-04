/**
 * Studio Apps inside a Solution (APPS-15).
 *
 * `studio_apps.project_id` has documented since the column was added that a
 * project's members may see an app filed into it without it being published to
 * their org — and neither the list nor the read predicate has ever looked at
 * the column. This file pins the resolution of that contradiction. The rules:
 *
 *   1. PROJECT MEMBERSHIP IS AN AUDIENCE, LIKE AN ORG OR A GROUP. It answers
 *      WHO may read an app, never WHETHER THERE IS ANYTHING TO READ: an
 *      UNPUBLISHED app stays invisible to its project's members, because there
 *      is no frozen published_definition to serve them and the owner's live
 *      draft is nobody else's to see. A tile that 404s on click is worse than
 *      no tile.
 *   2. ADDITIVE, NEVER A DOWNGRADE. A standalone app (project_id NULL) stays
 *      exactly as private as it was, and canReadStudioAppAsync is only ever
 *      consulted after the sync predicate has already said no — so every
 *      existing caller keeps its behaviour to the letter.
 *   3. READ ONLY. Filing an app into a project does not make the project's
 *      members its authors: canWriteStudioApp stays owner-only (app actions run
 *      automations acts-as-author), and no write path calls the async predicate.
 *
 * Modelled on stores/webpageStore.project.test.js, which pins the same three
 * rules for the webpage half of a Solution.
 *
 * Run: cd server && node --test stores/studioAppStore.project.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

process.env.NODE_ENV = 'test';

// ── Postgres stand-in ───────────────────────────────────────────────
// Only the reads getAccessibleStudioApps issues are modelled, and each
// condition is applied only when the SQL actually asks for it — so dropping a
// clause from the store changes what this fake returns, instead of being
// papered over by a stub that filters on its own initiative.

const rows = [];

function doSelect(sql, params) {
    if (/SELECT\s+1\s+FROM studio_apps/i.test(sql) && /project_id IS NOT NULL/i.test(sql)) {
        return rows.some(r => r.project_id) ? [{ '?column?': 1 }] : [];
    }
    let out = rows;
    if (/project_id = ANY\(\$1/i.test(sql)) {
        const ids = params[0] || [];
        out = out.filter(r => ids.includes(r.project_id));
        if (/is_published = TRUE/i.test(sql)) out = out.filter(r => r.is_published === true);
    } else if (/user_id = \$1/i.test(sql)) {
        const [userId, orgIds = []] = params;
        out = out.filter(r => r.user_id === userId
            || (/organization_id = ANY\(\$2/i.test(sql)
                && r.is_published === true && r.organization_id && orgIds.includes(r.organization_id)));
    } else {
        return [];
    }
    if (/ORDER BY updated_at DESC/i.test(sql)) {
        out = [...out].sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
    }
    // Project the column list the store actually asked for, so a field dropped
    // from META_COLS goes missing here exactly as it would in Postgres.
    const cols = sql.replace(/^\s*SELECT\s+/i, '').split(/\s+FROM\s+/i)[0]
        .split(',').map(c => c.trim()).filter(Boolean);
    return out.map(r => Object.fromEntries(cols.map(c => [c, r[c]])));
}

const mockDb = {
    // Everything that is not one of the modelled reads (CREATE/ALTER during
    // init, the migration modules) answers empty rather than throwing.
    getAll: async (sql, params = []) => (/^SELECT/i.test(String(sql).trim()) ? doSelect(String(sql), params) : []),
    getOne: async (sql, params = []) => (/^SELECT/i.test(String(sql).trim()) ? (doSelect(String(sql), params)[0] || null) : null),
    run: async () => ({ rows: [], rowCount: 0 }),
    exec: async () => {},
    getClient: async () => ({ query: async () => ({ rows: [], rowCount: 0 }), release() {} }),
};

const Module = require('module');
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (request === '../db') return 'mock-db';
    return originalResolve.call(this, request, parent, ...rest);
};
require.cache['mock-db'] = { id: 'mock-db', exports: mockDb };

// ── Membership stand-ins ────────────────────────────────────────────
// `${userId}:${projectId}` → role. Both the single-row predicate (which asks
// projectAccess.getProjectRole) and the list (which asks projectStore for the
// user's projects) read from this one table, so a member is a member for both.
const roles = {};
const lookups = { getProjectRole: 0, listUserProjects: 0 };

function seedModule(request, exports) {
    const filename = require.resolve(request);
    require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

seedModule('../auth/projectAccess', {
    getProjectRole: async (userId, projectId) => {
        lookups.getProjectRole++;
        return roles[`${userId}:${projectId}`] || null;
    },
});
// `throwOnLookup` lets a test make the membership lookup FAIL rather than
// return nothing — the two are different events and the store has to treat
// them the same way: deny.
const failure = { listUserProjects: false };
seedModule('./projectStore', {
    listUserProjects: async (userId) => {
        lookups.listUserProjects++;
        if (failure.listUserProjects) throw new Error('projects table unreachable');
        return Object.keys(roles)
            .filter(k => k.startsWith(`${userId}:`))
            .map(k => ({ id: k.slice(userId.length + 1) }));
    },
});

const store = require('./studioAppStore');

// ── Fixtures ────────────────────────────────────────────────────────

const OWNED = { id: 'app1', userId: 'alice', isPublished: false, organizationId: null, sharedGroups: [], projectId: null };
const IN_PROJECT = { ...OWNED, id: 'app2', projectId: 'p1', isPublished: true, organizationId: 'org1' };
const DRAFT_IN_PROJECT = { ...OWNED, id: 'app3', projectId: 'p1' };
const PUBLISHED = { ...OWNED, id: 'app4', isPublished: true, organizationId: 'org1' };

// ── The single-row predicate ────────────────────────────────────────

test('the owner reads their own app, project or not', async () => {
    assert.strictEqual(await store.canReadStudioAppAsync(OWNED, 'alice'), true);
    assert.strictEqual(await store.canReadStudioAppAsync(IN_PROJECT, 'alice'), true);
    assert.strictEqual(await store.canReadStudioAppAsync(DRAFT_IN_PROJECT, 'alice'), true);
});

test('a standalone app stays strictly private to its owner', async () => {
    // The additive rule's floor: no project, no widening, whoever is asking.
    roles['bob:p1'] = 'editor';
    assert.strictEqual(await store.canReadStudioAppAsync(OWNED, 'bob'), false);
    delete roles['bob:p1'];
});

test('a project member reads a published app filed into that project', async () => {
    roles['bob:p1'] = 'viewer';
    // bob is in no org here, so the org/group route cannot be what lets him in.
    assert.strictEqual(store.canReadStudioApp(IN_PROJECT, 'bob'), false, 'the sync predicate still says no');
    assert.strictEqual(await store.canReadStudioAppAsync(IN_PROJECT, 'bob'), true, 'the project is what widens it');
    delete roles['bob:p1'];
});

test('an UNPUBLISHED app in a project stays invisible to its members', async () => {
    // Membership answers who, not whether there is anything to serve: there is
    // no frozen published copy, and the owner's draft is never anyone else's.
    roles['bob:p1'] = 'editor';
    assert.strictEqual(await store.canReadStudioAppAsync(DRAFT_IN_PROJECT, 'bob'), false);
    delete roles['bob:p1'];
});

test('a non-member reads nothing, even though the app is in a project', async () => {
    assert.strictEqual(await store.canReadStudioAppAsync(IN_PROJECT, 'mallory'), false);
});

test('an anonymous caller is never widened by a project', async () => {
    assert.strictEqual(await store.canReadStudioAppAsync(IN_PROJECT, null), false);
    assert.strictEqual(await store.canReadStudioAppAsync(IN_PROJECT, undefined), false);
});

test('org publishing keeps working untouched', async () => {
    assert.strictEqual(await store.canReadStudioAppAsync(PUBLISHED, 'bob', [], ['org1']), true);
    assert.strictEqual(await store.canReadStudioAppAsync(PUBLISHED, 'bob', [], ['org2']), false);
});

test('the async predicate agrees with the sync one wherever the sync one says yes', async () => {
    const cases = [
        [OWNED, 'alice', [], []],
        [PUBLISHED, 'bob', [], ['org1']],
        [PUBLISHED, 'bob', [], ['org2']],
        [{ ...PUBLISHED, sharedGroups: ['g1'] }, 'bob', ['g1'], ['org1']],
        [{ ...PUBLISHED, sharedGroups: ['g1'] }, 'bob', ['g2'], ['org1']],
        [IN_PROJECT, 'mallory', [], ['org9']],
    ];
    for (const [app, uid, groups, orgs] of cases) {
        if (store.canReadStudioApp(app, uid, groups, orgs)) {
            assert.strictEqual(await store.canReadStudioAppAsync(app, uid, groups, orgs), true,
                'the widening never turns an existing yes into a no');
        }
    }
});

test('a missing app is unreadable by anyone', async () => {
    assert.strictEqual(await store.canReadStudioAppAsync(null, 'alice'), false);
    assert.strictEqual(await store.canReadStudioAppAsync(undefined, 'alice'), false);
});

test('the widening is read-only — a project member is not an author', async () => {
    roles['bob:p1'] = 'editor';
    assert.strictEqual(store.canWriteStudioApp(IN_PROJECT, 'bob'), false);
    assert.strictEqual(store.canWriteStudioApp(DRAFT_IN_PROJECT, 'bob'), false);
    assert.strictEqual(store.canWriteStudioApp(IN_PROJECT, 'alice'), true, 'the owner still writes');
    delete roles['bob:p1'];
});

// ── The directory listing ───────────────────────────────────────────

function row(over = {}) {
    return {
        id: 'r', user_id: 'alice', organization_id: 'org1', project_id: null, name: 'App',
        description: '', icon: null, accent_color: null, category: null,
        definition_version: 1, published_version: null, is_published: false, shared_groups: '[]',
        nextcloud_menu: false, published_at: null,
        created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z',
        template_id: null, template_version: null, template_install_hash: null,
        ...over,
    };
}

function reset() {
    rows.length = 0;
    for (const k of Object.keys(roles)) delete roles[k];
    lookups.getProjectRole = 0;
    lookups.listUserProjects = 0;
}

test('an app published into a project I am in shows up in my directory', async () => {
    reset();
    // Published, but to an org bob is not in — only the project carries him.
    rows.push(row({ id: 'a1', user_id: 'alice', organization_id: 'org1', is_published: true, project_id: 'p1' }));
    roles['bob:p1'] = 'viewer';
    const bob = await store.getAccessibleStudioApps('bob', [], ['org9']);
    assert.deepStrictEqual(bob.map(a => a.id), ['a1']);
    assert.strictEqual(bob[0].projectId, 'p1');
});

test('an unpublished app in my project is NOT listed — no tile that 404s', async () => {
    reset();
    rows.push(row({ id: 'a1', user_id: 'alice', is_published: false, project_id: 'p1' }));
    roles['bob:p1'] = 'editor';
    assert.deepStrictEqual(await store.getAccessibleStudioApps('bob', [], ['org9']), []);
});

test("an app in someone else's project is not listed", async () => {
    reset();
    rows.push(row({ id: 'a1', user_id: 'alice', is_published: true, project_id: 'p1' }));
    roles['bob:p2'] = 'owner';
    assert.deepStrictEqual(await store.getAccessibleStudioApps('bob', [], ['org9']), []);
});

test('an app that is both mine and in my project is listed once', async () => {
    reset();
    rows.push(row({ id: 'a1', user_id: 'bob', is_published: true, project_id: 'p1' }));
    roles['bob:p1'] = 'owner';
    const bob = await store.getAccessibleStudioApps('bob', [], ['org1']);
    assert.deepStrictEqual(bob.map(a => a.id), ['a1']);
});

test('the merged list is one list, still newest-first', async () => {
    reset();
    rows.push(row({ id: 'own', user_id: 'bob', updated_at: '2026-02-02T00:00:00.000Z' }));
    // org2, so this row can only arrive through the project query — otherwise
    // the org query would have ordered it for us and the merge would be untested.
    rows.push(row({ id: 'proj', user_id: 'alice', is_published: true, organization_id: 'org2', project_id: 'p1', updated_at: '2026-03-03T00:00:00.000Z' }));
    rows.push(row({ id: 'org', user_id: 'carol', is_published: true, organization_id: 'org1', updated_at: '2026-01-01T00:00:00.000Z' }));
    roles['bob:p1'] = 'viewer';
    const bob = await store.getAccessibleStudioApps('bob', [], ['org1']);
    assert.deepStrictEqual(bob.map(a => a.id), ['proj', 'own', 'org']);
});

test('someone in no project sees exactly what they saw before', async () => {
    reset();
    rows.push(row({ id: 'own', user_id: 'bob' }));
    rows.push(row({ id: 'other', user_id: 'alice', is_published: true, organization_id: 'org1', project_id: 'p1' }));
    const bob = await store.getAccessibleStudioApps('bob', [], ['org1']);
    assert.deepStrictEqual(bob.map(a => a.id).sort(), ['other', 'own']);
});

test('no app is filed into a project → no membership lookup at all', async () => {
    reset();
    rows.push(row({ id: 'own', user_id: 'bob' }));
    roles['bob:p1'] = 'owner';
    await store.getAccessibleStudioApps('bob', [], ['org1']);
    assert.strictEqual(lookups.listUserProjects, 0,
        'the guard has to spare installs that do not use Solutions the extra query');
});

// ── APPS-04: the category rides on the same row ─────────────────────

test('the list row carries the app category', async () => {
    reset();
    rows.push(row({ id: 'a1', user_id: 'bob', category: 'sales' }));
    rows.push(row({ id: 'a2', user_id: 'bob' }));
    const bob = await store.getAccessibleStudioApps('bob', [], ['org1']);
    assert.deepStrictEqual(
        Object.fromEntries(bob.map(a => [a.id, a.category])),
        { a1: 'sales', a2: null },
        'uncategorised is null, never an empty string',
    );
});


/**
 * The lookup FAILING is not the lookup returning nothing.
 *
 * userProjectIds catches and answers "no projects", which is the whole reason
 * a hiccup in the projects table cannot take the app directory down. But the
 * same catch is what decides that an unreachable membership table DENIES
 * rather than grants, and until now nothing pinned that: flipping the catch to
 * return every project id left all eighteen tests green.
 *
 * This is the rule the rest of the product is built on — unknown must NARROW —
 * and it is worth a test precisely because the failure is invisible. Nobody
 * sees an app they should not see; they see one they should not see, once, on
 * the day the database hiccups.
 */
test('a membership lookup that THROWS denies, and does not take the directory down', async () => {
    reset();
    // app2 reaches bob ONLY through the project; app4 reaches him through org1.
    rows.push(row({ id: 'app2', user_id: 'alice', organization_id: 'org9', is_published: true, project_id: 'p1' }));
    rows.push(row({ id: 'app4', user_id: 'alice', organization_id: 'org1', is_published: true }));
    roles['bob:p1'] = 'viewer';

    failure.listUserProjects = true;
    try {
        const listed = await store.getAccessibleStudioApps('bob', [], ['org1']);
        // The org-published app still arrives: a broken projects table must not
        // blank the directory.
        assert.deepStrictEqual(listed.map(a => a.id), ['app4'],
            'a failed membership lookup either hid the org-published app or widened past it');
        // And the project-only app does NOT, even though bob really is a member.
        assert.ok(!listed.some(a => a.id === 'app2'),
            'an unreadable membership table was treated as membership');
    } finally {
        failure.listUserProjects = false;
    }
});
