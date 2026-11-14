/**
 * O4 part A — the release history of a project.
 *
 * Two things must be exactly right here, and both are ordering questions:
 *
 *   1. THE ORDER OF PUBLISHING. "Publish v1.3" is the gallery row AND the release
 *      row. If the second fails, no Blueprint may remain behind that
 *      is in no history at all — and no release row may arise that points to a
 *      Blueprint that does not exist. That is possible only if they sit in the same
 *      transaction; these tests pin that they do, and that a failed release
 *      row rolls everything back.
 *   2. PRUNING TO TWENTY. It must never remove the row that an installation points to,
 *      and never the row that the gallery is serving at this moment. Both are reachable
 *      (see the header of `_pruneReleases`), so both are checked here — including that the DELETE
 *      receives exclusively the ids that the candidate query returned.
 *
 * On a real Postgres: the boot ladder's schema on PGlite
 * (testUtils/pgliteTemplate.js ladderPglite) behind the store's db facade
 * (testUtils/pgliteDb.js dbFacade), whose withTransaction is a real BEGIN /
 * COMMIT / ROLLBACK on that database. A failing release row and a gallery row
 * that vanishes mid-publication are triggers the test switches on.
 *
 * Run: cd server && node --test stores/blueprint/releases.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { pgliteDb, dbFacade } = require('../../testUtils/pgliteDb');
const { ladderPglite } = require('../../testUtils/pgliteTemplate');
const { withTransactionVia } = require('../../testUtils/txFake');
const { makeBlueprintStore, MAX_NOTES_BYTES, MAX_RELEASES_PER_PROJECT } = require('../blueprintStore');

const { pg, db } = pgliteDb(ladderPglite());
const store = makeBlueprintStore(dbFacade(db));

test.before(() => pg.exec(`
    CREATE TABLE test_faults (name TEXT PRIMARY KEY);
    CREATE FUNCTION test_fail_release() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
        IF EXISTS (SELECT 1 FROM test_faults WHERE name = 'release_insert') THEN
            RAISE EXCEPTION 'disk full';
        END IF;
        RETURN NEW;
    END $$;
    CREATE TRIGGER test_fail_release BEFORE INSERT ON project_releases FOR EACH ROW EXECUTE FUNCTION test_fail_release();
    -- A row deleted between the lookup and the UPDATE: the UPDATE touches nothing.
    CREATE FUNCTION test_vanish_blueprint() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
        IF EXISTS (SELECT 1 FROM test_faults WHERE name = 'blueprint_vanishes') THEN
            RETURN NULL;
        END IF;
        RETURN NEW;
    END $$;
    CREATE TRIGGER test_vanish_blueprint BEFORE UPDATE ON project_blueprints FOR EACH ROW EXECUTE FUNCTION test_vanish_blueprint();
`));
test.after(() => pg.close());

// ── Fixtures ────────────────────────────────────────────────────────────────

const manifest = (over = {}) => ({
    solution: { key: 'sol_p1', name: 'Orders', description: 'Orders solution', icon: null, version: 1, entities: {} },
    ...over,
});

const publishArgs = (over = {}) => ({
    organizationId: 'org1', createdBy: 'alice', sourceProjectId: 'p1', manifest: manifest(), ...over,
});

async function reset() {
    await pg.exec(`
        DELETE FROM test_faults;
        DELETE FROM project_solution_entities;
        DELETE FROM project_releases;
        DELETE FROM project_blueprints;
        DELETE FROM projects;
        INSERT INTO projects (id, name, owner_id, organization_id) VALUES ('p1', 'Orders', 'alice', 'org1'), ('p2', 'Other', 'bob', 'org2');
    `);
}
/** @param {string} name */
const fault = (name) => pg.query('INSERT INTO test_faults (name) VALUES ($1)', [name]);
const blueprints = async () => (await pg.query('SELECT id, version, manifest FROM project_blueprints ORDER BY id')).rows;
const releases = async (projectId = 'p1') => (await pg.query(
    'SELECT id, blueprint_id, version, manifest, notes, channel FROM project_releases WHERE project_id = $1 ORDER BY published_at, id', [projectId])).rows;

let relSeq = 0;
/**
 * A release row of the past, `daysAgo` old.
 * @param {Record<string, unknown>} over
 */
async function pastRelease(over) {
    relSeq += 1;
    const r = { id: `rel_${String(relSeq).padStart(4, '0')}`, project_id: 'p1', blueprint_id: 'bp_old', version: 1,
        manifest: '{}', published_by: 'alice', channel: 'gallery', daysAgo: 100, ...over };
    const daysAgo = r.daysAgo; delete r.daysAgo;
    const cols = Object.keys(r);
    await pg.query(`INSERT INTO project_releases (${cols.join(', ')}, published_at)
        VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}, NOW() - make_interval(days => $${cols.length + 1}))`,
    [...Object.values(r), daysAgo]);
    return r.id;
}

