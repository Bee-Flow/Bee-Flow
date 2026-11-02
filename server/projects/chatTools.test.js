// @typecheck
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { makeProjectChatTools, TOOL_NAMES, MAX_ITEMS_PER_ANSWER, MAX_SEARCHES } = require('./chatTools');
const { MAX_EDITS, MAX_READS } = require('./chatItemTools.mts');

const PROJECT = { id: 'p1', name: 'Launch', organizationId: 'org1', kind: 'workspace' };

// A project notebook as getNotebook answers it for a project editor (synthetic).
const NB_NAME = 'Lead generation: market segments';
const NB = { id: 'nb1', name: NB_NAME, projectId: 'p1', role: 'editor', version: 7, documentContent: '<h1>Leads</h1><p>Retail</p>', documentMd: '# Leads\n\nRetail' };

function kit(over = {}) {
    const calls = { docs: [], nbs: [], updates: [], feed: [], searches: [], gets: [], reads: [], writers: [], writes: [], versions: [], contentFeed: [] };
    const roles = { ann: 'editor', vic: 'viewer', ...(over.roles || {}) };
    const tools = makeProjectChatTools({
        getProjectRole: async (userId) => roles[userId] || null,
        getUser: async (id) => (over.users || { ann: { id: 'ann', organizationId: 'org1' }, vic: { id: 'vic', organizationId: 'org1' } })[id] || null,
        documents: { createDocument: async (i) => { calls.docs.push(i); if (over.docError) throw over.docError; return { id: `doc-${calls.docs.length}`, name: i.name }; } },
        notebooks: {
            createNotebook: async (i) => { calls.nbs.push(i); return { id: `nb-${calls.nbs.length}`, name: i.name }; },
            updateNotebook: async (id, userId, u) => { calls.updates.push([id, userId, u]); return true; },
        },
        // The real predicate reads the user store through auth/orgScope; here the users map answers.
        projectOrg: {
            ...require('./projectOrg'),
            projectOrgOf: async (p) => p.organizationId || '',
            belongsToProjectOrg: async (id, org) => ((over.users || { ann: { organizationId: 'org1' }, vic: { organizationId: 'org1' } })[id]?.organizationId || '') === org,
        },
        membership: { isAllowedIn: (kind, container) => container !== 'solution' },
        recordCreated: async (e) => { calls.feed.push(e); },
        markdownToHtml: (md) => `<p>${md}</p>`,
        notebooksAllowed: async () => over.notebooks !== false,
        searchAvailable: async () => over.search === true,
        searchDefinition: () => ({ type: 'function', function: { name: 'agent_search', description: 'search', parameters: { type: 'object', properties: {} } } }),
        runSearch: async (name, args) => { calls.searches.push([name, args]); if (over.searchError) throw over.searchError; return over.searchResult || 'result'; },
        items: {
            notebooks: {
                listProjectNotebooks: async () => over.nbCards ?? [{ id: 'nb1', name: NB_NAME, description: 'Sector notes', preview: 'Retail', docWordCount: 2, userId: 'bob', updatedAt: '2026-10-12T10:00:00.000Z' }],
                getNotebook: async (id, userId) => { calls.gets.push([id, userId]); return (over.notebookRows || { nb1: NB })[id] || null; },
                recordVersion: async (id, v) => { calls.versions.push([id, v]); return { id: `v-${calls.versions.length}` }; },
            },
            documents: {
                listProjectDocuments: async () => over.docCards ?? [{ id: 'd1', name: 'Pricing page', docType: 'page', userId: 'bob', updatedAt: new Date('2026-10-01T00:00:00Z') }],
                getDocument: async (id) => (over.docRows || { d1: { id: 'd1', name: 'Pricing page', projectId: 'p1', bodyHtml: '<h1>Prices</h1><p>From 10 a month</p>' } })[id] || null,
            },
            readCurrent: async (nb) => {
                calls.reads.push(nb.id);
                return over.current ? over.current(nb) : { html: nb.documentContent || '', markdown: nb.documentMd ?? null, live: false, active: false };
            },
            makeWriter: (o) => {
                calls.writers.push(o);
                return {
                    contributors: [{ userId: o.userId, kind: 'ai' }],
                    write: async (html, md, opts) => { calls.writes.push({ id: o.notebookId, html, md, opts }); return over.writeOutcome || { ok: true }; },
                };
            },
            feed: { contentChanged: async (e) => { calls.contentFeed.push(e); } },
        },
    });
    return { tools, calls };
}
const ask = { project: PROJECT, userId: 'ann', orgId: 'org1', session: null };

