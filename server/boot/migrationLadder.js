// @typecheck strict
'use strict';
/**
 * The runner of the boot migration ladder (boot/bootMigrations.js holds the lists):
 * run a list of migrations in order and record every successful one in the
 * `schema_migrations` ledger (boot/migrationLedger.js) under its name.
 *
 * ABSENT IS NOT FAILED. A listed name whose file is absent because a module owns it and that
 * module is not here is skipped silently: reported under `absent`, never under `failed`, so
 * `npm run db:migrate` does not exit 1 over it and the ledger records nothing (the migration
 * runs once the module is there). A module is "not here" when core mode hides it
 * (moduleRoots.cjs hiddenOwner names it) or when it is not installed at all: then there is no
 * file and no owner to ask, so the name must be in the record of module-owned migrations,
 * modules/firstParty/migrationOwners.json (name -> module id, held equal to
 * scripts/module-map.json by boot/migrationLadder.test.js). A name whose file is missing for
 * any other reason still fails as before.
 */

const fs = require('node:fs');
const { readLedger, record } = require('./migrationLedger');
const { checksumOf, migrationFile } = require('./migrationChecksum');
const OWNERS = require('../modules/firstParty/migrationOwners.json');

/** @typedef {{ read: () => Promise<Map<string, { checksum: string, applied_at: unknown }>>, record: (name: string, checksum: string) => Promise<void> }} Ledger */
/** @typedef {{ ok: string[], skipped: string[], absent: string[], failed: { name: string, error: string }[] }} LadderReport */

/** @param {string} name */
const loadMigration = (name) => require(migrationFile(name));
/** @type {Ledger} */
const LEDGER = { read: readLedger, record };

/** @type {Readonly<Record<string, string>>} */
const RECORDED_OWNERS = Object.freeze({ ...OWNERS.migrations, ...OWNERS.nlTranslations });

/**
 * The module that owns this migration while it is not here, or null when the file is here
 * (or missing without a module to blame).
 * @param {string} name a file name under migrations/, without .js
 * @param {Readonly<Record<string, string>>} [owners] name -> module id
 * @returns {string | null}
 */
function absentModule(name, owners = RECORDED_OWNERS) {
    const roots = require('../moduleRoots.cjs');
    const file = roots.treePath('migrations', `${name}.js`);
    const hidden = roots.hiddenOwner(file);
    if (hidden) return hidden;
    if (fs.existsSync(file)) return null;
    return Object.prototype.hasOwnProperty.call(owners, name) ? /** @type {string} */ (owners[name]) : null;
}

/**
 * Run one migration unless the ledger already has it with the same checksum.
 * @param {string} name
 * @param {Map<string, { checksum: string, applied_at: unknown }>} ledger
 * @param {LadderReport} out
 * @param {{ log: Pick<Console, 'warn' | 'log'>, force: boolean, load: (name: string) => { up: () => Promise<unknown> }, store: Ledger, salt: string }} ctx
 */
async function runOne(name, ledger, out, { log, force, load, store, salt }) {
    const checksum = checksumOf(name, salt);
    const prior = ledger.get(name);
    if (prior && !force && prior.checksum === checksum) {
        out.skipped.push(name);
        return;
    }
    if (prior && prior.checksum !== checksum) {
        log.log(`[BootMigrations] ${name} is gewijzigd sinds ${prior.applied_at} en draait opnieuw`);
    }
    await load(name).up();
    out.ok.push(name);
    try {
        await store.record(name, checksum);
    } catch (e) {
        log.warn(`[BootMigrations] ${name} geslaagd maar niet geregistreerd (draait volgende keer opnieuw): ${/** @type {Error} */ (e).message}`);
    }
}

/**
 * Run a list of migrations in order and record every successful one in the
 * ledger. Every error is caught and collected — one broken catalogue must not hold
 * back the rest — but it is NOT silent: the caller receives the failures and decides
 * itself whether that is a warn (boot) or an exit 1 (migration runner).
 *
 * `salt` goes into every checksum of this run (migrationChecksum.js checksumOf); '' changes nothing.
 * `load`, `ledger` and `absentOf` are the test seam (boot/composition.migrations.characterisation.test.js
 * records the order the runner asks for its migrations); boot and migrateDb pass none.
 *
 * @param {readonly string[]} names
 * @param {{ log?: Pick<Console, 'warn' | 'log'>, force?: boolean, load?: (name: string) => { up: () => Promise<unknown> },
 *   ledger?: Ledger, absentOf?: (name: string) => string | null, salt?: string }} [opts]
 *   `log` is a Console or the telemetry logger
 * @returns {Promise<LadderReport>}
 */
async function runList(names, { log = require('../telemetry/log'), force = false, load = loadMigration, ledger: store = LEDGER, absentOf = absentModule, salt = '' } = {}) {
    /** @type {LadderReport} */
    const out = { ok: [], skipped: [], absent: [], failed: [] };
    let ledger = new Map();
    try {
        ledger = await store.read();
    } catch (e) {
        // No ledger means the pre-ledger behaviour: run everything, record nothing.
        log.warn(`[BootMigrations] ledger onbereikbaar, volledige ladder draait: ${/** @type {Error} */ (e).message}`);
    }
    for (const name of names) {
        try {
            if (absentOf(name)) {
                out.absent.push(name);
                continue;
            }
            await runOne(name, ledger, out, { log, force, load, store, salt });
        } catch (e) {
            out.failed.push({ name, error: /** @type {Error} */ (e).message });
            log.warn(`[BootMigrations] ${name} faalde: ${/** @type {Error} */ (e).message}`);
        }
    }
    return out;
}

module.exports = { runList, absentModule };
