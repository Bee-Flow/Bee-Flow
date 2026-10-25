// @typecheck noImplicitAny
/**
 * SSRF guard for custom-integration outbound HTTP.
 *
 * A re-export: the implementation (address table, inet_aton host
 * normalisation, https-target guard and the guarded dispatcher) is the
 * canonical core/http/ssrfGuard.js. This path stays because the custom
 * integration code and its tests require it by name.
 *
 * Exports (names, signatures and generic messages unchanged):
 *   isForbiddenAddress(ip), normalizeHostname(host),
 *   assertPublicHttpsTarget(url, { requireHttps, lookup }),
 *   createPinnedDispatcher(), safeFetch(url, options)
 */

'use strict';

const {
    isForbiddenAddress,
    normalizeHostname,
    assertPublicHttpsTarget,
    createPinnedDispatcher,
    safeFetch,
} = require('../http/ssrfGuard');

module.exports = {
    isForbiddenAddress,
    normalizeHostname,
    assertPublicHttpsTarget,
    createPinnedDispatcher,
    safeFetch,
};
