/**
 * ncScopeGuard — the server-side enforcement of "What Bee Flow may access".
 *
 * The properties a security reviewer should find pinned here:
 *   - NARROW-ONLY: the guard has no allow path — mode all/absent returns
 *     null and everything else denies or filters
 *   - FAIL-CLOSED: unreadable scope store ⇒ denial; unclassified tool under
 *     a selection ⇒ denial; unrecognisable filter shape ⇒ withheld result
 *   - files prefix semantics: /Projects allows /Projects/x, denies
 *     /Projects2 (the classic prefix-match trap)
 *   - DRIFT TRIPWIRES: every registered nextcloud_* tool resolves to its
 *     family and, for scopable families, carries an explicit policy; the
 *     local prefix table mirrors integrationToolMap
 *
 * Fake configStore injected into require.cache — no Postgres, no network.
 *
 * Run: node --test server/core/integrations/ncScopeGuard.test.js
 */

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const store = new Map();
function inject(rel, exports) {
    const resolved = require.resolve(path.join(__dirname, rel));
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}
let configFail = false;
inject('../../stores/configStore.js', {
    getConfig: async (k) => {
        if (configFail) throw new Error('db down');
        return store.get(k) ?? null;
    },
    setConfig: async (k, v) => { store.set(k, v); },
    deleteConfig: async (k) => { store.delete(k); },
});
inject('../../stores/guardrailEventStore.js', { logGuardrailEvent: async () => {} });
const userRows = new Map();
inject('../../stores/userStore.js', { getUser: async (id) => userRows.get(id) || null });

const guard = require('./ncScopeGuard');
require('./ncScope');

const USER = 'u-1';

function setUserScope(integrations) {
    store.set(`user_nc_scope_${USER}`, { v: 1, integrations });
    guard.invalidateScopeCache();
}

const ORG = 'org-1';
function setOrgScope(integrations) {
    store.set(`org_nc_scope_${ORG}`, { v: 1, integrations });
    guard.invalidateScopeCache();
}

beforeEach(() => { store.clear(); userRows.clear(); configFail = false; guard.invalidateScopeCache(); });

// ── Base modes ──────────────────────────────────────────────────────────────

test('default (no doc): every family call passes', async () => {
    for (const toolName of ['nextcloud_list_files', 'nextcloud_calendar_list_events', 'nextcloud_mail_read', 'nextcloud_notes_get']) {
        assert.equal(await guard.checkToolCall({ toolName, toolArgs: { path: '/x', calendar: 'c' }, userId: USER }), null);
    }
});

test('mode off denies every tool of the family, structured — never thrown', async () => {
    setUserScope({ 'nextcloud-talk': { mode: 'off' } });
    const denial = await guard.checkToolCall({ toolName: 'nextcloud_talk_send_message', toolArgs: { token: 't1', message: 'hi' }, userId: USER });
    assert.ok(denial && denial.error, 'must return { error }');
    assert.equal(denial.nc_scope_denied, true);
    assert.match(denial.error, /Nextcloud access settings/);
    // and the neighbour family is untouched
    assert.equal(await guard.checkToolCall({ toolName: 'nextcloud_list_files', toolArgs: { path: '/x' }, userId: USER }), null);
});

test('fail-closed: unreadable scope store denies instead of allowing', async () => {
    configFail = true;
    const denial = await guard.checkToolCall({ toolName: 'nextcloud_list_files', toolArgs: { path: '/x' }, userId: USER });
    assert.ok(denial && denial.error);
    assert.match(denial.error, /temporarily unavailable/);
});

// ── Files: prefix semantics ─────────────────────────────────────────────────

test('files selected: /Projects allows /Projects and /Projects/x, denies /Projects2 and /Secrets', async () => {
    setUserScope({ 'nextcloud': { mode: 'selected', selected: ['/Projects'] } });
    const call = (p) => guard.checkToolCall({ toolName: 'nextcloud_list_files', toolArgs: { path: p }, userId: USER });
    assert.equal(await call('/Projects'), null);
    assert.equal(await call('/Projects/Bee Flow/notes.md'), null);
    assert.equal(await call('Projects/sub'), null, 'unrooted caller paths normalise the same way');
    assert.ok((await call('/Projects2'))?.error, 'the prefix-match trap: /Projects2 is NOT inside /Projects');
    assert.ok((await call('/Secrets'))?.error);
});

test('files: move checks BOTH source and destination', async () => {
    setUserScope({ 'nextcloud': { mode: 'selected', selected: ['/Projects'] } });
    const ok = await guard.checkToolCall({ toolName: 'nextcloud_move', toolArgs: { source: '/Projects/a', destination: '/Projects/b' }, userId: USER });
    assert.equal(ok, null);
    const out = await guard.checkToolCall({ toolName: 'nextcloud_move', toolArgs: { source: '/Projects/a', destination: '/Elsewhere/b' }, userId: USER });
    assert.ok(out?.error, 'exfiltration via destination must be denied');
});

test('files: root selection (/) allows everything in the family', async () => {
    setUserScope({ 'nextcloud': { mode: 'selected', selected: ['/'] } });
    assert.equal(await guard.checkToolCall({ toolName: 'nextcloud_read_file', toolArgs: { path: '/anywhere/deep.txt' }, userId: USER }), null);
});

test('files: id-indirect tools are denied under a selection, with an honest hint', async () => {
    setUserScope({ 'nextcloud': { mode: 'selected', selected: ['/Projects'] } });
    const denial = await guard.checkToolCall({ toolName: 'nextcloud_direct_link', toolArgs: { fileId: 42 }, userId: USER });
    assert.ok(denial?.error);
    assert.match(denial.error, /cannot be limited/);
});

