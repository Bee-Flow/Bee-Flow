'use strict';
/**
 * The folder tools of the automations MCP server, with the store faked: what
 * each one validates, whom it lets through, and what it spends.
 * Run: cd server && node --test automation/mcpFolders.test.js
 */

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert');
const { makeFolderTools, FOLDER_TOOLS, FOLDER_WRITE_TOOL_NAMES, guideSection } = require('./mcpFolders.mts');
const { FolderError } = require('../stores/automationStore/folderStore.mts');
const mcpBuilder = require('./mcpBuilder');

let calls;
let spent;
let budgetLeft;
let callerImpl;
let folders;
let automations;

function build() {
    return makeFolderTools({
        store: {
            listFolders: async (org, user) => { calls.push(['list', org, user]); return folders; },
            createFolder: async (input) => {
                calls.push(['create', input]);
                if (input.parentId === 'gone') throw new FolderError(404, 'parent_not_found', 'The parent folder was not found.');
                const f = { id: 'new', organizationId: input.organizationId, parentId: input.parentId ?? null, name: input.name, icon: '📁', color: null, createdAt: null, updatedAt: null };
                folders = [...folders, f];
                return f;
            },
            moveFolder: async (id, parent, org) => {
                calls.push(['move', id, parent, org]);
                if (parent === 'child') throw new FolderError(409, 'folder_cycle', 'A folder cannot be moved into itself or into one of its own subfolders.');
                return folders.find((f) => f.id === id) || (() => { throw new FolderError(404, 'folder_not_found', 'Folder not found.'); })();
            },
            requireFolderForAutomation: async (folderId, org) => {
                calls.push(['require', folderId, org]);
                if (folderId == null) return null;
                if (folderId === 'foreign') throw new FolderError(404, 'folder_not_found', 'Folder not found.');
                return { id: folderId };
            },
            getAutomation: async (id) => automations[id] || null,
            updateAutomation: async (id, updates, by) => { calls.push(['update', id, updates, by]); if (id === 'boom') throw new Error('db down: secret detail'); return true; },
        },
        caller: (userId) => callerImpl(userId),
        charge: async (userId, cost) => { if (cost > budgetLeft) return false; budgetLeft -= cost; spent.push([userId, cost]); return true; },
        log: { error() {} },
    });
}

beforeEach(() => {
    calls = [];
    spent = [];
    budgetLeft = 100;
    callerImpl = async () => ({ orgId: 'o1', memberOrgIds: ['o1'] });
    folders = [
        { id: 'a', organizationId: 'o1', parentId: null, name: 'Finance', icon: '📁', color: null, createdAt: null, updatedAt: null, automationCount: 2 },
        { id: 'b', organizationId: 'o1', parentId: 'a', name: 'Invoices', icon: '📁', color: null, createdAt: null, updatedAt: null, automationCount: 0 },
    ];
    automations = {
        mine: { id: 'mine', userId: 'u1', organizationId: 'o1' },
        mine2: { id: 'mine2', userId: 'u1', organizationId: null },
        theirs: { id: 'theirs', userId: 'u2', organizationId: 'o1' },
        trashed: { id: 'trashed', userId: 'u1', organizationId: 'o1', deletedAt: '2026-10-01' },
        otherorg: { id: 'otherorg', userId: 'u1', organizationId: 'o9' },
        boom: { id: 'boom', userId: 'u1', organizationId: 'o1' },
    };
});

const call = (name, args, userId = 'u1') => build().call(name, args, { userId });

describe('listing', () => {
    test('a flat list with parentId, path and depth', async () => {
        const out = await call('automations_folder_list', {});
        assert.deepEqual(out.folders.map((f) => [f.folderId, f.parentId, f.path, f.depth, f.automationCount]),
            [['a', null, 'Finance', 1, 2], ['b', 'a', 'Finance / Invoices', 2, 0]]);
        assert.deepEqual(calls[0], ['list', 'o1', 'u1']);
        assert.equal(spent.length, 0, 'a read spends nothing');
    });

    test('arguments it does not know are refused', async () => {
        const out = await call('automations_folder_list', { orgId: 'o2' });
        assert.equal(out.code, 'invalid_arguments');
    });
});

describe('creating', () => {
    test('a subfolder, in the caller organisation, for one unit', async () => {
        const out = await call('automations_folder_create', { name: '  2026 ', parentId: 'b' });
        assert.deepEqual(calls[0], ['create', { organizationId: 'o1', name: '2026', parentId: 'b' }]);
        assert.equal(out.folder.path, 'Finance / Invoices / 2026');
        assert.deepEqual(spent, [['u1', 1]]);
    });

    test('a blank name, an over-long name and an unknown field are refused before the store', async () => {
        for (const args of [{ name: ' ' }, { name: 'x'.repeat(81) }, { name: 'ok', organizationId: 'o2' }, {}, { name: 5 }]) {
            const out = await call('automations_folder_create', args);
            assert.equal(out.code, 'invalid_arguments', JSON.stringify(args));
        }
        assert.equal(calls.length, 0);
        assert.equal(spent.length, 0);
    });

    test('a store refusal comes back with its code', async () => {
        const out = await call('automations_folder_create', { name: 'x', parentId: 'gone' });
        assert.equal(out.code, 'parent_not_found');
    });
});

