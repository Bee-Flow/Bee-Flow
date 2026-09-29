// @typecheck
/**
 * stores/lib/_ddl.js — luide, geserialiseerde boot-DDL voor stores.
 *
 * WAAROM. De store-inits droegen ~250 `try { await exec(...) } catch (e) {}`
 * blokken met als commentaar "column already exists". Maar zo'n catch slikt
 * ÁLLES: de poolbrede statement_timeout van 30s (db.js), een afgebroken
 * lock-wait, een verbroken verbinding — elke fout las als "bestond al" en de
 * store meldde zich gezond terwijl het schema half af was. Deze helper draait
 * dezelfde statements, maar verzamelt fouten per statement in een luide
 * failures-lijst in plaats van ze te verzwelgen.
 *
 * WERKING (per aanroep één transactie):
 *   1. `SELECT pg_advisory_xact_lock(hashtext('beeflow:ddl:<tag>'))` — hetzelfde
 *      idioom als configStore.mutateConfig: xact-scoped, komt automatisch vrij
 *      op COMMIT/ROLLBACK, en serialiseert de DDL van déze store over ALLE
 *      replicas heen. (De in-proces _schemaQueue in db.js dekte maar één proces
 *      en triggerde bovendien alleen op de substrings CREATE TABLE/ALTER TABLE/
 *      CREATE INDEX — 'CREATE UNIQUE INDEX', 'DROP TABLE' en 'CREATE EXTENSION'
 *      passeerden hem, de waargenomen pg_class-race.)
 *   2. `SET LOCAL lock_timeout = '15s'` — ruim maar eindig. Boot-DDL mag even
 *      wachten achter een drukke tabel, maar een boot mag nooit onbeperkt
 *      hangen achter andermans lock; met lock_timeout faalt de wachtende
 *      statement eerder en met een duidelijke fout (55P03) in plaats van pas
 *      op de 30s statement_timeout. SET LOCAL geldt alleen binnen deze
 *      transactie, dus het poolbrede gedrag verandert niet.
 *   3. Elk statement onder een SAVEPOINT: één falend statement wordt
 *      teruggerold en genoteerd, de rest draait door en commit gewoon.
 *
 * FOUTSEMANTIEK.
 *   - SQLSTATE-fout (de server antwoordde; db.isSqlStateError): entry in
 *     `failures` + console.error, de rest van de lijst draait door.
 *   - Verwachte SQLSTATE (per statement opgegeven via `tolerate`): entry in
 *     `tolerated`, géén log. Dit is voor statements waar de oude catch het
 *     idempotentie-mechanisme WAS (bv. ADD COLUMN zonder IF NOT EXISTS die op
 *     duplicate_column rekent) — alleen precies die code is stil, al het
 *     andere blijft luid.
 *   - Verbindingsfout (geen SQLSTATE): de hele aanroep rejict. De store-init
 *     faalt dan en de promise-memo probeert het bij de volgende aanroep
 *     opnieuw — nooit half-gezond doorstarten op een dode verbinding.
 *
 * IN-PROCES WACHTRIJ. Alle runDdl-aanroepen in dit proces draaien één voor één
 * (zoals db.js' _schemaQueue): boot-DDL hoort de pool niet leeg te trekken, en
 * testomgevingen met één verbinding (pglite achter de db.js-mock van
 * migrateDb.integration.test.js) kunnen geen twee overlappende
 * BEGIN/SAVEPOINT-reeksen aan. Wederzijdse uitsluiting TUSSEN processen komt
 * van de advisory lock en is met pglite (één verbinding) niet te bewijzen —
 * dat blijft handmatige verificatie, zie de colocated test.
 *
 * Leunt uitsluitend op de db.js-facade (withTransaction, isSqlStateError) —
 * geen eigen Pool, geen pg-import — zodat de pglite-mock van de
 * integratietests alles dekt. Voor DB-loze stub-facades (hermetische
 * storetests) valt hij terug op sequentiële exec-statements: zie _dbFacade.
 *
 * ── RUNBOOKREGEL: CREATE INDEX CONCURRENTLY op volumetabellen ──────────────
 * Een NIEUWE index op een tabel die al groot is hoort NIET in boot-DDL: de
 * bouw houdt de tabel vast (of loopt hier op de 30s statement_timeout stuk)
 * en elke pod herhaalt de poging bij elke boot. Zo'n index wordt éénmalig
 * handmatig gezet met `CREATE INDEX CONCURRENTLY` (buiten transactie, via het
 * runbook), en daarna desgewenst als `IF NOT EXISTS` in de boot-DDL
 * bijgeschreven zodat verse installaties hem ook krijgen — op een lege tabel
 * is die bouw gratis. Dit geldt in elk geval voor de tabellen zonder (of met
 * beperkte) retentie die in de praktijk groot worden:
 *   ai_usage_log, automation_runs, automation_run_steps, conversation_messages,
 *   cowork_runs, notifications, integration_activity_log, guardrail_events,
 *   ai_task_termination_log, azure_service_usage_log, access_audit_log,
 *   consent_acceptances, subscription_audit_log, support_messages,
 *   support_audit_log.
 * De boot-indexen die daar al staan dateren van vóór deze regel (idempotent,
 * bestaan al op draaiende installaties); er komen geen nieuwe bij via boot.
 */