test('an editor is offered documents and notebooks, and the tools to find, read and change what exists; nobody else, and nothing else', async () => {
    const { tools } = kit();
    assert.deepStrictEqual((await tools.offered(ask)).map((t) => t.function.name),
        ['create_document', 'create_notebook', 'list_project_items', 'read_project_item', 'edit_notebook']);
    assert.deepStrictEqual(await tools.offered({ ...ask, userId: 'vic' }), [], 'a viewer cannot add to the project');
    assert.deepStrictEqual(await tools.offered({ ...ask, userId: 'zed' }), [], 'not a member');
    assert.deepStrictEqual((await kit({ notebooks: false }).tools.offered(ask)).map((t) => t.function.name),
        ['create_document', 'list_project_items', 'read_project_item'], 'no notebooks without the permission: documents can be found and read, nothing edited');
    assert.deepStrictEqual(await tools.offered({ ...ask, project: { ...PROJECT, kind: 'solution' } }), [], 'a Studio Solution holds neither');
});

test('a document is made in the project as the asker, private, as a page from the Markdown, and shows up in the feed', async () => {
    const { tools, calls } = kit();
    const run = tools.forAnswer(ask);
    const out = JSON.parse(await run.execute('create_document', { name: '  Launch plan ', content: '# Plan' }));
    assert.deepStrictEqual(out, { ok: true, kind: 'document', id: 'doc-1', name: 'Launch plan', url: '/app/projects/p1/documents/doc-1' });
    assert.deepStrictEqual(calls.docs[0], { userId: 'ann', name: 'Launch plan', docType: 'page', bodyHtml: '<p># Plan</p>', kind: 'document', visibility: 'private', projectId: 'p1', projectOrgChecked: true });
    assert.deepStrictEqual(calls.feed, [{ projectId: 'p1', itemType: 'document', itemId: 'doc-1', actorId: 'ann' }]);
    assert.deepStrictEqual(run.created, [{ kind: 'document', id: 'doc-1', name: 'Launch plan' }]);
    assert.ok(!JSON.stringify(out).includes('# Plan'), 'the result carries no text');
});

test('a notebook is made in the project with its organisation, and its first text is written as the asker', async () => {
    const { tools, calls } = kit();
    const run = tools.forAnswer(ask);
    const out = JSON.parse(await run.execute('create_notebook', { name: 'Research', description: 'Market notes', content: 'First line' }));
    assert.strictEqual(out.url, '/app/projects/p1/notebooks/nb-1');
    assert.deepStrictEqual(calls.nbs[0], { userId: 'ann', name: 'Research', description: 'Market notes', projectId: 'p1', organizationId: 'org1' });
    assert.deepStrictEqual(calls.updates, [['nb-1', 'ann', { documentContent: 'First line' }]]);
});

