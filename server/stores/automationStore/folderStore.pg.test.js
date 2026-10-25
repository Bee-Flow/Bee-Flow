// @typecheck
'use strict';
/**
 * The folder tree against a real Postgres (PGlite): placement rules (no loops,
 * one organisation, depth limit, names per parent) and the delete that never
 * deletes. Run: cd server && node --test stores/automationStore/folderStore.pg.test.js
 */

const { test, before, after, beforeEach, describe } = require('node:test');
const assert = require('node:assert');
const { pgliteDb } = require('../../testUtils/pgliteDb');
const { makeFolderStore, FolderError } = require('./folderStore.mts');

const { pg, db } = pgliteDb();
let depth = 8;
const store = makeFolderStore(db, { maxDepth: () => depth });

before(async () => {
    await pg.exec(`
        CREATE TABLE automation_folders (
            id TEXT PRIMARY KEY, organization_id TEXT,
            parent_id TEXT REFERENCES automation_folders(id) ON DELETE SET NULL,
            name TEXT NOT NULL, icon TEXT DEFAULT '📁', color TEXT,
            created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
        );
        CREATE UNIQUE INDEX idx_automation_folders_name_parent
            ON automation_folders(COALESCE(organization_id, ''), COALESCE(parent_id, ''), LOWER(name));
        CREATE TABLE automations (
            id TEXT PRIMARY KEY, user_id TEXT, kind TEXT DEFAULT 'automation', folder_id TEXT, deleted_at TIMESTAMPTZ
        );
    `);
});
after(async () => { await pg.close(); });
beforeEach(async () => {
    depth = 8;
    await pg.exec('TRUNCATE automations; TRUNCATE automation_folders;');
});

const rejects = (p, code) => assert.rejects(p, (e) => e instanceof FolderError && e.code === code, `expected ${code}`);
const mk = (name, parentId = null, org = 'o1') => store.createFolder({ organizationId: org, name, parentId });

describe('create', () => {
    test('nests, and lists parentId', async () => {
        const a = await mk('A');
        const b = await mk('B', a.id);
        assert.equal(b.parentId, a.id);
        const list = await store.listFolders('o1', 'u1');
        assert.deepEqual(list.map((f) => [f.name, f.parentId]), [['A', null], ['B', a.id]]);
    });

    test('a parent of another organisation, or one that does not exist, is not found', async () => {
        const other = await mk('Theirs', null, 'o2');
        await rejects(mk('X', other.id), 'parent_not_found');
        await rejects(mk('X', 'nope'), 'parent_not_found');
    });

    test('names are unique per parent, case-insensitively, not per organisation', async () => {
        const a = await mk('A');
        const b = await mk('B');
        await mk('Invoices', a.id);
        await mk('Invoices', b.id);
        await rejects(mk('invoices', a.id), 'folder_name_taken');
        await rejects(mk(' ', a.id), 'folder_name_required');
    });

    test('the depth limit holds, and 0 means unlimited', async () => {
        depth = 3;
        const a = await mk('1');
        const b = await mk('2', a.id);
        const c = await mk('3', b.id);
        await rejects(mk('4', c.id), 'folder_too_deep');
        depth = 0;
        let cur = c;
        for (let i = 4; i < 30; i += 1) cur = await mk(String(i), cur.id);
        assert.equal((await store.listFolders('o1', 'u')).length, 29);
    });
});