'use strict';
const log = require('../../telemetry/log');

/**
 * De db-facade wordt LAZY en via twee routes opgelost, zodat runDdl onder
 * álle testpatronen van deze repo dezelfde facade ziet als de store die hem
 * aanroept:
 *   1. `require('../db')` — bestaat op schijf niet (stores/db.js), maar de
 *      hermetische storetests onderscheppen precies dít request voor bestanden
 *      onder stores/ met een DB-loze stub (Module._resolveFilename-hook).
 *   2. `require('../../db')` — het echte db.js; ook het pad dat
 *      migrateDb.integration.test.js via require.cache door pglite vervangt.
 * Een stub zonder withTransaction (de hermetische tests) krijgt de
 * SEQUENTIËLE variant hieronder: per statement via db.exec, zonder lock of
 * transactie — daar is geen database, dus ook niets te serialiseren. Het
 * echte db.js exporteert withTransaction altijd, dus productie draait altijd
 * de gelockte transactievariant.
 */
function _dbFacade() {
    try {
        // @ts-ignore -- resolves only where a hermetic test intercepts it; the fallback is the real module
        return require('../db');
    } catch (_) {
        return require('../../db');
    }
}

// Fallback-predicaat voor stubs die isSqlStateError niet exporteren.
function _isSqlStateErrorFallback(err) {
    return typeof err?.code === 'string' && /^[0-9A-Z]{5}$/.test(err.code);
}

// Veelgebruikte SQLSTATE-codes voor `tolerate` — met naam, zodat de bedoeling
// op de plek van gebruik leesbaar blijft.
const CODES = Object.freeze({
    DUPLICATE_COLUMN: '42701',   // ADD COLUMN zonder IF NOT EXISTS, kolom bestaat al
    DUPLICATE_TABLE: '42P07',    // relatie (tabel/index) bestaat al
    DUPLICATE_OBJECT: '42710',   // constraint/objectnaam bestaat al
    UNDEFINED_TABLE: '42P01',    // tabel bestaat (nog) niet
    UNDEFINED_COLUMN: '42703',   // kolom bestaat (nog) niet
    UNDEFINED_OBJECT: '42704',   // bv. operator class gin_trgm_ops zonder pg_trgm
    UNIQUE_VIOLATION: '23505',   // CREATE UNIQUE INDEX over bestaande duplicaten
    CHECK_VIOLATION: '23514',    // ADD CONSTRAINT ... CHECK over bestaande legacy-rijen
    FEATURE_NOT_SUPPORTED: '0A000', // bv. CREATE EXTENSION in een omgeving zonder die extensie
});

const DEFAULT_LOCK_TIMEOUT = '15s';
// Alleen een simpele duur — de waarde wordt (na validatie) letterlijk in
// SET LOCAL geïnterpoleerd, want SET accepteert geen bind-parameters.
const LOCK_TIMEOUT_RE = /^\d+(ms|s|min)$/;
const LOCK_NS = 'beeflow:ddl:'; // eigen naamruimte naast configStore's kale sleutels

// Zelfde afkap-idee als db.js' _sanitizeSql: genoeg om het statement te
// herkennen, nooit hele DDL-lappen in de log.
function _prefix(sql) {
    return String(sql).replace(/\s+/g, ' ').trim().slice(0, 160);
}

function _normalize(s) {
    if (typeof s === 'string') return { sql: s, tolerate: [] };
    if (s && typeof s.sql === 'string') {
        const tol = s.tolerate == null ? [] : (Array.isArray(s.tolerate) ? s.tolerate : [s.tolerate]);
        return { sql: s.sql, tolerate: tol, reden: s.reden };
    }
    throw new TypeError('runDdl: statement moet een SQL-string of { sql, tolerate?, reden? } zijn');
}

function _isTolerated(tolerate, err) {
    return tolerate.some((t) => (t instanceof RegExp ? t.test(err.message || '') : t === err.code));
}

