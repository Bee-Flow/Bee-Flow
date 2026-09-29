'use strict';

/**
 * Guard-tests bij de INGETROKKEN knowledge-store (Track Z, Z5).
 *
 * De per-agent kennis-router (/agents/:id/knowledge) en de CRUD van deze store zijn
 * gesloopt; stores/knowledgeStore.js is nog slechts een gedocumenteerde stub met een
 * no-op initDB, omdat migrateDb.js hem nog registreert. Deze tests zijn de bewijslast
 * dat het gesloopt BLIJFT: ze bijten op een her-mount van de router, op een
 * heringevoerde CRUD-methode en op elk nieuw SQL-statement tegen knowledge_metadata.
 *
 * Statisch en DB-vrij met opzet (dezelfde stijl als migrateDb.registration.test.js):
 * afwezigheid is een tekstueel feit over de boom, geen runtime-gedrag, en het require'n
 * van de fleet zou hier alleen ruis opleveren.
 *
 * Run: cd server && timeout 300 node --test --test-reporter=tap stores/knowledgeStore.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SERVER = path.join(__dirname, '..');
const STUB = path.join(__dirname, 'knowledgeStore.js');

/** De zeven CRUD-namen die met de router zijn verdwenen en niet terug mogen komen. */
const RETIRED_METHODS = [
    'addKnowledge',
    'listKnowledge',
    'searchKnowledge',
    'deleteKnowledge',
    'deleteBySource',
    'hasSource',
    'hasKnowledge',
];

/**
 * Matcht een require van de ingetrokken kennis-router.
 *
 * BEWUST een regex en nergens een stringliteral met dat pad erin: de repo-brede guard
 * importPaths.test.js strijkt commentaar weg maar scant wél stringliteralen in code, en
 * meldde daardoor `stores/knowledgeStore.test.js  ->  ./routes/knowledge` als onoplosbare
 * relatieve import (dat pad bestaat immers niet meer, en zou hiervandaan bovendien naar
 * stores/routes/knowledge wijzen). Zijn eindassertie is een deepStrictEqual op de hele
 * lijst, dus die ene regel hield BFSF-127's guard permanent rood. Deze regex bewijst
 * precies hetzelfde — de PATTERNS van die guard matchen hem niet, want na `require`
 * staat hier een backslash en geen haakje-openen.
 *
 * De sluitquote direct achter `knowledge` houdt hem af van routes/knowledgeBases.
 */
const MOUNT_RE = /require\(\s*['"][^'"]*routes\/knowledge['"]\s*\)/;

/** Alle runtime-bronnen onder server/ (recursief; node_modules en tests uitgesloten). */
function runtimeSources() {
    const out = [];
    const walk = (dir) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            if (e.name === 'node_modules' || e.name === '.git') continue;
            const p = path.join(dir, e.name);
            if (e.isDirectory()) { walk(p); continue; }
            if (!/\.(js|mjs|cjs)$/.test(e.name)) continue;
            if (/\.test\.(js|mjs|cjs)$/.test(e.name)) continue;
            out.push({ rel: path.relative(SERVER, p).replace(/\\/g, '/'), src: fs.readFileSync(p, 'utf8') });
        }
    };
    walk(SERVER);
    return out;
}

test('de stub exporteert een awaitbare initDB en geen enkele CRUD-methode meer', async () => {
    const mod = require('./knowledgeStore');

    assert.strictEqual(typeof mod.initDB, 'function', 'migrateDb kan een geregistreerde store alleen verifiëren als hij initDB exporteert');
    const ret = mod.initDB();
    assert.ok(ret && typeof ret.then === 'function', 'initDB moet awaitbaar zijn — de migratierunner awaitet hem');
    await ret;

    for (const name of RETIRED_METHODS) {
        assert.strictEqual(mod[name], undefined, `${name} is ingetrokken en mag niet terugkeren op de stub`);
    }
    assert.deepStrictEqual(Object.keys(mod).sort(), ['initDB'],
        'de stub hoort niets anders te exporteren dan initDB');

    // Genuinely textual, zoals de bestandskop zegt: afwezigheid van DDL is
    // een tekstueel feit, geen gedrag om te draaien. Ook geen schema meer: zou
    // de CREATE TABLE blijven staan, dan maakt de migratieladder
    // knowledge_metadata na de drop van de eigenaar stil opnieuw aan.
    const src = fs.readFileSync(STUB, 'utf8');
    assert.ok(!/CREATE\s+TABLE/i.test(src), 'de stub mag geen DDL meer bezitten — anders hermaakt de ladder de ingetrokken tabel');
});

