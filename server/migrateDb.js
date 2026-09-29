#!/usr/bin/env node
/**
 * Database Migration Runner — en sinds U1 doet hij dat ook echt.
 *
 * De oude versie deed synchroon `require(store)` en meldde meteen ✅: elke
 * store startte zijn initDB toen als niet-afgewachte promise bij module-load,
 * dus het script eindigde met exit 0 vóór er ook maar één CREATE TABLE was
 * uitgevoerd — aantoonbaar, tegen een echte Postgres (zie PLAN-APP-UPGRADE.md).
 * Die load-time-start bestaat niet meer (boot/storeSchemas.js doet het nu
 * expliciet), dus requiren alléén zou hier helemaal niets meer doen. Nu:
 *
 *   - elke store wordt AFGEWACHT via zijn gememoiseerde initDB()/ready
 *     (de promise-memo verhelpt meteen de pg_class-race van twee parallelle
 *     identieke CREATE TABLE IF NOT EXISTS);
 *   - de boot-migratieladder (losse datamigraties + NL-catalogi uit
 *     boot/bootMigrations.js) draait hier OOK — dat was precies de categorie
 *     die "npm run db:migrate" altijd oversloeg;
 *   - falen is luid: exit 1 met de namen; een store zonder awaitbare ingang
 *     telt als NIET GEVERIFIEERD en wordt genoemd in plaats van goedgepraat.
 *
 * De store-DDL is idempotent en draait bij elke aanroep; de boot-ladder
 * (datamigraties + NL-catalogi) staat in de `schema_migrations`-ledger van
 * boot/bootMigrations.js en wordt overgeslagen zodra hij geregistreerd is.
 * Een bestaande installatie draait die ladder de eerste keer nog één keer
 * volledig (idempotent) en registreert hem dan.
 *
 * Usage:
 *   node migrateDb.js                    # alles, exit 1 bij enige fout
 *   node migrateDb.js --force            # ook de geregistreerde boot-ladder opnieuw
 *   npm run db:migrate                   # hetzelfde
 *   docker exec beeflow-server node migrateDb.js
 *   MIGRATE_TIMEOUT_MS=1200000 node migrateDb.js   # ruimere waakhond
 */

const path = require('path');
const { STORE_MODULES, collectStoreModules } = require('./storeModules');

// Load env vars from project-root .env so npm run db:migrate / direct node calls
// see DATABASE_URL / CORE_DATABASE_URL / MONITORING_DATABASE_URL.
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });


/**
 * Draai de volledige ladder: user_sessions, elke store AFGEWACHT, en daarna
 * de boot-migraties (losse datamigraties + NL-catalogi). Gooit zelf niet —
 * de aanroeper leest het rapport en beslist over de exitcode.
 *
 * @returns {Promise<{succeeded: string[], skipped: string[], unverified: string[],
 *   failed: {name: string, error: string}[]}>}
 */
