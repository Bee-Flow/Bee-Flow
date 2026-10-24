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
 * Hermetic: `../db` is stubbed (the pattern of guardrailEventStore.test.js),
 * so no Postgres is involved. The SQL is therefore checked on SHAPE —
 * the same choice that blueprint/mappers.test.js makes for `canRead` — plus on
 * behaviour where that is possible: which calls land on the transaction client,
 * in which order, with which parameters, and what comes back.
 *
 * Run: cd server && node --test stores/blueprint/releases.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('module');

// ── De db-stub ──────────────────────────────────────────────────────────────

const calls = { exec: [], run: [], getOne: [], getAll: [], client: [], tx: [] };

// Wat de stub antwoordt; per test bijgesteld.
const state = {
    existingBlueprint: null,   // rij voor de bump-lookup, of null (nieuw pad)
    blueprintCount: 0,         // voor het plafond van 100
    pruneCandidates: [],       // id's die de kandidatenquery teruggeeft
    releaseInsertThrows: null, // Error om de INSERT op project_releases te laten falen
    blueprintWriteEmpty: false, // de UPDATE/INSERT op project_blueprints raakt nul rijen
    poolRows: [],              // rijen voor getAll (listReleases)
    poolRow: null,             // rij voor getOne (getRelease)
};

const flat = (s) => String(s).replace(/\s+/g, ' ').trim();

function answer(sql, params = []) {
    const s = flat(sql);
    if (/^SELECT id, version FROM project_blueprints/.test(s)) {
        return { rows: state.existingBlueprint ? [state.existingBlueprint] : [], rowCount: 0 };
    }
    if (/SELECT COUNT\(\*\)::int AS n FROM project_blueprints/.test(s)) {
        return { rows: [{ n: state.blueprintCount }], rowCount: 1 };
    }
    if (/^UPDATE project_blueprints/.test(s)) {
        if (state.blueprintWriteEmpty) return { rows: [], rowCount: 0 };
        return { rows: [{
            id: params[5], solution_key: 'sol_p1', version: params[1], name: params[2],
            description: params[3], icon: params[4], created_by: 'alice',
            source_project_id: 'p1', organization_id: 'org1',
            manifest: JSON.parse(params[0]), created_at: 't0', updated_at: 't1',
        }], rowCount: 1 };
    }
    if (/^INSERT INTO project_blueprints/.test(s)) {
        return { rows: [{
            id: params[0], organization_id: params[1], created_by: params[2],
            source_project_id: params[3], solution_key: params[4], name: params[5],
            description: params[6], icon: params[7], version: params[8],
            manifest: JSON.parse(params[9]), created_at: 't0', updated_at: 't0',
        }], rowCount: 1 };
    }
    if (/^INSERT INTO project_releases/.test(s)) {
        if (state.releaseInsertThrows) throw state.releaseInsertThrows;
        return { rows: [{
            id: params[0], project_id: params[1], blueprint_id: params[2], version: params[3],
            notes: JSON.parse(params[5]), published_at: '2026-09-08T10:00:00.000Z',
            published_by: params[6],
        }], rowCount: 1 };
    }
    if (/^SELECT id FROM project_releases/.test(s)) {
        return { rows: state.pruneCandidates.map(id => ({ id })), rowCount: state.pruneCandidates.length };
    }
    if (/^DELETE FROM project_releases/.test(s)) {
        return { rows: [], rowCount: (params[0] || []).length };
    }
    return { rows: [], rowCount: 0 };
}

