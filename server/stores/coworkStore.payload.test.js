/**
 * De cowork-payload: de velden die het Cowork-scherm nieuw leest, tegen een
 * gestubde db. Dit bestand pint het SQL- en waardecontract; de echte
 * Postgres-round-trip staat in coworkStore.test.js en skipt zonder database,
 * dus wat hier staat draait overal.
 *
 * Drie eigenschappen, alle drie met een eigen wond:
 *
 *   - CW-13 `produced_output`. Een run die niets te melden had is GESLAAGD, en
 *     dat oordeel hoort één keer te vallen (bij het sluiten) en bewaard te
 *     worden — niet elke keer opnieuw uit de resultaattekst geraden te worden.
 *     NULL is een derde waarde: rijen van vóór de kolom weten het niet, en die
 *     als "niets geproduceerd" lezen verzint een uitspraak over het verleden.
 *
 *   - CW-06 `currentRunStartedAt`. De bron is de rij die open staat
 *     (`finished_at IS NULL`), niet `last_status = 'running'`: die twee lopen
 *     uiteen zodra reapStaleRuns een vastgelopen poging opruimt.
 *
 *   - CW-11 het aggregaat. `failed` is "gesloten en niet geslaagd", zodat een
 *     statusnaam die er later bij komt niet stilzwijgend tussen wal en schip
 *     valt, en een lopende run telt in geen van beide uitkomsten mee.
 *
 * Run: cd server && node --test --test-reporter=tap stores/coworkStore.payload.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { installResolveStub } = require('../testUtils/stubRequire');

const runCalls = [];
const execCalls = [];
let getOneHandler = () => null;
let getAllHandler = () => [];

const restore = installResolveStub({
    '../db': {
        run: async (sql, params) => { runCalls.push({ sql, params }); return { rowCount: 1, rows: [] }; },
        getOne: async (sql, params) => getOneHandler(sql, params),
        getAll: async (sql, params) => getAllHandler(sql, params),
        exec: async (sql) => { execCalls.push(sql); },
        pool: { query: async () => ({ rows: [], rowCount: 0 }) },
    },
});

const coworkStore = require('./coworkStore');
const { deriveProducedOutput } = coworkStore;

function reset() {
    runCalls.length = 0;
    getOneHandler = () => null;
    getAllHandler = () => [];
}

/** De UPDATE waarmee _closeOpenRun een open run afsluit. */
function closingUpdate() {
    return runCalls.find(c => /UPDATE cowork_runs/.test(c.sql) && /finished_at = NOW\(\)/.test(c.sql));
}

/** Doe alsof er precies één open run klaarstaat om afgesloten te worden. */
function withOpenRun() {
    getOneHandler = (sql) => (/SELECT id, started_at FROM cowork_runs/.test(sql)
        ? { id: 'run-open', started_at: '2026-09-10T08:00:04.000Z' }
        : null);
}

// ── CW-13: het oordeel "was er iets te melden" ──────────────────────

test('leeg en de "geen tekstresultaat"-markering tellen als niets geproduceerd', () => {
    assert.strictEqual(deriveProducedOutput(null), false);
    assert.strictEqual(deriveProducedOutput(undefined), false);
    assert.strictEqual(deriveProducedOutput(''), false);
    assert.strictEqual(deriveProducedOutput('   \n  '), false);
    // De letterlijke vorm die aiTaskRunner neerzet als het model niets schreef.
    assert.strictEqual(
        deriveProducedOutput('_(Deze cowork is uitgevoerd, maar er is geen tekstresultaat geproduceerd.)_'),
        false);
    // Dezelfde vorm, andere taal/copy: de afleiding hangt aan de VORM, niet aan
    // de Nederlandse zin — anders breekt hij zodra iemand de tekst vertaalt.
    assert.strictEqual(deriveProducedOutput('_(Nothing to report.)_'), false);
});

test('een echt resultaat telt mee, ook als het cursief begint', () => {
    assert.strictEqual(deriveProducedOutput('3 offertes klaargezet'), true);
    assert.strictEqual(deriveProducedOutput('_(let op)_ en dan 3 offertes'), true,
        'een markering met tekst eromheen is gewoon een antwoord');
    assert.strictEqual(deriveProducedOutput('0'), true,
        'het cijfer nul is een uitkomst, geen leegte');
});

test('markCompleted schrijft het oordeel mee in dezelfde UPDATE die de run sluit', async () => {
    reset();
    withOpenRun();
    await coworkStore.markCompleted('cw-1', '3 offertes klaargezet');
    const upd = closingUpdate();
    assert.ok(upd, 'de sluitende UPDATE hoort te lopen');
    assert.match(upd.sql, /produced_output = \$4/);
    assert.strictEqual(upd.params[3], true);
});

