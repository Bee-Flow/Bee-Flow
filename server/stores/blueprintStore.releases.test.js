/**
 * O4 deel A — de releasegeschiedenis van een project.
 *
 * Twee dingen moeten hier precies kloppen, en beide zijn ordeningsvragen:
 *
 *   1. DE VOLGORDE VAN PUBLICEREN. "v1.3 publiceren" is de galerijrij ÉN de
 *      release-rij. Faalt de tweede, dan mag er geen Blueprint achterblijven
 *      die in geen enkele geschiedenis staat — en er mag ook geen release-rij
 *      ontstaan die naar een Blueprint wijst die er niet is. Dat kan alleen als
 *      ze in dezelfde transactie zitten; deze tests pinnen dat ze dat doen, en
 *      dat een mislukte release-rij alles terugdraait.
 *   2. HET SNOEIEN TOT TWINTIG. Het mag nooit de rij weghalen waar een
 *      installatie naar wijst, en nooit de rij die de galerij op dit moment
 *      serveert. Beide zijn bereikbaar (zie de kop van `_pruneReleases`), dus
 *      beide worden hier nagerekend — inclusief dat de DELETE uitsluitend de
 *      id's krijgt die de kandidatenquery teruggaf.
 *
 * Hermetisch: `../db` is gestubd (het patroon van guardrailEventStore.test.js),
 * dus er komt geen Postgres aan te pas. De SQL wordt daarom op VORM getoetst —
 * dezelfde keuze die blueprintStore.test.js voor `canRead` maakt — plus op
 * gedrag waar dat kan: welke aanroepen op de transactieclient landen, in welke
 * volgorde, met welke parameters, en wat er terugkomt.
 *
 * Run: cd server && node --test stores/blueprintStore.releases.test.js
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
    // Het contract dat de store ziet: fn krijgt een client, COMMIT bij succes,
    // ROLLBACK bij een throw. De echte BEGIN/COMMIT staan in db.js.
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

const store = require('./blueprintStore');

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

    // En niets van dit alles mag langs de pool zijn gegaan: een schrijfactie
    // buiten de transactie is precies de half-afgemaakte publicatie die hier
    // verboden is.
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
    // Het bump-pad: de galerij staat op v2, dus deze publicatie zou v3 worden.
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
    // De maker mag zijn Blueprint verwijderen terwijl een collega publiceert:
    // de lookup vindt hem nog, de UPDATE raakt nul rijen. Zonder deze waarborg
    // zou de geschiedenis een blueprint_id vastleggen dat niet bestaat.
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

    // Een installatie wijst met installed_from_blueprint_id naar de Blueprint en
    // met installed_version naar het nummer; samen zijn dat precies één rij.
    assert.match(sql, /NOT EXISTS \( SELECT 1 FROM projects p JOIN project_solution_entities e ON e\.project_id = p\.id JOIN projects src ON src\.id = r\.project_id WHERE p\.installed_from_blueprint_id = r\.blueprint_id AND e\.installed_version = r\.version AND COALESCE\(p\.organization_id, ''\) = COALESCE\(src\.organization_id, ''\)\)/);
});

test('alleen installaties in de organisatie van de BRON houden een rij vast', async () => {
    // De versmalling, en waarom zij er is. Bij een bestandsinstallatie komen
    // zowel het beweerde Blueprint-id als installed_version uit een bestand dat
    // de installateur zelf bewerkt. Zonder de org-vergelijking kon iemand met
    // één doorgestuurd bestand de cap van een ánder project uitzetten door
    // installaties te maken die versies 21..300 claimen — en die rijen zijn voor
    // hem niet eens leesbaar (listReleases/getRelease staan achter de
    // eigenaarsrol op het bronproject, canRead is org-gescoopt).
    await reset();
    await store.publishRelease(publishArgs());
    const sql = flat(callMatching(/^SELECT id FROM project_releases/).sql);

    assert.match(sql, /JOIN projects src ON src\.id = r\.project_id/,
        'de organisatie van de bron komt uit het project dat publiceert');
    assert.match(sql, /COALESCE\(p\.organization_id, ''\) = COALESCE\(src\.organization_id, ''\)/,
        "projects.organization_id is TEXT DEFAULT '' en mag NULL zijn: een kale = matcht org-loze rijen nooit");
});

test('de kandidatenquery kijkt alleen naar de release-rijen van DIT project', async () => {
    // De DELETE hieronder is het enige destructieve statement van een
    // publicatie. Valt deze WHERE weg — of wordt hij `(r.project_id = $1 OR
    // TRUE)` — dan snoeit elke publicatie de geschiedenis van élk project op de
    // instantie weg, over org-grenzen heen. Alleen de parameter toetsen is niet
    // genoeg: die kan kloppen terwijl de query hem niet gebruikt.
    await reset();
    await store.publishRelease(publishArgs());
    const sql = flat(callMatching(/^SELECT id FROM project_releases/).sql);
    assert.match(sql, /^SELECT id FROM project_releases r WHERE r\.project_id = \$1 AND NOT EXISTS/,
        'de scoping staat vooraan en is de eerste voorwaarde, niet een losse parameter');
    assert.ok(!/OR\s+TRUE/i.test(sql), 'geen verbreding naast de scoping');
});

test('de bump-lookup vergrendelt de rij die hij gaat ophogen', async () => {
    // Zonder FOR UPDATE lezen twee gelijktijdige publicaties van dezelfde maker
    // allebei v2 en schrijven ze allebei v3. Dan draagt de geschiedenis TWEE
    // v3-rijen, waarvan er één een versie vastlegt die nooit installeerbaar is
    // geweest — en de invariant waar beide snoeiwaarborgen op leunen
    // ((blueprint_id, version) is precies één rij) is weg.
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
        notes: { summary: 'Twee routines erbij' },
        published_at: '2026-09-08T10:00:00.000Z', published_by: 'alice',
        // Twee kolommen die er vandaag niet zijn: een manifest van 16 MB en een
        // kolom die volgend jaar wordt toegevoegd. Geen van beide mag meereizen.
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
    // Deze WHERE ÍS de scoping — de kop van listReleases zegt zelf dat zij niets
    // autoriseert. Valt hij weg, dan levert GET /:id/package/releases elke
    // projecteigenaar de twintig nieuwste release-rijen van de HELE instantie,
    // inclusief de notities van projecten uit andere organisaties. De routetest
    // stubt deze functie en kan dat per definitie niet zien.
    await reset();
    await store.listReleases('p1');
    const call = calls.getAll.at(-1);
    assert.match(flat(call.sql), /FROM project_releases WHERE project_id = \$1 ORDER BY/,
        'de scoping zit in de query, niet alleen in de parameterlijst');
    assert.ok(!/OR\s+TRUE/i.test(flat(call.sql)), 'geen verbreding naast de scoping');
    assert.strictEqual(call.params[0], 'p1');
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
    // Dit is de ENE plek waar het manifest wel meereist: één release, expliciet opgevraagd.
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
    // `releaseNotesPayload` krimpt tot ZIJN eigen grens, en die is met de hand
    // overgeschreven omdat de store bij require een pool opent. Zakt
    // MAX_NOTES_BYTES ooit onder die kopie, dan gooit `normalizeNotes` vóór de
    // transactie en wordt een PUBLICATIE geweigerd wegens een notitie — precies
    // wat releaseNotes.js belooft dat nooit kan. Deze test is de koppeling die
    // in geen van beide bestanden past.
    const notes = require('../projects/packaging/releaseNotes');
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
    // Genuinely textual, zelfde reden als de COLUMN_LADDERS-claims in
    // boot/bootMigrations.test.js: het verschil tussen runDdl() en de oude
    // stille exec() is per-statement foutzichtbaarheid, niet een ander
    // resultaat in een levende database — dat is alleen na te rekenen door de
    // DDL echt te laten falen, niet iets een unit test hier kan waarnemen.
    // De COLUMN_LADDERS-claim rekent hetzelfde na vanaf de andere kant; dit is
    // de claim van de store zelf. Eigen naam (niet `src`) om geen toevallige
    // woordmatch te geven met de SQL-alias `src` in de tests hierboven.
    const ddlSrc = fs.readFileSync(path.join(__dirname, 'blueprintStore.js'), 'utf8');
    const ladder = ddlSrc.slice(ddlSrc.indexOf("runDdl('blueprintStore'"));
    assert.ok(ddlSrc.includes("runDdl('blueprintStore'"), 'de ladder bestaat');
    // Op de tabelnaam ZELF: `project_releases_iets_anders` bevat de substring en
    // zou anders als bewijs gelden. Zelfde reden als de woordgrens in de matcher
    // van COLUMN_LADDERS.
    assert.match(ladder.slice(0, 1200), /CREATE TABLE IF NOT EXISTS project_releases\s*\(/);

    const execBlock = ddlSrc.slice(ddlSrc.indexOf('await exec(`'), ddlSrc.indexOf("runDdl('blueprintStore'"));
    assert.ok(!/project_releases/.test(execBlock), 'en niet in de exec ernaast');
});