const dbStub = {
    async exec(sql) { calls.exec.push(sql); return { rowCount: 0 }; },
    async run(sql, params) { calls.run.push({ sql, params }); return answer(sql, params); },
    async getOne(sql, params) { calls.getOne.push({ sql, params }); return state.poolRow; },
    async getAll(sql, params) { calls.getAll.push({ sql, params }); return state.poolRows; },
    isSqlStateError(err) { return typeof err?.code === 'string' && /^[0-9A-Z]{5}$/.test(err.code); },
    // The contract that the store sees: fn receives a client, COMMIT on success,
    // ROLLBACK on a throw. The real BEGIN/COMMIT live in db.js.
    async withTransaction(fn) {
        calls.tx.push('BEGIN');
        const client = {
            async query(sql, params) { calls.client.push({ sql, params }); return answer(sql, params); },
        };
        try {
            const out = await fn(client);
            calls.tx.push('COMMIT');
            return out;
        } catch (err) {
            calls.tx.push('ROLLBACK');
            throw err;
        }
    },
};

const STORES_DIR = path.sep + 'stores' + path.sep;
const STUB_PATH = path.join(__dirname, '__stub_db_releases__.js');
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && parent.filename && parent.filename.includes(STORES_DIR) && request === '../db') {
        return STUB_PATH;
    }
    return origResolve.call(this, request, parent, ...rest);
};
require.cache[STUB_PATH] = { id: STUB_PATH, filename: STUB_PATH, loaded: true, exports: dbStub };

const store = require('../blueprintStore');

// ── Fixtures ────────────────────────────────────────────────────────────────

const manifest = (over = {}) => ({
    solution: { key: 'sol_p1', name: 'Orders', description: 'Orders solution', icon: null, version: 1, entities: {} },
    ...over,
});

const publishArgs = (over = {}) => ({
    organizationId: 'org1', createdBy: 'alice', sourceProjectId: 'p1', manifest: manifest(), ...over,
});

/** Warmt de init op (die draait zelf DDL) en wist daarna de recorders. */
async function reset() {
    await store.initDB();
    for (const k of Object.keys(calls)) calls[k].length = 0;
    state.existingBlueprint = null;
    state.blueprintCount = 0;
    state.pruneCandidates = [];
    state.releaseInsertThrows = null;
    state.blueprintWriteEmpty = false;
    state.poolRows = [];
    state.poolRow = null;
}

const clientSql = () => calls.client.map(c => flat(c.sql));
const indexOfCall = (re) => clientSql().findIndex(s => re.test(s));
const callMatching = (re) => calls.client.find(c => re.test(flat(c.sql)));

// ── 1. De volgorde: één transactie, en welke kant wint ──────────────────────

test('publiceren schrijft de Blueprint en de release-rij in ÉÉN transactie, in die volgorde', async () => {
    await reset();
    const out = await store.publishRelease(publishArgs());

    assert.deepStrictEqual(calls.tx, ['BEGIN', 'COMMIT'], 'één transactie, en die commit');

    const blueprintAt = indexOfCall(/^INSERT INTO project_blueprints/);
    const releaseAt = indexOfCall(/^INSERT INTO project_releases/);
    assert.ok(blueprintAt >= 0, 'de galerijrij wordt op de transactieclient geschreven');
    assert.ok(releaseAt >= 0, 'de release-rij wordt op de transactieclient geschreven');
    assert.ok(blueprintAt < releaseAt,
        'de release-rij draagt het blueprint_id, dus de galerijrij moet eerst geschreven zijn');

    // And none of this may have gone through the pool: a write
    // outside the transaction is exactly the half-finished publication that is forbidden here.
    const poolWrites = [...calls.run, ...calls.getOne]
        .map(c => flat(c.sql))
        .filter(s => /project_blueprints|project_releases/.test(s));
    assert.deepStrictEqual(poolWrites, [], 'geen enkele schrijfactie buiten de transactie');

    assert.strictEqual(out.blueprint.version, 1);
    assert.strictEqual(out.release.version, 1);
    assert.strictEqual(out.release.blueprintId, out.blueprint.id);
    assert.strictEqual(out.release.projectId, 'p1');
});

test('faalt de release-rij, dan is er NIETS gepubliceerd — ook geen Blueprint', async () => {
    await reset();
    state.releaseInsertThrows = Object.assign(new Error('disk full'), { code: '53100' });

    await assert.rejects(() => store.publishRelease(publishArgs()), /disk full/);

    assert.ok(calls.tx.includes('ROLLBACK'), 'de transactie draait terug');
    assert.ok(!calls.tx.includes('COMMIT'),
        'niets committen: een Blueprint die in geen geschiedenis staat is de W2-toestand');
});

