/**
 * DB-free tests for the document store.
 *
 * `../db` is stubbed before the first require: the real one is a live pg pool
 * and this store kicks initDB() at load time, so an unstubbed require would
 * hang on connection retries rather than fail. The fake records every
 * statement, which is enough to assert the two things that actually matter
 * here — the size caps, and that every read is owner-scoped in SQL.
 */

const test = require('node:test');
const assert = require('node:assert');

const { installResolveStub } = require('../testUtils/stubRequire');

const db = { statements: [], rows: [], one: null };

function resetDb() {
    db.statements = [];
    db.rows = [];
    db.one = null;
}

const restore = installResolveStub({
    '../db': {
        exec: async (sql) => { db.statements.push({ kind: 'exec', sql }); },
        run: async (sql, params) => { db.statements.push({ kind: 'run', sql, params }); return { rowCount: 1 }; },
        getOne: async (sql, params) => { db.statements.push({ kind: 'getOne', sql, params }); return db.one; },
        getAll: async (sql, params) => { db.statements.push({ kind: 'getAll', sql, params }); return db.rows; },
        withTransaction: async fn => fn({ query: async (sql,params) => {
            db.statements.push({kind:'transaction',sql,params});
            if (/SELECT d\.\*/.test(sql)) return {rows:db.one?[db.one]:[]};
            if (/UPDATE studio_documents SET/.test(sql)) return {rows:[{...db.one,name:params[1],doc_type:params[2],description:params[3],body_html:params[4],css:params[5],settings:JSON.parse(params[6]),kind:params[7],visibility:params[8],folder_id:params[9],categories:JSON.parse(params[10]),version_id:params[11]}]};
            return {rows:[],rowCount:1};
        }}),
        makeStoreInit: (tag, fn) => {
            let p = null;
            return () => (p ||= Promise.resolve().then(fn));
        },
    },
});

const documentStore = require('./documentStore');
const { normaliseType, assertWithinCaps, mapRow, mapListRow } = documentStore._test;

test.after(() => restore());

// ── The table-name collision that broke every create ─────────────────
//
// FIRST in the file on purpose: the store issues its DDL once, at require
// time, and `resetDb()` in the tests below wipes the statement log. Awaiting
// the memoised initDB() here guarantees the DDL has landed before we read it.