test('files: metadata-only tools stay allowed under a selection', async () => {
    setUserScope({ 'nextcloud': { mode: 'selected', selected: ['/Projects'] } });
    assert.equal(await guard.checkToolCall({ toolName: 'nextcloud_list_tags', toolArgs: {}, userId: USER }), null);
});

// ── Id families ─────────────────────────────────────────────────────────────

test('calendar selected: allowed slug passes, others deny, missing arg denies with the arg named', async () => {
    setUserScope({ 'nextcloud-calendar': { mode: 'selected', selected: ['work'] } });
    const call = (args) => guard.checkToolCall({ toolName: 'nextcloud_calendar_list_events', toolArgs: args, userId: USER });
    assert.equal(await call({ calendar: 'work' }), null);
    assert.ok((await call({ calendar: 'personal' }))?.error);
    const missing = await call({});
    assert.ok(missing?.error);
    assert.match(missing.error, /calendar/);
});

test('deck selected: numeric ids compare as strings both ways', async () => {
    setUserScope({ 'nextcloud-deck': { mode: 'selected', selected: [7] } });
    assert.equal(await guard.checkToolCall({ toolName: 'nextcloud_deck_list_cards', toolArgs: { boardId: 7 }, userId: USER }), null);
    assert.equal(await guard.checkToolCall({ toolName: 'nextcloud_deck_list_cards', toolArgs: { boardId: '7' }, userId: USER }), null);
    assert.ok((await guard.checkToolCall({ toolName: 'nextcloud_deck_list_cards', toolArgs: { boardId: 8 }, userId: USER }))?.error);
});

test('talk selected: create_room stays allowed (a NEW resource), cross-room search now filters', async () => {
    // search_messages used to deny. It cannot be arg-gated — the endpoint has
    // no token parameter — but its hits carry the conversation they belong to,
    // so it runs and filterResult trims them. See the dedicated test below.
    setUserScope({ 'nextcloud-talk': { mode: 'selected', selected: ['tok-a'] } });
    assert.equal(await guard.checkToolCall({ toolName: 'nextcloud_talk_create_room', toolArgs: { roomType: 2, roomName: 'x' }, userId: USER }), null);
    assert.equal(await guard.checkToolCall({ toolName: 'nextcloud_talk_search_messages', toolArgs: { query: 'x' }, userId: USER }), null);
    assert.ok((await guard.checkToolCall({ toolName: 'nextcloud_talk_send_message', toolArgs: { token: 'tok-b', message: 'x' }, userId: USER }))?.nc_scope_denied);
});
test('mail selected: accountId tools check; message-level tools deny honestly', async () => {
    setUserScope({ 'nextcloud-mail': { mode: 'selected', selected: ['2'] } });
    assert.equal(await guard.checkToolCall({ toolName: 'nextcloud_mail_send', toolArgs: { accountId: 2, to: 'a@b.c', subject: 's', body: 'b' }, userId: USER }), null);
    assert.ok((await guard.checkToolCall({ toolName: 'nextcloud_mail_send', toolArgs: { accountId: 3, to: 'a@b.c' }, userId: USER }))?.error);
    assert.ok((await guard.checkToolCall({ toolName: 'nextcloud_mail_read', toolArgs: { messageId: 99 }, userId: USER }))?.error);
});

// ── Result filtering ────────────────────────────────────────────────────────

test('calendar list filter: only selected slugs survive; count is corrected', async () => {
    setUserScope({ 'nextcloud-calendar': { mode: 'selected', selected: ['work'] } });
    const result = { count: 3, calendars: [{ slug: 'work' }, { slug: 'personal' }, { slug: 'family' }] };
    const filtered = await guard.filterResult({ toolName: 'nextcloud_calendar_list', result, userId: USER });
    assert.deepEqual(filtered.calendars.map(c => c.slug), ['work']);
    assert.equal(filtered.count, 1);
});

test('talk rooms filter keys on token; entries without one are dropped (fail-closed)', async () => {
    setUserScope({ 'nextcloud-talk': { mode: 'selected', selected: ['t1'] } });
    const result = { rooms: [{ token: 't1' }, { token: 't2' }, { name: 'tokenless' }] };
    const filtered = await guard.filterResult({ toolName: 'nextcloud_talk_list_rooms', result, userId: USER });
    assert.deepEqual(filtered.rooms.map(r => r.token), ['t1']);
});

test('files search filter: path-carrying entries filtered by prefix, pathless entries dropped', async () => {
    setUserScope({ 'nextcloud': { mode: 'selected', selected: ['/Projects'] } });
    const result = { count: 3, items: [{ path: '/Projects/a.md' }, { path: '/Elsewhere/b.md' }, { weird: true }] };
    const filtered = await guard.filterResult({ toolName: 'nextcloud_search_files', result, userId: USER });
    assert.deepEqual(filtered.items.map(i => i.path), ['/Projects/a.md']);
    assert.equal(filtered.count, 1);
});

test('unrecognised result shape under a selection is withheld, not leaked', async () => {
    setUserScope({ 'nextcloud': { mode: 'selected', selected: ['/Projects'] } });
    const filtered = await guard.filterResult({ toolName: 'nextcloud_folder_tree', result: { mystery: { nested: true } }, userId: USER });
    assert.ok(filtered?.error);
    assert.match(filtered.error, /withheld/);
});