test('every call is checked again as it runs: role, container, organisation, notebook permission, a name, a cap', async () => {
    const refused = async (over, name, args, project = PROJECT) => {
        const { tools, calls } = kit(over);
        const out = JSON.parse(await tools.forAnswer({ ...ask, project, userId: over.asker || 'ann' }).execute(name, args));
        assert.strictEqual(out.ok, false, JSON.stringify(out));
        assert.strictEqual(calls.docs.length + calls.nbs.length, 0, 'nothing was made');
        return out.error;
    };
    assert.match(await refused({ asker: 'vic' }, 'create_document', { name: 'x' }), /can no longer add/);
    assert.match(await refused({}, 'create_document', { name: 'x' }, { ...PROJECT, kind: 'solution' }), /holds no documents/);
    assert.match(await refused({ users: { ann: { id: 'ann', organizationId: 'other' } } }, 'create_document', { name: 'x' }), /another organization/);
    assert.match(await refused({ notebooks: false }, 'create_notebook', { name: 'x' }), /not available/);
    assert.match(await refused({}, 'create_document', { name: '   ' }), /needs a name/);
    const { tools } = kit();
    const run = tools.forAnswer(ask);
    for (let i = 0; i < MAX_ITEMS_PER_ANSWER; i++) assert.strictEqual(JSON.parse(await run.execute('create_document', { name: `d${i}` })).ok, true);
    assert.match(JSON.parse(await run.execute('create_document', { name: 'one too many' })).error, /At most 3/);
});

test('any other tool name is refused, whatever the model says', async () => {
    const { tools, calls } = kit();
    const run = tools.forAnswer(ask);
    for (const name of ['send_email', 'create_automation', 'web_search', 'memory_remember', 'document_write', '__proto__', '']) {
        const out = JSON.parse(await run.execute(name, { name: 'x' }));
        assert.strictEqual(out.ok, false, name);
        assert.match(out.error, /not available in a team chat/);
    }
    assert.strictEqual(calls.docs.length + calls.nbs.length, 0);
});

test('a refusal the store states on purpose is told to the model; anything else is generic', async () => {
    const stated = kit({ docError: Object.assign(new Error('The document is too large.'), { status: 422 }) });
    assert.strictEqual(JSON.parse(await stated.tools.forAnswer(ask).execute('create_document', { name: 'x' })).error, 'The document is too large.');
    const broken = kit({ docError: new Error('connection to db-7.internal:5432 refused') });
    const out = JSON.parse(await broken.tools.forAnswer(ask).execute('create_document', { name: 'x' }));
    assert.strictEqual(out.error, 'It could not be made.', 'no internals');
});

const DESIGNED = {
    name: 'Invoice 2026-014', format: 'designed', docType: 'invoice',
    bodyHtml: '<div class="doc-logo"></div><h1>Invoice</h1><table class="lines"><tr><td>Hours</td><td>{{hours}}</td></tr></table>',
    css: '@page { size: A4; margin: 18mm 16mm; } h1 { color: var(--doc-accent); } table.lines { width: 100%; border-collapse: collapse; }',
};

test('a designed document is made in the project with the model\'s own HTML and CSS, as the asker', async () => {
    const { tools, calls } = kit();
    const run = tools.forAnswer(ask);
    const out = JSON.parse(await run.execute('create_document', DESIGNED));
    assert.deepStrictEqual(out, { ok: true, kind: 'document', id: 'doc-1', name: 'Invoice 2026-014', url: '/app/projects/p1/documents/doc-1' });
    assert.deepStrictEqual(calls.docs[0], {
        userId: 'ann', name: 'Invoice 2026-014', docType: 'invoice', bodyHtml: DESIGNED.bodyHtml, css: DESIGNED.css,
        settings: {}, kind: 'document', visibility: 'private', projectId: 'p1', projectOrgChecked: true,
    });
    assert.deepStrictEqual(calls.feed, [{ projectId: 'p1', itemType: 'document', itemId: 'doc-1', actorId: 'ann' }]);
    assert.ok(!JSON.stringify(out).includes('<h1>'), 'the result carries no markup');
});

test('a template is made in the asker\'s own library, not in the project, and says so', async () => {
    const { tools, calls } = kit();
    const run = tools.forAnswer(ask);
    const out = JSON.parse(await run.execute('create_document', { ...DESIGNED, template: true }));
    assert.deepStrictEqual([out.ok, out.kind, out.inProject, out.url], [true, 'template', false, '/app/studio/documents/doc-1']);
    assert.strictEqual(calls.docs[0].kind, 'template');
    assert.ok(!('projectId' in calls.docs[0]), 'a template is not filed in a project');
    assert.strictEqual(calls.feed.length, 0, 'nothing in the project changed');
    assert.deepStrictEqual(run.created, [{ kind: 'template', id: 'doc-1', name: 'Invoice 2026-014' }]);
});