test('er bestaat geen pad meer waarlangs een item van agent A via een andere agent verwijderd kan worden: geen SQL tegen knowledge_metadata en geen HTTP-oppervlak', () => {
    // De oude BOLA: routes/knowledge.js gate'de op de agent, maar de store deed
    // `DELETE FROM knowledge_metadata WHERE id = $1` zonder agent_id — een item-id
    // van agent B verwijderde dus prima via agent A. Die klasse fout kan niet
    // terugkeren zolang er geen enkel statement tegen de tabel meer bestaat.
    const offenders = [];
    for (const { rel, src } of runtimeSources()) {
        if (/\bDELETE\s+FROM\s+knowledge_metadata\b/i.test(src)) offenders.push(`${rel}: DELETE FROM knowledge_metadata`);
        if (/\bFROM\s+knowledge_metadata\b/i.test(src)) offenders.push(`${rel}: FROM knowledge_metadata`);
        if (/\bINTO\s+knowledge_metadata\b/i.test(src)) offenders.push(`${rel}: INTO knowledge_metadata`);
        if (/\bUPDATE\s+knowledge_metadata\b/i.test(src)) offenders.push(`${rel}: UPDATE knowledge_metadata`);
    }
    assert.deepStrictEqual(offenders, [],
        'knowledge_metadata is ingetrokken: geen runtime-bron onder server/ mag er nog tegen queryen.\n' +
        'Komt er weer een SELECT/INSERT/UPDATE/DELETE, dan komt ook het ongescopete verwijderpad terug.');
});

test('de ingetrokken router is weg en is nergens opnieuw gemount', () => {
    assert.ok(!fs.existsSync(path.join(SERVER, 'routes', 'knowledge.js')),
        'routes/knowledge.js is ingetrokken (Track Z, Z5) — de Studio-KB\'s leven op /api/kb');

    // Genuinely textual: index.js calls app.listen() unconditionally at
    // module scope (see compliance/dataPortability/exportRegistry.test.js
    // for the same constraint), so it is never require()'d in a test.
    const index = fs.readFileSync(path.join(SERVER, 'index.js'), 'utf8');
    assert.ok(!MOUNT_RE.test(index),
        'server/index.js mount de ingetrokken kennis-router opnieuw — /agents/:id/knowledge hoort niet te bestaan');

    // Breder: ook geen andere runtime-bron mag hem nog laden.
    const remounts = runtimeSources()
        .filter(({ src }) => MOUNT_RE.test(src))
        .map(({ rel }) => rel);
    assert.deepStrictEqual(remounts, [], 'deze bestanden laden de ingetrokken kennis-router nog');
});

test('niets requiret de store nog, behalve de STORE_MODULES-entry in migrateDb.js', () => {
    // migrateDb.js:54 registreert './stores/knowledgeStore' dynamisch (geen letterlijke
    // require) en blijft dat doen tot de EIGENAAR de tabel heeft gedropt; daarna mogen
    // die entry en dit bestand samen weg. Elke andere aanroeper is een regressie.
    const ALLOWED = new Set(['migrateDb.js']);
    const callers = runtimeSources()
        .filter(({ src }) => /require\(\s*['"][^'"]*stores\/knowledgeStore['"]\s*\)/.test(src))
        .map(({ rel }) => rel)
        .filter((rel) => !ALLOWED.has(rel));
    assert.deepStrictEqual(callers, [],
        'de knowledge-store is een lege stub — code die hem requiret verwacht CRUD die niet meer bestaat');
});