test('mode all: filterResult passes results through untouched', async () => {
    const result = { count: 2, calendars: [{ slug: 'a' }, { slug: 'b' }] };
    const filtered = await guard.filterResult({ toolName: 'nextcloud_calendar_list', result, userId: USER });
    assert.deepEqual(filtered, result);
});

test('error results pass through unfiltered (the model needs the error)', async () => {
    setUserScope({ 'nextcloud-calendar': { mode: 'selected', selected: ['work'] } });
    const result = { error: 'Nextcloud calendar list failed (503)' };
    assert.deepEqual(await guard.filterResult({ toolName: 'nextcloud_calendar_list', result, userId: USER }), result);
});

// ── Narrow-only + drift tripwires ───────────────────────────────────────────

test('narrow-only: the guard exports no allow/grant API at all', () => {
    const surface = Object.keys(guard);
    for (const name of surface) {
        assert.ok(!/allow|grant|widen|permit/i.test(name),
            `guard export "${name}" smells like an allow path — the guard must only deny or filter`);
    }
});

test('drift: the local prefix table mirrors integrationToolMap for every NC prefix', () => {
    const toolMapSrc = require('fs').readFileSync(path.join(__dirname, 'integrationToolMap.js'), 'utf8');
    for (const [prefix, id] of guard.PREFIX_TO_INTEGRATION) {
        assert.ok(toolMapSrc.includes(prefix), `integrationToolMap has no entry for ${prefix}`);
        // hyphen/underscore translation: nextcloud-calendar ↔ nextcloud_calendar
        assert.equal(id.replace(/-/g, '_'), prefix.replace(/_$/, ''),
            `prefix ${prefix} must resolve to its own family id (got ${id})`);
    }
});

test('drift: every registered nextcloud_* tool is classified for its family', () => {
    // Enumerate the real tool definitions of every scopable family and
    // assert each carries an explicit policy — a tool added without one is
    // denied at runtime under a selection (fail-closed), and this test makes
    // that a CI failure instead of a customer surprise.
    const FAMILY_DEF_FILES = {
        'nextcloud': '../../integrations/nextcloudTools.js',
        'nextcloud-calendar': '../../integrations/nextcloudCalendarTools.js',
        'nextcloud-contacts': '../../integrations/nextcloudContactsTools.js',
        'nextcloud-deck': '../../integrations/nextcloudDeckTools.js',
        'nextcloud-talk': '../../integrations/nextcloudTalkTools.js',
        'nextcloud-tasks': '../../integrations/nextcloudTasksTools.js',
        'nextcloud-mail': '../../integrations/nextcloudMailTools.js',
        'nextcloud-tables': '../../integrations/nextcloudTablesTools.js',
        'nextcloud-forms': '../../integrations/nextcloudFormsTools.js',
    };
    for (const [familyId, rel] of Object.entries(FAMILY_DEF_FILES)) {
        const mod = require(path.join(__dirname, rel));
        const tools = Object.entries(mod)
            .filter(([k, v]) => Array.isArray(v) && k.endsWith('_TOOLS'))
            .flatMap(([, v]) => v)
            .map(t => t?.function?.name)
            .filter(Boolean);
        assert.ok(tools.length > 0, `no tool definitions found in ${rel}`);
        const policies = guard.FAMILY_POLICIES[familyId] || {};
        for (const toolName of tools) {
            assert.equal(guard.integrationIdForTool(toolName), familyId,
                `${toolName} resolves to the wrong family`);
            assert.ok(toolName in policies,
                `${toolName} has no scope policy — add it to FAMILY_POLICIES['${familyId}'] in ncScopeGuard.js `
                + '(args-checked, filter, allow, or deny). Unclassified tools are denied under a selection.');
        }
    }
});

// ── Findings from the pre-production security review ────────────────────────

test('cross-app search does not answer a disabled family (the review\'s high finding)', async () => {
    // nextcloud_search sorts under Files by name, but its executor asks
    // Nextcloud for every search provider and fans out. Scoping it by Files
    // alone meant a user who switched Mail off was still answered with mail.
    setUserScope({
        'nextcloud-mail': { mode: 'off' },
        'nextcloud-talk': { mode: 'off' },
        // Files deliberately left at its default 'all' — the configuration
        // in which the leak occurred.
    });
    const result = {
        results: [
            { provider: 'files', title: 'notes.md', path: '/notes.md' },
            { provider: 'mail', title: 'Salary review', subline: 'confidential' },
            { provider: 'talk', title: 'standup', subline: 'we are letting Bob go' },
            { provider: 'deck', title: 'Q3 board' },
        ],
        count: 4,
    };
    const out = await guard.filterResult({ toolName: 'nextcloud_search', result, userId: USER, orgId: ORG });
    const providers = out.results.map(r => r.provider);
    assert.ok(!providers.includes('mail'), 'mail is off — its hits must not come back through search');
    assert.ok(!providers.includes('talk'), 'talk is off — its hits must not come back through search');
    assert.ok(providers.includes('files'), 'files is on — its hits must survive');
    assert.ok(providers.includes('deck'), 'deck was never narrowed — its hits must survive');
    assert.equal(out.count, 2, 'count must follow the filtered rows');
});

test('cross-app search drops rows whose provider we cannot map', async () => {
    setUserScope({});
    const result = { results: [{ provider: 'some_future_app', title: 'x' }], count: 1 };
    const out = await guard.filterResult({ toolName: 'nextcloud_search', result, userId: USER, orgId: ORG });
    assert.deepEqual(out.results, [], 'an unmappable provider fails closed');
});