test('a designed document keeps its type to the known ones, can go without the letterhead, and needs its markup', async () => {
    const { tools, calls } = kit();
    const run = tools.forAnswer(ask);
    await run.execute('create_document', { ...DESIGNED, docType: 'presentation', useHouseStyle: false });
    assert.strictEqual(calls.docs[0].docType, 'document', 'a presentation or an unknown type is not what this tool makes');
    assert.deepStrictEqual(calls.docs[0].settings, { houseStyle: false });
    const empty = JSON.parse(await run.execute('create_document', { name: 'x', format: 'designed', css: 'p{}' }));
    assert.match(empty.error, /needs its bodyHtml/);
    assert.strictEqual(calls.docs.length, 1);
});

test('a template is only a designed document, and a page stays a page', async () => {
    const { tools, calls } = kit();
    const run = tools.forAnswer(ask);
    await run.execute('create_document', { name: 'Plan', content: '# Plan', template: true });
    assert.strictEqual(calls.docs[0].docType, 'page');
    assert.strictEqual(calls.docs[0].kind, 'document');
    assert.strictEqual(calls.docs[0].projectId, 'p1');
});

test('the tool says how to make a styled document, and the size of what one call may carry is bounded', async () => {
    const { tools, calls } = kit();
    const [doc] = await tools.offered(ask);
    assert.match(doc.function.description, /@page/);
    assert.match(doc.function.description, /var\(--doc-accent\)/);
    assert.match(doc.function.description, /\{\{placeholders\}\}/);
    assert.deepStrictEqual(doc.function.parameters.properties.docType.enum, ['document', 'invoice', 'quote', 'letter', 'report', 'security']);
    const run = tools.forAnswer(ask);
    await run.execute('create_document', { ...DESIGNED, bodyHtml: 'x'.repeat(400_000), css: 'y'.repeat(200_000) });
    assert.strictEqual(calls.docs[0].bodyHtml.length, 150_000);
    assert.strictEqual(calls.docs[0].css.length, 50_000);
});

test('a web search is offered to an editor only where a search is set up, and never to a viewer', async () => {
    assert.ok(!(await kit().tools.offered(ask)).some((t) => t.function.name === 'agent_search'), 'no search configured');
    const on = kit({ search: true }).tools;
    assert.deepStrictEqual((await on.offered(ask)).map((t) => t.function.name),
        ['create_document', 'create_notebook', 'list_project_items', 'read_project_item', 'edit_notebook', 'agent_search']);
    assert.deepStrictEqual(await on.offered({ ...ask, userId: 'vic' }), [], 'a viewer gets no tools');
});

test('a search runs through the configured search, with a trimmed query, and makes nothing', async () => {
    const { tools, calls } = kit({ search: true, searchResult: 'Found: https://example.org' });
    const run = tools.forAnswer(ask);
    assert.strictEqual(await run.execute('agent_search', { query: `  ${'q'.repeat(400)}  `, mode: 'web' }), 'Found: https://example.org');
    assert.strictEqual(calls.searches[0][0], 'agent_search');
    assert.strictEqual(calls.searches[0][1].query.length, 300);
    assert.strictEqual(calls.searches[0][1].mode, 'web');
    assert.deepStrictEqual(run.created, []);
    assert.deepStrictEqual(calls.docs, []);
});

