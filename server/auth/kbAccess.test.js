/**
 * auth/kbAccess.mts: the knowledge-base access rules and the gate, with every
 * dependency injected. The store policy's own matrix is
 * stores/knowledgeBases.authz.test.js; here: the ladder (whoever may manage
 * may read; `canReadKb` alone stays the content question), the owner before
 * any lookup, manage_knowledge counted in the base's organisation only, a
 * failed lookup granting nothing, the gate's answers (404 for no grade and for
 * an unknown id alike, 403 below the grade, or 404 when asked to hide it), what
 * it leaves on the request, its tag, and the per-request memo.
 *
 * Run: cd server && node --test auth/kbAccess.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { makeKbAccess, kbGradeAtLeast, kbAccessOf } = require('./kbAccess.mts');
const { readGate } = require('./gateMeta');
const { makeAccessFns } = require('../stores/kb/access');

// The real store policy over a store double: the rules are tested on the policy they ship with.
const policy = makeAccessFns({ getAll: async () => [], initDB: async () => {}, self: {} });

/**
 * `orgIds`: resolveUserOrgIds (default orgA; null = super admin); `adminOrgs`: the organisations the
 * caller administers; `manageIn`: where manage_knowledge holds (default orgA); `groups`: the caller's
 * group ids; `kbs`: the store by id; `fail`: which lookups reject.
 */
function access(fx = {}) {
    const calls = { orgs: 0, groups: 0, adminOrgs: 0, permission: 0 };
    const manageIn = new Set(fx.manageIn ?? ['orgA']);
    const fail = new Set(fx.fail ?? []);
    const kbs = fx.kbs ?? {};
    const warnings = [];
    const a = makeKbAccess({
        getKB: async (id) => kbs[id] || null,
        getUserId: (req) => req.session?.user?.id || null,
        resolveUserOrgIds: async () => { calls.orgs++; if (fail.has('orgs')) throw new Error('orgs down'); return 'orgIds' in fx ? fx.orgIds : new Set(['orgA']); },
        resolveUserGroups: async () => { calls.groups++; if (fail.has('groups')) throw new Error('groups down'); return fx.groups ?? []; },
        resolveAdminOrgIds: async () => { calls.adminOrgs++; if (fail.has('adminOrgs')) throw new Error('admin down'); return new Set(fx.adminOrgs ?? []); },
        resolvePermissionsByOrg: async () => {
            calls.permission++;
            if (fail.has('permission')) throw new Error('permissions down');
            return { holds: (perm, orgId) => perm === 'manage_knowledge' && !!orgId && manageIn.has(orgId) };
        },
        canUserAccessKB: policy.canUserAccessKB,
        canUserManageKB: policy.canUserManageKB,
        fallback: (where, _err, value) => { warnings.push(where); return value; },
    });
    return { a, calls, warnings };
}
const req = (session = {}, params = { id: 'k1' }) => ({ session: { user: { id: 'me' }, ...session }, params });
const kb = (over = {}) => ({ id: 'k1', tenant_id: 'someone', organization_id: 'orgA', is_published: true, shared_groups: '[]', ...over });

/** Dispatch the gate and capture its answer. */
async function run(gate, r) {
    const out = { status: 200, body: null, next: false };
    const res = { status(c) { out.status = c; return { json(b) { out.body = b; return out; } }; } };
    await gate(r, res, () => { out.next = true; });
    return out;
}

// ── The rules ─────────────────────────────────────────────────────────

