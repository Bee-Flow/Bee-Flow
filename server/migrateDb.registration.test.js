// @typecheck
'use strict';

/**
 * Every store that owns DDL is in the migration ladder — enforced.
 *
 * The sweep that this test institutionalises found 34 stores with CREATE TABLE that
 * `npm run db:migrate` had never known: the whole RAG family (knowledge_bases, kb_sources), skills,
 * webpages, invitations, the complete compliance hub. Nobody saw it, because the old runner reported
 * success regardless. From now on a new store with a CREATE TABLE that is not in STORE_MODULES is a
 * RED TEST with a hint, not a silently missing table on the next fresh installation.
 *
 * Static and DB-free on purpose: registration is a textual fact (is the name in the list), and the
 * behavioural side — does the ladder really run, is it idempotent — is proven by
 * migrateDb.integration.test.js against real Postgres.
 *
 * Run: cd server && node --test --test-force-exit migrateDb.registration.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

/**
 * Deliberate exceptions, each with the reason. An entry here is a claim that a
 * reviewer can check — not an escape hatch without a story.
 */
const EXEMPT = new Map([
    // Per-tenant engines: their CREATE TABLE runs per app/tenant at the moment that
    // tenant comes into being, in a schema of its own — there is no global boot DDL to await here.
    ['stores/lib/pgAppEngine.js', 'per-tenant engine — DDL per app-schema, niet bij boot'],
    ['stores/lib/pgAppEnginePartsTx.js', 'per-tenant engine (migration part) — DDL per app-schema, niet bij boot'],
    // Het schema van projectChatStore, eruit gesplitst; de store zelf staat in de ladder en draait het bij boot.
    // initSchema.js (the agentStore ladder entry) is a facade since LF-S3: it runs
    // these two parts in order, so the ladder still executes all of their DDL.
    ['stores/agent/initSchema.base.js', 'DDL of stores/agent/initSchema.js — run by its initDB (agent schema facade)'],
    ['stores/agent/initSchema.agents.js', 'DDL of stores/agent/initSchema.js — run by its initDB (agent schema facade)'],
    // DDL of projectAiParticipationStore / projectTaskStore, split out of them
    // (LF-S2); each store requires its DDL and is itself in STORE_MODULES.
    ['stores/projectAiParticipationDdl.js', 'DDL of projectAiParticipationStore — covered via that store (ladder)'],
    ['stores/projectTaskDdl.js', 'DDL of projectTaskStore — covered via that store (ladder)'],
    ['stores/lib/projectChatSchema.js', 'schema van projectChatStore — DDL draait via die store (ladder)'],
    ['stores/lib/automationTestingSchema.js', 'schema of automationTestingStore: its DDL runs via that store (ladder)'],
    ['stores/lib/sqliteBlobEngine.js', 'per-tenant engine — sqlite-blob per app, geen Postgres-DDL'],
    ['stores/lib/sqliteBlobStatements.js', 'statement API of the sqlite-blob engine — names CREATE TABLE only in a comment'],
    // The user store's statement lists, split out of stores/user/schema.js:
    // that file's initDB runs them, reached through the userStore facade.
    ['stores/user/schemaTables.js', 'DDL of stores/user/schema.js — run by its initDB (userStore facade)'],
    ['stores/user/schemaMigrations.js', 'DDL of stores/user/schema.js — run by its initDB (userStore facade)'],
    ['stores/user/planMigrations.js', 'DDL of stores/user/schema.js — run by its initDB (userStore facade)'],
    // Bereikt via de automationStore-facade in de lijst: die exporteert core's
    // initDB, en de integratietest bewijst dat automations/automation_runs
    // na de ladder bestaan.
    ['stores/automationStore/core.js', 'gedekt via de automationStore-facade'],
    // Same form: supportStore.js has, since the split, been a facade that passes on
    // schema.js' initDB, and STORE_MODULES names that facade — so the ladder does run
    // this schema.
    ['stores/supportStore/schema.js', 'gedekt via de supportStore-facade'],
    // Idem: datatableStore.js has, since the split, been a facade that passes on schema.js'
    // initDB, and STORE_MODULES names that facade — so the ladder does run
    // the four tables that this file owns.
    ['stores/datatableStore/schema.js', 'gedekt via de datatableStore-facade'],
    // Idem: blueprintStore.js is sinds de opsplitsing (golf 1) een facade die
    // blueprint/schema.js' initDB doorgeeft.
    ['stores/blueprint/schema.js', 'gedekt via de blueprintStore-facade'],
    // Same for the skill store: skillStore.js re-exports stores/skill/schema.js's initDB.
    ['stores/skill/schema.js', 'covered via the skillStore facade'],
    // Idem for the stores that became a facade in the second split wave: every
    // facade below is in STORE_MODULES and exports the initDB of its schema module (makeStoreInit or
    // passed on directly), so the ladder still runs this DDL via that facade, in the same order.
    ['stores/compliance/schema.js', 'gedekt via de complianceStore-facade'],
    // FINDING_DDL is executed by compliance/schema.js (createSchema), not here.
    ['stores/compliance/findings.js', 'bezit FINDING_DDL, uitgevoerd door compliance/schema.js — gedekt via de complianceStore-facade'],
    ['stores/compliance/settingsFields.js', 'noemt CREATE TABLE alleen in commentaar — het schema staat in compliance/schema.js'],
    ['stores/kb/schema.js', 'gedekt via de knowledgeBases-facade'],
    ['stores/memorySchema.js', 'gedekt via de memoryStore-facade'],
    ['stores/notebook/schema.js', 'gedekt via de notebookStore-facade'],
    ['stores/project/schema.js', 'gedekt via de projectStore-facade'],
    ['stores/studioApp/schema.js', 'gedekt via de studioAppStore-facade'],
    ['stores/studioAppData/schema.js', 'gedekt via de studioAppDataStore-facade'],
    // Classifies dataModel migration statements: "CREATE TABLE" appears here in
    // a regex and in comments, not in a schema of its own.
    ['stores/studioAppData/dataModel.js', 'herkent CREATE TABLE alleen in een regex — het schema staat in studioAppData/schema.js'],
    ['stores/transcription/schema.js', 'gedekt via de transcriptionStore-facade'],
    ['stores/usage/schema.js', 'gedekt via de usageStore-facade'],
    // Same module, no schema of its own: "CREATE TABLE" appears here only in the
    // documentation of createDatatable/deleteDatatable (the physical DDL is
    // injected by the caller); the four tables themselves are in
    // datatableStore/schema.js above.
    ['stores/datatableStore/datatables.js', 'noemt CREATE TABLE alleen in commentaar — het schema staat in datatableStore/schema.js'],
    // DDL helper (U5): owns no schema itself — the statements come from the calling
    // store, which is itself registered; "CREATE TABLE" appears there only in the
    // documentation of db.exec's substring queue.
    ['stores/lib/_ddl.js', 'helper zonder eigen schema — draait DDL namens geregistreerde stores'],
    // Idem: the init memo owns no table; "CREATE TABLE" appears only in the
    // explanation of what the schemaFn of a registered store does.
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
    // Static (no require — that would load the whole fleet): the file
    // exists, and it names initDB in its exports or defines it via
    // makeStoreInit. The real await guarantee is supplied by the integration test.
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
