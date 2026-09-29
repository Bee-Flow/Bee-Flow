// @typecheck
'use strict';

/**
 * Buildstempel van dit serverproces.
 *
 * CI geeft de git-SHA door als build-arg (.github/workflows/build-push-ghcr.yml,
 * job `server`) die server/Dockerfile als ENV APP_BUILD_SHA in het image bakt.
 *
 * De fallback is bewust 'dev' en niet een lege string: lokale dev en self-host
 * builds zonder CI-injectie hebben óók een bruikbare, niet-lege stempel nodig —
 * onder andere als versiecomponent in cachesleutels, waar '' onzichtbaar in de
 * sleutel verdwijnt en twee verschillende builds dezelfde sleutel zouden munten.
 * Eén keer hier vastgelegd, zodat niet elke lezer zijn eigen fallback verzint.
 */
const APP_BUILD_SHA = process.env.APP_BUILD_SHA || 'dev';

/**
 * Vlecht de buildversie in een cachesleutel-prefix, zodat sleutels van een
 * oude en een nieuwe build elkaar in gedeelde caches (sessie/Redis) nooit
 * kunnen raken — ook niet bij een rollback.
 *
 * @param {string} prefix - de sleutel zonder versiecomponent, bv. `_ent:u1:o2`
 * @returns {string} `${prefix}:b<sha>`
 */
function buildKey(prefix) {
    return `${prefix}:b${APP_BUILD_SHA}`;
}

module.exports = { APP_BUILD_SHA, buildKey };
