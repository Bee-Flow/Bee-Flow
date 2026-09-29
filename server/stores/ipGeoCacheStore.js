// @typecheck
/**
 * Retired: the persistent IP → geo cache, and the removal of its table.
 *
 * `ip_geo_cache` held the answers of ip-api.com, keyed by IP, for 30 days of
 * reads and forever on disk: nothing ever deleted a row. Among those IPs were
 * the addresses of users who signed up (auth/signupGuards.js geolocated them
 * through the same resolver), so the table was personal data without a
 * retention rule, filled by a lookup that itself sent the address to a third
 * party. Location now comes from a local database (core/http/geo/geoDb.js)
 * with no cache, so the table has no reader and no writer left.
 *
 * This module stays registered in storeModules.js for one reason: its init
 * drops the table on every existing install, once, guarded by a probe so a
 * clean install pays a single catalog lookup.
 */

const { getOne, exec } = require('../db');
const { makeStoreInit } = require('./lib/storeInit');
const log = require('../telemetry/log');

const initDB = makeStoreInit('IpGeoCacheStore', _doInit);

async function _doInit() {
    const probe = await getOne(`SELECT to_regclass('ip_geo_cache') AS t`).catch(() => null);
    if (!probe?.t) return;
    await exec(`DROP TABLE IF EXISTS ip_geo_cache`);
    log.info('[IpGeoCacheStore] dropped the retired ip_geo_cache table (IP addresses without a retention rule)');
}

module.exports = {};

// Awaitable init entry point for migrateDb.
module.exports.initDB = initDB;
