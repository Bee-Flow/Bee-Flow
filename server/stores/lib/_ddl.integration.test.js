'use strict';

/**
 * stores/lib/_ddl.js tegen echte Postgres (pglite), achter de pool van de
 * echte db.js (testUtils/pglitePool) — geen fakeDb-stringmock.
 *
 * Bewezen wordt: (1) een falend statement komt in de failures-lijst én de
 * rest van de reeks draait door en commit; (2) een verwachte SQLSTATE
 * (`tolerate`) komt in `tolerated` zonder logregel; (3) twee gelijktijdige
 * aanroepen met dezelfde tag draaien strikt na elkaar; (4) een
 * verbindingsfout (geen SQLSTATE) rejict de hele aanroep en rolt de
 * transactie terug.
 *
 * Eerlijk over de grens (PLAN-APP-UPGRADE.md kritiek-2 punt 9): pglite heeft
 * één WASM-verbinding, dus wederzijdse uitsluiting TUSSEN verbindingen — het
 * werk van pg_advisory_xact_lock — is hier niet te bewijzen. Test 3 bewijst
 * de in-proces wachtrij; de advisory lock is hetzelfde idioom dat
 * configStore.mutateConfig al productie-draait en dat test 3 van
 * migrateDb.integration.test.js onder pglite aantoonbaar uitvoert.
 *
 * Run: cd server && node --test stores/lib/_ddl.integration.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');

// ── The real db.js, its pool answered by one pglite connection ──────────────
// Before the stores are required: they start their schema init at load.
// pglite is ONE connection, so these tests stay sequential.
const { usePglitePool } = require('../../testUtils/pglitePool');
const { query: rawQuery } = usePglitePool();

// Testhaak voor test 4: één statement dat "de verbinding verliest" —
// een rejectie ZONDER SQLSTATE, zoals een pool-timeout of dode socket.
const BOOM = 'SELECT __verbinding_weg__';
{
    const db = require('../../db');
    const answer = db.pool.query;
    db.pool.query = async (sql, params) => {
        if (String(sql).includes(BOOM)) throw new Error('Connection terminated unexpectedly');
        return answer(sql, params);
    };
    db.pool.connect = async () => ({ query: db.pool.query, release() {} });
}

// Alles hieronder is het echte spul.
const { runDdl, CODES } = require('./_ddl.js');

async function tableExists(name) {
    const r = await rawQuery(
        `SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1`, [name]);
    return r.rows.length === 1;
}

function captureErrors(fn) {
    const lines = [];
    const orig = console.error;
    console.error = (...args) => { lines.push(args.map(String).join(' ')); };
    return Promise.resolve().then(fn).finally(() => { console.error = orig; }).then((out) => ({ out, lines }));
}

test('een falend statement komt in failures én de rest draait door (en commit)', async () => {
    const { out, lines } = await captureErrors(() => runDdl('ddltest-basis', [
        `CREATE TABLE IF NOT EXISTS ddl_a (id INT PRIMARY KEY)`,
        // Bewijst dat SET LOCAL lock_timeout écht in deze transactie staat.
        `DO $$ BEGIN IF current_setting('lock_timeout') <> '15s' THEN RAISE EXCEPTION 'lock_timeout niet gezet'; END IF; END $$`,
        `ALTER TABLE ddl_bestaat_niet ADD COLUMN x INT`,          // faalt: 42P01
        `CREATE TABLE IF NOT EXISTS ddl_b (id INT PRIMARY KEY)`,  // moet daarna gewoon draaien
        `CREATE UNIQUE INDEX IF NOT EXISTS idx_ddl_b_id ON ddl_b(id)`,
    ]));

    assert.strictEqual(out.failures.length, 1, 'precies één statement hoort te falen');
    assert.strictEqual(out.failures[0].code, CODES.UNDEFINED_TABLE);
    assert.match(out.failures[0].sql, /ddl_bestaat_niet/);
    assert.deepStrictEqual(out.tolerated, []);
    // Luid: de fout én de samenvatting staan in de log.
    assert.ok(lines.some((l) => l.includes('[DDL:ddltest-basis]') && l.includes('42P01')), 'faalregel hoort gelogd te zijn');
    assert.ok(lines.some((l) => l.includes('1 van 5')), 'samenvattingsregel hoort gelogd te zijn');
    // De rest draaide door én is gecommit — vóór en ná het falende statement.
    assert.ok(await tableExists('ddl_a'), 'statement vóór de fout hoort gecommit te zijn');
    assert.ok(await tableExists('ddl_b'), 'statement ná de fout hoort gewoon te draaien');
    const idx = await rawQuery(`SELECT 1 FROM pg_indexes WHERE indexname = 'idx_ddl_b_id'`);
    assert.strictEqual(idx.rows.length, 1, 'ook de index ná de fout hoort te bestaan');
});

test('tolerate: verwachte SQLSTATE komt stil in tolerated, onverwachte blijft luid', async () => {
    await runDdl('ddltest-tolerate', [`CREATE TABLE IF NOT EXISTS ddl_c (x INT)`]);

    // Het mcpStore-patroon: ADD COLUMN zonder IF NOT EXISTS, de verwachte
    // duplicate_column is het idempotentie-mechanisme en hoort stil te zijn.
    const eerste = await captureErrors(() => runDdl('ddltest-tolerate', [
        { sql: `ALTER TABLE ddl_c ADD COLUMN x INT`, tolerate: CODES.DUPLICATE_COLUMN, reden: 'kolom bestaat al — verwacht' },
    ]));
    assert.deepStrictEqual(eerste.out.failures, []);
    assert.strictEqual(eerste.out.tolerated.length, 1);
    assert.strictEqual(eerste.out.tolerated[0].code, CODES.DUPLICATE_COLUMN);
    assert.strictEqual(eerste.out.tolerated[0].reden, 'kolom bestaat al — verwacht');
    assert.deepStrictEqual(eerste.lines, [], 'een getolereerde fout hoort géén logregel te geven');

    // Maar een ANDERE fout op zo'n statement blijft een luide failure —
    // tolerate is een verwachte code, geen catch {}.
    const tweede = await captureErrors(() => runDdl('ddltest-tolerate', [
        { sql: `ALTER TABLE ddl_bestaat_niet ADD COLUMN x INT`, tolerate: CODES.DUPLICATE_COLUMN },
    ]));
    assert.strictEqual(tweede.out.failures.length, 1);
    assert.strictEqual(tweede.out.failures[0].code, CODES.UNDEFINED_TABLE);
    assert.ok(tweede.lines.length >= 1, 'de onverwachte fout hoort wél gelogd te zijn');
});

test('twee gelijktijdige aanroepen met dezelfde tag draaien strikt na elkaar', async () => {
    // NB: op één pglite-verbinding bewijst dit de in-proces wachtrij (die er
    // óók voor zorgt dat twee transacties nooit één verbinding delen); de
    // cross-proces uitsluiting is de advisory lock — zie de header.
    await runDdl('ddltest-serial', [
        `CREATE TABLE IF NOT EXISTS ddl_volgorde (id SERIAL PRIMARY KEY, aanroep TEXT NOT NULL)`,
    ]);
    const a = runDdl('ddltest-serial', [
        `INSERT INTO ddl_volgorde (aanroep) VALUES ('A')`,
        `INSERT INTO ddl_volgorde (aanroep) VALUES ('A')`,
        `INSERT INTO ddl_volgorde (aanroep) VALUES ('A')`,
    ]);
    const b = runDdl('ddltest-serial', [
        `INSERT INTO ddl_volgorde (aanroep) VALUES ('B')`,
        `INSERT INTO ddl_volgorde (aanroep) VALUES ('B')`,
        `INSERT INTO ddl_volgorde (aanroep) VALUES ('B')`,
    ]);
    const [ra, rb] = await Promise.all([a, b]);
    assert.deepStrictEqual(ra.failures, []);
    assert.deepStrictEqual(rb.failures, []);
    const rows = (await rawQuery(`SELECT aanroep FROM ddl_volgorde ORDER BY id`)).rows.map((r) => r.aanroep);
    assert.deepStrictEqual(rows, ['A', 'A', 'A', 'B', 'B', 'B'],
        'de tweede aanroep hoort pas te beginnen als de eerste volledig klaar is');
});

test('verbindingsfout (geen SQLSTATE) rejict de hele aanroep en rolt terug', async () => {
    await assert.rejects(
        () => runDdl('ddltest-verbinding', [
            `CREATE TABLE ddl_weg (id INT)`,
            BOOM, // rejectie zonder SQLSTATE — zie rawQuery
            `CREATE TABLE ddl_nooit (id INT)`,
        ]),
        /Connection terminated/,
        'zonder serverantwoord hoort runDdl hard te falen, niet te verzamelen');
    // De transactie is teruggerold: ook het statement vóór de klap is weg.
    assert.strictEqual(await tableExists('ddl_weg'), false, 'ROLLBACK hoort het eerdere statement mee te nemen');
    assert.strictEqual(await tableExists('ddl_nooit'), false);
    // En de wachtrij is niet vergiftigd: een volgende aanroep draait gewoon.
    const na = await runDdl('ddltest-verbinding', [`CREATE TABLE IF NOT EXISTS ddl_daarna (id INT)`]);
    assert.deepStrictEqual(na.failures, []);
    assert.ok(await tableExists('ddl_daarna'));
});

test('kapotte invoer faalt meteen en synchroon', () => {
    assert.throws(() => runDdl('', ['SELECT 1']), TypeError);
    assert.throws(() => runDdl('x', [{ geen: 'sql' }]), TypeError);
    assert.throws(() => runDdl('x', ['SELECT 1'], { lockTimeout: "15s'; DROP TABLE users; --" }), TypeError,
        'lockTimeout wordt geïnterpoleerd en moet dus gevalideerd zijn');
});
