'use strict';

/**
 * Elke store die DDL bezit, staat in de migratieladder — afgedwongen.
 *
 * De sweep die deze test institutionaliseert vond 34 stores met CREATE TABLE
 * die `npm run db:migrate` nooit heeft gekend: de hele RAG-familie
 * (knowledge_bases, kb_sources), skills, webpagina's, uitnodigingen, de
 * complete compliance-hub. Niemand zag het, want de oude runner meldde
 * hoe dan ook succes. Vanaf nu is een nieuwe store met een CREATE TABLE die
 * niet in STORE_MODULES staat een RODE TEST met een aanwijzing, geen stil
 * ontbrekende tabel op de eerstvolgende verse installatie.
 *
 * Statisch en DB-vrij met opzet: registratie is een tekstueel feit (staat de
 * naam in de lijst), en de gedragskant — draait de ladder echt, is hij
 * idempotent — bewijst migrateDb.integration.test.js tegen echte Postgres.
 *
 * Run: cd server && node --test --test-force-exit migrateDb.registration.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

/**
 * Bewuste uitzonderingen, elk met de reden. Een entry hier is een claim die
 * een reviewer kan controleren — geen ontsnappingsluik zonder verhaal.
 */
const EXEMPT = new Map([
    // Per-tenant engines: hun CREATE TABLE draait per app/tenant op het moment
    // dat die tenant ontstaat, in een eigen schema — er bestaat geen globale
    // boot-DDL om hier af te wachten.
    ['stores/lib/pgAppEngine.js', 'per-tenant engine — DDL per app-schema, niet bij boot'],
    // Het schema van projectChatStore, eruit gesplitst; de store zelf staat in de ladder en draait het bij boot.
    ['stores/lib/projectChatSchema.js', 'schema van projectChatStore — DDL draait via die store (ladder)'],
    ['stores/lib/sqliteBlobEngine.js', 'per-tenant engine — sqlite-blob per app, geen Postgres-DDL'],
    // Bereikt via de automationStore-facade in de lijst: die exporteert core's
    // initDB, en de integratietest bewijst dat automations/automation_runs
    // na de ladder bestaan.
    ['stores/automationStore/core.js', 'gedekt via de automationStore-facade'],
    // Zelfde vorm: supportStore.js is sinds de opsplitsing een facade die
    // schema.js' initDB doorgeeft, en STORE_MODULES noemt die facade — de
    // ladder draait dit schema dus wel degelijk.
    ['stores/supportStore/schema.js', 'gedekt via de supportStore-facade'],
    // Idem: datatableStore.js is sinds de opsplitsing een facade die schema.js'
    // initDB doorgeeft, en STORE_MODULES noemt die facade — de ladder draait
    // dus wel degelijk de vier tabellen die dit bestand bezit.
    ['stores/datatableStore/schema.js', 'gedekt via de datatableStore-facade'],
    // Zelfde module, geen eigen schema: "CREATE TABLE" staat hier alleen in de
    // documentatie van createDatatable/deleteDatatable (de fysieke DDL wordt
    // door de aanroeper geïnjecteerd); de vier tabellen zelf staan in
    // datatableStore/schema.js hierboven.
    ['stores/datatableStore/datatables.js', 'noemt CREATE TABLE alleen in commentaar — het schema staat in datatableStore/schema.js'],
    // DDL-helper (U5): bezit zelf geen schema — de statements komen van de
    // aanroepende store, die zelf geregistreerd is; "CREATE TABLE" staat er
    // alleen in de documentatie van db.exec' substring-queue.
    ['stores/lib/_ddl.js', 'helper zonder eigen schema — draait DDL namens geregistreerde stores'],
    // Idem: de init-memo bezit geen tabel; "CREATE TABLE" staat alleen in de
    // uitleg van wat de schemaFn van een geregistreerde store doet.
    ['stores/lib/storeInit.js', 'memo zonder eigen schema — memoïseert de init van geregistreerde stores'],
]);

function ddlOwners(root) {
    const out = [];
    const walk = (dir) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const p = path.join(dir, e.name);
            if (e.isDirectory()) { walk(p); continue; }
            if (!e.name.endsWith('.js') || e.name.includes('.test.')) continue;
            const src = fs.readFileSync(p, 'utf8');
            if (/CREATE TABLE/.test(src)) out.push(path.relative(__dirname, p).replace(/\\/g, '/'));
        }
    };
    walk(root);
    return out.sort();
}

test('elke DDL-eigenaar onder stores/ staat in STORE_MODULES of is met reden vrijgesteld', () => {
    const src = fs.readFileSync(path.join(__dirname, 'storeModules.js'), 'utf8');
    const registered = new Set(
        [...src.matchAll(/file:\s*'\.\/(stores\/[^']+)'/g)].map((m) => `${m[1]}.js`),
    );
    assert.ok(registered.size >= 70, `verdacht kleine ladder (${registered.size}) — is STORE_MODULES herschreven?`);

    const missing = ddlOwners(path.join(__dirname, 'stores'))
        .filter((f) => !registered.has(f) && !EXEMPT.has(f));

    assert.deepStrictEqual(missing, [],
        'deze stores bezitten CREATE TABLE maar staan niet in storeModules.js STORE_MODULES.\n' +
        'Registreer ze daar (met een awaitbare module.exports.initDB), of zet ze met een\n' +
        'controleerbare reden in de EXEMPT-lijst van deze test.');
});

test('elke vrijstelling wijst nog naar een bestaand bestand', () => {
    for (const f of EXEMPT.keys()) {
        assert.ok(fs.existsSync(path.join(__dirname, f)), `EXEMPT wijst naar een verdwenen bestand: ${f}`);
    }
});

test('elke geregistreerde store bestaat en exporteert een awaitbare initDB', () => {
    // Statisch (geen require — dat zou heel de fleet laden): het bestand
    // bestaat, en het noemt initDB in zijn exports of definieert hem via
    // makeStoreInit. De echte await-garantie levert de integratietest.
    const src = fs.readFileSync(path.join(__dirname, 'storeModules.js'), 'utf8');
    const files = [...src.matchAll(/file:\s*'\.\/(stores\/[^']+)'/g)].map((m) => `${m[1]}.js`);
    for (const f of files) {
        const p = path.join(__dirname, f);
        assert.ok(fs.existsSync(p), `STORE_MODULES wijst naar een verdwenen bestand: ${f}`);
        // Genuinely textual, met opzet — zie de bestandskop: 70+ stores hier
        // echt vereisen zou de hele fleet laden; de echte await-garantie komt
        // van migrateDb.integration.test.js tegen echte Postgres.
        const s = fs.readFileSync(p, 'utf8');
        assert.ok(
            /module\.exports\.initDB\s*=|^\s*initDB,\s*$|initDB:\s*|^\s*ready:\s*|const initDB = makeStoreInit|function initDB\(/m.test(s),
            // ready: — mcpStore's vorm; de runner accepteert een ready-promise.
            `${f}: geen initDB te vinden — migrateDb kan hem dan alleen "laden", niet verifiëren`);
    }
});