// ── 1. The order: one transaction, and which side wins ──────────────────────

test('publishing writes the Blueprint and the release row together', async () => {
    await reset();
    const out = await store.publishRelease(publishArgs());

    const [bp] = await blueprints();
    const [rel] = await releases();
    assert.strictEqual(bp.id, out.blueprint.id);
    assert.strictEqual(rel.blueprint_id, bp.id, 'the release row carries the blueprint_id of the gallery row');
    assert.strictEqual(out.blueprint.version, 1);
    assert.strictEqual(out.release.version, 1);
    assert.strictEqual(out.release.blueprintId, out.blueprint.id);
    assert.strictEqual(out.release.projectId, 'p1');
});

test('if the release row fails, NOTHING is published — no Blueprint either', async () => {
    await reset();
    await fault('release_insert');
    await assert.rejects(() => store.publishRelease(publishArgs()), /disk full/);
    assert.deepStrictEqual(await blueprints(), [], 'a Blueprint in no history at all is the forbidden state');
    assert.deepStrictEqual(await releases(), []);
});

test('a failed release row burns no version number', async () => {
    // The bump path: the gallery is at v2, so this publication would become v3.
    await reset();
    await store.publishRelease(publishArgs());
    await store.publishRelease(publishArgs());
    await fault('release_insert');
    await assert.rejects(() => store.publishRelease(publishArgs()));
    const [bp] = await blueprints();
    assert.strictEqual(bp.version, 2, '…the bump rolls back too, or the gallery serves a v3 nobody can find');
    assert.strictEqual(bp.manifest.solution.version, 2);
    assert.deepStrictEqual((await releases()).map(r => r.version), [1, 2]);
});

test('a gallery row that vanishes in between yields NO release row pointing nowhere', async () => {
    // The creator may delete their Blueprint while a colleague is publishing:
    // the lookup still finds it, the UPDATE touches zero rows. Without this guarantee
    // the history would record a blueprint_id that does not exist.
    await reset();
    await store.publishRelease(publishArgs());
    await fault('blueprint_vanishes');
    await assert.rejects(() => store.publishRelease(publishArgs()), /nothing was published/);
    assert.deepStrictEqual((await releases()).map(r => r.version), [1], 'no release row is written');
});

test('the release row carries the manifest as STORED, not as offered', async () => {
    await reset();
    await store.publishRelease(publishArgs());
    await store.publishRelease(publishArgs());
    const offered = manifest();           // carries version 1
    const out = await store.publishRelease(publishArgs({ manifest: offered }));

    const last = (await releases()).at(-1);
    assert.strictEqual(last.version, 3, 'the version number is the one after the bump');
    assert.strictEqual(last.manifest.solution.version, 3,
        'the stored manifest was rewritten to v3; the history records what was published');
    assert.strictEqual(offered.solution.version, 1, 'the caller\'s object is left alone');
    assert.strictEqual(out.release.version, 3);
});

test('the bump lookup locks the row it is about to raise, inside the publication\'s transaction', async () => {
    // Without FOR UPDATE, two simultaneous publications by the same creator both read v2 and
    // both write v3: two v3 rows in the history, and (blueprint_id, version) is no longer one
    // row, which both pruning guarantees rest on. One PGlite session cannot run that race, so
    // this pins the statement: the same store over a facade that records what it sends, and
    // where (`tx`: the transaction's client, `pool`: outside any transaction).
    await reset();
    /** @type {{ via: string, sql: string }[]} */
    const sent = [];
    /** @param {string} via */
    const recording = (via) => async (/** @type {string} */ sql, /** @type {unknown[]} */ params) => {
        sent.push({ via, sql: String(sql).replace(/\s+/g, ' ').trim() });
        return db.query(sql, params);
    };
    const recordingStore = makeBlueprintStore({
        ...dbFacade({ query: recording('pool') }),
        withTransaction: withTransactionVia(async () => ({ query: recording('tx'), release() {} })),
    });
    await recordingStore.publishRelease(publishArgs());
    sent.length = 0;
    const out = await recordingStore.publishRelease(publishArgs());
    assert.strictEqual(out.blueprint.version, 2, 'the bump path ran');

    const at = (/** @type {(sql: string) => boolean} */ match) => sent.findIndex(s => match(s.sql));
    const begin = at(s => s === 'BEGIN');
    const lookup = at(s => s.startsWith('SELECT id, version FROM project_blueprints'));
    const bump = at(s => s.startsWith('UPDATE project_blueprints'));
    const commit = at(s => s === 'COMMIT');
    assert.ok(begin >= 0 && lookup > begin && bump > lookup && commit > bump, `order: ${JSON.stringify(sent.map(s => s.sql.slice(0, 50)))}`);
    assert.strictEqual(sent[lookup].via, 'tx', 'the lookup runs on the transaction client, so its lock holds until the COMMIT');
    assert.ok(sent[lookup].sql.endsWith('FOR UPDATE'), `the lookup locks its row: ${sent[lookup].sql}`);
});