test('a search needs a query, has a budget per answer, and re-checks the role', async () => {
    const { tools, calls } = kit({ search: true });
    const run = tools.forAnswer(ask);
    assert.strictEqual(JSON.parse(await run.execute('agent_search', { query: '  ' })).ok, false);
    for (let i = 0; i < MAX_SEARCHES; i++) assert.strictEqual(await run.execute('agent_search', { query: `q${i}` }), 'result');
    assert.match(JSON.parse(await run.execute('agent_search', { query: 'one more' })).error, /At most/);
    assert.strictEqual(calls.searches.length, MAX_SEARCHES);
    const viewer = JSON.parse(await tools.forAnswer({ ...ask, userId: 'vic' }).execute('agent_search', { query: 'x' }));
    assert.strictEqual(viewer.ok, false);
});

test('a search that fails answers a refusal, not the error', async () => {
    const { tools } = kit({ search: true, searchError: new Error('serper key sk-secret rejected') });
    const out = JSON.parse(await tools.forAnswer(ask).execute('agent_search', { query: 'x' }));
    assert.deepStrictEqual(out, { ok: false, error: 'The search could not be run.' });
});

test('the allow-list names the search and nothing that is not a project tool', () => {
    assert.deepStrictEqual([...TOOL_NAMES], ['create_document', 'create_notebook', 'list_project_items', 'read_project_item', 'edit_notebook', 'agent_search']);
});

// ── What the project already holds (BFSF-489) ────────────────────────────

test('the list shows the project\'s notebooks and documents by name only, newest first, filtered by name', async () => {
    const { tools } = kit();
    const run = tools.forAnswer(ask);
    const all = JSON.parse(await run.execute('list_project_items', {}));
    assert.deepStrictEqual(all, {
        ok: true,
        items: [
            { kind: 'notebook', id: 'nb1', name: NB_NAME, updatedAt: '2026-10-12T10:00:00.000Z' },
            { kind: 'document', id: 'd1', name: 'Pricing page', updatedAt: '2026-10-01T00:00:00.000Z' },
        ],
    }, 'no preview, description, word count or owner: only the allow-listed card fields');
    const leads = JSON.parse(await run.execute('list_project_items', { query: 'LEAD GEN' }));
    assert.deepStrictEqual(leads.items.map((i) => i.id), ['nb1']);
    const docs = JSON.parse(await run.execute('list_project_items', { kind: 'document', query: 'nothing like it' }));
    assert.deepStrictEqual(docs.items, []);
    assert.match(docs.message, /Nothing in this project/);
});

test('the list is capped, and needs an editor of the project', async () => {
    const nbCards = Array.from({ length: 80 }, (_, i) => ({ id: `n${i}`, name: `Notes ${i}`, updatedAt: new Date(Date.UTC(2026, 0, 1 + i)).toISOString() }));
    const { tools } = kit({ nbCards, docCards: [] });
    const out = JSON.parse(await tools.forAnswer(ask).execute('list_project_items', {}));
    assert.strictEqual(out.items.length, 50);
    assert.strictEqual(out.more, 30);
    assert.strictEqual(out.items[0].id, 'n79', 'newest first');
    const viewer = JSON.parse(await tools.forAnswer({ ...ask, userId: 'vic' }).execute('list_project_items', {}));
    assert.deepStrictEqual(viewer, { ok: false, error: 'The person who asked can no longer use this project.' });
});

test('a notebook of the project is read as Markdown, a document as plain text that cannot be changed', async () => {
    const { tools } = kit();
    const run = tools.forAnswer(ask);
    const nb = JSON.parse(await run.execute('read_project_item', { kind: 'notebook', id: 'nb1' }));
    assert.strictEqual(nb.ok, true);
    assert.strictEqual(nb.canEdit, true);
    assert.strictEqual(nb.content, '# Leads\n\nRetail', 'a short notebook comes back whole');
    const doc = JSON.parse(await run.execute('read_project_item', { kind: 'document', id: 'd1' }));
    assert.deepStrictEqual([doc.ok, doc.readOnly], [true, true]);
    assert.match(doc.content, /^Prices\s+From 10 a month$/);
});