test('read: the owner, the super admin, a member of the organisation on a published base, an admin of that organisation on a draft', async () => {
    const { a } = access({ manageIn: [] });
    assert.equal(await a.canReadKb(req(), kb({ tenant_id: 'me', is_published: false })), true);
    assert.equal(await a.canReadKb(req(), kb()), true);
    assert.equal(await a.canReadKb(req(), kb({ is_published: false })), false, 'a draft is hidden from a plain member');
    assert.equal(await a.canReadKb(req(), kb({ organization_id: 'orgB' })), false, 'another organisation');
    assert.equal(await access({ orgIds: null }).a.canReadKb(req({ isAdmin: true }), kb({ is_published: false })), true, 'the super admin');
    assert.equal(await access({ adminOrgs: ['orgA'] }).a.canReadKb(req(), kb({ is_published: false })), true, 'the admin of the base\'s organisation');
    assert.equal(await access({ adminOrgs: ['orgB'], orgIds: new Set(['orgA', 'orgB']) }).a.canReadKb(req(), kb({ is_published: false })), false, 'an admin elsewhere reads as a member');
    assert.equal(await a.canReadKb(req(), null), false);
});

test('read: a shared group narrows the published audience', async () => {
    assert.equal(await access({ groups: ['g1'] }).a.canReadKb(req(), kb({ shared_groups: '["g1"]' })), true);
    assert.equal(await access({ groups: ['g2'] }).a.canReadKb(req(), kb({ shared_groups: '["g1"]' })), false);
});

test('manage: the owner, the super admin, manage_knowledge held in the base\'s organisation; a right held elsewhere does not count', async () => {
    assert.equal(await access({ manageIn: [] }).a.canManageKb(req(), kb({ tenant_id: 'me' })), true);
    assert.equal(await access({ orgIds: null, manageIn: [] }).a.canManageKb(req({ isAdmin: true }), kb()), true);
    assert.equal(await access().a.canManageKb(req(), kb({ is_published: false })), true, 'a draft of a colleague, with the right held in its organisation');
    assert.equal(await access({ manageIn: ['orgB'], orgIds: new Set(['orgA', 'orgB']) }).a.canManageKb(req(), kb()), false);
    assert.equal(await access({ manageIn: [] }).a.canManageKb(req(), kb()), false);
    assert.equal(await access().a.canManageKb(req(), kb({ organization_id: null })), false, 'a personal base of someone else');
    assert.equal(await access().a.canManageKb(req(), kb({ source_kind: 'project_files' })), false, 'a project\'s files are managed from the project');
    assert.equal(await access().a.canManageKb(req(), null), false);
});

test('the ladder: whoever may manage may read; canReadKb alone keeps the content question', async () => {
    const draft = kb({ is_published: false });
    const manager = access();
    assert.equal(await manager.a.gradeOf(req(), draft), 'manage');
    assert.equal(await manager.a.canReadKb(req(), draft), false, 'the management right is not a reason to read the content elsewhere');
    assert.equal(await access({ manageIn: [] }).a.gradeOf(req(), kb()), 'read');
    assert.equal(await access({ manageIn: [] }).a.gradeOf(req(), draft), null);
    assert.equal(await access({ manageIn: [] }).a.gradeOf(req(), kb({ tenant_id: 'me' })), 'manage');
});

test('gradeOf never looks beyond `upTo`: a read-only route spends no permission lookup on a reader', async () => {
    const { a, calls } = access();
    assert.equal(await a.gradeOf(req(), kb(), 'read'), 'read');
    assert.equal(calls.permission, 0);
    assert.equal(await a.gradeOf(req(), kb(), 'manage'), 'manage');
    assert.equal(calls.permission, 1);
});

test('the owner is decided before any lookup', async () => {
    const { a, calls } = access({ fail: ['orgs', 'groups', 'adminOrgs', 'permission'] });
    assert.equal(await a.gradeOf(req(), kb({ tenant_id: 'me' })), 'manage');
    assert.deepEqual(calls, { orgs: 0, groups: 0, adminOrgs: 0, permission: 0 });
});