test('een mislukte release-rij verbrandt geen versienummer', async () => {
    // The bump path: the gallery is at v2, so this publication would become v3.
    await reset();
    state.existingBlueprint = { id: 'bp_1', version: 2 };
    state.releaseInsertThrows = new Error('nope');

    await assert.rejects(() => store.publishRelease(publishArgs()));

    const update = callMatching(/^UPDATE project_blueprints/);
    assert.ok(update, 'de bump draait binnen de transactie');
    assert.strictEqual(update.params[1], 3, 'de bump zou v3 schrijven');
    assert.ok(calls.tx.includes('ROLLBACK'),
        '…en draait mee terug, anders serveert de galerij een v3 die niemand kan terugvinden');
});

test('een galerijrij die tussendoor verdwijnt levert GEEN release-rij op die nergens naar wijst', async () => {
    // The creator may delete their Blueprint while a colleague is publishing:
    // the lookup still finds it, the UPDATE touches zero rows. Without this guarantee
    // the history would record a blueprint_id that does not exist.
    await reset();
    state.existingBlueprint = { id: 'bp_1', version: 2 };
    state.blueprintWriteEmpty = true;

    await assert.rejects(() => store.publishRelease(publishArgs()), /nothing was published/);

    assert.strictEqual(callMatching(/^INSERT INTO project_releases/), undefined,
        'er wordt geen release-rij geschreven');
    assert.ok(calls.tx.includes('ROLLBACK'));
    assert.ok(!calls.tx.includes('COMMIT'));
});

test('de release-rij draagt het manifest zoals OPGESLAGEN, niet zoals aangeboden', async () => {
    await reset();
    state.existingBlueprint = { id: 'bp_1', version: 2 };
    const offered = manifest();           // draagt version 1
    const out = await store.publishRelease(publishArgs({ manifest: offered }));

    const insert = callMatching(/^INSERT INTO project_releases/);
    assert.strictEqual(insert.params[3], 3, 'het versienummer is dat van ná de bump');
    assert.strictEqual(JSON.parse(insert.params[4]).solution.version, 3,
        'het opgeslagen manifest is herschreven naar v3; de geschiedenis legt vast wat er is gepubliceerd');
    assert.strictEqual(offered.solution.version, 1, 'het object van de aanroeper blijft ongemoeid');
    assert.strictEqual(out.release.version, 3);
});

test('publiceren zonder project wordt geweigerd VÓÓR elke schrijfactie', async () => {
    await reset();
    await assert.rejects(
        () => store.publishRelease(publishArgs({ sourceProjectId: null })),
        /sourceProjectId is required/,
    );
    assert.deepStrictEqual(calls.tx, [], 'er is geen transactie geopend');
    assert.deepStrictEqual(calls.client, [], 'en dus ook geen Blueprint opgeslagen');
});

test('een notitie boven het plafond weigert vóór de transactie, en zegt wat eraan te doen is', async () => {
    await reset();
    const huge = { summary: 'x'.repeat(store.MAX_NOTES_BYTES + 1) };
    await assert.rejects(
        () => store.publishRelease(publishArgs({ notes: huge })),
        (err) => /over the .* limit/.test(err.message) && /Shorten/.test(err.message),
    );
    assert.deepStrictEqual(calls.tx, [], 'geen halve publicatie om een notitie');
});

test('een notitie is een object; alles anders is een weigering, geen stille {}', async () => {
    await reset();
    await assert.rejects(() => store.publishRelease(publishArgs({ notes: 'klaar' })), /must be an object/);
    await assert.rejects(() => store.publishRelease(publishArgs({ notes: ['a'] })), /must be an object/);
    // Geen notitie is wél geldig en landt als {}.
    await reset();
    await store.publishRelease(publishArgs({ notes: null }));
    const insert = callMatching(/^INSERT INTO project_releases/);
    assert.strictEqual(insert.params[5], '{}');
});