test('"niets te melden" wordt een GESLAAGDE run met produced_output false', async () => {
    reset();
    withOpenRun();
    await coworkStore.markCompleted('cw-1', '_(Deze cowork is uitgevoerd, maar er is geen tekstresultaat geproduceerd.)_');
    const upd = closingUpdate();
    assert.strictEqual(upd.params[0], 'success', 'de status blijft geslaagd — dat is de hele bevinding');
    assert.strictEqual(upd.params[3], false);
});

test('een aanroeper die het zeker weet overstemt de afleiding', async () => {
    reset();
    withOpenRun();
    // De runner weet of er tool-output was; die kennis mag niet verloren gaan
    // aan een tekstafleiding.
    await coworkStore.markCompleted('cw-1', 'ziet er leeg uit', { producedOutput: false });
    assert.strictEqual(closingUpdate().params[3], false);

    reset();
    withOpenRun();
    await coworkStore.markCompleted('cw-1', '', { producedOutput: true });
    assert.strictEqual(closingUpdate().params[3], true);
});

// EERLIJK: deze test kan niet falen op het contract dat hij noemt. markError
// geeft geen `result` mee, dus deriveProducedOutput(undefined) is al false —
// het expliciete `producedOutput: false` in markError weghalen is een
// EQUIVALENTE mutatie en blijft groen. De test is de waarde-assertie waard
// (produced_output = false op een mislukte rij) maar bewijst niet dat de
// aanroeper het zelf zegt. Wie dat wél wil bewijzen heeft een markError nodig
// die een resultaat draagt, en die bestaat vandaag niet.
test('een mislukte run heeft per definitie niets opgeleverd', async () => {
    reset();
    withOpenRun();
    await coworkStore.markError('cw-1', new Error('provider exploded'));
    const upd = closingUpdate();
    assert.strictEqual(upd.params[0], 'error');
    assert.strictEqual(upd.params[3], false);
});

test('een opgeruimde vastgelopen run wordt ook op false gezet', async () => {
    reset();
    await coworkStore.reapStaleRuns();
    const reap = runCalls.find(c => /UPDATE cowork_runs/.test(c.sql) && /finished_at IS NULL/.test(c.sql));
    assert.ok(reap);
    assert.match(reap.sql, /produced_output = FALSE/);
});

test('de kolom komt uit de runDdl-ladder van deze store, niet uit een stille catch', async () => {
    // Een nieuwe kolom hoort in de idempotente boot-DDL van zijn eigen store
    // (boot/bootMigrations.test.js legt die regel uit). IF NOT EXISTS draagt de
    // idempotentie, zodat elke boot van elke replica hem opnieuw mag draaien.
    const alter = execCalls.find(sql => /ADD COLUMN IF NOT EXISTS produced_output BOOLEAN/.test(sql));
    assert.ok(alter, `geen ALTER voor produced_output gezien; wel: ${execCalls.join(' | ')}`);
    assert.match(alter, /ALTER TABLE cowork_runs/);
});

test('listRuns geeft true, false en null door — null blijft null', async () => {
    reset();
    getAllHandler = () => [
        { id: 'r1', schedule_id: 'cw-1', status: 'success', produced_output: true },
        { id: 'r2', schedule_id: 'cw-1', status: 'success', produced_output: false },
        { id: 'r3', schedule_id: 'cw-1', status: 'success', produced_output: null },
    ];
    const runs = await coworkStore.listRuns('cw-1');
    assert.deepStrictEqual(runs.map(r => r.producedOutput), [true, false, null],
        'een rij van vóór de kolom weet het niet, en dat is geen "nee"');
});

// ── CW-06: de starttijd van de lopende run ──────────────────────────

test('de open run wordt gezocht op finished_at IS NULL, niet op een status', async () => {
    reset();
    let seen;
    getOneHandler = (sql, params) => { seen = { sql, params }; return { started_at: '2026-09-10T08:00:04.000Z' }; };
    const at = await coworkStore.getOpenRunStart('cw-1');
    assert.strictEqual(at, '2026-09-10T08:00:04.000Z');
    assert.match(seen.sql, /finished_at IS NULL/);
    // GEEN statuskolom, in welke spelling dan ook. De vorige versie van deze
    // regel verbood alleen `last_status`, waardoor `AND status = 'running'` —
    // precies de fout die de doc-comment beschrijft — er ongezien doorheen
    // kwam: na een reap staat de rij open én is de status geen 'running' meer.
    assert.ok(!/\bstatus\b/.test(seen.sql), 'een status in de WHERE loopt uiteen met de open rij');
    assert.deepStrictEqual(seen.params, ['cw-1']);
});

