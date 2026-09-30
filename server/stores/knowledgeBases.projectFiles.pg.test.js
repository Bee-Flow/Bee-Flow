'use strict';

/**
 * A project's files base is not an organisation base.
 *
 * projects/projectFiles.js stores the files uploaded into a collaborative
 * project in a knowledge base of their own (`source_kind = 'project_files'`),
 * stamped with the project's organisation. The generic knowledge-base ACL used
 * to treat it like any other base of that organisation, so:
 *
 *   - a project VIEWER whose org role carried `manage_knowledge` could
 *     PATCH /api/kb/:id/publish it (every colleague could then read and
 *     search the project's files), or DELETE it with every file in it;
 *   - an org admin who is not a member read it, and found it through
 *     GET /api/kb?includeAuto=1.
 *
 * Who reads it is decided by project membership, who changes it by the
 * project role ladder; the generic ACL gives it to its owner (the project's
 * owner) and a super admin only, and manages nothing in it.
 *
 * Against a real Postgres (@electric-sql/pglite behind db.js, no module mocks).
 *
 * Run: cd server && node --test stores/knowledgeBases.projectFiles.pg.test.js
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');

const { usePglitePool } = require('../testUtils/pglitePool');

const { close } = usePglitePool();
const store = require('./knowledgeBases');

const ORG = new Set(['org1']);

let filesKb;
let orgKb;
let orgDraft;

before(async () => {
    await store.initDB();
    filesKb = await store.createKB('owner', 'Launch · Files', '', 'org1', {
        sourceKind: 'project_files', usageContexts: ['agent', 'direct_chat'],
    });
    orgKb = await store.createKB('owner', 'Handbook', '', 'org1', { isPublished: true });
    orgDraft = await store.createKB('owner', 'Draft', '', 'org1');
});

after(close);

test('reading: the owner and a super admin, never an org admin, a publish flag or a group', async () => {
    assert.strictEqual(store.canUserAccessKB(filesKb, 'owner', ORG, []), true, 'the project owner');
    assert.strictEqual(store.canUserAccessKB(filesKb, 'root', null, []), true, 'a super admin');
    assert.strictEqual(store.canUserAccessKB(filesKb, 'admin', ORG, [], { isOrgAdmin: true }), false,
        'an org admin who is not a member reads nothing through the generic ACL');
    const published = { ...filesKb, is_published: true, shared_groups: '[]' };
    assert.strictEqual(store.canUserAccessKB(published, 'mallory', ORG, []), false,
        'a publish flag (however it got there) opens it to nobody');
    const grouped = { ...filesKb, is_published: true, shared_groups: '["g1"]' };
    assert.strictEqual(store.canUserAccessKB(grouped, 'mallory', ORG, ['g1']), false);
    // An ordinary org base is unchanged.
    assert.strictEqual(store.canUserAccessKB(orgKb, 'mallory', ORG, []), true);
    assert.strictEqual(store.canUserAccessKB(orgDraft, 'admin', ORG, [], { isOrgAdmin: true }), true);
});

test('managing: nobody through the generic routes, not even a same-org manage_knowledge holder', async () => {
    assert.strictEqual(store.canUserManageKB(filesKb, 'mallory', ORG, true), false,
        'the viewer with manage_knowledge who could publish or delete it');
    assert.strictEqual(store.canUserManageKB(filesKb, 'owner', ORG, true), false,
        'the owner manages the files from the project');
    assert.strictEqual(store.canUserManageKB(filesKb, 'root', null, true), false);
    assert.strictEqual(store.isProjectFilesKB(filesKb), true);
    assert.strictEqual(store.isProjectFilesKB(orgKb), false);
    // An ordinary org base is unchanged.
    assert.strictEqual(store.canUserManageKB(orgKb, 'mallory', ORG, true), true);
});

test('listing: an org admin\'s ?includeAuto=1 does not list another person\'s project files base', async () => {
    const ids = (rows) => rows.map(r => r.id);

    const admin = await store.listKBs('admin', ORG, { sourceKind: null, isOrgAdmin: true });
    assert.ok(ids(admin).includes(orgDraft.id), 'org drafts still listed for an org admin');
    assert.ok(!ids(admin).includes(filesKb.id), 'the files base is not an org row');

    const member = await store.listKBs('mallory', ORG, { sourceKind: null });
    assert.ok(ids(member).includes(orgKb.id));
    assert.ok(!ids(member).includes(filesKb.id));

    // Even published: the listing never makes it an org row.
    await store.setPublished(filesKb.id, true);
    try {
        const again = await store.listKBs('mallory', ORG, { sourceKind: null });
        assert.ok(!ids(again).includes(filesKb.id));
    } finally {
        await store.setPublished(filesKb.id, false);
    }

    const owner = await store.listKBs('owner', ORG, { sourceKind: null });
    assert.ok(ids(owner).includes(filesKb.id), 'its owner still sees their own base');
});