test('publishing without a project is refused BEFORE any write', async () => {
    await reset();
    await assert.rejects(
        () => store.publishRelease(publishArgs({ sourceProjectId: null })),
        /sourceProjectId is required/,
    );
    assert.deepStrictEqual(await blueprints(), [], 'so no Blueprint was saved either');
});

test('a note over the cap is refused before the transaction, and says what to do about it', async () => {
    await reset();
    const huge = { summary: 'x'.repeat(MAX_NOTES_BYTES + 1) };
    await assert.rejects(
        () => store.publishRelease(publishArgs({ notes: huge })),
        (err) => /over the .* limit/.test(err.message) && /Shorten/.test(err.message),
    );
    assert.deepStrictEqual(await blueprints(), [], 'no half publication over a note');
});

test('a note is an object; anything else is a refusal, not a silent {}', async () => {
    await reset();
    await assert.rejects(() => store.publishRelease(publishArgs({ notes: 'done' })), /must be an object/);
    await assert.rejects(() => store.publishRelease(publishArgs({ notes: ['a'] })), /must be an object/);
    // No note IS valid and lands as {}.
    await store.publishRelease(publishArgs({ notes: null }));
    assert.deepStrictEqual((await releases())[0].notes, {});
});

// ── 2. Pruning to twenty ────────────────────────────────────────────────────

/**
 * p1's history: bp_old (bob's, served at v2) published v1..v24, oldest first,
 * plus rows that are not p1's gallery history. Then alice publishes once more:
 * 25 gallery rows, so the five oldest are candidates.
 */
async function longHistory() {
    await reset();
    await pg.exec(`
        INSERT INTO project_blueprints (id, organization_id, created_by, solution_key, name, version, manifest)
            VALUES ('bp_old', 'org1', 'bob', 'sol_old', 'Old', 2, '{}');
        INSERT INTO projects (id, name, owner_id, organization_id, installed_from_blueprint_id) VALUES
            ('p_inst', 'Installed here', 'carol', 'org1', 'bp_old'),
            ('p_far', 'Installed elsewhere', 'dave', 'org2', 'bp_old');
        INSERT INTO project_solution_entities (project_id, ref, kind, entity_id, install_hash, installed_version) VALUES
            ('p_inst', 'r1', 'automation', 'a1', 'h', 3),
            ('p_far', 'r1', 'automation', 'a1', 'h', 4);
    `);
    for (let v = 1; v <= 24; v++) await pastRelease({ version: v, daysAgo: 100 - v });
    for (let i = 0; i < 3; i++) await pastRelease({ project_id: 'p2', version: i + 1, daysAgo: 200 });
    await pastRelease({ blueprint_id: null, channel: 'pipeline', version: 1, daysAgo: 300 });
    return store.publishRelease(publishArgs());
}

test('pruning keeps the newest twenty of this project\'s gallery history, and the rows something points at', async () => {
    const out = await longHistory();
    assert.strictEqual(MAX_RELEASES_PER_PROJECT, 20);
    const kept = (await releases()).filter(r => r.channel === 'gallery');
    const oldVersions = kept.filter(r => r.blueprint_id === 'bp_old').map(r => r.version);
    // Held rows sit outside the twenty: v2 is what the gallery serves for
    // bp_old, v3 is what an installation in the source's organisation runs,
    // and the new release is what the gallery serves for the new Blueprint.
    // Of the other 22, the twenty newest stay: v1 and v4 go.
    assert.deepStrictEqual(oldVersions, [2, 3, ...Array.from({ length: 20 }, (_, i) => i + 5)]);
    assert.ok(kept.some(r => r.blueprint_id === out.blueprint.id), 'the new release stays');
});

