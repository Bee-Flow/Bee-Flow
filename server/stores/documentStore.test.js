'use strict';

/**
 * The document store against a REAL Postgres (@electric-sql/pglite behind
 * db.js's pool, testUtils/pglitePool.js): its own schema init, its own SQL,
 * no module mocking. Project access is proven in documentStore.project.pg.test.js;
 * this file is about what a document IS and how its history is kept:
 *
 *   - caps, types, list rows without slots, totals, the archived view;
 *   - a page: sanitised on every write, its type fixed;
 *   - revision rows: seq, source, author, stats, coalesced autosave sessions;
 *   - a stale save merged per section, or refused with what to compare;
 *   - named versions, restore (with the state it replaces kept), deletion;
 *   - the live co-editing hooks (writeCollabBody, recordVersion).
 *
 * Run: cd server && node --test stores/documentStore.test.js
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');

const { usePglitePool } = require('../testUtils/pglitePool');

const { pg, close } = usePglitePool();
const store = require('./documentStore');
const { mergeBodies } = require('../core/documents/sectionMerge');
const { normaliseType, assertWithinCaps, mapRow, mapListRow } = store._test;

before(async () => {
    await pg.exec(`
        CREATE TABLE users (id TEXT PRIMARY KEY, "organizationId" TEXT);
        CREATE TABLE projects (id TEXT PRIMARY KEY, owner_id TEXT, organization_id TEXT NOT NULL DEFAULT '');
        INSERT INTO users VALUES ('ann','org1'), ('ben','org1'), ('cas','org2');
    `);
    await store.initDB();
});

after(close);

// A house style needs the organisation settings; these documents opt out of
// it so the tests are about content and history, not letterheads.
const PLAIN = { houseStyle: false };
const make = (userId, extra = {}) => store.createDocument({ userId, name: 'Plan', bodyHtml: '<p>one two</p>', settings: PLAIN, ...extra });
const rows = async (documentId) => (await pg.query(
    'SELECT id, seq, source, created_by, superseded_by, name, restored_from, stats FROM studio_document_versions WHERE document_id = $1 ORDER BY seq NULLS FIRST',
    [documentId])).rows;
const SECTION = (id, text) => `<section data-doc-section="${id}"><h2>${id}</h2><p>${text}</p></section>`;

// ═══ What a document is ═══════════════════════════════════════════════

test('the tables are studio_-prefixed: `documents` belongs to knowledge bases', async () => {
    const tables = (await pg.query(`SELECT table_name FROM information_schema.tables WHERE table_name LIKE '%documents%' OR table_name LIKE '%document_versions%'`)).rows.map(r => r.table_name);
    assert.ok(tables.includes('studio_documents'));
    assert.ok(tables.includes('studio_document_versions'));
    assert.ok(!tables.includes('documents'), 'never the bare name');
});

test('an unknown doc type degrades to "document"; page and presentation are types of their own', () => {
    assert.strictEqual(normaliseType('invoice'), 'invoice');
    assert.strictEqual(normaliseType('page'), 'page');
    assert.strictEqual(normaliseType('presentation'), 'presentation');
    assert.strictEqual(normaliseType('purchase_order'), 'document');
    assert.strictEqual(normaliseType(undefined), 'document');
});

test('oversized content is refused, never truncated, measured in bytes', () => {
    assert.throws(() => assertWithinCaps({ bodyHtml: 'x'.repeat(store.MAX_HTML_BYTES + 1) }), (e) => e.errorClass === 'document_too_large' && e.status === 413);
    assert.throws(() => assertWithinCaps({ css: 'x'.repeat(store.MAX_CSS_BYTES + 1) }), (e) => e.errorClass === 'document_too_large');
    const underInChars = '€'.repeat(Math.floor(store.MAX_HTML_BYTES / 3) + 10);
    assert.ok(underInChars.length < store.MAX_HTML_BYTES);
    assert.throws(() => assertWithinCaps({ bodyHtml: underInChars }), (e) => e.errorClass === 'document_too_large');
});

test('mapRow parses settings from an object or a string; a list row carries no slots', () => {
    const base = { id: 'd1', user_id: 'u1', name: 'X', doc_type: 'invoice', body_html: '<p>a</p>', css: '.a{}' };
    assert.deepStrictEqual(mapRow({ ...base, settings: { a: 1 } }).settings, { a: 1 });
    assert.deepStrictEqual(mapRow({ ...base, settings: '{"a":1}' }).settings, { a: 1 });
    assert.strictEqual(mapRow(null), null);
    const row = mapListRow({ ...base, html_size: '2048', updated_by: 'u2' });
    assert.strictEqual(row.htmlSize, 2048);
    assert.strictEqual(row.updatedBy, 'u2');
    assert.strictEqual(row.solutionProjectId, null);
    assert.strictEqual(mapListRow({ ...base, solution_project_id: 'sol1' }).solutionProjectId, 'sol1');
    assert.ok(!('bodyHtml' in row) && !('css' in row));
});

test('a new document has one revision: seq 1, source created, its creator as author', async () => {
    const doc = await make('ann');
    assert.strictEqual(doc.updatedBy, 'ann');
    const [first] = await rows(doc.id);
    assert.strictEqual(first.id, doc.versionId);
    assert.strictEqual(first.seq, 1);
    assert.strictEqual(first.source, 'created');
    assert.strictEqual(first.created_by, 'ann');
});

test('a stranger and another organisation read nothing', async () => {
    const doc = await make('ann');
    assert.strictEqual(await store.getDocument(doc.id, 'ben'), null, 'a private document is its owner\'s');
    assert.strictEqual(await store.getDocument(doc.id, 'cas'), null);
    assert.strictEqual(await store.listVersions(doc.id, 'ben'), null);
    assert.strictEqual(await store.getVersion(doc.id, 'ben', 'current'), null);
    assert.strictEqual(await store.updateDocument(doc.id, 'ben', { bodyHtml: '<p>no</p>' }), null);
});

// ═══ Pages ═════════════════════════════════════════════════════════════

test('a page is sanitised when it is created and on every save, and keeps no stylesheet', async () => {
    const page = await store.createDocument({
        userId: 'ann', name: 'Notes', docType: 'page', settings: PLAIN, css: 'body{color:red}',
        bodyHtml: '<h1>Hi</h1><script>alert(1)</script><img src="https://tracker.example/p.gif"><p onclick="x()">ok</p>',
    });
    assert.strictEqual(page.docType, 'page');
    assert.strictEqual(page.css, '');
    assert.doesNotMatch(page.bodyHtml, /script|tracker|onclick/);
    assert.match(page.bodyHtml, /<h1>Hi<\/h1>/);
    const saved = await store.updateDocument(page.id, 'ann', { bodyHtml: '<p>fine</p><iframe src="x"></iframe>', expectedVersionId: page.versionId });
    assert.strictEqual(saved.bodyHtml, '<p>fine</p>');
});

test('a page stays a page, and a designed document cannot become one', async () => {
    const page = await store.createDocument({ userId: 'ann', name: 'P', docType: 'page', settings: PLAIN });
    await assert.rejects(store.updateDocument(page.id, 'ann', { docType: 'letter' }), (e) => e.status === 422 && e.errorClass === 'document_type_fixed');
    const letter = await make('ann', { docType: 'letter' });
    await assert.rejects(store.updateDocument(letter.id, 'ann', { docType: 'page' }), (e) => e.errorClass === 'document_type_fixed');
});

// ═══ The library list ═══════════════════════════════════════════════════

test('the library pages with a total, filters pages from designed documents, and shows the archive on request', async () => {
    await pg.exec(`INSERT INTO users VALUES ('lib','org1')`);
    const page = await store.createDocument({ userId: 'lib', name: 'A page', docType: 'page', settings: PLAIN });
    const letter = await make('lib', { name: 'A letter', docType: 'letter' });
    const deck = await make('lib', { name: 'A deck', docType: 'presentation', bodyHtml: '# Deck' });
    const gone = await make('lib', { name: 'Archived one' });
    await store.deleteDocument(gone.id, 'lib');

    const first = await store.listDocumentsPage('lib', { limit: 2 });
    assert.strictEqual(first.total, 3, 'the total counts every match, not the page');
    assert.strictEqual(first.documents.length, 2);
    const past = await store.listDocumentsPage('lib', { limit: 2, offset: 10 });
    assert.strictEqual(past.total, 3, 'past the end still knows the total');
    assert.deepStrictEqual((await store.listDocuments('lib', { docType: 'page' })).map(d => d.id), [page.id]);
    assert.deepStrictEqual((await store.listDocuments('lib', { docType: 'designed' })).map(d => d.id), [letter.id]);
    assert.deepStrictEqual((await store.listDocuments('lib', { docType: 'presentation' })).map(d => d.id), [deck.id]);

    const archived = await store.listDocumentsPage('lib', { archived: true });
    assert.deepStrictEqual(archived.documents.map(d => d.id), [gone.id]);
    assert.strictEqual(archived.documents[0].archived, true);
    assert.strictEqual((await store.listDocumentsPage('ann', { archived: true })).total, 0, 'only your own archive');

    assert.strictEqual(await store.unarchiveDocument(gone.id, 'ben'), false, 'not somebody else\'s');
    assert.strictEqual(await store.unarchiveDocument(gone.id, 'lib'), true);
    assert.strictEqual(await store.unarchiveDocument(gone.id, 'lib'), false, 'nothing to restore twice');
    assert.strictEqual((await store.listDocumentsPage('lib', {})).total, 4);
});

// ═══ Autosave sessions ════════════════════════════════════════════════

test('saves by one person in one session are ONE history entry; every revision id stays readable', async () => {
    const doc = await make('ann');
    const s1 = await store.updateDocument(doc.id, 'ann', { bodyHtml: '<p>one two three</p>', expectedVersionId: doc.versionId });
    const s2 = await store.updateDocument(doc.id, 'ann', { bodyHtml: '<p>one two three four five</p>', expectedVersionId: s1.versionId });
    const { versions } = await store.listVersions(doc.id, 'ann');
    assert.deepStrictEqual(versions.map(v => v.source), ['autosave', 'created']);
    assert.strictEqual(versions[0].id, s2.versionId, 'the session is shown by its newest revision');
    assert.deepStrictEqual(versions[0].stats, { wordsAdded: 3, wordsRemoved: 0, blocksChanged: 1 }, 'counted from where the session began');
    assert.deepStrictEqual((await rows(doc.id)).map(r => r.seq), [1, 2, 3], 'gapless');
    const folded = (await rows(doc.id)).find(r => r.id === s1.versionId);
    assert.strictEqual(folded.superseded_by, s2.versionId);
    assert.strictEqual((await store.getDocumentVersion(doc.id, 'ann', s1.versionId)).bodyHtml, '<p>one two three</p>', 'a pinned id still reads');
});

test('another author, an AI edit or a named version starts a new entry', async () => {
    const doc = await make('ann', { projectId: null });
    const mine = await store.updateDocument(doc.id, 'ann', { bodyHtml: '<p>mine</p>', expectedVersionId: doc.versionId });
    const ai = await store.updateDocument(doc.id, 'ann', {
        bodyHtml: '<p>mine, improved</p>', expectedVersionId: mine.versionId, source: 'ai', summary: 'Tightened the intro',
        contributors: [{ userId: 'ann', kind: 'ai', agentId: 'chat' }, { bogus: true, kind: 'robot' }],
    });
    const again = await store.updateDocument(doc.id, 'ann', { bodyHtml: '<p>mine, improved again</p>', expectedVersionId: ai.versionId });
    const { versions } = await store.listVersions(doc.id, 'ann');
    assert.deepStrictEqual(versions.map(v => v.source), ['autosave', 'ai', 'autosave', 'created']);
    assert.strictEqual(versions[1].summary, 'Tightened the intro');
    assert.deepStrictEqual(versions[1].contributors, [{ userId: 'ann', kind: 'ai', agentId: 'chat' }, { userId: null, kind: 'user' }],
        'only the allow-listed fields of a contributor are kept');
    assert.strictEqual(versions[0].id, again.versionId);
});

test('an old session does not continue: past the gap a new entry starts', async () => {
    const doc = await make('ann');
    const s1 = await store.updateDocument(doc.id, 'ann', { bodyHtml: '<p>a</p>', expectedVersionId: doc.versionId });
    await pg.query(`UPDATE studio_document_versions SET created_at = NOW() - INTERVAL '11 minutes' WHERE id = $1`, [s1.versionId]);
    await store.updateDocument(doc.id, 'ann', { bodyHtml: '<p>b</p>', expectedVersionId: s1.versionId });
    assert.strictEqual((await store.listVersions(doc.id, 'ann')).versions.length, 3);
});

test('the history pages with a cursor, newest first', async () => {
    const doc = await make('ann');
    let versionId = doc.versionId;
    for (const n of [1, 2, 3, 4]) {
        versionId = (await store.updateDocument(doc.id, 'ann', { bodyHtml: `<p>${n}</p>`, expectedVersionId: versionId, source: 'ai' })).versionId;
    }
    const page1 = await store.listVersions(doc.id, 'ann', { limit: 3 });
    assert.strictEqual(page1.versions.length, 3);
    assert.ok(page1.nextCursor);
    const page2 = await store.listVersions(doc.id, 'ann', { limit: 3, cursor: page1.nextCursor });
    assert.deepStrictEqual(page2.versions.map(v => v.source), ['ai', 'created']);
    assert.strictEqual(page2.nextCursor, null);
    const ids = [...page1.versions, ...page2.versions].map(v => v.id);
    assert.strictEqual(new Set(ids).size, 5, 'no version twice');
    assert.strictEqual((await store.listVersions(doc.id, 'ann', { cursor: 'garbage' })).versions.length, 5, 'a broken cursor starts over');
});

// ═══ Stale saves ═════════════════════════════════════════════════════

test('a stale save without a merge is the plain 409, and nothing is written', async () => {
    const doc = await make('ann');
    const theirs = await store.updateDocument(doc.id, 'ann', { bodyHtml: '<p>kept</p>', expectedVersionId: doc.versionId });
    await assert.rejects(store.updateDocument(doc.id, 'ann', { bodyHtml: '<p>lost</p>', expectedVersionId: doc.versionId }), (e) => e.status === 409 && !e.conflict);
    assert.strictEqual((await store.getDocument(doc.id, 'ann')).versionId, theirs.versionId);
});

test('a stale save that touched other sections merges, and says which sections came from others', async () => {
    const base = SECTION('intro', 'a') + SECTION('pricing', 'b');
    const doc = await make('ann', { bodyHtml: base });
    const other = await store.updateDocument(doc.id, 'ann', { bodyHtml: SECTION('intro', 'a') + SECTION('pricing', 'B by ben'), expectedVersionId: doc.versionId });
    const merged = await store.updateDocument(doc.id, 'ann', {
        bodyHtml: SECTION('intro', 'A by ann') + SECTION('pricing', 'b'), expectedVersionId: doc.versionId, mergeWith: mergeBodies,
    });
    assert.strictEqual(merged.bodyHtml, SECTION('intro', 'A by ann') + SECTION('pricing', 'B by ben'));
    assert.deepStrictEqual(merged.merge, { merged: true, fromOthers: ['pricing'], othersOutsideSections: false });
    assert.notStrictEqual(merged.versionId, other.versionId);
});

test('a stale save that touched the same section is refused with the parts to choose from', async () => {
    const doc = await make('ann', { bodyHtml: SECTION('pricing', 'b') });
    const other = await store.updateDocument(doc.id, 'ann', { bodyHtml: SECTION('pricing', 'theirs'), expectedVersionId: doc.versionId });
    await assert.rejects(
        store.updateDocument(doc.id, 'ann', { bodyHtml: SECTION('pricing', 'mine'), expectedVersionId: doc.versionId, mergeWith: mergeBodies }),
        (e) => {
            assert.strictEqual(e.status, 409);
            assert.strictEqual(e.errorClass, 'document_conflict');
            assert.strictEqual(e.conflict.currentVersionId, other.versionId);
            const conflict = e.conflict.parts.find(p => p.kind === 'conflict');
            assert.strictEqual(conflict.label, 'pricing');
            assert.strictEqual(conflict.mine, '<p>mine</p>');
            assert.strictEqual(conflict.theirs, '<p>theirs</p>');
            return true;
        });
    assert.strictEqual((await store.getDocument(doc.id, 'ann')).versionId, other.versionId, 'nothing written');
});

test('a stale save of settings is never merged', async () => {
    const doc = await make('ann');
    await store.updateDocument(doc.id, 'ann', { bodyHtml: '<p>x</p>', expectedVersionId: doc.versionId });
    await assert.rejects(store.updateDocument(doc.id, 'ann', { settings: { ...PLAIN, a: 1 }, bodyHtml: '<p>y</p>', expectedVersionId: doc.versionId, mergeWith: mergeBodies }),
        (e) => e.status === 409 && !e.conflict);
});

// ═══ Named versions, restore, delete ═════════════════════════════════

test('naming the current state names the newest row; names are trimmed, capped and clearable', async () => {
    const doc = await make('ann');
    const saved = await store.updateDocument(doc.id, 'ann', { bodyHtml: '<p>draft</p>', expectedVersionId: doc.versionId });
    const named = await store.createNamedVersion(doc.id, 'ann', '  Sent to  client ');
    assert.strictEqual(named.id, saved.versionId, 'no copy of an identical state');
    assert.strictEqual(named.name, 'Sent to client');
    await assert.rejects(store.createNamedVersion(doc.id, 'ann', 'x'.repeat(81)), (e) => e.status === 422);
    await assert.rejects(store.createNamedVersion(doc.id, 'ann', '   '), (e) => e.status === 422);
    // A named row ends the session: the next save is a new entry.
    await store.updateDocument(doc.id, 'ann', { bodyHtml: '<p>draft 2</p>', expectedVersionId: saved.versionId });
    const listed = (await store.listVersions(doc.id, 'ann')).versions;
    assert.deepStrictEqual(listed.map(v => v.name), [null, 'Sent to client', null]);
    const cleared = await store.nameVersion(doc.id, 'ann', saved.versionId, null);
    assert.strictEqual(cleared.name, null);
    assert.strictEqual(await store.nameVersion(doc.id, 'ann', 'no-such-version', 'x'), undefined);
    assert.strictEqual(await store.nameVersion(doc.id, 'ben', saved.versionId, 'x'), null, 'no write access, no name');
});

test('naming a session revision brings it back into the list', async () => {
    const doc = await make('ann');
    const s1 = await store.updateDocument(doc.id, 'ann', { bodyHtml: '<p>a</p>', expectedVersionId: doc.versionId });
    await store.updateDocument(doc.id, 'ann', { bodyHtml: '<p>ab</p>', expectedVersionId: s1.versionId });
    assert.strictEqual((await store.listVersions(doc.id, 'ann')).versions.length, 2);
    await store.nameVersion(doc.id, 'ann', s1.versionId, 'Before the rewrite');
    assert.strictEqual((await store.listVersions(doc.id, 'ann')).versions.length, 3);
});

test('a restore writes a restore version pointing at its source, and honours expectedVersionId', async () => {
    const doc = await make('ann', { bodyHtml: '<p>original</p>' });
    const edited = await store.updateDocument(doc.id, 'ann', { bodyHtml: '<p>edited</p>', expectedVersionId: doc.versionId });
    await assert.rejects(store.restoreVersion(doc.id, 'ann', doc.versionId, { expectedVersionId: doc.versionId }), (e) => e.status === 409);
    const { current, version } = await store.restoreVersion(doc.id, 'ann', doc.versionId, { expectedVersionId: edited.versionId });
    assert.strictEqual(current.bodyHtml, '<p>original</p>');
    assert.strictEqual(version.source, 'restore');
    assert.strictEqual(version.restoredFrom, doc.versionId);
    assert.strictEqual(version.createdBy, 'ann');
    assert.ok(!(await rows(doc.id)).some(r => r.source === 'pre_restore'), 'the replaced state already had its row');
    assert.strictEqual(await store.restoreVersion(doc.id, 'ann', 'no-such-version', {}), null);
});

test('only the owner deletes a version, and never the current or the first one', async () => {
    const doc = await make('ann', { projectId: null });
    const edited = await store.updateDocument(doc.id, 'ann', { bodyHtml: '<p>2</p>', expectedVersionId: doc.versionId, source: 'ai' });
    const later = await store.updateDocument(doc.id, 'ann', { bodyHtml: '<p>3</p>', expectedVersionId: edited.versionId, source: 'ai' });
    await assert.rejects(store.deleteVersion(doc.id, 'ann', later.versionId), (e) => e.status === 409 && e.errorClass === 'version_in_use');
    await assert.rejects(store.deleteVersion(doc.id, 'ann', doc.versionId), (e) => e.errorClass === 'version_in_use');
    assert.strictEqual(await store.deleteVersion(doc.id, 'ben', edited.versionId), null, 'a stranger does not learn it exists');
    assert.strictEqual(await store.deleteVersion(doc.id, 'ann', edited.versionId), true);
    assert.strictEqual(await store.deleteVersion(doc.id, 'ann', edited.versionId), false);
});

test('a version an automation pins is not deleted: the automation would fail on its next run', async () => {
    // The pins as the versions route reads them: the retention job's own
    // lookup over the automation and app definitions.
    const { listPinnedVersionIds } = require('../jobs/documentVersionRetention');
    await pg.exec('CREATE TABLE IF NOT EXISTS automations (id TEXT PRIMARY KEY, definition_json JSONB)');
    const doc = await make('ann', { projectId: null });
    const pinned = await store.updateDocument(doc.id, 'ann', { bodyHtml: '<p>2</p>', expectedVersionId: doc.versionId, source: 'ai' });
    const loose = await store.updateDocument(doc.id, 'ann', { bodyHtml: '<p>3</p>', expectedVersionId: pinned.versionId, source: 'ai' });
    await store.updateDocument(doc.id, 'ann', { bodyHtml: '<p>4</p>', expectedVersionId: loose.versionId, source: 'ai' });
    await pg.query('INSERT INTO automations VALUES ($1, $2::jsonb)', ['auto-pin', JSON.stringify({ steps: [{ type: 'fill_document', documentId: doc.id, documentVersionId: pinned.versionId }] })]);
    const referencedIds = () => listPinnedVersionIds(pg);

    await assert.rejects(store.deleteVersion(doc.id, 'ann', pinned.versionId, { referencedIds }),
        (e) => e.status === 409 && e.errorClass === 'version_in_use' && /automation or an app/.test(e.message));
    assert.strictEqual((await store.getDocumentVersion(doc.id, 'ann', pinned.versionId)).bodyHtml, '<p>2</p>', 'the automation still prints it');
    assert.strictEqual(await store.deleteVersion(doc.id, 'ann', loose.versionId, { referencedIds }), true, 'an unpinned one still goes');
    let asked = 0;
    assert.strictEqual(await store.deleteVersion(doc.id, 'ben', pinned.versionId, { referencedIds: async () => { asked += 1; return []; } }), null);
    assert.strictEqual(asked, 0, 'the pins are looked up only for the owner');
});

test('firstAuthorOf: who first put a picture into a document, from its oldest revision holding it', async () => {
    const deck = await make('ann', { docType: 'presentation', bodyHtml: '# Deck\n\n## One\n![logo](users/ann/up/logo.png)', settings: { deck: {} } });
    const v2 = await store.updateDocument(deck.id, 'ann', { bodyHtml: `${deck.bodyHtml}\n\n## Two\n![x](/api/storage/file/users/ann/private/a%20b.png)`, expectedVersionId: deck.versionId, source: 'ai' });
    // Ben, a project editor, wrote the second key into the deck: his revision.
    await pg.query('UPDATE studio_document_versions SET created_by = $2 WHERE id = $1', [v2.versionId, 'ben']);
    await store.updateDocument(deck.id, 'ann', { bodyHtml: `${v2.bodyHtml}\n`, expectedVersionId: v2.versionId, source: 'ai' });
    const author = async (id, needles, opts) => (await store.firstAuthorOf(id, needles, opts))?.createdBy;

    assert.strictEqual(await author(deck.id, ['users/ann/up/logo.png']), 'ann');
    assert.strictEqual(await author(deck.id, ['users/ann/private/a b.png', 'users/ann/private/a%20b.png']), 'ben',
        'the oldest revision holding it is the one that counts, not a later save by its owner');
    assert.strictEqual(await store.firstAuthorOf(deck.id, ['users/ann/never.png']), null, 'no revision holds it');
    assert.strictEqual(await store.firstAuthorOf(deck.id, []), null);

    const withLogo = await make('ann', { docType: 'presentation', bodyHtml: '# D\n\n## A', settings: { deck: { logo: 'users/ann/brand/mark.png' } } });
    assert.strictEqual(await author(withLogo.id, ['users/ann/brand/mark.png']), 'ann', 'a key in the settings (the deck logo) counts too');
});

test('firstAuthorOf reads the unnumbered revisions first, and with afterSeq only the ones saved since', async () => {
    const deck = await make('ann', { docType: 'presentation', bodyHtml: '# Deck\n\n## One', settings: { deck: {} } });
    const latest = await store.revisionSeqOf(deck.id);
    assert.strictEqual(latest, 1, 'the created revision is number 1');
    assert.strictEqual(await store.firstAuthorOf(deck.id, ['users/ben/chart.png']), null);

    // Ben adds his chart (revision 2); Ann saves on (revision 3).
    const v2 = await store.updateDocument(deck.id, 'ann', { bodyHtml: '# Deck\n\n## One\n![c](users/ben/chart.png)', expectedVersionId: deck.versionId, source: 'ai' });
    await pg.query('UPDATE studio_document_versions SET created_by = $2 WHERE id = $1', [v2.versionId, 'ben']);
    await store.updateDocument(deck.id, 'ann', { bodyHtml: `${v2.bodyHtml}\n`, expectedVersionId: v2.versionId, source: 'ai' });
    assert.strictEqual(await store.revisionSeqOf(deck.id), 3);
    assert.deepStrictEqual(await store.firstAuthorOf(deck.id, ['users/ben/chart.png'], { afterSeq: latest }), { createdBy: 'ben', seq: 2 },
        'only the revisions after the one already read');
    assert.strictEqual(await store.firstAuthorOf(deck.id, ['users/ben/chart.png'], { afterSeq: 3 }), null, 'nothing saved since');

    // A revision from before revisions were numbered is older than every numbered one.
    await pg.query(`INSERT INTO studio_document_versions (id, document_id, body_html, css, snapshot, created_by, created_at)
        VALUES ($1, $2, $3, '', NULL, 'cas', NOW() + INTERVAL '1 day')`, [`legacy-${deck.id}`, deck.id, '![c](users/ben/chart.png)']);
    assert.deepStrictEqual(await store.firstAuthorOf(deck.id, ['users/ben/chart.png']), { createdBy: 'cas', seq: null });
    assert.strictEqual(await store.revisionSeqOf('no-such-document'), null);
});

test('reading one version: its content, or the current state', async () => {
    const doc = await make('ann', { bodyHtml: '<p>first</p>' });
    const saved = await store.updateDocument(doc.id, 'ann', { bodyHtml: '<p>second</p>', expectedVersionId: doc.versionId });
    const old = await store.getVersion(doc.id, 'ann', doc.versionId);
    assert.strictEqual(old.version.content.html, '<p>first</p>');
    assert.strictEqual(old.version.source, 'created');
    const current = await store.getVersion(doc.id, 'ann', 'current');
    assert.strictEqual(current.version.id, saved.versionId);
    assert.strictEqual(current.version.content.html, '<p>second</p>');
    assert.strictEqual(await store.getVersion(doc.id, 'ann', 'nope'), null);
});

// ═══ Live co-editing hooks ═══════════════════════════════════════════

test('writeCollabBody mirrors the live state of a page without a version, sanitised; other types are left alone', async () => {
    const page = await store.createDocument({ userId: 'ann', name: 'Live', docType: 'page', settings: PLAIN });
    const out = await store.writeCollabBody(page.id, { html: '<p>live</p><script>x</script>' });
    assert.deepStrictEqual(out, { versionId: page.versionId });
    assert.strictEqual((await store.getDocument(page.id, 'ann')).bodyHtml, '<p>live</p>');
    assert.strictEqual((await rows(page.id)).length, 1, 'no version for a mirror write');
    const letter = await make('ann', { docType: 'letter' });
    assert.strictEqual(await store.writeCollabBody(letter.id, { html: '<p>x</p>' }), null);
});

test('recordVersion checkpoints a page with its contributors, skips an identical state, and names on request', async () => {
    const page = await store.createDocument({ userId: 'ann', name: 'Live', docType: 'page', settings: PLAIN });
    const cp = await store.recordVersion(page.id, {
        html: '<p>together</p>', source: 'checkpoint',
        contributors: [{ userId: 'ann', kind: 'user' }, { userId: 'ben', kind: 'user' }, { userId: 'ann', kind: 'ai' }],
        stats: { wordsAdded: 1, wordsRemoved: 0, blocksChanged: 1 },
    });
    assert.ok(cp.versionId && cp.seq === 2);
    const doc = await store.getDocument(page.id, 'ann');
    assert.strictEqual(doc.versionId, cp.versionId, 'the checkpoint is the current revision');
    assert.strictEqual(doc.updatedBy, 'ann');
    const again = await store.recordVersion(page.id, { html: '<p>together</p>', contributors: [] });
    assert.deepStrictEqual(again, { versionId: cp.versionId, seq: 2, skipped: true });
    const named = await store.recordVersion(page.id, { html: '<p>together</p>', name: 'Agreed text', source: 'named' });
    assert.ok(!named.skipped, 'a name is never skipped');
    const listed = (await store.listVersions(page.id, 'ann')).versions;
    assert.strictEqual(listed[0].name, 'Agreed text');
    assert.deepStrictEqual(listed[1].contributors.map(c => `${c.userId}:${c.kind}`), ['ann:user', 'ben:user', 'ann:ai']);
    assert.strictEqual(await store.recordVersion('missing', { html: '<p>x</p>' }), null);
});

test('a body save while the page has a co-editing document is refused in the same transaction; a rename still saves', async () => {
    // The co-editing store's table (stores/collabDocStore.js), as much of it as the guard reads.
    await pg.exec('CREATE TABLE IF NOT EXISTS collab_docs (id TEXT PRIMARY KEY, resource_kind TEXT NOT NULL, resource_id TEXT NOT NULL)');
    const page = await store.createDocument({ userId: 'ann', name: 'Seeding', docType: 'page', bodyHtml: '<p>v1</p>', settings: PLAIN });
    // A colleague opened it live after this save's route checked: the seed read '<p>v1</p>'.
    await pg.query("INSERT INTO collab_docs (id, resource_kind, resource_id) VALUES ('cd-page', 'document', $1)", [page.id]);
    await assert.rejects(
        store.updateDocument(page.id, 'ann', { bodyHtml: '<p>solo text</p>', expectedVersionId: page.versionId }),
        (e) => e.status === 409 && e.errorClass === 'document_live',
    );
    const kept = await store.getDocument(page.id, 'ann');
    assert.strictEqual(kept.bodyHtml, '<p>v1</p>', 'nothing written behind the live state');
    const renamed = await store.updateDocument(page.id, 'ann', { name: 'Renamed', expectedVersionId: page.versionId });
    assert.strictEqual(renamed.name, 'Renamed', 'only the body is the live state\'s');

    await pg.query("DELETE FROM collab_docs WHERE id = 'cd-page'");
    const saved = await store.updateDocument(page.id, 'ann', { bodyHtml: '<p>solo text</p>', expectedVersionId: renamed.versionId });
    assert.strictEqual(saved.bodyHtml, '<p>solo text</p>', 'folded back: single-writer saves go through again');
});

test('restoring a page that moved on live keeps the state it replaces as pre_restore', async () => {
    const page = await store.createDocument({ userId: 'ann', name: 'Live', docType: 'page', bodyHtml: '<p>v1</p>', settings: PLAIN });
    await store.writeCollabBody(page.id, { html: '<p>typed live, no checkpoint yet</p>' });
    const { current } = await store.restoreVersion(page.id, 'ann', page.versionId, {});
    assert.strictEqual(current.bodyHtml, '<p>v1</p>');
    const history = await rows(page.id);
    const pre = history.find(r => r.source === 'pre_restore');
    assert.ok(pre, 'the live state before the restore is a version');
    assert.strictEqual((await store.getDocumentVersion(page.id, 'ann', pre.id)).bodyHtml, '<p>typed live, no checkpoint yet</p>');
    assert.deepStrictEqual(history.slice(-2).map(r => r.source), ['pre_restore', 'restore']);
});

test('retention thins old versions by the policy handed in, and never touches what something points at', async () => {
    const { selectPrunable } = require('../core/versioning/retention');
    const doc = await make('ann');
    let versionId = doc.versionId;
    const ids = [];
    for (const n of [1, 2, 3, 4]) {
        versionId = (await store.updateDocument(doc.id, 'ann', { bodyHtml: `<p>${n}</p>`, expectedVersionId: versionId, source: 'ai' })).versionId;
        ids.push(versionId);
    }
    // All four in the same hour, three weeks ago: one per day survives, and the current one.
    await pg.query(`UPDATE studio_document_versions SET created_at = date_trunc('day', NOW()) - INTERVAL '21 days' + seq * INTERVAL '1 minute' WHERE document_id = $1`, [doc.id]);
    const pinnedByAutomation = ids[0];
    const removed = await store.pruneVersions(doc.id, { selectPrunable, referencedIds: [pinnedByAutomation] });
    assert.strictEqual(removed, 1, 'of the two free versions of that day, the newer one is kept');
    const left = (await rows(doc.id)).map(r => r.id);
    assert.ok(left.includes(doc.versionId), 'the first revision stays');
    assert.ok(left.includes(versionId), 'the current revision stays');
    assert.ok(left.includes(pinnedByAutomation), 'a revision an automation pins stays');
    assert.strictEqual(await store.pruneVersions(doc.id, {}), 0, 'no policy, nothing pruned');
});
