#!/usr/bin/env node
// @typecheck
/**
 * Database Migration Runner — and since U1 it actually does that too.
 *
 * The old version synchronously did `require(store)` and reported ✅ immediately: every store started its
 * initDB at module load as a non-awaited promise, so the script ended with exit 0 before even a single
 * CREATE TABLE had run — demonstrably, against a real Postgres (see PLAN-APP-UPGRADE.md).
 * That load-time start no longer exists (boot/storeSchemas.js now does it explicitly), so merely requiring
 * would now do nothing at all here. Now:
 *
 *   - every store is AWAITED via its memoised initDB()/ready
 *     (the promise memo immediately resolves the pg_class race of two parallel
 *     identical CREATE TABLE IF NOT EXISTS);
 *   - the boot migration ladder (separate data migrations + NL catalogues from
 *     boot/bootMigrations.js) ALSO runs here — precisely the category that
 *     "npm run db:migrate" always skipped;
 *   - failure is loud: exit 1 with the names; a store without an awaitable entry point
 *     counts as NOT VERIFIED and is named, instead of being glossed over.
 *
 * The store DDL is idempotent and runs on every call; the boot ladder (data migrations +
 * NL catalogues) is in the `schema_migrations` ledger of boot/bootMigrations.js and is skipped
 * once it is registered. An existing installation runs that ladder once more in full (idempotent)
 * the first time and then registers it.
 *
 * Usage:
 *   node migrateDb.js                    # everything, exit 1 on any error
 *   node migrateDb.js --force            # also re-run the registered boot ladder
 *   npm run db:migrate                   # the same
 *   docker exec beeflow-server node migrateDb.js
 *   MIGRATE_TIMEOUT_MS=1200000 node migrateDb.js   # more generous watchdog
 */

const path = require('path');
const { STORE_MODULES, collectStoreModules } = require('./storeModules');
const telemetryLog = require('./telemetry/log');

// Load env vars from project-root .env so npm run db:migrate / direct node calls
// see DATABASE_URL / CORE_DATABASE_URL / MONITORING_DATABASE_URL.
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });


/**
 * Run the full ladder: user_sessions, every store AWAITED, and then
 * the boot migrations (separate data migrations + NL catalogues). Does not throw itself —
 * the caller reads the report and decides on the exit code.
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
            // Preferred order: initDB() — through the promise memo that is
            // the same promise as the load-time init, and after an earlier failure a real
            // retry. Otherwise an exported ready promise. Neither = not verifiable, and we
            // say so out loud instead of lying with ✅.
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
    for (const [label, run] of /** @type {Array<[string, typeof runLooseMigrations]>} */ ([['datamigraties', runLooseMigrations], ['NL-catalogi', runNlTranslations]])) {
        const r = await run({ log, force });
        report.succeeded.push(...r.ok.map(n => `${label}/${n}`));
        report.skipped.push(...r.skipped.map(n => `${label}/${n}`));
        report.failed.push(...r.failed.map(f => ({ name: `${label}/${f.name}`, error: f.error })));
        log.log(`  ${r.failed.length === 0 ? '✅' : '❌'} ${label}: ${r.ok.length} ok, ${r.skipped.length} al geregistreerd, ${r.failed.length} gefaald`);
    }

    // Not an error, but a reminder: these exist and deliberately never run
    // by themselves. The operator decides (after the dry run in their own header).
    if (MANUAL_MIGRATIONS.length > 0) {
        log.log(`  ◌  handmatig (niet gedraaid): ${MANUAL_MIGRATIONS.join(', ')}`);
    }

    return report;
}

module.exports = { runMigrations, STORE_MODULES };

if (require.main === module) {
    // Watchdog, not assassin: the old 30 s timer sat within a factor of 1.2 of a migration on an
    // EMPTY database and, after the await fix, would precisely abort the large installations where
    // migrating takes longest. A generous default, adjustable, and always exit 1 with an explanation.
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
        try { await require('./db').pool.end(); } catch (err) { telemetryLog.debug('exit regelt het', err); }
        process.exit(report.failed.length > 0 ? 1 : 0);
    }).catch(async (err) => {
        console.error('[migrate] ❌ runner zelf faalde:', err.message);
        try { await require('./db').pool.end(); } catch (err) { telemetryLog.debug('exit regelt het', err); }
        process.exit(1);
    });
}

/**
 * @typedef {Object} RunMigrationsArgs
 * @property {Console} [log]
 * @property {boolean} [force]
 */