// ── 2. Het snoeien tot twintig ──────────────────────────────────────────────

test('het snoeien houdt de laatste twintig aan, met een stabiele sortering', async () => {
    await reset();
    await store.publishRelease(publishArgs());

    const prune = callMatching(/^SELECT id FROM project_releases/);
    assert.ok(prune, 'er wordt gesnoeid');
    assert.strictEqual(prune.params[0], 'p1', 'per project');
    assert.strictEqual(prune.params[1], store.MAX_RELEASES_PER_PROJECT);
    assert.strictEqual(store.MAX_RELEASES_PER_PROJECT, 20);
    assert.match(flat(prune.sql), /ORDER BY r\.published_at DESC, r\.id\s+OFFSET \$2/,
        'published_at is transactietijd: zonder `, id` kan OFFSET een willekeurige rij laten vallen');
});

test('het snoeien laat de rij staan waar een INSTALLATIE naar wijst', async () => {
    await reset();
    await store.publishRelease(publishArgs());
    const sql = flat(callMatching(/^SELECT id FROM project_releases/).sql);

    // An installation points with installed_from_blueprint_id to the Blueprint and
    // with installed_version to the number; together those are precisely one row.
    assert.match(sql, /NOT EXISTS \( SELECT 1 FROM projects p JOIN project_solution_entities e ON e\.project_id = p\.id JOIN projects src ON src\.id = r\.project_id WHERE p\.installed_from_blueprint_id = r\.blueprint_id AND e\.installed_version = r\.version AND COALESCE\(p\.organization_id, ''\) = COALESCE\(src\.organization_id, ''\)\)/);
});

test('alleen installaties in de organisatie van de BRON houden een rij vast', async () => {
    // The narrowing, and why it exists. With a file installation both the claimed
    // Blueprint id and installed_version come from a file that
    // the installer edits himself. Without the org comparison someone could, with
    // one forwarded file, switch off the cap of a DIFFERENT project by
    // making installations that claim versions 21..300 — and those rows are not even
    // readable for him (listReleases/getRelease sit behind the
    // owner role on the source project, canRead is org-scoped).
    await reset();
    await store.publishRelease(publishArgs());
    const sql = flat(callMatching(/^SELECT id FROM project_releases/).sql);

    assert.match(sql, /JOIN projects src ON src\.id = r\.project_id/,
        'de organisatie van de bron komt uit het project dat publiceert');
    assert.match(sql, /COALESCE\(p\.organization_id, ''\) = COALESCE\(src\.organization_id, ''\)/,
        "projects.organization_id is TEXT DEFAULT '' en mag NULL zijn: een kale = matcht org-loze rijen nooit");
});

test('de kandidatenquery kijkt alleen naar de release-rijen van DIT project', async () => {
    // The DELETE below is the only destructive statement of a
    // publication. If this WHERE drops away — or becomes `(r.project_id = $1 OR
    // TRUE)` — then every publication prunes the history of EVERY project on the
    // instance, across organisation boundaries. Checking only the parameter is
    // not enough: that can be right while the query does not use it.
    await reset();
    await store.publishRelease(publishArgs());
    const sql = flat(callMatching(/^SELECT id FROM project_releases/).sql);
    assert.match(sql, /^SELECT id FROM project_releases r WHERE r\.project_id = \$1 AND NOT EXISTS/,
        'de scoping staat vooraan en is de eerste voorwaarde, niet een losse parameter');
    assert.ok(!/OR\s+TRUE/i.test(sql), 'geen verbreding naast de scoping');
});