async function runMigrations({ log = console, force = false } = {}) {
    const report = { succeeded: [], skipped: [], unverified: [], failed: [] };

    // Pre-create user_sessions (connect-pg-simple uses its own pool.query which
    // bypasses our serialized exec()). Awaited, als losse statements.
    const { pool } = require('./db');
    try {
        await pool.query(`CREATE TABLE IF NOT EXISTS "user_sessions" (
            "sid" varchar NOT NULL COLLATE "default",
            "sess" json NOT NULL,
            "expire" timestamp(6) NOT NULL,
            CONSTRAINT "user_sessions_pkey" PRIMARY KEY ("sid")
        )`);
        await pool.query(`CREATE INDEX IF NOT EXISTS "IDX_user_sessions_expire" ON "user_sessions" ("expire")`);
        report.succeeded.push('user_sessions');
        log.log('  ✅ user_sessions (pre-created)');
    } catch (err) {
        report.failed.push({ name: 'user_sessions', error: err.message });
        log.error(`  ❌ user_sessions: ${err.message}`);
    }

    for (const store of collectStoreModules(log)) {
        try {
            const mod = require(store.file);
            // Voorkeursvolgorde: initDB() — door de promise-memo is dat
            // dezelfde promise als de load-time init, en na een eerdere
            // mislukking een echte retry. Anders een geëxporteerde
            // ready-promise. Geen van beide = niet verifieerbaar, en dat
            // zeggen we hardop in plaats van ✅ te liegen.
            const handle = (mod && typeof mod.initDB === 'function') ? mod.initDB()
                : (mod && mod.ready && typeof mod.ready.then === 'function') ? mod.ready
                : null;
            if (handle) {
                await handle;
                report.succeeded.push(store.name);
                log.log(`  ✅ ${store.name}`);
            } else {
                report.unverified.push(store.name);
                log.warn(`  ◌  ${store.name}: geen initDB()/ready — geladen maar NIET geverifieerd`);
            }
        } catch (err) {
            report.failed.push({ name: store.name, error: err.message });
            log.error(`  ❌ ${store.name}: ${err.message}`);
        }
    }

    // De boot-ladder die de oude runner altijd oversloeg: losse datamigraties
    // en de NL-catalogi, uit dezelfde lijsten die de server bij boot draait.
    const { runLooseMigrations, runNlTranslations, MANUAL_MIGRATIONS } = require('./boot/bootMigrations');
    for (const [label, run] of [['datamigraties', runLooseMigrations], ['NL-catalogi', runNlTranslations]]) {
        const r = await run({ log, force });
        report.succeeded.push(...r.ok.map(n => `${label}/${n}`));
        report.skipped.push(...r.skipped.map(n => `${label}/${n}`));
        report.failed.push(...r.failed.map(f => ({ name: `${label}/${f.name}`, error: f.error })));
        log.log(`  ${r.failed.length === 0 ? '✅' : '❌'} ${label}: ${r.ok.length} ok, ${r.skipped.length} al geregistreerd, ${r.failed.length} gefaald`);
    }

    // Geen fout, wel een herinnering: deze bestaan en draaien bewust nooit
    // vanzelf. De operator beslist (na de dry-run uit hun eigen header).
    if (MANUAL_MIGRATIONS.length > 0) {
        log.log(`  ◌  handmatig (niet gedraaid): ${MANUAL_MIGRATIONS.join(', ')}`);
    }

    return report;
}

module.exports = { runMigrations, STORE_MODULES };

if (require.main === module) {
    // Waakhond, geen sluipmoordenaar: de oude 30s-timer zat binnen een factor
    // 1,2 van een migratie op een LEGE database en zou na de await-fix juist
    // de grote installaties afbreken waar migreren het langst duurt. Ruim
    // default, instelbaar, en altijd exit 1 mét uitleg.
    const TIMEOUT_MS = parseInt(process.env.MIGRATE_TIMEOUT_MS || String(10 * 60_000), 10);
    const watchdog = setTimeout(() => {
        console.error(`[migrate] ⚠️ Waakhond na ${TIMEOUT_MS}ms — het schema is vermoedelijk ONVOLLEDIG. ` +
            'Verhoog MIGRATE_TIMEOUT_MS en draai opnieuw (de ladder is idempotent).');
        process.exit(1);
    }, TIMEOUT_MS);
    watchdog.unref();

    console.log('');
    console.log('═══════════════════════════════════════');
    console.log('  Bee Flow — Database Migration Runner');
    console.log('═══════════════════════════════════════');
    console.log('');
    const dbUrl = process.env.CORE_DATABASE_URL || 'not set';
    console.log(`[migrate] Database: ${dbUrl.replace(/:[^:@]+@/, ':***@')}`);
    console.log('');

    const force = process.argv.includes('--force');
    runMigrations({ force }).then(async (report) => {
        console.log('');
        if (report.unverified.length > 0) {
            console.warn(`[migrate] ◌  niet verifieerbaar (geen initDB/ready): ${report.unverified.join(', ')}`);
        }
        if (report.failed.length > 0) {
            console.error(`[migrate] ❌ ${report.failed.length} gefaald: ${report.failed.map(f => f.name).join(', ')}`);
            console.error(`[migrate]    eerste fout: ${report.failed[0].name} — ${report.failed[0].error}`);
        } else {
            console.log(`[migrate] ✅ ${report.succeeded.length} onderdelen gemigreerd en afgewacht, ${report.skipped.length} al in schema_migrations${force ? '' : ' (--force draait ze opnieuw)'}`);
        }
        try { await require('./db').pool.end(); } catch (_) { /* exit regelt het */ }
        process.exit(report.failed.length > 0 ? 1 : 0);
    }).catch(async (err) => {
        console.error('[migrate] ❌ runner zelf faalde:', err.message);
        try { await require('./db').pool.end(); } catch (_) { /* exit regelt het */ }
        process.exit(1);
    });
}
