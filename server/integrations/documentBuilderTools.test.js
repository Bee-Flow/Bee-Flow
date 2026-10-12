/**
 * DB-free tests for the document chat tools.
 *
 * documentStore is stubbed via installResolveStub BEFORE the first require of
 * ./documentBuilderTools — the real store fires initDB() at load, so a test
 * that pulled it in would hang on pool retries rather than fail. Same reason
 * routes/ai/directChat/toolExec.test.js stubs this module in turn.
 */

const test = require('node:test');
const assert = require('node:assert');

const { installResolveStub } = require('../testUtils/stubRequire');

// ── Stub store ───────────────────────────────────────────────────────
const store = {
    docs: new Map(),
    calls: [],
    house: { enabled: false },
    // Project members who are not the owner, by role (documentStore answers a
    // document filed in a project with the reader's `projectRole`).
    roles: {},
};

function resetStore() {
    store.docs.clear();
    store.calls = [];
    store.house = { enabled: false };
    store.roles = {};
}
const roleOf = (d, userId) => (d.projectId && store.roles[userId]) || null;

const restore = installResolveStub({
    '../stores/documentStore': {
        DOC_TYPES: ['invoice', 'quote', 'letter', 'report', 'document', 'presentation'],
        DEFAULT_DOC_TYPE: 'document',
        createDocument: async ({ userId, name, docType, description, settings }) => {
            store.calls.push({ op: 'create', userId, name, docType, settings });
            const doc = {
                id: `doc_${store.docs.size + 1}`,
                userId,
                name: name || 'Untitled document',
                docType: ['invoice', 'quote', 'letter', 'report', 'document', 'presentation'].includes(docType) ? docType : 'document',
                description: description || '',
                bodyHtml: '',
                css: '',
                settings: settings || {},
            };
            store.docs.set(doc.id, doc);
            return doc;
        },
        getDocument: async (id, userId) => {
            const d = store.docs.get(id);
            if (!d) return null;
            if (d.userId === userId) return { ...d };
            return roleOf(d, userId) ? { ...d, projectRole: roleOf(d, userId) } : null;
        },
        updateDocument: async (id, userId, updates) => {
            store.calls.push({ op: 'update', id, updates });
            if (store.conflict) throw Object.assign(new Error('This document changed while you were editing.'), { status: 409, errorClass: 'document_conflict' });
            const d = store.docs.get(id);
            if (!d || (d.userId !== userId && !['editor', 'owner'].includes(roleOf(d, userId)))) return null;
            Object.assign(d, updates);
            return { ...d };
        },
        snapshotVersion: async (id, userId, summary) => {
            store.calls.push({ op: 'snapshot', id, summary });
            return { id: 'v1' };
        },
    },
    // Stubbed for the same reason as the store: the real one requires
    // configStore, which fires initDB() at load. `house` is what the org has
    // configured, so a test can flip it without a database.
    '../core/documents/documentHouseStyle': {
        getHouseStyle: async () => store.house,
        houseStyleFacts: (style) => (style && style.enabled
            ? { companyName: style.companyName, hasLogo: !!style.logoDataUrl, accent: style.accent }
            : null),
    },
});

const { createDocumentScope } = require('../core/documents/aiDocumentScope');
const {
    DOCUMENT_TOOLS,
    isDocumentTool,
    executeDocumentTool,
    documentUrl,
} = require('./documentBuilderTools');

test.after(() => restore());

// The scope rule (core/documents/aiDocumentScope.js) has its own tests below; the
// behaviour tests run with a scope that lets everything through.
const OPEN_SCOPE = { has: () => true, add() {}, markCreated() {}, createdInChat: () => false };
const CTX = { userId: 'u1', documentScope: OPEN_SCOPE };

// ── Tool surface ─────────────────────────────────────────────────────

test('the tool surface is exactly the four document tools', () => {
    const names = DOCUMENT_TOOLS.map(t => t.function.name).sort();
    assert.deepStrictEqual(names, ['create_document', 'document_edit', 'document_read', 'document_write']);
    for (const name of names) assert.ok(isDocumentTool(name), `${name} dispatches here`);
    assert.ok(!isDocumentTool('create_webpage'), 'webpage tools are somebody else\'s');
});