test('cross-app search honours the ORG ceiling too', async () => {
    setOrgScope({ 'nextcloud-mail': { mode: 'off' } });
    setUserScope({});
    const result = { results: [{ provider: 'mail', title: 'secret' }, { provider: 'files', title: 'a', path: '/a' }], count: 2 };
    const out = await guard.filterResult({ toolName: 'nextcloud_search', result, userId: USER, orgId: ORG });
    assert.deepEqual(out.results.map(r => r.provider), ['files']);
});

test('a trash restore is denied under a selection — originalPath is decorative', async () => {
    // The file is chosen by the unchecked trashPath, and Nextcloud restores it
    // where its own metadata says, so an in-scope originalPath proves nothing.
    setUserScope({ nextcloud: { mode: 'selected', selected: ['/Projects'] } });
    const denial = await guard.checkToolCall({
        toolName: 'nextcloud_restore_from_trash',
        toolArgs: { trashPath: 'trash/Salaries.xlsx.d1700000000', originalPath: '/Projects/anything' },
        userId: USER, orgId: ORG,
    });
    assert.ok(denial && denial.nc_scope_denied, 'must not restore a file it cannot locate in scope');
});

test('a table row write is denied under a selection — the row id ignores the table', async () => {
    // PUT /rows/{rowId} is table-independent, exactly like delete_row.
    setUserScope({ 'nextcloud-tables': { mode: 'selected', selected: ['7'] } });
    const denial = await guard.checkToolCall({
        toolName: 'nextcloud_tables_update_row',
        toolArgs: { tableId: '7', rowId: '999' },
        userId: USER, orgId: ORG,
    });
    assert.ok(denial && denial.nc_scope_denied, 'an in-scope tableId cannot vouch for an arbitrary rowId');
});

test('a table named by TITLE stays denied under a selection, and the denial says to use the id', async () => {
    // The Tables tools resolve a title to an id themselves — but only after
    // this guard, which holds ids and must not look names up over the network.
    // Fail closed, and say so: "outside the shared tables" about a table that
    // IS shared would read as a broken grant.
    setUserScope({ 'nextcloud-tables': { mode: 'selected', selected: ['4'] } });
    const denial = await guard.checkToolCall({
        toolName: 'nextcloud_tables_create_row',
        toolArgs: { tableId: 'Facturen', values: { Totaal: 1 } },
        userId: USER, orgId: ORG,
    });
    assert.ok(denial && denial.nc_scope_denied, 'a title is not an id in the selection');
    assert.match(denial.error, /"Facturen" is a table title; while a .* selection is active, name the table by its id/);
    // A numeric string that IS the selected id still passes, and an unselected
    // id still gets the plain "outside" denial.
    assert.equal(await guard.checkToolCall({ toolName: 'nextcloud_tables_create_row', toolArgs: { tableId: '4', values: {} }, userId: USER, orgId: ORG }), null);
    const other = await guard.checkToolCall({ toolName: 'nextcloud_tables_create_row', toolArgs: { tableId: 5, values: {} }, userId: USER, orgId: ORG });
    assert.match(other.error, /"5" is outside the/);
});

// ── Navigation: the shared folder has to be FINDABLE ────────────────────────
//
// Reported from the live embedded instance. A user set Files to "Only
// selected" and ticked one folder, then asked "can you see what files and
// folders I have?". nextcloud_folder_tree returned {"tree":[]} and
// nextcloud_list_files on "/" was refused as "outside the folders this user
// has shared" — so the assistant told them it had no access and asked them to
// grant some. They already had. The grant was real; enforcement made it
// unreachable, which reads to the user as the feature being broken.

test('navigation: listing the root shows the shared folder and nothing beside it', async () => {
    setUserScope({ nextcloud: { mode: 'selected', selected: ['/Invoice2'] } });

    assert.equal(
        await guard.checkToolCall({ toolName: 'nextcloud_list_files', toolArgs: { path: '/' }, userId: USER }),
        null,
        'listing an ancestor of a shared folder must run — it is how the folder is found',
    );

    const listed = await guard.filterResult({
        toolName: 'nextcloud_list_files',
        result: {
            path: '/', count: 4, items: [
                { name: 'Photos', path: '/Photos', type: 'folder' },
                { name: 'Documents', path: '/Documents', type: 'folder' },
                { name: 'Invoice2', path: '/Invoice2', type: 'folder' },
                { name: 'readme.md', path: '/readme.md', type: 'file' },
            ],
        },
        userId: USER,
    });
    assert.deepEqual(listed.items.map(i => i.path), ['/Invoice2']);
    assert.equal(listed.count, 1, 'count follows the filtered list, not the original');
});

test('navigation: an absent path means the root, and is allowed', async () => {
    setUserScope({ nextcloud: { mode: 'selected', selected: ['/Invoice2'] } });
    assert.equal(await guard.checkToolCall({ toolName: 'nextcloud_list_files', toolArgs: {}, userId: USER }), null);
});

