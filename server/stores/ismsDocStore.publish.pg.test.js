/**
 * ismsDocStore.publish against a real Postgres (PGlite behind the real db.js):
 * the draft is frozen as version+1 with a sha256 over the body, an empty draft
 * is refused, and the version row and the document's pointer commit together:
 * when the pointer update fails, no version row is left behind.
 *
 * Run: cd server && node --test stores/ismsDocStore.publish.pg.test.js
 */

'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { usePglitePool } = require('../testUtils/pglitePool');

const { pg, close } = usePglitePool();
const store = require('./ismsDocStore');

before(async () => {
    await store.initDB();
    await pg.exec(`
        CREATE FUNCTION refuse_publish() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
            RAISE EXCEPTION 'pointer update refused';
        END $$;
        CREATE TRIGGER refuse_publish BEFORE UPDATE ON isms_documents
            FOR EACH ROW WHEN (NEW.slug = 'refused') EXECUTE FUNCTION refuse_publish();
    `);
});
after(close);

async function seedDoc(slug, body, currentVersion = 0) {
    await pg.query(
        `INSERT INTO isms_documents (organization_id, slug, title, draft_body, current_version) VALUES ('o', $1, $1, $2, $3)`,
        [slug, body, currentVersion],
    );
}
const versionsOf = async (slug) => (await pg.query(
    `SELECT version, sha256 FROM isms_document_versions WHERE organization_id = 'o' AND slug = $1 ORDER BY version`, [slug],
)).rows;

test('publish freezes the draft as version+1 with a sha256 over the body', async () => {
    const body = '# Access Control Policy\nrules here';
    await seedDoc('access-control', body, 2);
    const doc = await store.publish('o', 'access-control', 'actor');
    const expectedHash = crypto.createHash('sha256').update(body, 'utf8').digest('hex');
    assert.deepStrictEqual(await versionsOf('access-control'), [{ version: 3, sha256: expectedHash }]);
    assert.strictEqual(doc.published_hash, expectedHash);
    assert.strictEqual(doc.current_version, 3);
    assert.strictEqual(doc.status, 'published');
    assert.strictEqual(doc.published.version, 3);
});

test('publish refuses an empty draft and writes nothing', async () => {
    await seedDoc('empty', '   ');
    await assert.rejects(() => store.publish('o', 'empty', 'a'), /empty/);
    assert.deepStrictEqual(await versionsOf('empty'), []);
});

test('publish of a missing document answers null', async () => {
    assert.strictEqual(await store.publish('o', 'nope', 'a'), null);
});

test('a failing pointer update leaves no version row behind', async () => {
    await seedDoc('refused', 'body');
    await assert.rejects(() => store.publish('o', 'refused', 'a'), /pointer update refused/);
    assert.deepStrictEqual(await versionsOf('refused'), []);
    const doc = (await pg.query(`SELECT current_version, status FROM isms_documents WHERE slug = 'refused'`)).rows[0];
    assert.deepStrictEqual(doc, { current_version: 0, status: 'draft' });
});
