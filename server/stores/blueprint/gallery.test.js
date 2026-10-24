/**
 * O4 part C — "how often has this been installed", as two numbers.
 *
 * Blueprints are strictly org-scoped (see the header of `canRead`).
 * `countInstallsFor` is the ONLY read that looks across that, and that is allowed
 * only because nothing but numbers can come out of it. These tests guard
 * exactly those sides:
 *
 *   1. IT COUNTS ACROSS ORGANISATIONS, split into "here" and "elsewhere". A
 *      count that quietly sees only the own organisation answers "0" to the question
 *      the function exists for.
 *   2. THE COMPARISON BETWEEN TWO DIFFERENT EMPTY VALUES.
 *      `projects.organization_id` is TEXT DEFAULT '' and the gallery side may be
 *      NULL; a naive `=` counts every org-less installation as "elsewhere".
 *   3. NO ROW COMES OUT. No `SELECT *`, no project name, no owner,
 *      no timestamp — one COUNT row. So there is also no column that is added to
 *      `projects` next year and rides along by itself.
 *   4. ZERO IS AN ANSWER, "not readable" is not one. Those two may not become the
 *      same on any screen, so they may not have the same value here either.
 *
 * Hermetic: `../db` is stubbed (the pattern of blueprint/releases.test.js),
 * so no Postgres is involved and the SQL is checked on SHAPE —
 * the same choice that blueprint/mappers.test.js makes for `canRead`.
 *
 * Run: cd server && node --test stores/blueprint/gallery.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const Module = require('module');

// ── De db-stub ──────────────────────────────────────────────────────────────

const calls = { getOne: [], getAll: [], run: [], exec: [] };
// `counts` is what the counting query answers; `countRow` overrides the WHOLE
// row, so that "the row did not come back" can also be simulated.
const state = { counts: { here: 0, elsewhere: 0 }, countRow: undefined, row: null };

const flat = (s) => String(s).replace(/\s+/g, ' ').trim();

const dbStub = {
    async exec(sql) { calls.exec.push(sql); return { rowCount: 0 }; },
    async run(sql, params) { calls.run.push({ sql, params }); return { rowCount: 0 }; },
    async getOne(sql, params) {
        calls.getOne.push({ sql, params });
        if (/COUNT\(\*\)/.test(flat(sql))) {
            return state.countRow !== undefined ? state.countRow : state.counts;
        }
        return state.row;
    },
    async getAll(sql, params) { calls.getAll.push({ sql, params }); return []; },
    isSqlStateError(err) { return typeof err?.code === 'string' && /^[0-9A-Z]{5}$/.test(err.code); },
    async withTransaction(fn) {
        return fn({ async query() { return { rows: [], rowCount: 0 }; } });
    },
};

const STORES_DIR = path.sep + 'stores' + path.sep;
const STUB_PATH = path.join(__dirname, '__stub_db_installs__.js');
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && parent.filename && parent.filename.includes(STORES_DIR) && request === '../db') {
        return STUB_PATH;
    }
    return origResolve.call(this, request, parent, ...rest);
};
require.cache[STUB_PATH] = { id: STUB_PATH, filename: STUB_PATH, loaded: true, exports: dbStub };

const store = require('../blueprintStore');

async function reset() {
    await store.initDB();
    for (const k of Object.keys(calls)) calls[k].length = 0;
    state.counts = { here: 0, elsewhere: 0 };
    state.countRow = undefined;
    state.row = null;
}

const countQuery = () => calls.getOne.find(c => /COUNT\(\*\)/.test(flat(c.sql)));

// ── 1. Over organisaties heen ───────────────────────────────────────────────

test('de telling splitst in hier en elders, en kijkt dus over organisaties heen', async () => {
    await reset();
    state.counts = { here: 2, elsewhere: 5 };
    const out = await store.countInstallsFor(['bp_a', 'bp_b'], { organizationId: 'org_source' });
    assert.deepStrictEqual(out, { here: 2, elsewhere: 5 });

    const q = countQuery();
    assert.ok(q, 'er is een tellende query gedraaid');
    const sql = flat(q.sql);
    // Exactly two parameters: the ids and the organisation of the source. Were the
    // organisation in the WHERE instead of the FILTER, the function would count
    // only its own organisation — the answer "0" to the question
    // it exists for.
    assert.deepStrictEqual(q.params, [['bp_a', 'bp_b'], 'org_source']);
    assert.match(sql, /WHERE installed_from_blueprint_id = ANY\(\$1::text\[\]\)/);
    // The organisation belongs in the FILTER and NOT in the WHERE of the table: if
    // it already filtered the rows away, "elsewhere" would be zero by definition and the
    // function would precisely not count what it has to count.
    const whereClause = sql.split('FROM projects')[1] || '';
    assert.ok(!whereClause.includes('organization_id'),
        'de WHERE van de tabel noemt geen organisatie — anders verdwijnt "elders"');
    assert.match(sql, /FILTER \(WHERE COALESCE\(organization_id, ''\) = COALESCE\(\$2, ''\)\)/);
    assert.match(sql, /FILTER \(WHERE COALESCE\(organization_id, ''\) <> COALESCE\(\$2, ''\)\)/);
});

// ── 2. Empty and NULL are the same "no organisation" ────────────────────────

test('een org-loze bron vergelijkt met de lege string, niet met NULL', async () => {
    // `projects.organization_id` is TEXT DEFAULT '' (createProject writes
    // `organizationId || ''`), while the gallery side may be NULL. Without the
    // COALESCE on BOTH sides an org-less installation never matches and
    // counts as "elsewhere" — exactly the wrong way round.
    await reset();
    await store.countInstallsFor(['bp_a'], { organizationId: null });
    assert.deepStrictEqual(countQuery().params[1], '',
        'null wordt de lege string, zodat de vergelijking klopt met wat er in de kolom staat');
});

// ── 3. Er komt geen rij uit ─────────────────────────────────────────────────

test('er komen twee getallen uit, nooit een rij', async () => {
    await reset();
    state.counts = { here: 1, elsewhere: 0 };
    const out = await store.countInstallsFor(['bp_a'], { organizationId: 'org1' });
    assert.deepStrictEqual(Object.keys(out).sort(), ['elsewhere', 'here']);

    const sql = flat(countQuery().sql);
    assert.ok(!/SELECT \*/.test(sql), 'geen SELECT * — dan reist elke toekomstige kolom mee');
    for (const column of ['p.name', 'owner_id', 'icon', 'created_at', 'installed_version']) {
        assert.ok(!sql.includes(column), `${column} hoort niet in een telling`);
    }
    // GROUP BY organization_id would give a breakdown PER organisation, and
    // with a single installation that is no longer an aggregate but a hint.
    assert.ok(!/GROUP BY/i.test(sql), 'geen uitsplitsing per organisatie');
});

