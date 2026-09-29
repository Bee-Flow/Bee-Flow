/**
 * The grade matrix. Every row here is a rule somebody could otherwise get
 * wrong in a way that leaks or loses data, so each one is pinned.
 *
 * The two that matter most:
 *   - `shared_groups: []` means ENTIRE ORG. Publishing a table must NOT make it
 *     org-writable, so a published table with no grants yields `viewer`.
 *   - Org isolation is checked FIRST, ahead of the super-admin bypass that
 *     auth/audience.canSeePublished grants.
 */

const { test } = require('node:test');
const assert = require('node:assert');

const {
    gradeForPrincipal, resolveDatatablePrincipal, effectiveGradeForRun, synthesizeAccess,
    gradeAtLeast, narrowGrade, ROLE_ORDER,
} = require('./datatableAccess');

const ORG = 'org-a';
const OWNER = 'u-owner';

const table = (over = {}) => ({
    id: 'tbl_aaaaaa',
    organization_id: ORG,
    owner_user_id: OWNER,
    is_published: false,
    shared_groups: [],
    write_mode: 'grants',
    row_scope: 'all',
    ...over,
});

const who = (over = {}) => ({
    userId: 'u-member',
    orgId: ORG,
    organizationId: ORG,
    groupIds: [],
    orgRole: 'member',
    ...over,
});

// ── RULE 0: a personal table is nobody else's ─────────────────────

const personal = (over = {}) => table({
    scope_kind: 'user', scope_id: 'u-solo',
    organization_id: null, owner_user_id: 'u-solo',
    ...over,
});

test('a personal table is owner for its own account', () => {
    assert.strictEqual(gradeForPrincipal(personal(), [], who({ userId: 'u-solo', orgId: null, organizationId: null })), 'owner');
    // And still owner once that account joins an organisation — the table did
    // not move, and its owner must not lose their own rows by being hired.
    assert.strictEqual(gradeForPrincipal(personal(), [], who({ userId: 'u-solo' })), 'owner');
});

test('an ORG ADMIN of the same organisation gets NOTHING on a personal table', () => {
    // "Personal, except an administrator can read it" is not personal. Rule 3
    // would return owner for this principal on any org table.
    const admin = who({ userId: 'u-admin', orgRole: 'org_admin' });
    assert.strictEqual(gradeForPrincipal(personal(), [], admin), null);
    assert.strictEqual(gradeForPrincipal(personal({ organization_id: ORG }), [], admin), null,
        'not even when the row still names an organisation');
});

test('a SUPER-ADMIN gets nothing on a personal table either', () => {
    // canSeePublished treats orgIds === null as a bypass; rule 0 returns before
    // any audience shape is built.
    const root = who({ userId: 'u-root', orgId: null, organizationId: null, orgRole: 'org_admin' });
    assert.strictEqual(gradeForPrincipal(personal({ is_published: true }), [], root), null);
});

test('a personal table cannot be widened by publishing, groups or write_mode', () => {
    // The routes refuse to set these; if one ever landed anyway, the grade rule
    // must still not honour it.
    const wide = personal({ is_published: true, shared_groups: [], write_mode: 'audience' });
    for (const p of [who(), who({ userId: 'u-admin', orgRole: 'org_admin' }), who({ groupIds: ['g1'] })]) {
        assert.strictEqual(gradeForPrincipal(wide, [], p), null);
    }
    assert.strictEqual(gradeForPrincipal(wide, [], who({ userId: 'u-solo' })), 'owner');
});

test('a GRANT on a personal table confers nothing — rule 0 returns before rule 4', () => {
    const grants = [{ grantee_type: 'user', grantee_id: 'u-member', grade: 'editor' }];
    assert.strictEqual(gradeForPrincipal(personal(), grants, who()), null);
});

test('a personal table with no scope_id is unreachable, not shared', () => {
    // The fail-closed direction: a half-written row must deny, never match a
    // principal whose userId happens to be undefined too.
    assert.strictEqual(gradeForPrincipal(personal({ scope_id: null }), [], who({ userId: 'u-solo' })), null);
});

// ── org isolation, first and unconditional ──────────────────────────────────

test('a principal from another organisation gets nothing, whatever else is true', () => {
    const t = table({ is_published: true, write_mode: 'audience' });
    const outsider = who({ userId: OWNER, orgId: 'org-b', organizationId: 'org-b', orgRole: 'org_admin' });
    assert.strictEqual(gradeForPrincipal(t, [], outsider), null,
        'not even the creator reaches a table through the wrong run org');
});

test('a table with no organisation is unreachable', () => {
    assert.strictEqual(gradeForPrincipal(table({ organization_id: null }), [], who({ userId: OWNER })), null);
});

