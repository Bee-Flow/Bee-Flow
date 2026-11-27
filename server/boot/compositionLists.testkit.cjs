'use strict';
/**
 * The recorder of boot/composition.stores.characterisation.test.js and
 * boot/composition.migrations.characterisation.test.js: a child process that loads the
 * store list and the migration ladder the way index.js and migrateDb.js do (the
 * module-roots resolver first) and writes what they run, in order, to a JSON file.
 *
 *   cd server && node boot/compositionLists.testkit.cjs <out.json> stores|migrations
 *
 * A child process because both lists are now merged from the core's rows and those of the
 * loaded first-party modules (modules/firstParty/loader.js): run through
 * boot/compositionChild.testkit.js, the recording is of the full tree with every module
 * available, also when the suite itself runs in core mode (BEEFLOW_HIDE_MODULES).
 */

require('../moduleRoots.cjs');
const fs = require('node:fs');

const [outFile, what] = process.argv.slice(2);
if (!outFile || !['stores', 'migrations'].includes(what)) {
    process.stderr.write('usage: compositionLists.testkit.cjs <out.json> stores|migrations (cwd: server/)\n');
    process.exit(2);
}

const quiet = { info() {}, warn() {}, error() {}, log() {} };

/** The stores boot starts (through the load seam of startStoreSchemas) and the list db:migrate awaits. */
function recordStores() {
    const { startStoreSchemas } = require('./storeSchemas');
    const { collectStoreModules } = require('../storeModules');
    /** @type {string[]} */
    const loaded = [];
    const report = startStoreSchemas({
        log: quiet,
        load: (file) => { loaded.push(file); return { initDB: () => Promise.resolve() }; },
    });
    return {
        unverified: report.unverified,
        failed: report.failed,
        boot: report.started.map((name, i) => ({ name, file: loaded[i] })),
        migrate: collectStoreModules(quiet).map(({ name, file }) => ({ name, file })),
    };
}

/**
 * The names a runner asks for, in order, with an empty ledger and every migration a recorder,
 * and the names it recorded in the ledger.
 * @param {(opts: object) => Promise<{ ok: string[], failed: unknown[] }>} run
 */
async function namesRun(run) {
    /** @type {string[]} */
    const ran = [];
    /** @type {string[]} */
    const recorded = [];
    const out = await run({
        log: quiet,
        load: (/** @type {string} */ name) => ({ up: async () => { ran.push(name); } }),
        ledger: { read: async () => new Map(), record: async (/** @type {string} */ name) => { recorded.push(name); } },
    });
    return { ran, ok: out.ok, failed: out.failed, recorded };
}

async function recordMigrations() {
    const { runLooseMigrations, runNlTranslations, MANUAL_MIGRATIONS } = require('./bootMigrations');
    return {
        looseMigrations: await namesRun(runLooseMigrations),
        nlTranslations: await namesRun(runNlTranslations),
        manualMigrations: [...MANUAL_MIGRATIONS],
    };
}

(async () => {
    const recording = what === 'stores' ? recordStores() : await recordMigrations();
    fs.writeFileSync(outFile, JSON.stringify(recording));
    // A loaded module may hold a handle open (a pool, a timer); the recording is written.
    process.exit(0);
})().catch((err) => {
    process.stderr.write(`${err && err.stack ? err.stack : err}\n`);
    process.exit(1);
});