describe('moving a folder', () => {
    test('passes the caller organisation to the store, and null means the top level', async () => {
        await call('automations_folder_move', { folderId: 'b', parentId: null });
        assert.deepEqual(calls[0], ['move', 'b', null, 'o1']);
    });

    test('parentId must be said, even when it is null', async () => {
        assert.equal((await call('automations_folder_move', { folderId: 'b' })).code, 'invalid_arguments');
    });

    test('a loop is refused with the store code', async () => {
        const out = await call('automations_folder_move', { folderId: 'a', parentId: 'child' });
        assert.equal(out.code, 'folder_cycle');
    });
});

describe('filing automations', () => {
    test('moves the caller own automations; others, trashed and foreign-organisation ones fail one by one', async () => {
        const out = await call('automations_move_to_folder', { automationIds: ['mine', 'theirs', 'nope', 'trashed', 'otherorg', 'mine2'], folderId: 'b' });
        assert.deepEqual(out.moved.map((m) => m.automationId), ['mine', 'mine2']);
        assert.deepEqual(out.failed.map((f) => [f.automationId, f.code]), [
            ['theirs', 'automation_not_found'], ['nope', 'automation_not_found'], ['trashed', 'automation_not_found'], ['otherorg', 'automation_not_found'],
        ]);
        const updates = calls.filter((c) => c[0] === 'update');
        assert.deepEqual(updates.map((u) => [u[1], u[2], u[3]]), [['mine', { folderId: 'b' }, 'u1'], ['mine2', { folderId: 'b' }, 'u1']]);
    });

    test('the folder is checked in the organisation of the automation; an automation without one uses the account organisation', async () => {
        await call('automations_move_to_folder', { automationIds: ['mine', 'mine2'], folderId: 'b' });
        assert.deepEqual(calls.filter((c) => c[0] === 'require').map((c) => c[2]), ['o1', 'o1']);
    });

    test('a folder of another organisation fails every automation and moves none', async () => {
        const out = await call('automations_move_to_folder', { automationIds: ['mine'], folderId: 'foreign' });
        assert.equal(out.moved.length, 0);
        assert.equal(out.failed[0].code, 'folder_not_found');
        assert.equal(calls.filter((c) => c[0] === 'update').length, 0);
    });

    test('null takes automations out of their folder', async () => {
        const out = await call('automations_move_to_folder', { automationIds: ['mine'], folderId: null });
        assert.deepEqual(out.moved, [{ automationId: 'mine', folderId: null }]);
    });

    test('at most 20 per call, and each one is charged', async () => {
        const many = Array.from({ length: 21 }, (_, i) => `a${i}`);
        assert.equal((await call('automations_move_to_folder', { automationIds: many, folderId: null })).code, 'invalid_arguments');
        assert.equal(spent.length, 0);
        await call('automations_move_to_folder', { automationIds: ['mine', 'mine', 'mine2'], folderId: null });
        assert.deepEqual(spent, [['u1', 2]], 'duplicates count once');
        assert.equal((await call('automations_move_to_folder', { automationIds: [] , folderId: null })).code, 'invalid_arguments');
    });

    test('a failing write is told in general words, never with the database message', async () => {
        const out = await call('automations_move_to_folder', { automationIds: ['boom'], folderId: null });
        assert.equal(out.failed[0].code, 'move_failed');
        assert.ok(!JSON.stringify(out).includes('secret detail'));
    });
});

describe('access', () => {
    test('an organisation that cannot be resolved denies every tool, reads included', async () => {
        callerImpl = async () => { throw new Error('groups unreadable'); };
        for (const [name, args] of [
            ['automations_folder_list', {}], ['automations_folder_create', { name: 'x' }],
            ['automations_folder_move', { folderId: 'a', parentId: null }], ['automations_move_to_folder', { automationIds: ['mine'], folderId: null }],
        ]) {
            const out = await call(name, args);
            assert.equal(out.code, 'organization_unresolved', name);
        }
        assert.equal(calls.length, 0, 'nothing reached the store');
    });

    test('out of budget: refused before anything is written', async () => {
        budgetLeft = 0;
        const out = await call('automations_folder_create', { name: 'x' });
        assert.equal(out.code, 'rate_limited');
        assert.equal(calls.length, 0);
    });

    test('the write tools are not read-only, so a read-level token cannot reach them; the list is', () => {
        const byName = new Map(mcpBuilder.buildToolList().map((t) => [t.name, t]));
        for (const t of FOLDER_TOOLS) {
            const tool = byName.get(t.name);
            assert.ok(tool, `${t.name} is advertised`);
            assert.equal(tool.annotations.readOnlyHint, !FOLDER_WRITE_TOOL_NAMES.has(t.name), t.name);
            assert.ok(!('automationId' in tool.inputSchema.properties), 'no automationId envelope');
        }
        const { scopeAllowsTool } = require('../auth/mcpAccess/scopes');
        const readScopes = { automations: { level: 'read' } };
        for (const name of FOLDER_WRITE_TOOL_NAMES) {
            assert.equal(scopeAllowsTool(readScopes, 'automations', name, { readOnly: byName.get(name).annotations.readOnlyHint === true }), false, name);
        }
        assert.equal(scopeAllowsTool(readScopes, 'automations', 'automations_folder_list', { readOnly: true }), true);
    });

    test('the guide documents every folder tool', () => {
        const text = guideSection();
        for (const t of FOLDER_TOOLS) assert.ok(text.includes(t.name), `${t.name} in the guide`);
    });

    test('callTool dispatches to the folder tools', async () => {
        assert.ok(mcpBuilder.TOOL_NAMES.has('automations_folder_create'));
        assert.ok(mcpBuilder.AUTOMATIONLESS_TOOLS.has('automations_move_to_folder'));
    });
});