test('org isolation is decided before the audience bypass', () => {
    // canSeePublished treats orgIds === null as a super-admin pass. This module
    // must never construct that shape — a cross-org principal is already gone.
    const t = table({ is_published: true });
    const superAdmin = who({ userId: 'u-root', orgId: 'org-b', organizationId: null, orgRole: 'org_admin' });
    assert.strictEqual(gradeForPrincipal(t, [], superAdmin), null);
});

// ── owner ───────────────────────────────────────────────────────────────────

test('the creator is owner', () => {
    assert.strictEqual(gradeForPrincipal(table(), [], who({ userId: OWNER })), 'owner');
});

test('an org admin of the SAME org is owner', () => {
    const admin = who({ userId: 'u-admin', orgRole: 'org_admin' });
    assert.strictEqual(gradeForPrincipal(table(), [], admin), 'owner');
});

test('the legacy "admin" orgRole counts as org admin', () => {
    assert.strictEqual(gradeForPrincipal(table(), [], who({ userId: 'u-admin', orgRole: 'admin' })), 'owner');
});

test('an org admin whose HOME org differs from the table\'s org is not owner', () => {
    // users."orgRole" is a global column. Someone who moved employer keeps the
    // role string; the anchor to users."organizationId" is what stops it
    // travelling into another tenant's table.
    const admin = who({ userId: 'u-admin', orgRole: 'org_admin', organizationId: 'org-b' });
    assert.strictEqual(gradeForPrincipal(table(), [], admin), null);
});

// ── the read/write split ────────────────────────────────────────────────────

test('published with shared_groups [] means the whole org can READ, not write', () => {
    const t = table({ is_published: true, shared_groups: [], write_mode: 'grants' });
    assert.strictEqual(gradeForPrincipal(t, [], who()), 'viewer',
        'an empty shared_groups is "everyone in the org"; it must never imply write');
});

test('write_mode "audience" upgrades that same table to editor', () => {
    const t = table({ is_published: true, shared_groups: [], write_mode: 'audience' });
    assert.strictEqual(gradeForPrincipal(t, [], who()), 'editor');
});

test('an unpublished table is invisible without a grant', () => {
    assert.strictEqual(gradeForPrincipal(table(), [], who()), null);
});

test('group sharing needs the viewer to be in one of the groups', () => {
    const t = table({ is_published: true, shared_groups: ['g-hr'] });
    assert.strictEqual(gradeForPrincipal(t, [], who({ groupIds: ['g-sales'] })), null);
    assert.strictEqual(gradeForPrincipal(t, [], who({ groupIds: ['g-hr'] })), 'viewer');
});

// ── explicit grants ─────────────────────────────────────────────────────────

test('a user grant is honoured, and the strongest one wins', () => {
    const grants = [
        { grantee_type: 'user', grantee_id: 'u-member', grade: 'viewer' },
        { grantee_type: 'user', grantee_id: 'u-member', grade: 'editor' },
    ];
    assert.strictEqual(gradeForPrincipal(table(), grants, who()), 'editor');
});

test('a group grant is honoured only for a member of that group', () => {
    const grants = [{ grantee_type: 'group', grantee_id: 'g-ops', grade: 'editor' }];
    assert.strictEqual(gradeForPrincipal(table(), grants, who()), null);
    assert.strictEqual(gradeForPrincipal(table(), grants, who({ groupIds: ['g-ops'] })), 'editor');
});

test('a grant for somebody else does nothing', () => {
    const grants = [{ grantee_type: 'user', grantee_id: 'u-other', grade: 'editor' }];
    assert.strictEqual(gradeForPrincipal(table(), grants, who()), null);
});

test('a grant with an unknown grade is ignored rather than trusted', () => {
    const grants = [{ grantee_type: 'user', grantee_id: 'u-member', grade: 'owner' }];
    assert.strictEqual(gradeForPrincipal(table(), grants, who()), null,
        'owner is derived, never granted — a stray row must not confer it');
});

// ── de graadrekenkunde zelf ─────────────────────────────────────────────────
//
// narrowGrade is uit effectiveGradeForRun getrokken toen App Studio dezelfde
// regel nodig had (een app die een Studio-tabel toont versmalt de graad van de
// eigenaar met het plafond van de app-rol van de kijker). Eén implementatie,
// dus hier gepind: twee kopieën van "het minimum, nooit de unie" lopen uit
// elkaar, en de kopie die drift is de kopie waar niemand naar kijkt.