test('only installations in the organisation of the SOURCE hold a row', async () => {
    // The narrowing, and why it exists. With a file installation both the claimed
    // Blueprint id and installed_version come from a file that
    // the installer edits himself. Without the org comparison someone could, with
    // one forwarded file, switch off the cap of a DIFFERENT project by
    // making installations that claim versions 21..300 — and those rows are not even
    // readable for him (listReleases/getRelease sit behind the
    // owner role on the source project, canRead is org-scoped).
    await longHistory();
    const versions = (await releases()).filter(r => r.blueprint_id === 'bp_old').map(r => r.version);
    assert.ok(!versions.includes(4), 'p_far (org2) claims v4 and does not hold it');
    assert.ok(versions.includes(3), 'p_inst (org1) holds v3');
});

test('an org-less source holds the rows of its org-less installations', async () => {
    // projects.organization_id is TEXT DEFAULT '' and may be NULL: a bare = never matches org-less rows.
    await longHistory();
    await pg.exec(`
        UPDATE projects SET organization_id = NULL WHERE id = 'p1';
        UPDATE projects SET organization_id = '' WHERE id = 'p_far';
        UPDATE project_blueprints SET version = 99 WHERE id = 'bp_old';
    `);
    for (let v = 1; v <= 3; v++) await pastRelease({ version: 100 + v, daysAgo: 500 });
    await pastRelease({ version: 4, daysAgo: 500 });   // the row p_far (now org-less) claims
    await store.publishRelease(publishArgs({ organizationId: null }));
    const versions = (await releases()).filter(r => r.blueprint_id === 'bp_old').map(r => r.version);
    assert.ok(versions.includes(4), 'NULL and \'\' are the same "no organisation"');
    assert.ok(!versions.some(v => v > 100), 'the unheld old rows go');
});

test('the prune touches only THIS project\'s gallery rows', async () => {
    // The DELETE is the only destructive statement of a publication. If the
    // project scope or the channel dropped away, every publication would prune
    // the history of EVERY project on the instance, across organisation
    // boundaries, and the releases a UAT or PRD stage runs on.
    await longHistory();
    assert.strictEqual((await releases('p2')).length, 3, 'another project keeps its history');
    assert.strictEqual((await releases()).filter(r => r.channel === 'pipeline').length, 1, 'a pipeline row is not pruned by a gallery publish');
});

test('nothing to prune deletes nothing', async () => {
    await reset();
    for (let v = 1; v <= 5; v++) await pastRelease({ version: v });
    await store.publishRelease(publishArgs());
    assert.strictEqual((await releases()).length, 6);
});

test('the prune rolls back with a failed publication', async () => {
    await longHistory();
    const before = (await releases()).length;
    await pastRelease({ version: 50, daysAgo: 1 });
    await fault('release_insert');
    await assert.rejects(() => store.publishRelease(publishArgs()));
    assert.strictEqual((await releases()).length, before + 1);
});

// ── 3. What comes out of the store ──────────────────────────────────────────

test('listReleases builds an ALLOW-LIST, not a passed-through row', async () => {
    await reset();
    await pastRelease({ id: 'rel_1', version: 3, notes: JSON.stringify({ summary: 'Two more automations' }), manifest: JSON.stringify({ solution: { key: 'sol_p1' } }) });
    await pg.exec('ALTER TABLE project_releases ADD COLUMN internal_note_next_year TEXT DEFAULT \'secret\'');
    try {
        const [row] = await store.listReleases('p1');
        assert.deepStrictEqual(Object.keys(row).sort(),
            ['blueprintId', 'id', 'notes', 'projectId', 'publishedAt', 'publishedBy', 'version']);
        assert.deepStrictEqual(row.notes, { summary: 'Two more automations' });
        assert.strictEqual(row.manifest, undefined, 'a list of twenty releases is not twenty manifests');
    } finally {
        await pg.exec('ALTER TABLE project_releases DROP COLUMN internal_note_next_year');
    }
});

test('listReleases reads ONLY the rows of the given project, and one channel', async () => {
    // This WHERE IS the scoping — the header of listReleases itself says that it
    // authorises nothing. If it drops away, then GET /:id/package/releases gives every
    // project owner the twenty newest release rows of the WHOLE instance,
    // including the notes of projects from other organisations.
    await reset();
    await pastRelease({ id: 'rel_mine', version: 1 });
    await pastRelease({ id: 'rel_theirs', project_id: 'p2', version: 1 });
    await pastRelease({ id: 'rel_pipe', blueprint_id: null, channel: 'pipeline', version: 1 });
    assert.deepStrictEqual((await store.listReleases('p1')).map(r => r.id), ['rel_mine'], 'the gallery channel by default');
    assert.deepStrictEqual((await store.listReleases('p1', { channel: 'pipeline' })).map(r => r.id), ['rel_pipe']);
    await assert.rejects(() => store.listReleases('p1', { channel: /** @type {any} */ ('nope') }), /Unknown release channel/);
});

