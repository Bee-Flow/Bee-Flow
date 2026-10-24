// @typecheck
'use strict';

/**
 * Build stamp of this server process.
 *
 * CI passes the git SHA as a build arg (.github/workflows/build-push-ghcr.yml, job `server`), which
 * server/Dockerfile bakes into the image as ENV APP_BUILD_SHA.
 *
 * The fallback is deliberately 'dev' and not an empty string: local dev and self-host builds without
 * CI injection also need a usable, non-empty stamp — among other things as a version component in cache
 * keys, where '' silently disappears from the key and two different builds would mint the same key.
 * Recorded once here, so that not every reader invents its own fallback.
 */
const APP_BUILD_SHA = process.env.APP_BUILD_SHA || 'dev';

/**
 * Weaves the build version into a cache key prefix, so that keys of an old and a new build can never
 * collide in shared caches (session/Redis) — not even on a rollback.
 *
 * @param {string} prefix - the key without the version component, e.g. `_ent:u1:o2`
 * @returns {string} `${prefix}:b<sha>`
 */
function buildKey(prefix) {
    return `${prefix}:b${APP_BUILD_SHA}`;
}

module.exports = { APP_BUILD_SHA, buildKey };