test('narrowGrade geeft het MINIMUM, en is symmetrisch', () => {
    assert.strictEqual(narrowGrade('owner', 'editor'), 'editor');
    assert.strictEqual(narrowGrade('editor', 'owner'), 'editor');
    assert.strictEqual(narrowGrade('editor', 'viewer'), 'viewer');
    assert.strictEqual(narrowGrade('viewer', 'owner'), 'viewer');
    assert.strictEqual(narrowGrade('owner', 'owner'), 'owner');
});

test('narrowGrade laat ONBEKEND versmallen tot een weigering, niet tot de laagste graad', () => {
    // `null` en `'viewer'` zijn verschillende antwoorden: alleen het eerste is
    // een weigering. rank(null) is -1 en zou ook al het minimum zijn — het gaat
    // erom dat het ANTWOORD null blijft en geen graadnaam wordt.
    assert.strictEqual(narrowGrade(null, 'owner'), null);
    assert.strictEqual(narrowGrade('owner', null), null);
    assert.strictEqual(narrowGrade(null, null), null);
    assert.strictEqual(narrowGrade('owner', 'admin'), null, 'een onbekende naam is geen graad');
    assert.strictEqual(narrowGrade('owner', ''), null);
});

// ── acting on behalf of someone else ────────────────────────────────────────

test('a run on behalf of another user takes the MINIMUM grade, never the union', () => {
    const t = table({ is_published: true, write_mode: 'audience' });   // everyone: editor
    const runner = who({ userId: OWNER });                             // owner
    const behalf = who({ userId: 'u-member' });                        // editor
    assert.strictEqual(effectiveGradeForRun(t, [], runner, behalf), 'editor');
    assert.strictEqual(effectiveGradeForRun(t, [], runner, null), 'owner');
});

test('a run on behalf of someone with no grade has no grade', () => {
    const t = table();                                                  // private
    const runner = who({ userId: OWNER });
    assert.strictEqual(effectiveGradeForRun(t, [], runner, who({ userId: 'u-stranger' })), null);
});

// ── the engine descriptor ───────────────────────────────────────────────────

test('synthesizeAccess denies by default and never lets a viewer write', () => {
    const a = synthesizeAccess(table());
    assert.strictEqual(a.default, 'none');
    assert.strictEqual(a.roles.viewer.create, false);
    assert.strictEqual(a.roles.viewer.update, 'none');
    assert.strictEqual(a.roles.viewer.delete, 'none');
    assert.strictEqual(a.roles.editor.create, true);
});

test('row_scope "own" narrows every non-owner grade to their own rows', () => {
    const a = synthesizeAccess(table({ row_scope: 'own' }));
    assert.strictEqual(a.roles.viewer.read, 'own');
    assert.strictEqual(a.roles.editor.read, 'own');
    assert.strictEqual(a.roles.editor.update, 'own');
    assert.strictEqual(a.roles.editor.delete, 'own');
});

test('the synthesized access compiles to a real predicate through the core engine', () => {
    const accessFilter = require('../core/dataEngine/accessFilter');
    const meta = {
        id: 'tbl_aaaaaa', key: 'rows',
        fields: [{ id: 'f1', key: 'name', type: 'text' }],
        access: synthesizeAccess(table({ row_scope: 'own' })),
    };
    const af = accessFilter.compileAccessFilter(meta, 'viewer', { id: 'u-member' }, 'read');
    assert.match(af.where, /created_by/);
    assert.ok(af.params.includes('u-member'));
    // and a principal with no grade compiles to a deny, not an absent filter
    const denied = accessFilter.compileAccessFilter(meta, null, { id: 'u-member' }, 'read');
    assert.match(denied.where, /1\s*=\s*0/);
});

// ── the ladder ──────────────────────────────────────────────────────────────

test('gradeAtLeast uses the shipped project ROLE_ORDER, not a new one', () => {
    assert.deepStrictEqual(ROLE_ORDER, { viewer: 0, editor: 1, owner: 2 });
    assert.ok(gradeAtLeast('owner', 'editor'));
    assert.ok(gradeAtLeast('editor', 'editor'));
    assert.ok(!gradeAtLeast('viewer', 'editor'));
    assert.ok(!gradeAtLeast(null, 'viewer'));
    assert.ok(!gradeAtLeast('nonsense', 'viewer'));
});

// ── the principal itself, resolved from the DB ──────────────────────────────
//
// The grade rules above are only as good as the principal handed to them, and
// the principal is where the bug actually lived: three routers each read the
// org, the role and the groups off `req.session.user`, where
// sessionShapes.contract.test.js shows only two of the seven login shapes ever
// write an organisationId. Every request below therefore carries the RETURNING
// user's session — `{id, displayName, role}` and nothing more.

const userStore = require('../stores/userStore');