// ── 4. Nul is een antwoord ──────────────────────────────────────────────────

test('zonder Blueprint valt er niets te tellen, en dat is nul', async () => {
    // From an id that does not exist nobody can have installed anything. Zero is
    // an answer here and not a gap — and it saves a query.
    await reset();
    for (const ids of [[], null, ['', null, 42]]) {
        assert.deepStrictEqual(await store.countInstallsFor(ids, { organizationId: 'org1' }),
            { here: 0, elsewhere: 0 });
    }
    assert.strictEqual(countQuery(), undefined, 'geen query zonder een enkel bruikbaar id');
});

test('een onleesbare telling is null, nooit 0', async () => {
    // "Nobody has installed this" and "we could not check" are
    // two different statements. `Number(null)` is 0, so this is precisely
    // the place where a bare coercion throws the distinction away.
    for (const answer of [null, {}, { here: null, elsewhere: 0 }, { here: 0, elsewhere: 'veel' }]) {
        await reset();
        state.countRow = answer;
        assert.strictEqual(await store.countInstallsFor(['bp_a'], {}), null,
            `${JSON.stringify(answer)} is geen telling en mag niet als 0 lezen`);
    }
});

// ── 5. The access question does NOT belong here ─────────────────────────────────

test('de store autoriseert niets — de aanroeper levert de geautoriseerde id\'s', async () => {
    // The same promise as listStamps/listInstalledVersions/listReleases: this
    // function counts what it gets. Who may count is decided by the route, with the
    // owner role on the source project.
    await reset();
    state.counts = { here: 9, elsewhere: 9 };
    const out = await store.countInstallsFor(['bp_van_een_ander'], { organizationId: 'org_willekeurig' });
    assert.deepStrictEqual(out, { here: 9, elsewhere: 9 });
});

// ── 6. The meta read does not drag the manifest along ───────────────────────────

test('een lezing zonder manifest haalt het manifest ook echt niet op', async () => {
    await reset();
    state.row = { id: 'bp_abc', organization_id: 'org1', created_by: 'alice', solution_key: 'sol_p1', version: 2, name: 'Orders' };
    const meta = await store.getBlueprintById('bp_abc', { includeManifest: false });
    assert.strictEqual(meta.manifest, undefined, 'geen manifest in het antwoord');
    assert.strictEqual(meta.organizationId, 'org1');

    const read = calls.getOne.find(c => /FROM project_blueprints/.test(flat(c.sql)));
    assert.ok(!/SELECT \*/.test(flat(read.sql)), 'geen SELECT * op het meta-pad');
    assert.ok(!/manifest/.test(flat(read.sql)), 'het manifest staat niet in de kolommenlijst');
});

test('de gewone lezing draagt het manifest nog steeds', async () => {
    // The install wizard reads a Blueprint WITH the manifest; that path must not
    // have been quietly narrowed by the option above.
    await reset();
    state.row = { id: 'bp_abc', organization_id: 'org1', created_by: 'alice', version: 1, manifest: { solution: {} } };
    const full = await store.getBlueprintById('bp_abc');
    assert.deepStrictEqual(full.manifest, { solution: {} });
    const read = calls.getOne.find(c => /FROM project_blueprints/.test(flat(c.sql)));
    assert.match(flat(read.sql), /SELECT \* FROM project_blueprints/);
});

test('de galerijlijst haalt de manifesten óók niet op', async () => {
    // `mapRow(..., { includeManifest: false })` gooide ze daarna toch weg, dus
    // de query sleepte tot MAX_BLUEPRINTS_PER_ORG (100) JSONB-blobs van elk
    // maximaal MAX_BLUEPRINT_BYTES (16 MB) door de pool om er een handvol
    // strings uit te lezen. Elke lezer betaalde dat: de galerij, de
    // toegangsvraag én de installatieteller.
    await reset();
    await store.listBlueprintsFor({ userId: 'alice', organizationId: 'org1' });
    const read = calls.getAll.find(c => /FROM project_blueprints/.test(flat(c.sql)));
    assert.ok(read, 'de galerijlijst draait een query');
    assert.ok(!/SELECT \*/.test(flat(read.sql)), 'geen SELECT * op een lijst die het manifest weggooit');
    assert.ok(!/manifest/.test(flat(read.sql)), 'het manifest staat niet in de kolommenlijst');
});