test('navigation: the folders leading down to a nested share survive, siblings do not', async () => {
    setUserScope({ nextcloud: { mode: 'selected', selected: ['/Documents/Invoices'] } });

    const atRoot = await guard.filterResult({
        toolName: 'nextcloud_list_files',
        result: { path: '/', count: 2, items: [
            { name: 'Documents', path: '/Documents', type: 'folder' },
            { name: 'Photos', path: '/Photos', type: 'folder' },
        ] },
        userId: USER,
    });
    assert.deepEqual(atRoot.items.map(i => i.path), ['/Documents'], 'the way down is visible');

    assert.equal(await guard.checkToolCall({ toolName: 'nextcloud_list_files', toolArgs: { path: '/Documents' }, userId: USER }), null);
    const inDocs = await guard.filterResult({
        toolName: 'nextcloud_list_files',
        result: { path: '/Documents', count: 3, items: [
            { name: 'Invoices', path: '/Documents/Invoices', type: 'folder' },
            { name: 'Payslips', path: '/Documents/Payslips', type: 'folder' },
            { name: 'tax.pdf', path: '/Documents/tax.pdf', type: 'file' },
        ] },
        userId: USER,
    });
    assert.deepEqual(inDocs.items.map(i => i.path), ['/Documents/Invoices'],
        'a sibling of the shared folder stays invisible even one level down');
});

test('navigation: a path that leads nowhere shared is still refused', async () => {
    setUserScope({ nextcloud: { mode: 'selected', selected: ['/Invoice2'] } });
    const denied = await guard.checkToolCall({ toolName: 'nextcloud_list_files', toolArgs: { path: '/Photos' }, userId: USER });
    assert.ok(denied?.nc_scope_denied);
});

test('navigation is READ-ONLY: an ancestor is not a place you may write', async () => {
    setUserScope({ nextcloud: { mode: 'selected', selected: ['/Documents/Invoices'] } });
    for (const tool of ['nextcloud_upload_file', 'nextcloud_create_folder', 'nextcloud_delete', 'nextcloud_create_share']) {
        const res = await guard.checkToolCall({ toolName: tool, toolArgs: { path: '/Documents' }, userId: USER });
        assert.ok(res?.nc_scope_denied, `${tool} must not accept an ancestor as a target`);
    }
});

test('folder_tree is pruned recursively, and each surviving node carries its full path', async () => {
    // Nextcloud's folder-tree nodes nest, and a child may carry only its own
    // name — which is why a shallow, path-keyed filter emptied the whole tree.
    setUserScope({ nextcloud: { mode: 'selected', selected: ['/Documents/Invoices'] } });
    const out = await guard.filterResult({
        toolName: 'nextcloud_folder_tree',
        result: { depth: 3, tree: [
            { name: 'Documents', children: [
                { name: 'Invoices', children: [{ name: '2026' }] },
                { name: 'Payslips', children: [{ name: 'secret' }] },
            ] },
            { name: 'Photos', children: [{ name: 'Holiday' }] },
        ] },
        userId: USER,
    });
    assert.equal(out.tree.length, 1);
    assert.equal(out.tree[0].path, '/Documents');
    assert.deepEqual(out.tree[0].children.map(c => c.path), ['/Documents/Invoices'],
        'Payslips is a sibling of the share and must not appear');
    assert.deepEqual(out.tree[0].children[0].children.map(c => c.name), ['2026'],
        'everything under the shared folder comes through — the user shared it');
});

test('folder_tree: a node whose path cannot be established is dropped', async () => {
    setUserScope({ nextcloud: { mode: 'selected', selected: ['/Invoice2'] } });
    const out = await guard.filterResult({
        toolName: 'nextcloud_folder_tree',
        result: { depth: 1, tree: [{ id: 42 }, { name: 'Invoice2' }] },
        userId: USER,
    });
    assert.deepEqual(out.tree.map(n => n.path), ['/Invoice2']);
});

test('searching is not navigating: hits stay strictly inside the selection', async () => {
    // The ancestor tolerance exists so a share can be FOUND. A search hit is a
    // different question, and an ancestor folder is not an answer to it.
    setUserScope({ nextcloud: { mode: 'selected', selected: ['/Documents/Invoices'] } });
    const out = await guard.filterResult({
        toolName: 'nextcloud_search_files',
        result: { count: 2, results: [
            { name: 'Documents', path: '/Documents' },
            { name: 'inv-1.pdf', path: '/Documents/Invoices/inv-1.pdf' },
        ] },
        userId: USER,
    });
    assert.deepEqual(out.results.map(r => r.path), ['/Documents/Invoices/inv-1.pdf']);
});

// ── An argument that belongs to another family ──────────────────────────────
//
// Found by the pre-deploy audit and confirmed under adversarial review. The
// guard files a tool by its NAME prefix, so nextcloud_talk_share_file was
// judged against the Talk scope only — while its `path` argument names a
// FILE. Files narrowed to /Invoice2 did not stop /Private/salaries.xlsx being
// posted into a conversation. The inverse of a dead end: the boundary the
// settings screen promises, silently not applied.

test('sharing a file into Talk is judged against the FILES scope too', async () => {
    setUserScope({ nextcloud: { mode: 'selected', selected: ['/Invoice2'] } });
    // Talk itself is unrestricted here — that must not vouch for the file.
    const leaked = await guard.checkToolCall({
        toolName: 'nextcloud_talk_share_file',
        toolArgs: { token: 't1', path: '/Private/salaries.xlsx' },
        userId: USER,
    });
    assert.ok(leaked?.nc_scope_denied, 'a file outside the selection must not reach a conversation');

    const allowed = await guard.checkToolCall({
        toolName: 'nextcloud_talk_share_file',
        toolArgs: { token: 't1', path: '/Invoice2/inv-1.pdf' },
        userId: USER,
    });
    assert.equal(allowed, null, 'a file inside the selection still shares normally');
});

test('saving a mail attachment is judged against the FILES scope too', async () => {
    setUserScope({ nextcloud: { mode: 'selected', selected: ['/Invoice2'] } });
    const denied = await guard.checkToolCall({
        toolName: 'nextcloud_mail_save_attachment',
        toolArgs: { messageId: 9, attachmentId: '1', targetPath: '/Private' },
        userId: USER,
    });
    assert.ok(denied?.nc_scope_denied);
});