/** Run `fn` with `users`/`groups` stubbed. The resolver may only read these. */
async function withDb({ users = {}, groups = [] }, fn) {
    const realUser = userStore.getUser;
    const realGroups = userStore.getAllGroups;
    userStore.getUser = async (id) => users[id] || null;
    userStore.getAllGroups = async () => groups;
    try { return await fn(); } finally {
        userStore.getUser = realUser;
        userStore.getAllGroups = realGroups;
    }
}

const session = (over = {}) => ({
    session: { user: { id: 'u-member', displayName: 'Mem', role: 'user', ...over } },
});

test('the org comes off the users row when the session has none', async () => {
    await withDb({ users: { 'u-member': { id: 'u-member', organizationId: ORG, orgRole: 'member', groups: [] } } },
        async () => {
            const p = await resolveDatatablePrincipal(session());
            assert.strictEqual(p.orgId, ORG);
            assert.strictEqual(p.organizationId, ORG);
            assert.strictEqual(p.orgRole, 'member');
        });
});

test("an org-less users row falls back to the first org-bearing group", async () => {
    await withDb({
        users: { 'u-member': { id: 'u-member', organizationId: '', orgRole: '', groups: ['g-none', 'g-org'] } },
        groups: [{ id: 'g-none', organizationId: null }, { id: 'g-org', organizationId: 'org-b' }],
    }, async () => {
        const p = await resolveDatatablePrincipal(session());
        assert.strictEqual(p.orgId, 'org-b', 'the tenant being acted in');
        assert.strictEqual(p.organizationId, null,
            'but NOT the home org — otherwise a stale orgRole would grant owner in an org nobody made them admin of');
    });
});

test("'' is absent, not a tenant key", async () => {
    // stores/user/users.js createUser writes `organizationId || ''`, so an
    // org-less account holds the empty string. An `IS NOT NULL`-shaped check
    // hands that on as a real organisation id.
    await withDb({ users: { 'u-member': { id: 'u-member', organizationId: '', orgRole: '', groups: [] } } },
        async () => {
            const p = await resolveDatatablePrincipal(session());
            assert.strictEqual(p.orgId, null);
            assert.strictEqual(p.organizationId, null);
            assert.strictEqual(p.orgRole, null);
        });
});

test('a session claiming org_admin in another org is ignored entirely', async () => {
    await withDb({ users: { 'u-member': { id: 'u-member', organizationId: ORG, orgRole: 'member', groups: [] } } },
        async () => {
            const p = await resolveDatatablePrincipal(session({ organizationId: 'org-evil', orgRole: 'org_admin' }));
            assert.strictEqual(p.orgId, ORG);
            assert.strictEqual(p.orgRole, 'member');
            assert.strictEqual(gradeForPrincipal(table(), [], p), null,
                'a session-declared org_admin must confer nothing');
        });
});

test('a demoted admin loses owner on the next request, not on the next login', async () => {
    // The session still says org_admin because it was minted before the
    // demotion; the users row is what decides.
    await withDb({ users: { 'u-admin': { id: 'u-admin', organizationId: ORG, orgRole: 'member', groups: [] } } },
        async () => {
            const req = { session: { user: { id: 'u-admin', orgRole: 'org_admin' } } };
            const p = await resolveDatatablePrincipal(req);
            assert.strictEqual(gradeForPrincipal(table({ is_published: true }), [], p), 'viewer');
        });
});

test('a genuine org admin DOES get owner over HTTP — this could never fire before', async () => {
    await withDb({ users: { 'u-admin': { id: 'u-admin', organizationId: ORG, orgRole: 'org_admin', groups: [] } } },
        async () => {
            const p = await resolveDatatablePrincipal(session({ id: 'u-admin' }));
            assert.strictEqual(gradeForPrincipal(table(), [], p), 'owner');
        });
});

test('the principal is memoised on the request', async () => {
    let reads = 0;
    await withDb({ users: { 'u-member': { id: 'u-member', organizationId: ORG, orgRole: 'member', groups: [] } } },
        async () => {
            const realUser = userStore.getUser;
            userStore.getUser = async (id) => { reads += 1; return realUser(id); };
            const req = session();
            const a = await resolveDatatablePrincipal(req);
            const first = reads;
            const b = await resolveDatatablePrincipal(req);
            assert.strictEqual(a, b);
            assert.strictEqual(reads, first, 'a route chain resolves once, not once per call site');
        });
});

test('a request with no session resolves to nothing rather than throwing', async () => {
    await withDb({}, async () => {
        const p = await resolveDatatablePrincipal({});
        assert.strictEqual(p.userId, null);
        assert.strictEqual(p.orgId, null);
        assert.deepStrictEqual(p.groupIds, []);
    });
});