async function _runLocked(tag, list, lockTimeout) {
    const db = _dbFacade();
    const isSqlStateError = typeof db.isSqlStateError === 'function' ? db.isSqlStateError : _isSqlStateErrorFallback;
    const failures = [];
    const tolerated = [];

    // Stub-omgeving zonder withTransaction (hermetische storetests): draai de
    // statements sequentieel via exec met dezelfde classificatie. Geen lock en
    // geen savepoints — er is daar geen echte database.
    if (typeof db.withTransaction !== 'function') {
        for (const stmt of list) {
            try {
                await db.exec(stmt.sql);
            } catch (err) {
                if (!isSqlStateError(err)) throw err;
                const entry = {
                    sql: _prefix(stmt.sql),
                    code: err.code,
                    message: err.message,
                    ...(stmt.reden ? { reden: stmt.reden } : {}),
                };
                if (_isTolerated(stmt.tolerate, err)) tolerated.push(entry);
                else {
                    failures.push(entry);
                    log.error(`[DDL:${tag}] statement gefaald (SQLSTATE ${err.code}): ${entry.sql} — ${err.message}`);
                }
            }
        }
        if (failures.length > 0) {
            log.error(`[DDL:${tag}] ${failures.length} van ${list.length} statements gefaald — schema mogelijk incompleet, zie de regels hierboven`);
        }
        return { tag, failures, tolerated };
    }

    await db.withTransaction(async (client) => {
        // Serialiseert dezelfde store over alle replicas; xact-scoped, dus
        // automatisch vrij op COMMIT/ROLLBACK. De wachttijd op deze lock valt
        // onder de poolbrede statement_timeout (30s) — een boot die zo lang
        // achter een andere replica aanhangt faalt luid en de memo retryt.
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [LOCK_NS + tag]);
        await client.query(`SET LOCAL lock_timeout = '${lockTimeout}'`);
        for (const stmt of list) {
            await client.query('SAVEPOINT beeflow_ddl_stmt');
            try {
                await client.query(stmt.sql);
                await client.query('RELEASE SAVEPOINT beeflow_ddl_stmt');
            } catch (err) {
                // Geen SQLSTATE = de server heeft nooit geantwoord (verbinding
                // weg, pool-timeout). Dan is ook de transactie onbruikbaar:
                // hard falen, zodat de store-init dit als échte fout ziet.
                if (!isSqlStateError(err)) throw err;
                await client.query('ROLLBACK TO SAVEPOINT beeflow_ddl_stmt');
                await client.query('RELEASE SAVEPOINT beeflow_ddl_stmt');
                const entry = {
                    sql: _prefix(stmt.sql),
                    code: err.code,
                    message: err.message,
                    ...(stmt.reden ? { reden: stmt.reden } : {}),
                };
                if (_isTolerated(stmt.tolerate, err)) {
                    tolerated.push(entry);
                } else {
                    failures.push(entry);
                    log.error(`[DDL:${tag}] statement gefaald (SQLSTATE ${err.code}): ${entry.sql} — ${err.message}`);
                }
            }
        }
    });
    if (failures.length > 0) {
        log.error(`[DDL:${tag}] ${failures.length} van ${list.length} statements gefaald — schema mogelijk incompleet, zie de regels hierboven`);
    }
    return { tag, failures, tolerated };
}

// Force-serialisatie binnen dit proces (zie header). De ketting slikt zelf
// nooit een fout in: elke aanroep krijgt zijn eigen rejectie terug.
let _queue = Promise.resolve();

/**
 * Draai een reeks schema-statements voor één store, geserialiseerd en luid.
 *
 * @param {string} tag - storenaam voor de lock én de logregels (bv. 'usageStore')
 * @param {(string|{sql: string, tolerate?: (string|RegExp)|Array<string|RegExp>, reden?: string})[]} statements
 *        SQL-strings, of objecten met verwachte SQLSTATE-codes (zie CODES) /
 *        message-RegExps in `tolerate` en een korte `reden` voor in het rapport.
 * @param {{ lockTimeout?: string }} [opts] - bv. { lockTimeout: '30s' }; default 15s.
 * @returns {Promise<{ tag: string, failures: Array<{sql,code,message,reden?}>, tolerated: Array<{sql,code,message,reden?}> }>}
 *          Rejict alléén op verbindingsfouten (of een mislukte lock/commit) —
 *          SQLSTATE-fouten komen als entries terug en zijn dan al gelogd.
 */
function runDdl(tag, statements, opts = {}) {
    if (typeof tag !== 'string' || tag.trim() === '') {
        throw new TypeError('runDdl: tag moet een niet-lege string zijn');
    }
    const list = (Array.isArray(statements) ? statements : [statements]).map(_normalize);
    const lockTimeout = opts.lockTimeout || DEFAULT_LOCK_TIMEOUT;
    if (!LOCK_TIMEOUT_RE.test(lockTimeout)) {
        throw new TypeError(`runDdl: ongeldige lockTimeout '${lockTimeout}' (verwacht bv. '500ms', '15s', '1min')`);
    }
    if (list.length === 0) return Promise.resolve({ tag, failures: [], tolerated: [] });
    const run = _queue.then(
        () => _runLocked(tag, list, lockTimeout),
        () => _runLocked(tag, list, lockTimeout)
    );
    _queue = run.then(() => undefined, () => undefined);
    return run;
}

module.exports = { runDdl, CODES, DEFAULT_LOCK_TIMEOUT };