test('a notebook read hands on its own text as it is, and points the outline at this tool', async () => {
    const long = `# Tools\n\nThe old notebook_read tool. ${'word '.repeat(2000)}\n\n## More\n\nText`;
    const { tools } = kit({ notebookRows: { nb1: { ...NB, documentMd: long } } });
    const run = tools.forAnswer(ask);
    const full = JSON.parse(await run.execute('read_project_item', { kind: 'notebook', id: 'nb1', mode: 'full' }));
    assert.match(full.content, /The old notebook_read tool\./, 'the text is not rewritten');
    const outline = JSON.parse(await run.execute('read_project_item', { kind: 'notebook', id: 'nb1' }));
    assert.match(outline.outline, /Use read_project_item with mode="section"/);
    assert.doesNotMatch(outline.outline, /Use notebook_read/);
});

test('an item outside this project is not read, even one the asker can open elsewhere', async () => {
    const { tools, calls } = kit({
        notebookRows: { mine: { ...NB, id: 'mine', projectId: null, role: 'owner' }, other: { ...NB, id: 'other', projectId: 'p2' } },
        docRows: {
            priv: { id: 'priv', name: 'Private', projectId: null, bodyHtml: '<p>secret</p>' },
            old: { id: 'old', name: 'Archived', projectId: 'p1', kind: 'document', archived: true, bodyHtml: '<p>secret</p>' },
            tpl: { id: 'tpl', name: 'Template', projectId: 'p1', kind: 'template', bodyHtml: '<p>secret</p>' },
        },
    });
    const run = tools.forAnswer(ask);
    for (const [kind, id] of [['notebook', 'mine'], ['notebook', 'other'], ['notebook', 'gone'], ['document', 'priv'], ['document', 'old'], ['document', 'tpl']]) {
        const out = JSON.parse(await run.execute('read_project_item', { kind, id }));
        assert.strictEqual(out.ok, false, `${kind} ${id}`);
        assert.match(out.error, /no such item in this project/);
        assert.ok(!JSON.stringify(out).includes('secret'));
    }
    assert.deepStrictEqual(calls.reads, [], 'no notebook content was read');
});

test('BFSF-489: a change to an existing notebook edits that notebook as the asker and makes nothing new', async () => {
    const { tools, calls } = kit();
    const run = tools.forAnswer(ask);
    const out = JSON.parse(await run.execute('edit_notebook', { id: 'nb1', action: 'replace', find_text: 'Retail', replace_text: 'Retail, healthcare' }));
    assert.deepStrictEqual(out, { ok: true, kind: 'notebook', id: 'nb1', name: NB_NAME, url: '/app/projects/p1/notebooks/nb1' });
    assert.deepStrictEqual(calls.writers, [{ notebookId: 'nb1', userId: 'ann', baseHtml: NB.documentContent, expectedVersion: 7 }], 'over the version and the document it read');
    assert.deepStrictEqual(calls.writes, [{ id: 'nb1', html: '<p># Leads\n\nRetail, healthcare</p>', md: '# Leads\n\nRetail, healthcare', opts: { snapshot: true } }]);
    assert.strictEqual(calls.nbs.length, 0, 'no second notebook');
    assert.deepStrictEqual(run.created, []);
    assert.deepStrictEqual(run.edited, [{ kind: 'notebook', id: 'nb1', name: NB_NAME }]);
    assert.strictEqual(calls.versions[0][1].source, 'ai');
    assert.deepStrictEqual(calls.contentFeed, [{ projectId: 'p1', notebookId: 'nb1', contributors: [{ userId: 'ann', kind: 'ai' }], versionId: 'v-1', source: 'ai' }]);
    assert.ok(!JSON.stringify(out).includes('healthcare'), 'the result carries no text');

    await run.execute('edit_notebook', { id: 'nb1', action: 'insert', content: '## Next steps' });
    assert.strictEqual(calls.writes[1].md, '# Leads\n\nRetail\n\n## Next steps', 'an insert goes at the end by default');
    assert.deepStrictEqual(calls.writes[1].opts, { snapshot: false }, 'one checkpoint per notebook per answer');
    assert.deepStrictEqual(run.edited, [{ kind: 'notebook', id: 'nb1', name: NB_NAME }], 'listed once');
});