test('de bump-lookup vergrendelt de rij die hij gaat ophogen', async () => {
    // Without FOR UPDATE, two simultaneous publications by the same creator both read
    // v2 and both write v3. Then the history carries TWO v3 rows, one of which records a version that
    // was never installable — and the invariant on which both pruning guarantees rest
    // ((blueprint_id, version) is exactly one row) is gone.
    await reset();
    state.existingBlueprint = { id: 'bp_1', version: 2 };
    await store.publishRelease(publishArgs());
    const lookup = callMatching(/^SELECT id, version FROM project_blueprints/);
    assert.ok(lookup, 'de lookup draait op de transactieclient');
    assert.match(flat(lookup.sql), /FOR UPDATE$/,
        'de vergrendeling houdt tot de COMMIT, dus de tweede publicatie telt door vanaf het nieuwe nummer');
});

test('het snoeien laat de versie staan die de galerij NU serveert', async () => {
    await reset();
    await store.publishRelease(publishArgs());
    const sql = flat(callMatching(/^SELECT id FROM project_releases/).sql);
    assert.match(sql, /NOT EXISTS \( SELECT 1 FROM project_blueprints b WHERE b\.id = r\.blueprint_id AND b\.version = r\.version\)/);
});

test('de DELETE krijgt uitsluitend de id\'s die de kandidatenquery teruggaf', async () => {
    await reset();
    state.pruneCandidates = ['rel_old1', 'rel_old2'];
    await store.publishRelease(publishArgs());

    const del = callMatching(/^DELETE FROM project_releases/);
    assert.ok(del, 'de kandidaten worden verwijderd');
    assert.match(flat(del.sql), /WHERE id = ANY\(\$1::text\[\]\)$/,
        'geen eigen predicaat — dat zou de drie waarborgen van de kandidatenquery omzeilen');
    assert.deepStrictEqual(del.params[0], ['rel_old1', 'rel_old2']);
});

test('niets te snoeien is geen DELETE', async () => {
    await reset();
    state.pruneCandidates = [];
    await store.publishRelease(publishArgs());
    assert.strictEqual(callMatching(/^DELETE FROM project_releases/), undefined);
});

test('het snoeien draait binnen dezelfde transactie als de publicatie', async () => {
    await reset();
    state.pruneCandidates = ['rel_old1'];
    await store.publishRelease(publishArgs());
    assert.ok(indexOfCall(/^DELETE FROM project_releases/) > indexOfCall(/^INSERT INTO project_releases/));
    const poolDeletes = calls.run.map(c => flat(c.sql)).filter(s => /DELETE FROM project_releases/.test(s));
    assert.deepStrictEqual(poolDeletes, [], 'niet buiten de transactie om');
});

// ── 3. Wat er uit de store komt ─────────────────────────────────────────────

test('listReleases bouwt een ALLOW-LIST, geen doorgegeven rij', async () => {
    await reset();
    state.poolRows = [{
        id: 'rel_1', project_id: 'p1', blueprint_id: 'bp_1', version: 3,
        notes: { summary: 'Twee automations erbij' },
        published_at: '2026-09-08T10:00:00.000Z', published_by: 'alice',
        // Two columns that do not exist today: a manifest of 16 MB and a
        // column that will be added next year. Neither may ride along.
        manifest: { solution: { key: 'sol_p1' } },
        internal_note_next_year: 'geheim',
    }];
    const [row] = await store.listReleases('p1');
    assert.deepStrictEqual(Object.keys(row).sort(),
        ['blueprintId', 'id', 'notes', 'projectId', 'publishedAt', 'publishedBy', 'version']);
    assert.strictEqual(row.manifest, undefined, 'een lijst van twintig releases is geen twintig manifesten');
    assert.strictEqual(row.internal_note_next_year, undefined);
});

