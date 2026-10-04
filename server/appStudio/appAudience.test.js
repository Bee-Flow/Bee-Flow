/**
 * appStudio/appAudience.js — who an app reaches, with every collaborator
 * injected (no database, no module mocking).
 *
 * Pinned:
 *   - an ordinary app's publish validates the draft and FREEZES exactly the
 *     validated definition at the version it was read at; a failed validation
 *     is a 422 and writes nothing;
 *   - an app of a Solution stage moves only its audience (setStudioAppAudience),
 *     never validates or freezes the working draft, and keeps its deployed
 *     published version; publishing one that was never deployed is a 409;
 *   - the first publish stamps the organisation from the groups (or the
 *     owner's), and refuses unknown or cross-organisation groups;
 *   - a group refusal keeps its 4xx; the audit and the Nextcloud nudge follow
 *     a write that took, and only then.
 *
 * Run: cd server && node --test appStudio/appAudience.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { setAppAudience, resolveOwnerOrgId } = require('./appAudience');

const GROUPS = [
    { id: 'g1', organizationId: 'org1' },
    { id: 'g2', organizationId: 'org1' },
    { id: 'gx', organizationId: 'org2' },
];

/** A world of recorders; `managed` makes every app a stage's. */
function world({ managed = null, writeOk = true, owner = { id: 'owner', organizationId: 'org1' } } = {}) {
    const calls = { published: [], audience: [], audits: [], menu: [], validated: 0 };
    const deps = {
        store: {
            managedInfoOfApp: async () => managed,
            setStudioAppPublished: async (...args) => { calls.published.push(args); return writeOk; },
            setStudioAppAudience: async (...args) => { calls.audience.push(args); return writeOk; },
        },
        userStore: {
            getUser: async (id) => (id === owner.id ? owner : null),
            getAllGroups: async () => GROUPS,
        },
        validateSharedGroupsForOrg: async (orgId, groups) => {
            if (groups === undefined) return undefined;
            const bad = (groups || []).filter((g) => !GROUPS.some((x) => x.id === g && x.organizationId === orgId));
            if (bad.length) throw Object.assign(new Error(`Invalid groups for this organisation: ${bad.join(', ')}`), { status: 400 });
            return groups;
        },
        audit: { auditPublishChange: async (entry) => { calls.audits.push(entry); } },
        notifyMenuChange: (orgId, meta) => { calls.menu.push({ orgId, ...meta }); },
    };
    const validateDraft = async () => { calls.validated++; return { ok: true, def: { canonical: true } }; };
    return { calls, deps, validateDraft };
}

const APP = {
    id: 'app1', userId: 'owner', organizationId: 'org1', projectId: null,
    definitionVersion: 7, publishedVersion: 5, publishedDefinition: { v: 5 }, nextcloudMenu: true,
};
const STAGE = { solutionId: 'dev1', stage: 'prd', stageProjectId: 'stage_prd' };

test('an ordinary publish freezes exactly the validated draft at the version it was read at', async () => {
    const { calls, deps, validateDraft } = world();
    const out = await setAppAudience({ app: APP, publishing: true, sharedGroups: ['g1'], actorId: 'owner', validateDraft, deps });
    assert.deepStrictEqual(out, { ok: true, isPublished: true, sharedGroups: ['g1'], publishedVersion: 7, managed: false });
    assert.strictEqual(calls.validated, 1);
    assert.deepStrictEqual(calls.published, [['app1', true, 'owner', ['g1'], undefined, { canonical: true }, 7]]);
    assert.strictEqual(calls.audience.length, 0);
    assert.strictEqual(calls.audits[0].publishedVersion, 7);
    assert.strictEqual(calls.audits[0].actorId, 'owner');
    assert.deepStrictEqual(calls.menu, [{ orgId: 'org1', reason: 'publish', appId: 'app1' }]);
});

test('a draft that fails validation is a 422 and nothing is written', async () => {
    const { calls, deps } = world();
    const out = await setAppAudience({
        app: APP, publishing: true, actorId: 'owner', deps,
        validateDraft: async () => ({ ok: false, errors: ['broken'], warnings: [] }),
    });
    assert.strictEqual(out.ok, false);
    assert.strictEqual(out.status, 422);
    assert.deepStrictEqual(out.body.errors, ['broken']);
    assert.strictEqual(calls.published.length + calls.audits.length, 0);
});

test('an ordinary unpublish keeps the frozen copy and its version', async () => {
    const { calls, deps, validateDraft } = world();
    const out = await setAppAudience({ app: APP, publishing: false, actorId: 'owner', validateDraft, deps });
    assert.strictEqual(out.publishedVersion, 5);
    assert.strictEqual(calls.validated, 0, 'nothing to validate on an unpublish');
    assert.deepStrictEqual(calls.published[0].slice(0, 3), ['app1', false, 'owner']);
    assert.strictEqual(calls.published[0][6], undefined);
    assert.deepStrictEqual(calls.menu, [{ orgId: 'org1', reason: 'unpublish', appId: 'app1' }]);
});