test('an insert after a heading needs that heading exactly, and a replace text keeps a $ as text', async () => {
    const { tools, calls } = kit();
    const run = tools.forAnswer(ask);
    await run.execute('edit_notebook', { id: 'nb1', action: 'insert', position: 'after', after_text: '# Leads', content: 'Intro' });
    assert.strictEqual(calls.writes[0].md, '# Leads\n\nIntro\n\nRetail');
    const missing = JSON.parse(await run.execute('edit_notebook', { id: 'nb1', action: 'insert', position: 'after', after_text: '## Contacts', content: 'x' }));
    assert.match(missing.error, /after_text does not occur/);
    await run.execute('edit_notebook', { id: 'nb1', action: 'replace', find_text: 'Retail', replace_text: 'Retail ($& 5)' });
    assert.strictEqual(calls.writes.at(-1).md, '# Leads\n\nRetail ($& 5)');
    assert.strictEqual(calls.writes.length, 2);
});

test('a replace whose text is not in the notebook, or not unique, writes nothing', async () => {
    const twice = { ...NB, documentMd: '# Leads\n\nRetail\n\nMore retail\n\nRetail' };
    const { tools, calls } = kit({ notebookRows: { nb1: twice } });
    const run = tools.forAnswer(ask);
    // Blank lines in the notebook once let a fuzzy match "find" the first one and write there.
    const absent = JSON.parse(await run.execute('edit_notebook', { id: 'nb1', action: 'replace', find_text: 'Wholesale', replace_text: 'x' }));
    assert.match(absent.error, /does not occur in the notebook/);
    const ambiguous = JSON.parse(await run.execute('edit_notebook', { id: 'nb1', action: 'replace', find_text: 'Retail', replace_text: 'x' }));
    assert.match(ambiguous.error, /more than once/);
    assert.deepStrictEqual(calls.writers, []);
    assert.deepStrictEqual(run.edited, []);
});

test('an edit is refused to a viewer of the notebook, outside the project, and for a notebook the asker cannot open', async () => {
    const refusedEdit = async (over, id = 'nb1', who = ask) => {
        const { tools, calls } = kit(over);
        const out = JSON.parse(await tools.forAnswer(who).execute('edit_notebook', { id, action: 'insert', content: 'x' }));
        assert.strictEqual(out.ok, false, JSON.stringify(out));
        assert.deepStrictEqual(calls.writes, []);
        return out.error;
    };
    assert.match(await refusedEdit({ notebookRows: { nb1: { ...NB, role: 'viewer' } } }), /read this notebook but not change it/);
    assert.match(await refusedEdit({ notebookRows: { nb1: { ...NB, projectId: 'p2' } } }), /no such item in this project/);
    assert.match(await refusedEdit({}, 'gone'), /no such item in this project/);
    assert.match(await refusedEdit({}, 'nb1', { ...ask, userId: 'vic' }), /can no longer use this project/);
    assert.match(await refusedEdit({ notebooks: false }), /Notebooks are not available/);
    assert.match(await refusedEdit({}, 'nb1', { ...ask, project: { ...PROJECT, kind: 'solution' } }), /holds no notebooks/);
});

test('a change that collides with a colleague\'s is kept as a proposal and reported, not counted as made', async () => {
    const { tools, calls } = kit({ writeOutcome: { ok: false, conflict: true } });
    const run = tools.forAnswer(ask);
    const out = JSON.parse(await run.execute('edit_notebook', { id: 'nb1', action: 'insert', content: 'x' }));
    assert.match(out.error, /kept as a proposal/);
    assert.deepStrictEqual(calls.versions, [], 'no AI version over what was not written');
    assert.deepStrictEqual(run.edited, []);
});