test('no tool offers a script slot — a document does not run', () => {
    const json = JSON.stringify(DOCUMENT_TOOLS);
    const props = DOCUMENT_TOOLS.flatMap(t => Object.keys(t.function.parameters.properties || {}));
    assert.ok(!props.includes('js'), 'no js slot');
    assert.ok(!props.includes('script'), 'no script slot');
    // And the model is told so in as many words, since that is what actually
    // stops it writing an onclick into the markup.
    assert.match(json, /no <script>|Scripts are stripped|scripts are stripped/i);
});

// ── create_document ──────────────────────────────────────────────────

test('create_document returns an id, a url and the next step', async () => {
    resetStore();
    const out = await executeDocumentTool('create_document', { name: 'Factuur 2026-014', docType: 'invoice' }, CTX);
    assert.ok(out.documentId, 'has an id');
    assert.strictEqual(out.name, 'Factuur 2026-014');
    assert.strictEqual(out.docType, 'invoice');
    assert.strictEqual(out.url, documentUrl(out.documentId));
    assert.match(out.message, /document_write/, 'the message names the next call');
});

test('create_document falls back to a default name rather than failing', async () => {
    resetStore();
    const out = await executeDocumentTool('create_document', { name: '   ' }, CTX);
    assert.strictEqual(out.name, 'Untitled document');
});

test('create_document records only a DECISION to opt out, never one to opt in', async () => {
    // An ABSENT key means "nobody decided", which reads as ON — so a document
    // made before the org had a letterhead picks one up the moment it exists.
    // Writing `houseStyle: true` would freeze that document's answer forever.
    resetStore();
    await executeDocumentTool('create_document', { name: 'A' }, CTX);
    assert.deepStrictEqual(store.calls[0].settings, {}, 'the default is silence');

    resetStore();
    await executeDocumentTool('create_document', { name: 'B', useHouseStyle: true }, CTX);
    assert.deepStrictEqual(store.calls[0].settings, {}, 'an explicit yes is still silence');

    resetStore();
    await executeDocumentTool('create_document', { name: 'C', useHouseStyle: false }, CTX);
    assert.deepStrictEqual(store.calls[0].settings, { houseStyle: false }, 'only a NO is recorded');
});

test('create_document hands the model the letterhead facts when the org has one', async () => {
    resetStore();
    store.house = { enabled: true, companyName: 'Van Dijk Groep', accent: '#b0342c', logoDataUrl: 'data:image/png;base64,AAA' };
    const out = await executeDocumentTool('create_document', { name: 'Factuur' }, { ...CTX, orgId: 'org1' });
    assert.strictEqual(out.houseStyle.companyName, 'Van Dijk Groep');
    assert.match(out.message, /var\(--doc-accent\)/, 'and tells it to use the variables');
    assert.match(out.message, /doc-logo/, 'and where the logo goes');
});

test('an opted-out document is told nothing about the letterhead', async () => {
    resetStore();
    store.house = { enabled: true, companyName: 'Van Dijk Groep' };
    const out = await executeDocumentTool('create_document', { name: 'X', useHouseStyle: false }, { ...CTX, orgId: 'org1' });
    assert.strictEqual(out.houseStyle, null);
    assert.ok(!/var\(--doc-accent\)/.test(out.message));
});

// ── document_read ────────────────────────────────────────────────────

test('document_read returns both slots', async () => {
    resetStore();
    const { documentId } = await executeDocumentTool('create_document', { name: 'X' }, CTX);
    await executeDocumentTool('document_write', { documentId, bodyHtml: '<p>a</p>', css: '.a{}' }, CTX);
    const out = await executeDocumentTool('document_read', { documentId }, CTX);
    assert.strictEqual(out.bodyHtml, '<p>a</p>');
    assert.strictEqual(out.css, '.a{}');
});

test('a document belonging to someone else is not found, not refused', async () => {
    resetStore();
    const { documentId } = await executeDocumentTool('create_document', { name: 'X' }, CTX);
    const out = await executeDocumentTool('document_read', { documentId }, { userId: 'someone-else', documentScope: OPEN_SCOPE });
    assert.strictEqual(out.error, 'Document not found.');
});

// ── document_write ───────────────────────────────────────────────────