test('an app of a Solution stage moves only its audience and keeps its deployed version', async () => {
    const { calls, deps, validateDraft } = world({ managed: STAGE });
    const app = { ...APP, projectId: 'stage_prd' };
    const out = await setAppAudience({ app, publishing: true, sharedGroups: ['g2'], actorId: 'operator', validateDraft, deps });
    assert.deepStrictEqual(out, { ok: true, isPublished: true, sharedGroups: ['g2'], publishedVersion: 5, managed: true });
    assert.strictEqual(calls.validated, 0, 'the working draft is never validated nor frozen');
    assert.strictEqual(calls.published.length, 0, 'setStudioAppPublished is never used on a managed app');
    assert.deepStrictEqual(calls.audience, [['app1', 'owner', { isPublished: true, sharedGroups: ['g2'], organizationId: undefined }]]);
    assert.strictEqual(calls.audits[0].actorId, 'operator');
    assert.strictEqual(calls.audits[0].publishedVersion, 5);
});

test('a stage app that was never deployed cannot be published', async () => {
    const { calls, deps, validateDraft } = world({ managed: STAGE });
    const app = { ...APP, projectId: 'stage_prd', publishedDefinition: null, publishedVersion: null };
    const out = await setAppAudience({ app, publishing: true, actorId: 'operator', validateDraft, deps });
    assert.strictEqual(out.status, 409);
    assert.strictEqual(out.body.code, 'app.not_deployed');
    assert.strictEqual(calls.audience.length, 0);
    // Switching it off is always possible.
    assert.strictEqual((await setAppAudience({ app, publishing: false, actorId: 'operator', deps })).ok, true);
});

test('a first publish stamps the organisation of the groups, or the owner\'s', async () => {
    const fresh = { ...APP, organizationId: null };
    let w = world();
    let out = await setAppAudience({ app: fresh, publishing: true, sharedGroups: ['g1', 'g2'], actorId: 'owner', validateDraft: w.validateDraft, deps: w.deps });
    assert.strictEqual(out.ok, true);
    assert.strictEqual(w.calls.published[0][4], 'org1');

    w = world();
    out = await setAppAudience({ app: fresh, publishing: true, sharedGroups: [], actorId: 'owner', validateDraft: w.validateDraft, deps: w.deps });
    assert.strictEqual(w.calls.published[0][4], 'org1', 'the owner\'s organisation for a whole-org publish');

    w = world();
    out = await setAppAudience({ app: fresh, publishing: true, sharedGroups: ['g1', 'gx'], actorId: 'owner', validateDraft: w.validateDraft, deps: w.deps });
    assert.deepStrictEqual([out.status, out.body.error], [400, 'Cannot publish to groups across multiple organisations']);
    out = await setAppAudience({ app: fresh, publishing: true, sharedGroups: ['nope'], actorId: 'owner', validateDraft: w.validateDraft, deps: w.deps });
    assert.deepStrictEqual([out.status, out.body.error], [400, 'Unknown group: nope']);

    w = world({ owner: { id: 'owner', organizationId: null, groups: '[]' } });
    out = await setAppAudience({ app: fresh, publishing: true, actorId: 'owner', validateDraft: w.validateDraft, deps: w.deps });
    assert.deepStrictEqual([out.status, out.body.error], [400, 'Cannot publish: owner has no organisation']);
    assert.strictEqual(w.calls.published.length, 0);
});

test('an explicit organisation is stamped as given (a stage operator\'s call)', async () => {
    const { calls, deps } = world({ managed: STAGE });
    const app = { ...APP, organizationId: null, projectId: 'stage_prd' };
    const out = await setAppAudience({ app, publishing: true, sharedGroups: ['g1'], organizationId: 'org1', actorId: 'operator', deps });
    assert.strictEqual(out.ok, true);
    assert.deepStrictEqual(calls.audience[0][2], { isPublished: true, sharedGroups: ['g1'], organizationId: 'org1' });
});

test('a group refusal keeps its 4xx, a store that wrote nothing is a 500, and neither is audited', async () => {
    let w = world();
    let out = await setAppAudience({ app: APP, publishing: true, sharedGroups: ['gx'], actorId: 'owner', validateDraft: w.validateDraft, deps: w.deps });
    assert.strictEqual(out.status, 400);
    assert.match(out.body.error, /Invalid groups/);
    assert.strictEqual(w.calls.published.length, 0);

    w = world({ writeOk: false });
    out = await setAppAudience({ app: APP, publishing: false, actorId: 'owner', deps: w.deps });
    assert.deepStrictEqual([out.status, out.body.error], [500, 'Failed to update published status']);
    assert.strictEqual(w.calls.audits.length + w.calls.menu.length, 0);
});

test('a store refusal (409 managed_part) propagates to the caller', async () => {
    const { deps } = world();
    deps.store.setStudioAppPublished = async () => {
        throw Object.assign(new Error('managed'), { status: 409, code: 'managed_part', expose: true });
    };
    await assert.rejects(setAppAudience({ app: APP, publishing: false, actorId: 'owner', deps }), { code: 'managed_part' });
});

test('resolveOwnerOrgId falls back to the organisation of the owner\'s first group', async () => {
    const userStore = {
        getUser: async () => ({ organizationId: null, groups: '["gx"]' }),
        getAllGroups: async () => GROUPS,
    };
    assert.strictEqual(await resolveOwnerOrgId('u', userStore), 'org2');
    assert.strictEqual(await resolveOwnerOrgId('u', { getUser: async () => null, getAllGroups: async () => [] }), null);
});