test('listReleases leest ALLEEN de rijen van het meegegeven project', async () => {
    // This WHERE IS the scoping — the header of listReleases itself says that it
    // authorises nothing. If it drops away, then GET /:id/package/releases gives every
    // project owner the twenty newest release rows of the WHOLE instance,
    // including the notes of projects from other organisations. The route test
    // stubs this function and by definition cannot see that.
    await reset();
    await store.listReleases('p1');
    const call = calls.getAll.at(-1);
    assert.match(flat(call.sql), /FROM project_releases WHERE project_id = \$1 AND channel = \$3 ORDER BY/,
        'de scoping zit in de query, niet alleen in de parameterlijst');
    assert.ok(!/OR\s+TRUE/i.test(flat(call.sql)), 'geen verbreding naast de scoping');
    assert.strictEqual(call.params[0], 'p1');
    // The channel is part of the scope: the Versions tab and the installs
    // counter must never see a pipeline release.
    assert.strictEqual(call.params[2], 'gallery', 'the gallery channel by default');
    await store.listReleases('p1', { channel: 'pipeline' });
    assert.strictEqual(calls.getAll.at(-1).params[2], 'pipeline');
    await assert.rejects(() => store.listReleases('p1', { channel: 'nope' }), /Unknown release channel/);
});

test('a gallery publication prunes the gallery channel only', async () => {
    // A pipeline row has no blueprint_id, so both NOT EXISTS guards are true
    // for it: without the channel predicate one gallery publish would prune the
    // releases a UAT or PRD stage runs on.
    await reset();
    await store.publishRelease(publishArgs());
    const sql = flat(callMatching(/^SELECT id FROM project_releases/).sql);
    assert.match(sql, /AND r\.channel = 'gallery' ORDER BY/);
    assert.strictEqual(callMatching(/to_regclass/), undefined, 'the pipeline prune does not run on a gallery publish');
});

test('listReleases is nieuwste-eerst met dezelfde tiebreaker, en begrensd', async () => {
    await reset();
    await store.listReleases('p1', { limit: 999 });
    const call = calls.getAll.at(-1);
    assert.match(flat(call.sql), /ORDER BY published_at DESC, id LIMIT \$2/);
    assert.ok(!/SELECT \*/.test(call.sql), 'expliciete kolomlijst');
    assert.strictEqual(call.params[1], store.MAX_RELEASES_PER_PROJECT, 'het plafond is het plafond');

    await store.listReleases('p1', { limit: 0 });
    assert.strictEqual(calls.getAll.at(-1).params[1], store.MAX_RELEASES_PER_PROJECT);
});

test('listReleases zonder project vraagt de database niets', async () => {
    await reset();
    assert.deepStrictEqual(await store.listReleases(null), []);
    assert.deepStrictEqual(await store.listReleases(''), []);
    assert.deepStrictEqual(calls.getAll, []);
});

test('getRelease scoopt ALTIJD op het project, nooit op het id alleen', async () => {
    await reset();
    state.poolRow = {
        id: 'rel_1', project_id: 'p1', blueprint_id: 'bp_1', version: 3,
        manifest: { solution: { key: 'sol_p1', version: 3 } }, notes: {},
        published_at: 'x', published_by: 'alice',
    };
    const rel = await store.getRelease('p1', 'rel_1');
    const call = calls.getOne.at(-1);
    assert.match(flat(call.sql), /WHERE id = \$1 AND project_id = \$2/);
    assert.deepStrictEqual(call.params, ['rel_1', 'p1']);
    // This is the ONE place where the manifest does travel along: one release, explicitly requested.
    assert.strictEqual(rel.manifest.solution.version, 3);
});

test('getRelease zonder project of zonder id vraagt de database niets', async () => {
    await reset();
    assert.strictEqual(await store.getRelease(null, 'rel_1'), null);
    assert.strictEqual(await store.getRelease('p1', null), null);
    assert.deepStrictEqual(calls.getOne, []);
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
    assert.strictEqual(notes.MAX_NOTES_ENVELOPE_BYTES, store.MAX_NOTES_BYTES);

    // En de envelop die hij bij die grens teruggeeft, past er ook echt in.
    const rows = Array.from({ length: 400 }, (_, i) => ({
        kind: 'automation', entityId: `a${i}`, name: 'R'.repeat(100), change: 'changed', text: 'T'.repeat(150),
    }));
    const payload = notes.releaseNotesPayload(rows);
    assert.ok(Buffer.byteLength(JSON.stringify(payload), 'utf8') <= store.MAX_NOTES_BYTES);
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