test('niets open → null, geen verzonnen tijd', async () => {
    reset();
    getOneHandler = () => null;
    assert.strictEqual(await coworkStore.getOpenRunStart('cw-1'), null);
});

test('de lijstvariant vraagt het in ÉÉN query voor de hele gebruiker', async () => {
    reset();
    let seen;
    getAllHandler = (sql, params) => {
        seen = { sql, params };
        return [{ schedule_id: 'cw-a', started_at: '2026-09-10T08:00:04.000Z' }];
    };
    const map = await coworkStore.getOpenRunStarts('u1');
    assert.deepStrictEqual(map, { 'cw-a': '2026-09-10T08:00:04.000Z' });
    assert.deepStrictEqual(seen.params, ['u1'], 'op user_id — de bestaande index');
    assert.match(seen.sql, /finished_at IS NULL/);
    assert.ok(!/\bstatus\b/.test(seen.sql), 'dezelfde bron als de losse variant: de open rij, geen status');
    assert.match(seen.sql, /GROUP BY schedule_id/);
});

// ── CW-11: het aggregaat ────────────────────────────────────────────

test('het aggregaat telt geslaagd apart en rekent "mislukt" als gesloten-en-niet-geslaagd', async () => {
    reset();
    let seen;
    getOneHandler = (sql, params) => {
        seen = { sql, params };
        return { total: 12, success: 10, failed: 2, avg_duration_ms: '71999.6' };
    };
    const stats = await coworkStore.getRunStats('cw-1');
    assert.deepStrictEqual(stats, { total: 12, success: 10, failed: 2, avgDurationMs: 72000 });
    assert.deepStrictEqual(seen.params, ['cw-1']);
    // Zonder database is SQL-tekst het enige wat hier te meten valt, dus deze
    // drie regels toetsen de VOORWAARDEN en niet de schrijfwijze: een
    // semantisch identieke SUM(CASE WHEN …) hoort niet rood te worden, een
    // veranderde voorwaarde wel. De echte round-trip hoort in
    // coworkStore.test.js en skipt hier zonder Postgres.
    assert.match(seen.sql, /success[\s\S]{0,80}status = 'success'|status = 'success'[\s\S]{0,80}success/);
    // Niet een lijst foutstatussen: 'needs_reauth' bestaat al en er komt er ooit
    // een bij. "Gesloten en niet geslaagd" dekt die allemaal.
    assert.match(seen.sql, /finished_at IS NOT NULL AND status <> 'success'/);
    assert.ok(!/status = 'error'/.test(seen.sql), 'een lijst foutstatussen laat een nieuwe status wegvallen');
    // Een lopende run heeft nog geen duur; die hoort het gemiddelde niet te verdunnen.
    assert.match(seen.sql, /AVG\(duration_ms\)[\s\S]{0,60}finished_at IS NOT NULL/);
});

test('nog nooit een poging afgerond geeft null, niet 0 ms', async () => {
    reset();
    getOneHandler = () => ({ total: 1, success: 0, failed: 0, avg_duration_ms: null });
    const stats = await coworkStore.getRunStats('cw-1');
    assert.strictEqual(stats.avgDurationMs, null, '"nog niets gemeten" is geen "gemiddeld 0 ms"');
    assert.strictEqual(stats.total, 1);
});

test('een GEMETEN 0 blijft 0 — de andere helft van dezelfde regel', async () => {
    // Het onderscheid stond in drie commentaarblokken en in nul fixtures: geen
    // enkele test gaf ooit 0 mee, dus `avg ? … : null` in plaats van een
    // null-check bleef overal groen. Een run die onder de milliseconde
    // afrondt IS afgerond, en 0 is dan een meting.
    reset();
    getOneHandler = () => ({ total: 3, success: 3, failed: 0, avg_duration_ms: '0' });
    const stats = await coworkStore.getRunStats('cw-1');
    assert.strictEqual(stats.avgDurationMs, 0);
    assert.notStrictEqual(stats.avgDurationMs, null);
});

test('een schema zonder historie geeft nullen terug in plaats van te vallen', async () => {
    reset();
    getOneHandler = () => null;
    assert.deepStrictEqual(await coworkStore.getRunStats('cw-1'),
        { total: 0, success: 0, failed: 0, avgDurationMs: null });
});

test.after(() => restore());
