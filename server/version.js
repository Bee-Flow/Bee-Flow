/**
 * App + module host-contract versions.
 *
 * APP_VERSION feeds the ADVISORY semver compat gates (a module package's
 * min_app_version / max_app_version). server/package.json is frozen at 1.0.0,
 * so those gates stay advisory until real releases stamp APP_VERSION at build
 * time via the APP_VERSION env var.
 *
 * HOST_API_VERSION is the HARD gate: an integer contract version for the
 * module host API. A package declares the host_api_version it was built
 * against; if that doesn't match this integer the module is incompatible
 * regardless of semver. Bump it only on breaking host-API changes.
 */
const APP_VERSION = process.env.APP_VERSION || require('./package.json').version;
const HOST_API_VERSION = 1;

module.exports = {
    APP_VERSION,
    HOST_API_VERSION,
};
