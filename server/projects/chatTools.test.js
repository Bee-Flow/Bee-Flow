'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { makeProjectChatTools, TOOL_NAMES, MAX_ITEMS_PER_ANSWER, MAX_SEARCHES } = require('./chatTools');

const PROJECT = { id: 'p1', name: 'Launch', organizationId: 'org1', kind: 'workspace' };

function kit(over = {}) {
    const calls = { docs: [], nbs: [], updates: [], feed: [], searches: [] };
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
    });
    return { tools, calls };
}
const ask = { project: PROJECT, userId: 'ann', orgId: 'org1', session: null };

test('an editor is offered documents and notebooks; nobody else, and nothing else', async () => {
    const { tools } = kit();
    assert.deepStrictEqual((await tools.offered(ask)).map((t) => t.function.name), ['create_document', 'create_notebook']);
    assert.deepStrictEqual(await tools.offered({ ...ask, userId: 'vic' }), [], 'a viewer cannot add to the project');
    assert.deepStrictEqual(await tools.offered({ ...ask, userId: 'zed' }), [], 'not a member');
    assert.deepStrictEqual((await kit({ notebooks: false }).tools.offered(ask)).map((t) => t.function.name), ['create_document'], 'no notebooks without the permission');
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
    for (const name of ['send_email', 'create_routine', 'web_search', 'memory_remember', 'document_write', '__proto__', '']) {
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
    assert.deepStrictEqual((await on.offered(ask)).map((t) => t.function.name), ['create_document', 'create_notebook', 'agent_search']);
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
    assert.deepStrictEqual([...TOOL_NAMES], ['create_document', 'create_notebook', 'agent_search']);
});