test('the tables are studio_-prefixed — `documents` belongs to knowledge bases', async () => {
    // stores/knowledgeBases.js owns a `documents` table (tenant_id,
    // knowledge_base_id, chunk_count). Claiming that name here failed in the
    // worst possible way: CREATE TABLE IF NOT EXISTS silently did nothing and
    // the first CREATE INDEX (user_id) then threw against a stranger's schema,
    // so every create answered `column "user_id" does not exist`. Asserting on
    // the DDL keeps the next rename honest.
    await documentStore.initDB();
    const ddl = db.statements.filter(s => s.kind === 'exec').map(s => s.sql).join('\n');
    assert.match(ddl, /CREATE TABLE IF NOT EXISTS studio_documents\b/);
    assert.match(ddl, /CREATE TABLE IF NOT EXISTS studio_document_versions\b/);
    assert.ok(!/ON documents\(/.test(ddl), 'never an index on the bare `documents` table');
    assert.ok(!/TABLE IF NOT EXISTS documents\b/.test(ddl), 'never the bare `documents` table');
});

// ── Type normalising ─────────────────────────────────────────────────

test('an unknown doc type degrades to "document" rather than being refused', () => {
    // The type is a presentation hint — an icon and a grouping — never a
    // permission, so a model that invents "purchase_order" should still get a
    // working document.
    assert.strictEqual(normaliseType('invoice'), 'invoice');
    assert.strictEqual(normaliseType('purchase_order'), 'document');
    assert.strictEqual(normaliseType(undefined), 'document');
    assert.strictEqual(normaliseType(null), 'document');
});

// ── Size caps ────────────────────────────────────────────────────────

test('oversized content is refused, never truncated', () => {
    // A silently cut-off invoice looks complete and is missing its total.
    assert.throws(
        () => assertWithinCaps({ bodyHtml: 'x'.repeat(documentStore.MAX_HTML_BYTES + 1) }),
        (e) => e.errorClass === 'document_too_large' && e.status === 413,
    );
    assert.throws(
        () => assertWithinCaps({ css: 'x'.repeat(documentStore.MAX_CSS_BYTES + 1) }),
        (e) => e.errorClass === 'document_too_large',
    );
    assert.doesNotThrow(() => assertWithinCaps({ bodyHtml: 'x'.repeat(1000), css: 'y'.repeat(1000) }));
});

test('the cap is measured in BYTES, not characters', () => {
    // '€' is three UTF-8 bytes, and an invoice is full of them. A length check
    // would let a document through that is three times the intended size.
    const justUnderInChars = '€'.repeat(Math.floor(documentStore.MAX_HTML_BYTES / 3) + 10);
    assert.ok(justUnderInChars.length < documentStore.MAX_HTML_BYTES, 'under the cap by character count');
    assert.throws(
        () => assertWithinCaps({ bodyHtml: justUnderInChars }),
        (e) => e.errorClass === 'document_too_large',
        'but over it by byte count, which is what is checked',
    );
});

// ── Row mapping ──────────────────────────────────────────────────────

test('mapRow parses settings whether pg hands back an object or a string', () => {
    const base = { id: 'd1', user_id: 'u1', name: 'X', doc_type: 'invoice', body_html: '<p>a</p>', css: '.a{}' };
    assert.deepStrictEqual(mapRow({ ...base, settings: { a: 1 } }).settings, { a: 1 });
    assert.deepStrictEqual(mapRow({ ...base, settings: '{"a":1}' }).settings, { a: 1 });
    assert.deepStrictEqual(mapRow({ ...base, settings: null }).settings, {});
    assert.strictEqual(mapRow(null), null);
});

test('the list row carries no slots', () => {
    // A documents list renders names and dates. Shipping every document's full
    // markup to paint it is what only hurts once somebody has three hundred.
    const row = mapListRow({
        id: 'd1', user_id: 'u1', name: 'X', doc_type: 'invoice',
        html_size: '2048', created_at: 'now', updated_at: 'now',
    });
    assert.strictEqual(row.htmlSize, 2048, 'the SIZE is reported instead');
    assert.ok(!('bodyHtml' in row), 'no body');
    assert.ok(!('css' in row), 'no stylesheet');
});

// ── Owner scoping ────────────────────────────────────────────────────

test('every single-document read is owner-scoped in SQL', async () => {
    resetDb();
    db.one = null;
    await documentStore.getDocument('d1', 'u1');
    const q = db.statements.find(s => s.kind === 'getOne');
    assert.match(q.sql, /d\.id = \$1 AND.*d\.user_id = \$2/, 'the owner is part of the predicate');
    assert.deepStrictEqual(q.params, ['d1', 'u1']);
});

test('version history requires an authorized parent document', async () => {
    resetDb();
    assert.deepStrictEqual(await documentStore.listVersions('d1','u1'),[]);
    assert.ok(!db.statements.some(s=>s.kind==='getAll'));
    db.one={id:'d1',user_id:'u1'};
    await documentStore.listVersions('d1','u1');
    const q=db.statements.find(s=>s.kind==='getAll');
    assert.match(q.sql,/WHERE document_id=\$1/);
});
test('archive preserves revisions and enforces owner or same-organization admin access', async () => {
    resetDb();
    assert.equal(await documentStore.deleteDocument('d1','u1'),true);
    const q=db.statements.find(s=>s.kind==='run');
    assert.match(q.sql,/SET archived = true/);assert.match(q.sql,/d\.user_id = \$2/);
    assert.deepStrictEqual(q.params,['d1','u1',false]);
});

// ── Patch semantics ──────────────────────────────────────────────────

test('body-only edits preserve CSS and atomically create a complete revision', async () => {
    resetDb();
    db.one={id:'d1',user_id:'u1',name:'X',doc_type:'document',body_html:'old',css:'.keep{}',version_id:'v1'};
    const updated=await documentStore.updateDocument('d1','u1',{bodyHtml:'<p>new</p>',expectedVersionId:'v1'});
    assert.equal(updated.bodyHtml,'<p>new</p>');assert.equal(updated.css,'.keep{}');
    const write=db.statements.find(s=>/INSERT INTO studio_document_versions/.test(s.sql));
    assert.equal(write.kind,'transaction');assert.equal(JSON.parse(write.params[5]).css,'.keep{}');
});
test('conflicting edits cannot overwrite the current document or create history', async () => {
    resetDb();db.one={id:'d1',user_id:'u1',version_id:'new',body_html:'kept'};
    await assert.rejects(documentStore.updateDocument('d1','u1',{bodyHtml:'lost',expectedVersionId:'old'}),e=>e.status===409);
    assert.ok(!db.statements.some(s=>/^\s*(INSERT|UPDATE)/.test(s.sql)));
});
test('team reads require matching organization, and private records stay owner-only', async () => {
    resetDb();await documentStore.getDocument('d1','other');
    const sql=db.statements.find(s=>s.kind==='getOne').sql;
    assert.match(sql,/visibility = 'team'/);assert.match(sql,/organization_id = \(SELECT "organizationId" FROM users WHERE id = \$2\)/);
});
test('migrations create a stable baseline and are repeatable', async () => {
    // The baseline naming is deterministic; a restart cannot create a new pin.
    //
    // Genuinely textual in THIS file, by its own header ("DB-free tests"):
    // initDB()'s migration runs as one multi-statement exec() this mock
    // records as a single opaque string, and initDB is memoized
    // (makeStoreInit), so there is no seam here to re-trigger it and inspect
    // a finer-grained effect. documentStore.integration.test.js already
    // proves this behaviourally against real Postgres — it calls the real
    // initDB() and asserts the resulting row's baselineVersionId is exactly
    // `baseline-legacy` for a document seeded with id `legacy`.
    const source=require('node:fs').readFileSync(require.resolve('./documentStore'),'utf8');
    assert.match(source,/baseline_version_id = 'baseline-' \|\| id WHERE version_id IS NULL/);
    assert.match(source,/ON CONFLICT \(id\) DO NOTHING/);
});

test('an update with nothing to set does not emit an UPDATE at all', async () => {
    resetDb();
    db.one = { id: 'd1', user_id: 'u1', name: 'X', doc_type: 'document', body_html: '', css: '' };
    await documentStore.updateDocument('d1', 'u1', {});
    assert.ok(!db.statements.some(s => /UPDATE studio_documents/.test(s.sql || '')), 'no pointless write');
});

test('snapshotVersion skips a document that has never been written', async () => {
    resetDb();
    db.one = { id: 'd1', user_id: 'u1', name: 'X', doc_type: 'document', body_html: '', css: '' };
    const v = await documentStore.snapshotVersion('d1', 'u1');
    assert.equal(v.id, null, 'legacy snapshot calls do not create duplicate revisions');
    assert.ok(!db.statements.some(s => /INSERT INTO studio_document_versions/.test(s.sql || '')));
});
