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
};

function resetStore() {
    store.docs.clear();
    store.calls = [];
    store.house = { enabled: false };
}

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
            return d && d.userId === userId ? { ...d } : null;
        },
        updateDocument: async (id, userId, updates) => {
            store.calls.push({ op: 'update', id, updates });
            const d = store.docs.get(id);
            if (!d || d.userId !== userId) return null;
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

const {
    DOCUMENT_TOOLS,
    isDocumentTool,
    executeDocumentTool,
    documentUrl,
} = require('./documentBuilderTools');

test.after(() => restore());

const CTX = { userId: 'u1' };

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
    const out = await executeDocumentTool('document_read', { documentId }, { userId: 'someone-else' });
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

test('document_write snapshots the previous state BEFORE overwriting it', async () => {
    resetStore();
    const { documentId } = await executeDocumentTool('create_document', { name: 'X' }, CTX);
    await executeDocumentTool('document_write', { documentId, bodyHtml: '<p>v1</p>' }, CTX);
    store.calls = [];
    await executeDocumentTool('document_write', { documentId, bodyHtml: '<p>v2</p>' }, CTX);

    const snapshotIdx = store.calls.findIndex(c => c.op === 'snapshot');
    const updateIdx = store.calls.findIndex(c => c.op === 'update');
    assert.ok(snapshotIdx > -1, 'a version was taken');
    assert.ok(snapshotIdx < updateIdx, 'the undo exists before the write, not after');
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

test('document_edit snapshots a version BEFORE writing', async () => {
    const documentId = await seed();
    store.calls = [];
    await executeDocumentTool('document_edit', {
        documentId, slot: 'body', find_text: '1.140,00', replace_text: '1.320,00',
    }, CTX);
    const snap = store.calls.findIndex(c => c.op === 'snapshot');
    const upd = store.calls.findIndex(c => c.op === 'update');
    assert.ok(snap > -1 && snap < upd, 'the undo exists before the write');
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
    }, { userId: 'someone-else' });
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
