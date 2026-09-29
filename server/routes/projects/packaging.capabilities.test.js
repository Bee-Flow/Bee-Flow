/**
 * The installer's licence gates and the predicate that answers them must not drift.
 *
 * capabilityPredicate() builds a Map by fetching a fixed list of feature names,
 * then answers `granted.get(feature) === true`. A name it never fetched is
 * therefore DENIED — safe in direction, but silent: the whole entity kind is
 * skipped with a plausible-sounding reason instead of failing loudly.
 *
 * That is not hypothetical. Datatables gate on 'automations' (the same licence
 * feature /api/datatables uses, see license/featureMap.js), the name was missing
 * from the list, and every table in a Blueprint was skipped at install AND at
 * upgrade with "Tables are not part of this plan." The feature was unreachable
 * over HTTP from the day it was written.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { INSTALLER_FEATURES } = require('./packaging');

function featuresAskedFor(file) {
    const src = fs.readFileSync(path.join(__dirname, '../../projects/packaging', file), 'utf8');
    const found = new Set();
    for (const m of src.matchAll(/\bctx\.can\(\s*['"]([^'"]+)['"]\s*\)/g)) found.add(m[1]);
    return found;
}

test('every feature the installer gates on is one the predicate actually fetches', () => {
    const asked = new Set([...featuresAskedFor('install.js'), ...featuresAskedFor('upgrade.js')]);
    assert.ok(asked.size > 0, 'found no ctx.can() calls at all — the scan is broken, not the code');

    const missing = [...asked].filter(f => !INSTALLER_FEATURES.includes(f));
    assert.deepStrictEqual(missing, [],
        'these features are gated on but never fetched, so they read as denied and their entity kind is silently skipped');
});

test('the predicate fetches nothing the installer never asks about', () => {
    // Not a safety property — a stale name costs a licence round-trip per
    // install and, more to the point, is a claim about the installer that is
    // no longer true.
    const asked = new Set([...featuresAskedFor('install.js'), ...featuresAskedFor('upgrade.js')]);
    const stale = INSTALLER_FEATURES.filter(f => !asked.has(f));
    assert.deepStrictEqual(stale, [], 'these are fetched but no longer gated on anywhere — remove them');
});