test('Files turned off blocks the borrowed argument even when the owning family is on', async () => {
    setUserScope({ nextcloud: { mode: 'off' } });
    const denied = await guard.checkToolCall({
        toolName: 'nextcloud_talk_share_file',
        toolArgs: { token: 't1', path: '/anything.pdf' },
        userId: USER,
    });
    assert.ok(denied?.nc_scope_denied);
});

test('share_with_team is gated by the folder selection, like its share siblings', async () => {
    // Executed by the Teams executor but named nextcloud_*, so it files under
    // Files — where it had no policy at all and hit the fail-closed denial.
    setUserScope({ nextcloud: { mode: 'selected', selected: ['/Invoice2'] } });
    assert.equal(
        await guard.checkToolCall({ toolName: 'nextcloud_share_with_team', toolArgs: { path: '/Invoice2' }, userId: USER }),
        null,
    );
    assert.ok(
        (await guard.checkToolCall({ toolName: 'nextcloud_share_with_team', toolArgs: { path: '/Private' }, userId: USER }))?.nc_scope_denied,
    );
});

test('trash entries are placed by where they were deleted FROM', async () => {
    // Trash rows carry originalLocation and no path, so every row was
    // unplaceable and the list came back empty — reported to the user as
    // "your trash is empty", which is worse than a denial: nothing signals
    // that a scope is in play.
    setUserScope({ nextcloud: { mode: 'selected', selected: ['/Invoice2'] } });
    const out = await guard.filterResult({
        toolName: 'nextcloud_list_trash',
        result: { count: 2, items: [
            { name: 'inv.pdf', trashPath: '/trash/inv.pdf.d1', originalLocation: 'Invoice2/inv.pdf' },
            { name: 'pay.pdf', trashPath: '/trash/pay.pdf.d2', originalLocation: 'Private/pay.pdf' },
        ] },
        userId: USER,
    });
    assert.deepEqual(out.items.map(i => i.name), ['inv.pdf']);
});

test('unified search keeps in-scope file hits — they carry a path now', async () => {
    setUserScope({ nextcloud: { mode: 'selected', selected: ['/Invoice2'] } });
    const out = await guard.filterResult({
        toolName: 'nextcloud_search',
        result: { count: 2, results: [
            { provider: 'files', title: 'inv-1.pdf', path: '/Invoice2/inv-1.pdf' },
            { provider: 'files', title: 'salaries.xlsx', path: '/Private/salaries.xlsx' },
        ] },
        userId: USER,
    });
    assert.deepEqual(out.results.map(r => r.title), ['inv-1.pdf']);
});

test('unified search can place a Teams hit instead of dropping it from everyone', async () => {
    // The cross-family branch runs before the mode check, so an unmappable
    // provider was dropped even for a user who had never narrowed anything.
    const out = await guard.filterResult({
        toolName: 'nextcloud_search',
        result: { count: 1, results: [{ provider: 'circles', title: 'Onboarding 2026' }] },
        userId: USER,
    });
    assert.deepEqual(out.results.map(r => r.title), ['Onboarding 2026']);
});

// ── Mail under an account selection ─────────────────────────────────────────
//
// Selecting your work account used to grant a list of accounts, a list of
// mailboxes and the ability to SEND — and no way to read a single subject,
// because mailboxId and messageId are account-indirect and every
// message-level tool was denied outright. "Anything important in my inbox?"
// was answered with a refusal, which reads as the account grant doing nothing.
//
// They are gated by memory now: an id is honoured once it has come back from
// a result the guard already vouched for.

test('mail: a mailbox is honoured only after an account-gated listing returned it', async () => {
    setUserScope({ 'nextcloud-mail': { mode: 'selected', selected: ['7'] } });

    const cold = await guard.checkToolCall({
        toolName: 'nextcloud_mail_search', toolArgs: { mailboxId: 31 }, userId: USER,
    });
    assert.ok(cold?.nc_scope_denied, 'an unheard-of mailbox must not be searchable');
    assert.match(cold.error, /list_mailboxes/, 'the denial names the step that establishes it');

    // The account-gated listing runs and teaches the guard.
    assert.equal(await guard.checkToolCall({ toolName: 'nextcloud_mail_list_mailboxes', toolArgs: { accountId: '7' }, userId: USER }), null);
    await guard.filterResult({
        toolName: 'nextcloud_mail_list_mailboxes',
        result: { count: 2, mailboxes: [{ id: 31, name: 'INBOX' }, { id: 32, name: 'Sent' }] },
        userId: USER,
    });

    assert.equal(await guard.checkToolCall({ toolName: 'nextcloud_mail_search', toolArgs: { mailboxId: 31 }, userId: USER }), null);
    assert.ok((await guard.checkToolCall({ toolName: 'nextcloud_mail_search', toolArgs: { mailboxId: 99 }, userId: USER }))?.nc_scope_denied,
        'a mailbox of an unshared account is still refused');
});