test('listReleases is newest first, and capped', async () => {
    await reset();
    for (let v = 1; v <= 25; v++) await pastRelease({ version: v, daysAgo: 100 - v });
    const all = await store.listReleases('p1', { limit: 999 });
    assert.strictEqual(all.length, MAX_RELEASES_PER_PROJECT, 'the cap is the cap');
    assert.deepStrictEqual(all.slice(0, 3).map(r => r.version), [25, 24, 23]);
    assert.strictEqual((await store.listReleases('p1', { limit: 0 })).length, MAX_RELEASES_PER_PROJECT);
    assert.strictEqual((await store.listReleases('p1', { limit: 2 })).length, 2);
});

test('listReleases without a project asks the database nothing', async () => {
    await reset();
    assert.deepStrictEqual(await store.listReleases(null), []);
    assert.deepStrictEqual(await store.listReleases(''), []);
});

test('getRelease ALWAYS scopes on the project, never on the id alone', async () => {
    await reset();
    await pastRelease({ id: 'rel_1', version: 3, manifest: JSON.stringify({ solution: { key: 'sol_p1', version: 3 } }) });
    const rel = await store.getRelease('p1', 'rel_1');
    // This is the ONE place where the manifest does travel along: one release, explicitly requested.
    assert.strictEqual(rel.manifest.solution.version, 3);
    assert.strictEqual(await store.getRelease('p2', 'rel_1'), null, 'another project\'s id reads nothing');
});

test('getRelease without a project or without an id is null', async () => {
    await reset();
    await pastRelease({ id: 'rel_1' });
    assert.strictEqual(await store.getRelease(null, 'rel_1'), null);
    assert.strictEqual(await store.getRelease('p1', null), null);
});

// ── 4. De grens die twee bestanden delen ────────────────────────────────────

test('de enveloppegrens van releaseNotes.js is dezelfde als MAX_NOTES_BYTES', async () => {
    // `releaseNotesPayload` shrinks to ITS OWN boundary, and that was copied by hand
    // because the store opens a pool on require. If
    // MAX_NOTES_BYTES ever drops below that copy, then `normalizeNotes` throws before the
    // transaction and a PUBLICATION is refused on account of a note — exactly
    // what releaseNotes.js promises can never happen. This test is the link that
    // fits in neither of the two files.
    const notes = require('../../projects/packaging/releaseNotes');
    assert.strictEqual(notes.MAX_NOTES_ENVELOPE_BYTES, MAX_NOTES_BYTES);

    // En de envelop die hij bij die grens teruggeeft, past er ook echt in.
    const rows = Array.from({ length: 400 }, (_, i) => ({
        kind: 'automation', entityId: `a${i}`, name: 'R'.repeat(100), change: 'changed', text: 'T'.repeat(150),
    }));
    const payload = notes.releaseNotesPayload(rows);
    assert.ok(Buffer.byteLength(JSON.stringify(payload), 'utf8') <= MAX_NOTES_BYTES);
});

// ── 5. De ladder ────────────────────────────────────────────────────────────

test('project_releases komt uit de runDdl-ladder, niet uit de stille exec', async () => {
    // Genuinely textual, for the same reason as the COLUMN_LADDERS claims in
    // boot/bootMigrations.test.js: the difference between runDdl() and the old
    // silent exec() is per-statement error visibility, not a different
    // result in a live database — that can only be verified by actually letting
    // the DDL fail, not by something a unit test can observe here.
    // The COLUMN_LADDERS claim checks the same thing from the other side; this is
    // the claim of the store itself. Own name (not `src`) so as not to create an accidental
    // word match with the SQL alias `src` in the tests above.
    const ddlSrc = fs.readFileSync(path.join(__dirname, 'schema.js'), 'utf8');
    const ladder = ddlSrc.slice(ddlSrc.indexOf("runDdl('blueprintStore'"));
    assert.ok(ddlSrc.includes("runDdl('blueprintStore'"), 'de ladder bestaat');
    // Op de tabelnaam ZELF: `project_releases_iets_anders` bevat de substring en
    // zou anders als bewijs gelden. Zelfde reden als de woordgrens in de matcher
    // van COLUMN_LADDERS.
    assert.match(ladder.slice(0, 1200), /CREATE TABLE IF NOT EXISTS project_releases\s*\(/);

    const execBlock = ddlSrc.slice(ddlSrc.indexOf('await exec(`'), ddlSrc.indexOf("runDdl('blueprintStore'"));
    assert.ok(!/project_releases/.test(execBlock), 'en niet in de exec ernaast');
});
