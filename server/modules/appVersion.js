// @typecheck strict
'use strict';
/**
 * The product version a release stamped into the image (build-arg APP_VERSION,
 * see scripts/app-version.sh). server/package.json is frozen at 1.0.0 and is
 * NOT the product version, so there is no fallback to it.
 *
 * Unknown (a plain `docker build`, a dev checkout) means null. What that
 * means for a module's min/max_app_version is decided by the caller: the
 * bounds are skipped, not enforced (modules/packageStaging.js `_compatCheck`),
 * and this logs one warning per process so it is visible.
 */

const log = require('../telemetry/log');

let warned = false;

/** @returns {string | null} */
function productVersion() {
    const v = (process.env.APP_VERSION || '').trim();
    if (v) return v;
    if (!warned) {
        warned = true;
        log.warn('[modules] APP_VERSION is not set: the product version is unknown, so a module\'s min_app_version / max_app_version are not checked and the hub is told no product version. Release images stamp it at build time.');
    }
    return null;
}

/** Test hook: forget that the warning was logged. */
function _resetWarned() { warned = false; }

module.exports = { productVersion, _resetWarned };