describe('move', () => {
    test('moves a subtree and back to the top level', async () => {
        const a = await mk('A');
        const b = await mk('B');
        const c = await mk('C', b.id);
        const moved = await store.moveFolder(b.id, a.id, 'o1');
        assert.equal(moved.parentId, a.id);
        assert.equal((await store.getFolder(c.id))?.parentId, b.id);
        assert.equal((await store.moveFolder(b.id, null, 'o1')).parentId, null);
    });

    test('no loops: not under itself, not under a descendant', async () => {
        const a = await mk('A');
        const b = await mk('B', a.id);
        const c = await mk('C', b.id);
        await rejects(store.moveFolder(a.id, a.id, 'o1'), 'folder_cycle');
        await rejects(store.moveFolder(a.id, c.id, 'o1'), 'folder_cycle');
        assert.equal((await store.getFolder(a.id))?.parentId, null);
    });

    test('the depth limit counts the moved subtree', async () => {
        depth = 3;
        const a = await mk('A');
        const b = await mk('B', a.id);
        const x = await mk('X');
        const y = await mk('Y', x.id);
        await mk('Z', y.id);
        await rejects(store.moveFolder(x.id, b.id, 'o1'), 'folder_too_deep');
    });

    test('another organisation: folder or parent answers not found', async () => {
        const mine = await mk('Mine');
        const theirs = await mk('Theirs', null, 'o2');
        await rejects(store.moveFolder(theirs.id, null, 'o1'), 'folder_not_found');
        await rejects(store.moveFolder(mine.id, theirs.id, 'o1'), 'parent_not_found');
    });

    test('a name taken in the new parent is refused', async () => {
        const a = await mk('A');
        await mk('Same', a.id);
        const other = await mk('Same');
        await rejects(store.moveFolder(other.id, a.id, 'o1'), 'folder_name_taken');
    });

    test('two racing moves cannot close a loop', async () => {
        const a = await mk('A');
        const b = await mk('B');
        const results = await Promise.allSettled([store.moveFolder(a.id, b.id, 'o1'), store.moveFolder(b.id, a.id, 'o1')]);
        assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    });
});

describe('delete', () => {
    test('children move up, automations are detached, nothing else is deleted', async () => {
        const a = await mk('A');
        const b = await mk('B', a.id);
        const c = await mk('C', b.id);
        await pg.query(`INSERT INTO automations (id, user_id, folder_id) VALUES ('x1','u1',$1),('x2','u2',$1)`, [b.id]);
        const out = await store.deleteFolder(b.id);
        assert.deepEqual(out, { detached: 2, reparented: 1 });
        assert.equal((await store.getFolder(c.id))?.parentId, a.id);
        const { rows } = await pg.query('SELECT id, folder_id FROM automations ORDER BY id');
        assert.deepEqual(rows.map((r) => r.folder_id), [null, null]);
    });

    test('a child whose name is taken in the grandparent is renamed, not lost', async () => {
        const a = await mk('A');
        const b = await mk('B', a.id);
        await mk('Same', a.id);
        const c = await mk('Same', b.id);
        await store.deleteFolder(b.id);
        const moved = await store.getFolder(c.id);
        assert.equal(moved?.parentId, a.id);
        assert.equal(moved?.name, 'Same (2)');
    });

    test('a top-level folder frees its children to the top level', async () => {
        const a = await mk('A');
        const b = await mk('B', a.id);
        await store.deleteFolder(a.id);
        assert.equal((await store.getFolder(b.id))?.parentId, null);
    });
});

describe('filing', () => {
    test('a folder of another organisation cannot be filed into', async () => {
        const theirs = await mk('Theirs', null, 'o2');
        const mine = await mk('Mine');
        await rejects(store.requireFolderForAutomation(theirs.id, 'o1'), 'folder_not_found');
        await rejects(store.requireFolderForAutomation('nope', 'o1'), 'folder_not_found');
        assert.equal((await store.requireFolderForAutomation(mine.id, 'o1'))?.id, mine.id);
        assert.equal(await store.requireFolderForAutomation(null, 'o1'), null);
    });

    test('the tree view nests children and sorts by name', async () => {
        const a = await mk('b-parent');
        await mk('z', a.id);
        await mk('a', a.id);
        await mk('A-first');
        const tree = await store.listFolderTree('o1', 'u1');
        assert.deepEqual(tree.map((n) => n.name), ['A-first', 'b-parent']);
        assert.deepEqual(tree[1].children.map((n) => n.name), ['a', 'z']);
    });
});