test('document_write writes only the slots it was given', async () => {
    resetStore();
    const { documentId } = await executeDocumentTool('create_document', { name: 'X' }, CTX);
    await executeDocumentTool('document_write', { documentId, bodyHtml: '<p>body</p>', css: '.a{color:red}' }, CTX);

    // A second write that touches only the body must not blank the stylesheet.
    await executeDocumentTool('document_write', { documentId, bodyHtml: '<p>new body</p>' }, CTX);
    const after = await executeDocumentTool('document_read', { documentId }, CTX);
    assert.strictEqual(after.bodyHtml, '<p>new body</p>');
    assert.strictEqual(after.css, '.a{color:red}', 'the untouched slot survives');
});

test('an AI write is its own version: marked as the AI\'s, for the person who asked, with its summary', async () => {
    resetStore();
    const { documentId } = await executeDocumentTool('create_document', { name: 'X' }, CTX);
    await executeDocumentTool('document_write', { documentId, bodyHtml: '<p>v1</p>' }, CTX);
    store.calls = [];
    await executeDocumentTool('document_write', { documentId, bodyHtml: '<p>v2</p>', summary: 'Added VAT row' }, CTX);
    const update = store.calls.find(c => c.op === 'update');
    assert.strictEqual(update.updates.source, 'ai');
    assert.strictEqual(update.updates.summary, 'Added VAT row', 'the summary reaches the history (it used to be dropped)');
    assert.deepStrictEqual(update.updates.contributors, [{ userId: 'u1', kind: 'ai' }]);
    assert.ok(!store.calls.some(c => c.op === 'snapshot'), 'no separate snapshot call: the write IS the version');
    await executeDocumentTool('document_write', { documentId, bodyHtml: '<p>v3</p>' }, CTX);
    assert.strictEqual(store.calls.filter(c => c.op === 'update').at(-1).updates.summary, 'AI edit', 'a default that says who');
});

test('a stale write is told to read again, not thrown', async () => {
    resetStore();
    const { documentId } = await executeDocumentTool('create_document', { name: 'X' }, CTX);
    store.conflict = true;
    try {
        const out = await executeDocumentTool('document_write', { documentId, bodyHtml: '<p>v2</p>', expectedVersionId: 'old' }, CTX);
        assert.match(out.error, /changed/);
    } finally { store.conflict = false; }
});

test('document_write with no slots is an error, not a silent no-op', async () => {
    resetStore();
    const { documentId } = await executeDocumentTool('create_document', { name: 'X' }, CTX);
    const out = await executeDocumentTool('document_write', { documentId }, CTX);
    assert.match(out.error, /Nothing to write/);
});

test('document_write on a missing document reports it rather than creating one', async () => {
    resetStore();
    const out = await executeDocumentTool('document_write', { documentId: 'nope', bodyHtml: '<p>x</p>' }, CTX);
    assert.strictEqual(out.error, 'Document not found.');
    assert.strictEqual(store.docs.size, 0, 'nothing was created as a side effect');
});

// ── document_edit ────────────────────────────────────────────────────

async function seed(ctx = CTX) {
    resetStore();
    const { documentId } = await executeDocumentTool('create_document', { name: 'Factuur' }, ctx);
    await executeDocumentTool('document_write', {
        documentId,
        bodyHtml: '<h1>Factuur</h1>\n<p>Bedrag: 1.140,00</p>',
        css: 'h1 { color: #123a5e; }\np { margin: 0; }',
    }, ctx);
    return documentId;
}

test('document_edit changes one snippet of the body and nothing else', async () => {
    const documentId = await seed();
    const out = await executeDocumentTool('document_edit', {
        documentId, slot: 'body', find_text: '1.140,00', replace_text: '1.320,00',
    }, CTX);
    assert.ok(!out.error, out.error);

    const after = await executeDocumentTool('document_read', { documentId }, CTX);
    assert.strictEqual(after.bodyHtml, '<h1>Factuur</h1>\n<p>Bedrag: 1.320,00</p>');
    assert.strictEqual(after.css, 'h1 { color: #123a5e; }\np { margin: 0; }', 'the stylesheet is untouched');
});