test('a failed lookup grants nothing and is reported: no organisations, no groups, no administered organisations, no permission', async () => {
    const orgs = access({ fail: ['orgs'] });
    assert.equal(await orgs.a.gradeOf(req(), kb()), null, 'a failed organisation read is an empty set, never the super admin\'s null');
    assert.deepEqual(orgs.warnings, ['auth/kbAccess:readContext#orgIds']);
    const perm = access({ fail: ['permission'], adminOrgs: ['orgA'] });
    assert.equal(await perm.a.gradeOf(req(), kb({ is_published: false })), 'read');
    assert.ok(perm.warnings.includes('auth/kbAccess:permissions'));
    const admin = access({ fail: ['adminOrgs'], manageIn: [] });
    assert.equal(await admin.a.gradeOf(req(), kb({ is_published: false })), null);
});

test('kbGradeAtLeast orders the ladder', () => {
    assert.equal(kbGradeAtLeast('manage', 'read'), true);
    assert.equal(kbGradeAtLeast('read', 'manage'), false);
    assert.equal(kbGradeAtLeast(null, 'read'), false);
});

// ── The gate ──────────────────────────────────────────────────────────

test('requireKbGrade: an unknown id and a base the caller holds no grade on answer the same 404', async () => {
    const { a } = access({ kbs: { k1: kb({ organization_id: 'orgB' }) }, manageIn: [] });
    const gate = a.requireKbGrade('read');
    const unknown = await run(gate, req({}, { id: 'nope' }));
    const foreign = await run(gate, req());
    assert.deepEqual([unknown.status, unknown.body], [404, { error: 'KB not found', code: 'kb_not_found' }]);
    assert.deepEqual([foreign.status, foreign.body], [unknown.status, unknown.body]);
    assert.equal(foreign.next, false);
});

test('requireKbGrade: below the grade is the structured 403, or the same 404 when asked to hide it; at the grade the handler runs with req.kbAccess', async () => {
    const { a } = access({ kbs: { k1: kb() }, manageIn: [] });
    const refused = await run(a.requireKbGrade('manage'), req());
    assert.deepEqual([refused.status, refused.body.code], [403, 'kb_not_manageable']);
    const hidden = await run(a.requireKbGrade('manage', { belowGrade: 404 }), req());
    assert.deepEqual([hidden.status, hidden.body.code], [404, 'kb_not_found']);
    const r = req();
    const passed = await run(a.requireKbGrade('read'), r);
    assert.equal(passed.next, true);
    const left = kbAccessOf(r);
    assert.equal(left.kb.id, 'k1');
    assert.equal(left.grade, 'read');
    assert.equal(left.userId, 'me');
    assert.throws(() => kbAccessOf(req()), /gate missing/);
});

test('requireKbGrade: `param` names the path parameter, and a manager passes the manage gate', async () => {
    const { a } = access({ kbs: { k1: kb() } });
    const out = await run(a.requireKbGrade('manage', { param: 'kbId' }), req({}, { kbId: 'k1' }));
    assert.equal(out.next, true);
    assert.equal(out.status, 200);
});

test('the gate is tagged scoped, with the grade, so the route contract can read it', () => {
    const { a } = access();
    assert.deepEqual(readGate(a.requireKbGrade('manage')), { axis: 'scoped', minGrade: 'manage', param: 'id' });
    assert.deepEqual(readGate(a.requireKbGrade('read', { param: 'kbId', belowGrade: 404 })), { axis: 'scoped', minGrade: 'read', param: 'kbId' });
});

// ── The memo ──────────────────────────────────────────────────────────

test('the per-request lookups are made once per request, so a loop over many bases pays for one set of reads', async () => {
    const { a, calls } = access();
    const r = req();
    for (const id of ['k1', 'k2', 'k3']) await a.gradeOf(r, kb({ id, is_published: false }));
    assert.deepEqual(calls, { orgs: 1, groups: 1, adminOrgs: 1, permission: 1 });
    await a.gradeOf(req(), kb({ is_published: false }));
    assert.equal(calls.permission, 2, 'a new request reads again');
});