test('mail: a message is readable only after an in-scope search returned it', async () => {
    setUserScope({ 'nextcloud-mail': { mode: 'selected', selected: ['7'] } });
    await guard.filterResult({
        toolName: 'nextcloud_mail_list_mailboxes',
        result: { count: 1, mailboxes: [{ id: 31 }] }, userId: USER,
    });

    const cold = await guard.checkToolCall({ toolName: 'nextcloud_mail_read', toolArgs: { messageId: 500 }, userId: USER });
    assert.ok(cold?.nc_scope_denied);

    await guard.filterResult({
        toolName: 'nextcloud_mail_search',
        result: { mailboxId: 31, count: 2, messages: [{ id: 500, subject: 'Invoice' }, { id: 501, subject: 'Lunch' }] },
        userId: USER,
    });

    assert.equal(await guard.checkToolCall({ toolName: 'nextcloud_mail_read', toolArgs: { messageId: 500 }, userId: USER }), null);
    assert.equal(await guard.checkToolCall({ toolName: 'nextcloud_mail_set_flags', toolArgs: { messageId: 501 }, userId: USER }), null);
    assert.ok((await guard.checkToolCall({ toolName: 'nextcloud_mail_read', toolArgs: { messageId: 777 }, userId: USER }))?.nc_scope_denied,
        'a message id the model invented, or kept from an out-of-scope context, is refused');
});

test('mail: move is checked at BOTH ends', async () => {
    // Otherwise "move" is a way to walk a message out of the selection.
    setUserScope({ 'nextcloud-mail': { mode: 'selected', selected: ['7'] } });
    await guard.filterResult({ toolName: 'nextcloud_mail_list_mailboxes', result: { mailboxes: [{ id: 31 }] }, userId: USER });
    await guard.filterResult({ toolName: 'nextcloud_mail_search', result: { mailboxId: 31, messages: [{ id: 500 }] }, userId: USER });

    assert.ok((await guard.checkToolCall({ toolName: 'nextcloud_mail_move', toolArgs: { messageId: 500, destMailboxId: 99 }, userId: USER }))?.nc_scope_denied,
        'a destination outside the shared accounts is refused');
    assert.equal(await guard.checkToolCall({ toolName: 'nextcloud_mail_move', toolArgs: { messageId: 500, destMailboxId: 31 }, userId: USER }), null);
});

test('mail: changing the scope forgets what the old scope taught', async () => {
    setUserScope({ 'nextcloud-mail': { mode: 'selected', selected: ['7'] } });
    await guard.filterResult({ toolName: 'nextcloud_mail_list_mailboxes', result: { mailboxes: [{ id: 31 }] }, userId: USER });
    assert.equal(await guard.checkToolCall({ toolName: 'nextcloud_mail_search', toolArgs: { mailboxId: 31 }, userId: USER }), null);

    setUserScope({ 'nextcloud-mail': { mode: 'selected', selected: ['8'] } }); // calls invalidateScopeCache
    assert.ok((await guard.checkToolCall({ toolName: 'nextcloud_mail_search', toolArgs: { mailboxId: 31 }, userId: USER }))?.nc_scope_denied,
        'a mailbox learned under the previous selection must not keep vouching for itself');
});

test('mail: nothing is remembered while the family is unrestricted', async () => {
    // filterResult returns early under mode 'all', so the memory only ever
    // fills from results a selection actually vetted.
    await guard.filterResult({ toolName: 'nextcloud_mail_list_mailboxes', result: { mailboxes: [{ id: 31 }] }, userId: USER });
    setUserScope({ 'nextcloud-mail': { mode: 'selected', selected: ['7'] } });
    assert.ok((await guard.checkToolCall({ toolName: 'nextcloud_mail_search', toolArgs: { mailboxId: 31 }, userId: USER }))?.nc_scope_denied);
});

// ── Talk ────────────────────────────────────────────────────────────────────

test('talk message search runs and its hits are trimmed to the shared rooms', async () => {
    // It cannot be arg-gated — the endpoint has no token parameter — but every
    // hit CAN be placed, so refusing the whole call was the wrong trade.
    setUserScope({ 'nextcloud-talk': { mode: 'selected', selected: ['room-a'] } });
    assert.equal(await guard.checkToolCall({ toolName: 'nextcloud_talk_search_messages', toolArgs: { query: 'invoice' }, userId: USER }), null);

    const out = await guard.filterResult({
        toolName: 'nextcloud_talk_search_messages',
        result: { query: 'invoice', count: 3, messages: [
            { title: 'Bob', subline: 'the invoice is paid', token: 'room-a' },
            { title: 'Eve', subline: 'salary review', token: 'room-b' },
            { title: 'Nobody', subline: 'unplaceable', token: null },
        ] },
        userId: USER,
    });
    assert.deepEqual(out.messages.map(m => m.subline), ['the invoice is paid'],
        'a hit in an unshared room, and one that cannot be placed at all, are both dropped');
});

test('create_room withholds the contents of a conversation that already existed', async () => {
    // Talk's POST /room is IDEMPOTENT for a one-to-one: it returns the
    // EXISTING conversation, and the executor cannot tell that from a fresh
    // one. Because create_room is 'allow', its result used to pass through
    // untouched — handing over the last message of a room never selected.
    setUserScope({ 'nextcloud-talk': { mode: 'selected', selected: ['room-a'] } });
    const out = await guard.filterResult({
        toolName: 'nextcloud_talk_create_room',
        result: { success: true, room: { token: 'room-b', name: 'Bob', lastMessage: { message: 'my salary is 90k' } } },
        userId: USER,
    });
    assert.equal(out.room.token, 'room-b', 'the token still comes back — the model must be able to say what it made');
    assert.equal(out.room.lastMessage, undefined, 'the message content does not');
    assert.match(out.nc_scope_note, /not among the ones shared/);

    const inScope = await guard.filterResult({
        toolName: 'nextcloud_talk_create_room',
        result: { success: true, room: { token: 'room-a', lastMessage: { message: 'hi' } } },
        userId: USER,
    });
    assert.ok(inScope.room.lastMessage, 'a room the user did share is untouched');
});

