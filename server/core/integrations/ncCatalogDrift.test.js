/**
 * Catalog drift — the 14 Nextcloud integration ids, in one place.
 *
 * Three lists used to be maintained by hand and had all drifted apart:
 *   - connectorBootstrap's NC_INTEGRATIONS (10 of 14: mail, tables, forms
 *     and teams missing) decided what a freshly bootstrapped org got
 *   - integrationTools' AUTO_ENABLED_APPS (11 of 14: tables, forms, teams
 *     missing) decided which families skip the per-user app toggle
 *   - ncIntegrationCatalog (14) is what the admin UI and the scope model use
 *
 * Both now derive from the catalog. This test fails if anyone forks a copy
 * again, and — more usefully — when a 15th integration is added and only
 * some of the surfaces learn about it.
 *
 * Run: node --test server/core/integrations/ncCatalogDrift.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { NC_INTEGRATION_IDS, NC_INTEGRATIONS } = require('./ncIntegrationCatalog');

test('the catalog is the 14 documented integrations, ids unique', () => {
    assert.equal(NC_INTEGRATIONS.length, 14);
    assert.equal(new Set(NC_INTEGRATION_IDS).size, 14);
});

test('AUTO_ENABLED_APPS covers every catalog id', () => {
    // Genuinely textual: read off the source, the same way
    // integrationTools.permittedApps.test.js does — the constant is
    // module-private and requiring the module drags in the whole tool graph.
    // The list stays a plain literal for exactly that reason, so this test is
    // what keeps it honest.
    const src = fs.readFileSync(path.join(__dirname, 'integrationTools.js'), 'utf8');
    const m = src.match(/const AUTO_ENABLED_APPS = \[([^\]]*)\]/);
    assert.ok(m, 'AUTO_ENABLED_APPS must remain a parseable array literal');
    const listed = new Set(m[1].split(',').map(s => s.trim().replace(/^'|'$/g, '')).filter(Boolean));
    const missing = NC_INTEGRATION_IDS.filter(id => !listed.has(id));
    assert.deepEqual(missing, [],
        `AUTO_ENABLED_APPS is missing ${missing.join(', ')} — those integrations end up gated by a `
        + 'per-user app toggle that has no UI, so they are simply never offered');
});

test('connectorBootstrap provisions every catalog id at bootstrap', () => {
    // Genuinely textual, same reason as AUTO_ENABLED_APPS above:
    // NC_INTEGRATIONS is module-private, and connectorBootstrap.js pulls in
    // userStore, configStore, planEntitlements, orgHealth and the email
    // service just to be required — a unit test has no business paying that
    // to read one array.
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'auth', 'connectorBootstrap.js'), 'utf8');
    assert.match(src, /const NC_INTEGRATIONS = NC_INTEGRATION_IDS\.slice\(\)/,
        'bootstrap must take the catalog wholesale — the hand-maintained copy silently dropped mail/tables/forms/teams');
});

test('every catalog id is classified by the scope model', () => {
    // ncScope decides all|off vs selectable; ncScopeGuard owns the policies.
    // A new integration that neither knows about would be unscopable AND
    // policy-less, i.e. denied under any selection with no way to grant it.
    const { RESOURCE_KINDS } = require('./ncScope');
    const { FAMILY_POLICIES } = require('./ncScopeGuard');
    for (const id of NC_INTEGRATION_IDS) {
        assert.ok(id in FAMILY_POLICIES,
            `${id} has no entry in ncScopeGuard.FAMILY_POLICIES (use null for all|off-only families)`);
        const scopable = id in RESOURCE_KINDS;
        if (scopable) {
            assert.ok(FAMILY_POLICIES[id] && typeof FAMILY_POLICIES[id] === 'object',
                `${id} is selectable (RESOURCE_KINDS) but has no per-tool policies`);
        } else {
            assert.equal(FAMILY_POLICIES[id], null,
                `${id} is not selectable, so its policy table must be null`);
        }
    }
});
