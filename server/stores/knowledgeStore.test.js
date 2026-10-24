'use strict';

/**
 * Guard tests for the WITHDRAWN knowledge store (Track Z, Z5).
 *
 * The per-agent knowledge router (/agents/:id/knowledge) and the CRUD of this store have been
 * demolished; stores/knowledgeStore.js is now only a documented stub with a no-op
 * initDB, because migrateDb.js still registers it. These tests are the proof
 * that it STAYS demolished: they bite on a re-mount of the router, on a
 * reintroduced CRUD method and on any new SQL statement against knowledge_metadata.
 *
 * Static and DB-free on purpose (same style as migrateDb.registration.test.js):
 * absence is a textual fact about the tree, not runtime behaviour, and requiring
 * the fleet would only produce noise here.
 *
 * Run: cd server && timeout 300 node --test --test-reporter=tap stores/knowledgeStore.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SERVER = path.join(__dirname, '..');
const STUB = path.join(__dirname, 'knowledgeStore.js');

/** The seven CRUD names that disappeared with the router and may not come back. */
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
 * Matches a require of the withdrawn knowledge router.
 *
 * DELIBERATELY a regex and nowhere a string literal with that path in it: the repo-wide guard
 * importPaths.test.js strips comments but DOES scan string literals in code, and
 * therefore reported `stores/knowledgeStore.test.js  ->  ./routes/knowledge` as an unresolvable
 * relative import (that path no longer exists, and from here would moreover point to
 * stores/routes/knowledge). Its final assertion is a deepStrictEqual on the whole
 * list, so that one line kept BFSF-127's guard permanently red. This regex proves
 * exactly the same thing — the PATTERNS of that guard do not match it, because after `require`
 * there is a backslash here and not an opening parenthesis.
 *
 * The closing quote right after `knowledge` keeps it from matching routes/knowledgeBases.
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

    // Genuinely textual, as the file header says: the absence of DDL is
    // a textual fact, not behaviour to run. Also no schema any more: if
    // the CREATE TABLE stayed, the migration ladder would silently
    // recreate knowledge_metadata after the owner's drop.
    const src = fs.readFileSync(STUB, 'utf8');
    assert.ok(!/CREATE\s+TABLE/i.test(src), 'de stub mag geen DDL meer bezitten — anders hermaakt de ladder de ingetrokken tabel');
});

test('er bestaat geen pad meer waarlangs een item van agent A via een andere agent verwijderd kan worden: geen SQL tegen knowledge_metadata en geen HTTP-oppervlak', () => {
    // The old BOLA: routes/knowledge.js gated on the agent, but the store did
    // `DELETE FROM knowledge_metadata WHERE id = $1` without agent_id — an item id
    // of agent B could thus be deleted just fine via agent A. That class of error cannot
    // return as long as no single statement against the table exists any more.
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

    // Wider: no other runtime source may load it either.
    const remounts = runtimeSources()
        .filter(({ src }) => MOUNT_RE.test(src))
        .map(({ rel }) => rel);
    assert.deepStrictEqual(remounts, [], 'deze bestanden laden de ingetrokken kennis-router nog');
});

test('niets requiret de store nog, behalve de STORE_MODULES-entry in migrateDb.js', () => {
    // migrateDb.js:54 registers './stores/knowledgeStore' dynamically (not a literal
    // require) and keeps doing so until the OWNER has dropped the table; after that
    // that entry and this file may go together. Any other caller is a regression.
    const ALLOWED = new Set(['migrateDb.js']);
    const callers = runtimeSources()
        .filter(({ src }) => /require\(\s*['"][^'"]*stores\/knowledgeStore['"]\s*\)/.test(src))
        .map(({ rel }) => rel)
        .filter((rel) => !ALLOWED.has(rel));
    assert.deepStrictEqual(callers, [],
        'de knowledge-store is een lege stub — code die hem requiret verwacht CRUD die niet meer bestaat');
});
