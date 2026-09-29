'use strict';

/**
 * /api/health/schema — degradeert, crasht nooit, lekt niets.
 *
 * De db.js-facade wordt vóór het requiren van de router gestubd via
 * require.cache (zelfde patroon als migrateDb.integration.test.js), zodat elke
 * case zelf bepaalt wat "de database" antwoordt — inclusief helemaal niet.
 * De router draait op een ephemeral poort (patroon: routes/maintenance.test.js).
 *
 * Run: cd server && node --test --test-force-exit routes/healthSchema.test.js
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const Module = require('node:module');
const express = require('express');

// De stempel moet in deze suite deterministisch 'dev' zijn.
delete process.env.APP_BUILD_SHA;

// ── db.js-stub, geïnstalleerd vóór de router hem kan requiren ──────────────
let getAllImpl = async () => { throw new Error('stub zonder implementatie'); };
let dbCalls = 0;

function mock(absId, exportsObj) {
    const p = require.resolve(absId);
    const m = new Module(p);
    m.exports = exportsObj;
    m.loaded = true;
    require.cache[p] = m;
}

mock(path.join(__dirname, '..', 'db.js'), {
    getAll: (...args) => { dbCalls++; return getAllImpl(...args); },
});

const router = require('./healthSchema');

let server, base;

before(async () => {
    const app = express();
    app.use('/api/health/schema', router);
    await new Promise((resolve) => { server = app.listen(0, resolve); });
    base = `http://127.0.0.1:${server.address().port}/api/health/schema`;
});

after(() => new Promise((resolve) => server.close(resolve)));

function reset() {
    router._resetCache();
    dbCalls = 0;
}

const ALL_TABLES = ['users', 'agents', 'automations', 'direct_conversations'];

// ── Gezond schema ──────────────────────────────────────────────────────────

test('alle sentinel-tabellen aanwezig ⇒ 200 { ok:true, schemaReady:true, build }', async () => {
    reset();
    getAllImpl = async () => ALL_TABLES.map((t) => ({ table_name: t }));
    const res = await fetch(base);
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(await res.json(), { ok: true, schemaReady: true, build: 'dev' });
});

// ── Ongemigreerd schema ────────────────────────────────────────────────────

test('ontbrekende kerntabel ⇒ ok:true maar schemaReady:false — en géén tabelnamen in de response', async () => {
    reset();
    getAllImpl = async () => ALL_TABLES.filter((t) => t !== 'direct_conversations')
        .map((t) => ({ table_name: t }));
    const res = await fetch(base);
    assert.strictEqual(res.status, 200);
    const raw = await res.text();
    assert.deepStrictEqual(JSON.parse(raw), { ok: true, schemaReady: false, build: 'dev' });
    for (const t of ALL_TABLES) {
        assert.ok(!raw.includes(t), `het ongeauthenticeerde endpoint mag tabelnaam "${t}" niet prijsgeven`);
    }
});

// ── Onbereikbare database ──────────────────────────────────────────────────

test('database onbereikbaar ⇒ 200 { ok:false, schemaReady:false } zonder fouttekst — nooit een 500', async () => {
    reset();
    const err = new Error('connect ECONNREFUSED 10.0.0.7:5432');
    err.code = 'ECONNREFUSED';
    getAllImpl = async () => { throw err; };

    const res = await fetch(base);
    assert.strictEqual(res.status, 200, 'de probe degradeert, hij crasht niet');
    const raw = await res.text();
    assert.deepStrictEqual(JSON.parse(raw), { ok: false, schemaReady: false, build: 'dev' });
    for (const leak of ['ECONNREFUSED', '10.0.0.7', '5432', 'connect', ...ALL_TABLES]) {
        assert.ok(!raw.includes(leak), `responsedetail gelekt: ${leak}`);
    }
});

test('een synchroon werpende facade degradeert net zo netjes', async () => {
    reset();
    // Niet elke fout is een nette async rejection; ook een throw vóór de
    // eerste await mag het endpoint niet omleggen.
    getAllImpl = () => { throw new Error('pool is exhausted'); };
    const res = await fetch(base);
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(await res.json(), { ok: false, schemaReady: false, build: 'dev' });
});

// ── De 30s-cache ───────────────────────────────────────────────────────────

test('de uitkomst wordt in-proces gecachet: twee polls, één query', async () => {
    reset();
    getAllImpl = async () => ALL_TABLES.map((t) => ({ table_name: t }));
    await fetch(base);
    await fetch(base);
    assert.strictEqual(dbCalls, 1, 'binnen de TTL hoort de database maar één keer geraakt te worden');
});

test('ook een mislukking wordt gecachet — een liveness-loop hamert niet op een zieke database', async () => {
    reset();
    getAllImpl = async () => { throw new Error('down'); };
    const first = await (await fetch(base)).json();
    const second = await (await fetch(base)).json();
    assert.deepStrictEqual(first, second);
    assert.strictEqual(dbCalls, 1);
});

test('gelijktijdige polls delen één in-flight query', async () => {
    reset();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    getAllImpl = async () => { await gate; return ALL_TABLES.map((t) => ({ table_name: t })); };

    const inflight = Promise.all([fetch(base), fetch(base), fetch(base)]);
    release();
    const bodies = await Promise.all((await inflight).map((r) => r.json()));
    assert.strictEqual(dbCalls, 1);
    for (const b of bodies) assert.deepStrictEqual(b, { ok: true, schemaReady: true, build: 'dev' });
});