test('editing the css leaves the TEXT alone — "only the styling" really means only', async () => {
    const documentId = await seed();
    await executeDocumentTool('document_edit', {
        documentId, slot: 'css', find_text: '#123a5e', replace_text: '#b0342c',
    }, CTX);

    const after = await executeDocumentTool('document_read', { documentId }, CTX);
    assert.match(after.css, /#b0342c/);
    assert.strictEqual(after.bodyHtml, '<h1>Factuur</h1>\n<p>Bedrag: 1.140,00</p>', 'not one character of text moved');
});

test('an edit whose snippet no longer matches REFUSES rather than clobbering a hand-edit', async () => {
    // The property the whole tool exists for. The user corrected the amount by
    // hand; the model still believes the old one. A full-slot write would
    // silently revert them — this must not.
    const documentId = await seed();
    store.docs.get(documentId).bodyHtml = '<h1>Factuur</h1>\n<p>Bedrag: 1.250,00</p>';

    const out = await executeDocumentTool('document_edit', {
        documentId, slot: 'body', find_text: '1.140,00', replace_text: '1.320,00',
    }, CTX);
    assert.ok(out.error, 'refused');

    const after = await executeDocumentTool('document_read', { documentId }, CTX);
    assert.match(after.bodyHtml, /1\.250,00/, "the user's correction survived");
});

test('document_edit is an AI version with the summary it was given', async () => {
    const documentId = await seed();
    store.calls = [];
    await executeDocumentTool('document_edit', {
        documentId, slot: 'body', find_text: '1.140,00', replace_text: '1.320,00', summary: 'Corrected the total',
    }, CTX);
    const update = store.calls.find(c => c.op === 'update');
    assert.strictEqual(update.updates.source, 'ai');
    assert.strictEqual(update.updates.summary, 'Corrected the total');
});

test('a bad slot name is refused with the two that exist', async () => {
    const documentId = await seed();
    const out = await executeDocumentTool('document_edit', {
        documentId, slot: 'js', find_text: 'a', replace_text: 'b',
    }, CTX);
    assert.match(out.error, /slot must be "body".*"css"/);
});

test('document_edit on somebody else\'s document is not found', async () => {
    const documentId = await seed();
    const out = await executeDocumentTool('document_edit', {
        documentId, slot: 'body', find_text: '1.140,00', replace_text: 'x',
    }, { userId: 'someone-else', documentScope: OPEN_SCOPE });
    assert.strictEqual(out.error, 'Document not found.');
});

test('a snippet matching twice is refused with the line numbers', async () => {
    resetStore();
    const { documentId } = await executeDocumentTool('create_document', { name: 'X' }, CTX);
    await executeDocumentTool('document_write', { documentId, bodyHtml: '<p>x</p>\n<p>x</p>' }, CTX);
    const out = await executeDocumentTool('document_edit', {
        documentId, slot: 'body', find_text: '<p>x</p>', replace_text: '<p>y</p>',
    }, CTX);
    assert.match(out.error, /matches 2 places/);
    assert.match(out.error, /replace_all/);
});

test('an unknown tool name is reported rather than swallowed', async () => {
    const out = await executeDocumentTool('document_delete_everything', {}, CTX);
    assert.match(out.error, /Unknown document tool/);
});

test('a missing user context is refused', async () => {
    const out = await executeDocumentTool('create_document', { name: 'X' }, {});
    assert.match(out.error, /No user context/);
});

// ── Presentations ────────────────────────────────────────────────────

test('a presentation: create explains the outline (no css), read returns it as `outline`, write ignores css, edit refuses the css slot', async () => {
    resetStore();
    store.house = { enabled: true, companyName: 'Van Dijk', accent: '#123456' };
    const created = await executeDocumentTool('create_document', { name: 'Kick-off', docType: 'presentation' }, CTX);
    assert.strictEqual(created.docType, 'presentation');
    assert.match(created.message, /outline/);
    assert.match(created.message, /No HTML, no css/);
    assert.match(created.message, /house style .*applied automatically/);
    assert.doesNotMatch(created.message, /var\(--doc-accent\)/, 'the CSS-variable advice is for pages');
    assert.match(created.message, new RegExp(`\\[Kick-off\\]\\(${documentUrl(created.documentId).replace(/\//g, '\\/')}\\)`));

    const written = await executeDocumentTool('document_write', { documentId: created.documentId, bodyHtml: '# Kick-off\n\n## Goals\n- a', css: 'h1 { color: red }', expectedVersionId: created.versionId }, CTX);
    assert.deepStrictEqual(written.wrote, ['bodyHtml'], 'css is not a slot a presentation has');
    const read = await executeDocumentTool('document_read', { documentId: created.documentId }, CTX);
    assert.strictEqual(read.outline, '# Kick-off\n\n## Goals\n- a');
    assert.strictEqual(read.css, undefined);
    assert.match(read.message, /slide outline/);

    const viaOutline = await executeDocumentTool('document_write', { documentId: created.documentId, outline: '# Kick-off\n\n## Goals\n- b', expectedVersionId: read.versionId }, CTX);
    assert.deepStrictEqual(viaOutline.wrote, ['bodyHtml']);
    const nothing = await executeDocumentTool('document_write', { documentId: created.documentId, css: 'x', expectedVersionId: read.versionId }, CTX);
    assert.match(nothing.error, /no css/);

    const refused = await executeDocumentTool('document_edit', { documentId: created.documentId, slot: 'css', find_text: 'a', replace_text: 'b', expectedVersionId: read.versionId }, CTX);
    assert.match(refused.error, /no stylesheet/);
    const edited = await executeDocumentTool('document_edit', { documentId: created.documentId, slot: 'body', find_text: '- b', replace_text: '- b\n- c', expectedVersionId: read.versionId }, CTX);
    assert.strictEqual(edited.error, undefined);
    assert.strictEqual(store.docs.get(created.documentId).bodyHtml, '# Kick-off\n\n## Goals\n- b\n- c');
});

// ── Pages ────────────────────────────────────────────────────────────

test('the chat creates designed documents, not pages', () => {
    const create = DOCUMENT_TOOLS.find(t => t.function.name === 'create_document');
    assert.ok(!create.function.parameters.properties.docType.enum.includes('page'));
});

/**
 * A page that is being edited live, with a live layer that behaves like
 * core/collab: `read` answers the state and the update it is at. `typed()` is
 * a colleague typing.
 */
function withLivePage(t, { projectRole } = {}) {
    resetStore();
    store.docs.set('pg1', { id: 'pg1', userId: 'u1', name: 'Minutes', docType: 'page', bodyHtml: '<p>a</p>', css: '', settings: {}, versionId: 'v1', projectId: 'p1' });
    if (projectRole) store.roles.member = projectRole;
    const live = { html: '<p>live a</p>', seq: 3, edits: [] };
    live.typed = (html) => { live.html = html; live.seq += 1; };
    const documentFeed = require('../core/documents/documentFeed');
    const saved = documentFeed.liveCollabFor;
    t.after(() => { documentFeed.liveCollabFor = saved; });
    const facade = {
        read: async () => ({ html: live.html, seq: live.seq }),
        readHtml: async () => live.html,
        applyServerEdit: async (kind, id, actor, change) => { live.edits.push([kind, id, actor, change]); return { applied: true, seq: live.seq }; },
    };
    documentFeed.liveCollabFor = async (doc) => (doc.docType === 'page' ? facade : null);
    return { live, facade };
}

// The engine is a seam (core/documents/suggestions/engine.js): a fake that
// treats the "AST" as the HTML string itself, one hunk per changed body.
const fakeEngine = {
    htmlToAst: (html) => html,
    astToHtml: (ast) => ast,
    hunksFrom: (current, proposed) => ({
        hunks: current === proposed ? [] : [{ anchor: { quote: current, prefix: '', suffix: '', blockIndex: 0 }, before: [current], after: [proposed], summary: `Rewrote "${current}"` }],
        replaceAll: false,
    }),
};

/** An in-memory stand-in for stores/documentSuggestionStore. */
function fakeSuggestionStore() {
    const rows = [];
    return {
        rows,
        async createBatch(args) {
            const batchId = `b${rows.length + 1}`;
            const made = args.hunks.map((h, i) => ({ id: `s${rows.length + i + 1}`, batchId, status: 'open', ...h }));
            rows.push(...made.map((m) => ({ ...m, args })));
            return { batchId, suggestions: made };
        },
        async list(_type, id, { status } = {}) { return rows.filter((r) => r.args.targetId === id && (!status || r.status === status)); },
        async countOpen(_type, id) { return rows.filter((r) => r.args.targetId === id && r.status === 'open').length; },
    };
}

function suggestCtx(extra = {}) {
    const suggestionStore = fakeSuggestionStore();
    const announced = [];
    return { userId: 'u1', documentScope: OPEN_SCOPE, suggestionStore, engine: fakeEngine, announceSuggestions: async (e) => { announced.push(e); }, announced, ...extra };
}

test('a page edited live is never written: the model\'s body becomes suggestions; css is refused', async (t) => {
    const { live } = withLivePage(t);
    const ctx = suggestCtx();
    const read = await executeDocumentTool('document_read', { documentId: 'pg1' }, ctx);
    assert.strictEqual(read.bodyHtml, '<p>live a</p>', 'the model reads what people see now');
    assert.strictEqual(read.versionId, 'v1@live:3', 'and the versionId names the live state it read');
    assert.deepStrictEqual(read.openSuggestions, []);
    const cssOnly = await executeDocumentTool('document_write', { documentId: 'pg1', css: 'p{}', expectedVersionId: read.versionId }, ctx);
    assert.match(cssOnly.error, /no stylesheet/);

    const out = await executeDocumentTool('document_write', { documentId: 'pg1', bodyHtml: '<p>b</p>', expectedVersionId: read.versionId, summary: 'Tighten' }, ctx);
    assert.ok(!out.error, out.error);
    assert.strictEqual(out.suggested, 1);
    assert.strictEqual(out.batchId, 'b1');
    assert.strictEqual(out.documentId, 'pg1');
    assert.match(out.message, /Proposed 1 change to "Minutes".*Do not claim they are applied/);
    const [row] = ctx.suggestionStore.rows;
    assert.deepStrictEqual([row.before, row.after], [['<p>live a</p>'], ['<p>b</p>']], 'hunks are computed against the LIVE state');
    assert.deepStrictEqual([row.args.targetId, row.args.projectId, row.args.authorKind, row.args.authorUserId, row.args.baseToken], ['pg1', 'p1', 'ai', 'u1', 'v1@live:3']);
    assert.deepStrictEqual(ctx.announced, [{ documentId: 'pg1', projectId: 'p1', batchId: 'b1', open: 1 }]);
    assert.deepStrictEqual(live.edits, [], 'the live layer is not touched');
    assert.ok(!store.calls.some(c => c.op === 'update'), 'nor the stored body');
});

test('document_edit on a page proposes the find/replace result; a snippet that does not match still refuses', async (t) => {
    withLivePage(t);
    const ctx = suggestCtx();
    const out = await executeDocumentTool('document_edit', { documentId: 'pg1', slot: 'body', find_text: 'live a', replace_text: 'live b', expectedVersionId: 'v1' }, ctx);
    assert.ok(!out.error, out.error);
    assert.strictEqual(out.suggested, 1);
    assert.deepStrictEqual([ctx.suggestionStore.rows[0].before, ctx.suggestionStore.rows[0].after], [['<p>live a</p>'], ['<p>live b</p>']]);
    const missing = await executeDocumentTool('document_edit', { documentId: 'pg1', slot: 'body', find_text: 'not there', replace_text: 'x', expectedVersionId: 'v1' }, ctx);
    assert.ok(missing.error);
    assert.strictEqual(ctx.suggestionStore.rows.length, 1);
    const same = await executeDocumentTool('document_edit', { documentId: 'pg1', slot: 'body', find_text: 'live a', replace_text: 'live a', expectedVersionId: 'v1' }, ctx);
    assert.strictEqual(same.suggested, 0, 'a change that changes nothing proposes nothing');
    assert.strictEqual(ctx.suggestionStore.rows.length, 1);
});

test('a stored page in a project is suggested too, from its stored body', async (t) => {
    withLivePage(t);
    require('../core/documents/documentFeed').liveCollabFor = async () => null;
    const ctx = suggestCtx();
    const out = await executeDocumentTool('document_write', { documentId: 'pg1', bodyHtml: '<p>new</p>', expectedVersionId: 'v1' }, ctx);
    assert.strictEqual(out.suggested, 1);
    assert.deepStrictEqual(ctx.suggestionStore.rows[0].before, ['<p>a</p>']);
    assert.ok(!store.calls.some(c => c.op === 'update'));
});

test('an open page of your own that the chat did not make is suggested, one it made (private, unfiled, not live) is written directly', async (t) => {
    resetStore();
    const documentFeed = require('../core/documents/documentFeed');
    const saved = documentFeed.liveCollabFor;
    t.after(() => { documentFeed.liveCollabFor = saved; });
    documentFeed.liveCollabFor = async () => null;
    store.docs.set('own', { id: 'own', userId: 'u1', name: 'Own', docType: 'page', bodyHtml: '<p>a</p>', css: '', settings: {}, versionId: 'v1', projectId: null, sharing: { audience: 'private' } });

    const opened = suggestCtx({ documentScope: createDocumentScope({ sidePanelDocument: { id: 'own' } }) });
    const proposed = await executeDocumentTool('document_write', { documentId: 'own', bodyHtml: '<p>b</p>', expectedVersionId: 'v1' }, opened);
    assert.strictEqual(proposed.suggested, 1, 'merely opened: proposed');
    assert.ok(!store.calls.some(c => c.op === 'update'));

    const scope = createDocumentScope({ sidePanelDocument: { id: 'own' } });
    scope.markCreated('own');
    const made = suggestCtx({ documentScope: scope });
    const direct = await executeDocumentTool('document_write', { documentId: 'own', bodyHtml: '<p>b</p>', expectedVersionId: 'v1' }, made);
    assert.ok(!direct.error, direct.error);
    assert.strictEqual(direct.suggested, undefined);
    assert.strictEqual(store.docs.get('own').bodyHtml, '<p>b</p>', 'written directly');
    assert.strictEqual(made.suggestionStore.rows.length, 0);

    // Made in this chat but shared since: back to suggestions.
    store.docs.get('own').sharing = { audience: 'organisation' };
    const shared = await executeDocumentTool('document_edit', { documentId: 'own', slot: 'body', find_text: 'b', replace_text: 'c', expectedVersionId: 'v1' }, made);
    assert.strictEqual(shared.suggested, 1);
    assert.strictEqual(store.docs.get('own').bodyHtml, '<p>b</p>');
});

test('document_read lists the open suggestions of a page, so the model does not propose them twice', async (t) => {
    withLivePage(t);
    require('../core/documents/documentFeed').liveCollabFor = async () => null;
    const ctx = suggestCtx();
    await executeDocumentTool('document_write', { documentId: 'pg1', bodyHtml: '<p>new</p>', expectedVersionId: 'v1' }, ctx);
    ctx.suggestionStore.rows.push({ id: 'done', status: 'accepted', summary: 'old', args: { targetId: 'pg1' } });
    const read = await executeDocumentTool('document_read', { documentId: 'pg1' }, ctx);
    assert.deepStrictEqual(read.openSuggestions, [{ id: 's1', summary: 'Rewrote "<p>a</p>"' }]);
    assert.match(read.message, /1 suggestion\(s\) are already proposed/);
    const broken = suggestCtx();
    broken.suggestionStore.list = async () => { throw new Error('db down'); };
    const still = await executeDocumentTool('document_read', { documentId: 'pg1' }, broken);
    assert.strictEqual(still.openSuggestions, undefined, 'a failing list never fails the read');
    assert.strictEqual(still.bodyHtml, '<p>a</p>');
});

test('a project viewer cannot change a live page through the chat, nor a stored one', async (t) => {
    const { live } = withLivePage(t, { projectRole: 'viewer' });
    const member = suggestCtx({ userId: 'member' });
    const read = await executeDocumentTool('document_read', { documentId: 'pg1' }, member);
    assert.strictEqual(read.readOnly, true, 'the model is told it may only read');
    const write = await executeDocumentTool('document_write', { documentId: 'pg1', bodyHtml: '<p>vic</p>', expectedVersionId: read.versionId }, member);
    assert.strictEqual(write.error, 'Document is read-only.');
    const edit = await executeDocumentTool('document_edit', { documentId: 'pg1', slot: 'body', find_text: 'live a', replace_text: 'vic', expectedVersionId: read.versionId }, member);
    assert.strictEqual(edit.error, 'Document is read-only.');
    assert.deepStrictEqual(live.edits, [], 'nothing reached the live layer');
    assert.strictEqual(member.suggestionStore.rows.length, 0, 'and no suggestion was made');
    assert.ok(!store.calls.some(c => c.op === 'update'), 'nor the stored body');

    // The same page when nobody has it open live: refused before the store.
    const documentFeed = require('../core/documents/documentFeed');
    documentFeed.liveCollabFor = async () => null;
    const stored = await executeDocumentTool('document_write', { documentId: 'pg1', bodyHtml: '<p>vic</p>', expectedVersionId: 'v1' }, member);
    assert.strictEqual(stored.error, 'Document is read-only.');
    assert.strictEqual(store.docs.get('pg1').bodyHtml, '<p>a</p>');
});

test('a project editor proposes suggestions on a page through the chat, in their own name', async (t) => {
    withLivePage(t, { projectRole: 'editor' });
    const ctx = suggestCtx({ userId: 'member', conversationId: 'c9' });
    const read = await executeDocumentTool('document_read', { documentId: 'pg1' }, ctx);
    assert.strictEqual(read.readOnly, undefined);
    const out = await executeDocumentTool('document_write', { documentId: 'pg1', bodyHtml: '<p>ed</p>', expectedVersionId: read.versionId }, ctx);
    assert.ok(!out.error, out.error);
    assert.deepStrictEqual([ctx.suggestionStore.rows[0].args.authorUserId, ctx.suggestionStore.rows[0].args.conversationId], ['member', 'c9']);
});

// ── Document scope: the AI touches only what the person pointed at ───

const SCOPE_ERROR = /has not been shared with this chat/;

test('document_read/write/edit fail closed when the caller passes no scope', async () => {
    const { documentId } = await executeDocumentTool('create_document', { name: 'X' }, CTX);
    for (const [tool, args] of [
        ['document_read', { documentId }],
        ['document_write', { documentId, bodyHtml: '<p>x</p>' }],
        ['document_edit', { documentId, slot: 'body', find_text: 'a', replace_text: 'b' }],
    ]) {
        const out = await executeDocumentTool(tool, args, { userId: 'u1' });
        assert.match(out.error, SCOPE_ERROR, tool);
    }
});

test('an id outside the scope is refused with the same answer as one that does not exist', async () => {
    const { documentId } = await executeDocumentTool('create_document', { name: 'X' }, CTX);
    const scope = createDocumentScope({});
    const real = await executeDocumentTool('document_read', { documentId }, { userId: 'u1', documentScope: scope });
    const missing = await executeDocumentTool('document_read', { documentId: 'does-not-exist' }, { userId: 'u1', documentScope: scope });
    assert.match(real.error, SCOPE_ERROR);
    assert.deepStrictEqual(real, missing, 'no hint whether the document exists');
});

test('a document in the scope (the open one) can be read, written and edited', async () => {
    const { documentId } = await executeDocumentTool('create_document', { name: 'X' }, CTX);
    const ctx = { userId: 'u1', documentScope: createDocumentScope({ sidePanelDocument: { id: documentId } }) };
    const read = await executeDocumentTool('document_read', { documentId }, ctx);
    assert.strictEqual(read.error, undefined);
    const wrote = await executeDocumentTool('document_write', { documentId, bodyHtml: '<p>a</p>', expectedVersionId: read.versionId }, ctx);
    assert.strictEqual(wrote.error, undefined);
});

test('create_document adds its new id to the scope for the rest of the turn', async () => {
    const scope = createDocumentScope({});
    const ctx = { userId: 'u1', documentScope: scope };
    const created = await executeDocumentTool('create_document', { name: 'Fresh' }, ctx);
    assert.ok(scope.has(created.documentId));
    const read = await executeDocumentTool('document_read', { documentId: created.documentId }, ctx);
    assert.strictEqual(read.error, undefined);
});

test('create_document marks its document as made in this chat (the only way to a direct write)', async () => {
    const scope = createDocumentScope({});
    const created = await executeDocumentTool('create_document', { name: 'Fresh' }, { userId: 'u1', documentScope: scope });
    assert.ok(scope.createdInChat(created.documentId));
});