test('a co-edited notebook whose live document cannot be read is not written from its stale mirror', async () => {
    const { tools, calls } = kit({ current: (nb) => ({ html: nb.documentContent, markdown: nb.documentMd, live: false, active: true }) });
    const out = JSON.parse(await tools.forAnswer(ask).execute('edit_notebook', { id: 'nb1', action: 'insert', content: 'x' }));
    assert.match(out.error, /could not be read just now/);
    assert.deepStrictEqual(calls.writers, []);
});

test('edits and lookups have their own budgets, apart from the one for making things', async () => {
    const { tools, calls } = kit();
    const run = tools.forAnswer(ask);
    for (let i = 0; i < MAX_EDITS; i++) assert.strictEqual(JSON.parse(await run.execute('edit_notebook', { id: 'nb1', action: 'insert', content: `line ${i}` })).ok, true);
    assert.match(JSON.parse(await run.execute('edit_notebook', { id: 'nb1', action: 'insert', content: 'one more' })).error, /At most 3 edits/);
    assert.strictEqual(JSON.parse(await run.execute('create_notebook', { name: 'Fresh' })).ok, true, 'edits did not use up the creation budget');
    for (let i = 0; i < MAX_READS; i++) assert.strictEqual(JSON.parse(await run.execute('read_project_item', { kind: 'document', id: 'd1' })).ok, true);
    assert.match(JSON.parse(await run.execute('list_project_items', {})).error, /At most 6 lookups/);
    assert.strictEqual(calls.writes.length, MAX_EDITS);
});

test('Privacy Shield: a value hidden from a read cannot be matched or written back as its marker', async () => {
    const piiGate = require('../core/privacy/toolPiiGate');
    const saved = { ...piiGate._deps };
    const EMAIL = 'ann@example.test';
    piiGate._deps.detectPii = async (text) => {
        const i = text.indexOf(EMAIL);
        return { hasPii: i >= 0, entities: i >= 0 ? [{ text: EMAIL, category: 'Email', label: 'Email Address', offset: i, length: EMAIL.length }] : [] };
    };
    piiGate._deps.orgShield = () => /** @type {any} */ ({ classifyToolClass: () => 'internal' });
    try {
        const withMail = { ...NB, documentMd: `# Leads\n\nContact: ${EMAIL}\n\nRetail` };
        const { tools, calls } = kit({ notebookRows: { nb1: withMail } });
        const run = tools.forAnswer(ask);
        const shield = { enabled: true, toolPiiPolicy: { internal: { blockCategories: ['Email'] } } };
        // What the model reads is the read as the shield hands it on (chatToolRun: gate.forModel).
        const seen = JSON.parse(await piiGate.stripToolResultForModel(await run.execute('read_project_item', { kind: 'notebook', id: 'nb1' }), { toolName: 'read_project_item', shield }));
        const line = seen.content.split('\n').find((l) => l.startsWith('Contact:'));
        assert.match(line, /^Contact: \[blocked:[^\]]+\]$/, 'the read hides the address');
        for (const args of [
            { action: 'replace', find_text: line, replace_text: 'Contact: sales' },
            { action: 'replace', find_text: 'Retail', replace_text: `Retail\n\n${line}` },
            { action: 'insert', content: line },
        ]) {
            const out = JSON.parse(await run.execute('edit_notebook', { id: 'nb1', ...args }));
            assert.match(out.error, /Privacy Shield hid/, JSON.stringify(args));
        }
        assert.deepStrictEqual(calls.writes, [], 'the hidden address was never overwritten');
    } finally {
        Object.assign(piiGate._deps, saved);
    }
});

test('a read or edit that fails inside says so in a sentence, not the error', async () => {
    const { tools } = kit({ current: () => { throw new Error('connection to db-7.internal:5432 refused'); } });
    const out = JSON.parse(await tools.forAnswer(ask).execute('read_project_item', { kind: 'notebook', id: 'nb1' }));
    assert.deepStrictEqual(out, { ok: false, error: 'That could not be done just now.' });
});
