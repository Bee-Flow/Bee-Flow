/**
 * O4 deel C — "hoe vaak is dit geïnstalleerd", als twee getallen.
 *
 * Blueprints zijn strikt org-gescoopt (zie de kop van `canRead`).
 * `countInstallsFor` is de ENIGE lezing die daaroverheen kijkt, en dat mag
 * alleen omdat er niets anders uit kan komen dan getallen. Deze tests bewaken
 * precies die kanten:
 *
 *   1. HET TELT OVER ORGANISATIES HEEN, gesplitst in "hier" en "elders". Een
 *      telling die stilletjes alleen de eigen organisatie ziet, geeft het
 *      antwoord "0" op de vraag waarvoor de functie bestaat.
 *   2. DE VERGELIJKING TUSSEN TWEE VERSCHILLENDE LEGE WAARDEN.
 *      `projects.organization_id` is TEXT DEFAULT '' en de galerijkant mag NULL
 *      zijn; een naïeve `=` telt elke org-loze installatie als "elders".
 *   3. ER KOMT GEEN RIJ UIT. Geen `SELECT *`, geen projectnaam, geen eigenaar,
 *      geen tijdstip — één COUNT-rij. Er is dus ook geen kolom die volgend jaar
 *      aan `projects` wordt toegevoegd en vanzelf meelift.
 *   4. NUL IS EEN ANTWOORD, "niet te lezen" is er geen. Die twee mogen op geen
 *      enkel scherm hetzelfde worden, dus mogen ze hier ook niet dezelfde
 *      waarde hebben.
 *
 * Hermetisch: `../db` is gestubd (het patroon van blueprintStore.releases.test.js),
 * dus er komt geen Postgres aan te pas en de SQL wordt op VORM getoetst —
 * dezelfde keuze die blueprintStore.test.js voor `canRead` maakt.
 *
 * Run: cd server && node --test stores/blueprintStore.installs.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const Module = require('module');

// ── De db-stub ──────────────────────────────────────────────────────────────

const calls = { getOne: [], getAll: [], run: [], exec: [] };
// `counts` is wat de tellende query antwoordt; `countRow` overschrijft de HELE
// rij, zodat "de rij kwam niet terug" ook te spelen is.
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

const store = require('./blueprintStore');

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
    // Precies twee parameters: de id's en de organisatie van de bron. Zou de
    // organisatie in de WHERE staan in plaats van in de FILTER, dan telde de
    // functie alleen de eigen organisatie — het antwoord "0" op de vraag
    // waarvoor zij bestaat.
    assert.deepStrictEqual(q.params, [['bp_a', 'bp_b'], 'org_source']);
    assert.match(sql, /WHERE installed_from_blueprint_id = ANY\(\$1::text\[\]\)/);
    // De organisatie hoort in de FILTER en NIET in de WHERE van de tabel: zou
    // zij de rijen al wegfilteren, dan is "elders" per definitie nul en telt de
    // functie precies niet wat zij moet tellen.
    const whereClause = sql.split('FROM projects')[1] || '';
    assert.ok(!whereClause.includes('organization_id'),
        'de WHERE van de tabel noemt geen organisatie — anders verdwijnt "elders"');
    assert.match(sql, /FILTER \(WHERE COALESCE\(organization_id, ''\) = COALESCE\(\$2, ''\)\)/);
    assert.match(sql, /FILTER \(WHERE COALESCE\(organization_id, ''\) <> COALESCE\(\$2, ''\)\)/);
});

// ── 2. Leeg en NULL zijn hetzelfde "geen organisatie" ───────────────────────

test('een org-loze bron vergelijkt met de lege string, niet met NULL', async () => {
    // `projects.organization_id` is TEXT DEFAULT '' (createProject schrijft
    // `organizationId || ''`), terwijl de galerijkant NULL mag zijn. Zonder de
    // COALESCE aan BEIDE kanten matcht een org-loze installatie nooit en telt
    // zij als "elders" — precies verkeerd om.
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
    // GROUP BY organization_id zou een uitsplitsing PER organisatie geven, en
    // bij één installatie is dat geen aggregaat meer maar een aanwijzing.
    assert.ok(!/GROUP BY/i.test(sql), 'geen uitsplitsing per organisatie');
});

// ── 4. Nul is een antwoord ──────────────────────────────────────────────────

test('zonder Blueprint valt er niets te tellen, en dat is nul', async () => {
    // Uit een id dat niet bestaat kan niemand iets geïnstalleerd hebben. Nul is
    // hier een antwoord en geen gat — en het spaart een query uit.
    await reset();
    for (const ids of [[], null, ['', null, 42]]) {
        assert.deepStrictEqual(await store.countInstallsFor(ids, { organizationId: 'org1' }),
            { here: 0, elsewhere: 0 });
    }
    assert.strictEqual(countQuery(), undefined, 'geen query zonder een enkel bruikbaar id');
});

test('een onleesbare telling is null, nooit 0', async () => {
    // "Niemand heeft dit geïnstalleerd" en "we konden het niet nakijken" zijn
    // twee verschillende mededelingen. `Number(null)` is 0, dus dit is precies
    // de plek waar een kale coercie het onderscheid weggooit.
    for (const answer of [null, {}, { here: null, elsewhere: 0 }, { here: 0, elsewhere: 'veel' }]) {
        await reset();
        state.countRow = answer;
        assert.strictEqual(await store.countInstallsFor(['bp_a'], {}), null,
            `${JSON.stringify(answer)} is geen telling en mag niet als 0 lezen`);
    }
});

// ── 5. De toegangsvraag hoort hier NIET ─────────────────────────────────────

test('de store autoriseert niets — de aanroeper levert de geautoriseerde id\'s', async () => {
    // Dezelfde belofte als listStamps/listInstalledVersions/listReleases: deze
    // functie telt wat zij krijgt. Wie mag tellen beslist de route, met de
    // eigenaarsrol op het bronproject.
    await reset();
    state.counts = { here: 9, elsewhere: 9 };
    const out = await store.countInstallsFor(['bp_van_een_ander'], { organizationId: 'org_willekeurig' });
    assert.deepStrictEqual(out, { here: 9, elsewhere: 9 });
});

// ── 6. De meta-lezing sleept het manifest niet mee ──────────────────────────

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
    // De installwizard leest een Blueprint mét manifest; dat pad mag niet
    // stilletjes zijn versmald door de optie hierboven.
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