// ── Findings from the pre-production adversarial review ─────────────────────

test('a mail id learned under one selection does not vouch under another — without any cache invalidation', async () => {
    // The memo used to be keyed by WHO learned it. Unticking an account left
    // its mailbox and message ids still vouching for themselves, so the
    // account-level tools started refusing while READING its messages kept
    // working — the failure hidden behind its own half-fix. The one thing that
    // cleared it emptied an in-process Map, and production runs two replicas,
    // so the pod that did not serve the settings write never heard.
    //
    // This test therefore rewrites the stored doc DIRECTLY and only clears the
    // 15s scope cache — the state the OTHER replica is in. If the fingerprint
    // is doing the work, the stale id is refused anyway.
    setUserScope({ 'nextcloud-mail': { mode: 'selected', selected: ['7'] } });
    await guard.filterResult({ toolName: 'nextcloud_mail_list_mailboxes', result: { mailboxes: [{ id: 31 }] }, userId: USER });
    assert.equal(await guard.checkToolCall({ toolName: 'nextcloud_mail_search', toolArgs: { mailboxId: 31 }, userId: USER }), null);

    store.set(`user_nc_scope_${USER}`, { v: 1, integrations: { 'nextcloud-mail': { mode: 'selected', selected: ['8'] } } });
    guard.invalidateScopeCache(); // only what the 15s TTL would have done anyway

    assert.ok((await guard.checkToolCall({ toolName: 'nextcloud_mail_search', toolArgs: { mailboxId: 31 }, userId: USER }))?.nc_scope_denied,
        'the mailbox of a revoked account must stop vouching on every replica');
});

test('create_room returns only the token and type for a room outside the selection', async () => {
    // The withholding was a blacklist: stripping lastMessage left sixteen
    // other fields — the other party's name, unread count, whether they
    // mentioned you, when they last wrote, whether they are in a call and
    // whether it is being recorded. POST /room being idempotent for a 1:1
    // makes that queryable for any uid on the instance: an activity oracle,
    // not one slip.
    setUserScope({ 'nextcloud-talk': { mode: 'selected', selected: ['room-a'] } });
    const out = await guard.filterResult({
        toolName: 'nextcloud_talk_create_room',
        result: { success: true, room: {
            token: 'room-b', type: 1, name: 'Alice Smith', description: 'private',
            lastMessage: { message: 'secret' }, unreadMessages: 17, unreadMention: true,
            lastActivity: 1755800000, hasCall: true, callRecording: 1, participantType: 1,
        } },
        userId: USER,
    });
    assert.deepEqual(Object.keys(out.room).sort(), ['token', 'type'],
        'an allowlist — a field added to mapRoom later must not leak by default');
    assert.equal(out.room.token, 'room-b');
});

test('guardedNcCall recovers the org ceiling when the session carries no identity', async () => {
    // triggerBus's pseudo-sessions are {accessToken, refreshToken, ...} with
    // no `user` and no connector fields, so both session fallbacks miss. With
    // org null, resolveNcScope skips the org layer entirely — an integration
    // the ORG switched off was enforced for nobody on those paths, while the
    // user layer still made it look enforced.
    userRows.set(USER, { id: USER, organizationId: ORG });
    setOrgScope({ 'nextcloud-talk': { mode: 'off' } });

    let ran = false;
    const res = await guard.guardedNcCall('nextcloud_talk_list_rooms', {},
        { userId: USER, session: { accessToken: 'x', _source: 'vault' } },
        () => { ran = true; return { rooms: [] }; });

    assert.ok(res?.nc_scope_denied, 'the org ceiling applies even without an org id in hand');
    assert.equal(ran, false, 'and the executor never ran');
});

test('guardedNcCall runs the call and filters its result on the happy path', async () => {
    setUserScope({ 'nextcloud-talk': { mode: 'selected', selected: ['room-a'] } });
    userRows.set(USER, { id: USER, organizationId: null });
    const res = await guard.guardedNcCall('nextcloud_talk_list_rooms', {}, { userId: USER, session: {} },
        () => ({ count: 2, rooms: [{ token: 'room-a' }, { token: 'room-b' }] }));
    assert.deepEqual(res.rooms.map(r => r.token), ['room-a'], 'filtered, not merely allowed');
});

test('a table Bee Flow just created says so, instead of silently vanishing', async () => {
    // Creation is 'allow', so the table is really made — and then every
    // follow-up is refused and the list tool hides it, which reads as
    // "creation failed". The assistant tries again and leaves a second empty
    // table behind. Deliberately NOT self-granting the id: the same mechanism
    // on Talk would permanently add a conversation the user never selected,
    // because POST /room returns an EXISTING one-to-one room.
    setUserScope({ 'nextcloud-tables': { mode: 'selected', selected: ['3'] } });
    const out = await guard.filterResult({
        toolName: 'nextcloud_tables_create',
        result: { success: true, table: { id: 41, title: 'Invoices' } },
        userId: USER,
    });
    assert.equal(out.table.id, 41, 'the result itself is untouched');
    assert.match(out.nc_scope_note, /41/);
    assert.match(out.nc_scope_note, /do not create another one/);

    const inScope = await guard.filterResult({
        toolName: 'nextcloud_tables_create',
        result: { success: true, table: { id: 3 } },
        userId: USER,
    });
    assert.equal(inScope.nc_scope_note, undefined, 'no note when the id is already shared');
});
