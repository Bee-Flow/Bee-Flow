/**
 * Unit — featureMap.js notes must not contradict the router they describe.
 *
 * '/api/studio-apps/:id/large-datasets' and '/api/projects/:id/package' share a
 * mount with routes that have nothing to do with their own licence feature,
 * so both gates were moved from a path-less `router.use(...)` to the first
 * handler of each route (see routes/studioAppDatasets.js and
 * routes/projects/packaging.js). The note for large_datasets kept saying
 * ROUTER-LEVEL after that move; this guards against it drifting back.
 *
 * Run: node server/license/featureMap.notes.test.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const featureMap = require('./featureMap');

const datasetsNote = featureMap['/api/studio-apps/:id/large-datasets'].notes;
assert.ok(
    /PER-ROUTE/.test(datasetsNote),
    'the large_datasets note must say the gate is PER-ROUTE, matching routes/studioAppDatasets.js'
);
assert.ok(
    !/applied ROUTER-LEVEL/i.test(datasetsNote),
    'the large_datasets note must not claim the gate is applied ROUTER-LEVEL — routes/studioAppDatasets.js moved it to each route'
);

const packagingNote = featureMap['/api/projects/:id/package'].notes;
assert.ok(
    /PER-ROUTE/.test(packagingNote),
    'the blueprint_packaging note must say the gate is PER-ROUTE'
);

// Cross-check against the actual router: every mounted route must carry the
// large_datasets gate as its OWN first middleware. A regression to a
// path-less `router.use(requireFeature(...))` shows up here as gatedCount
// dropping to 0 while routeCount stays > 0 — it would no longer be each
// route's own middleware, so this stays a claim about behaviour (which
// requests the gate actually covers), not about the router.use text itself.
function readSource(rel) {
    return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
}
const datasetsFile = readSource('routes/studioAppDatasets.js');
const routeCount = (datasetsFile.match(/^router\.(get|post|put|delete)\(/gm) || []).length;
const gatedRouteCount = (datasetsFile.match(/^router\.(get|post|put|delete)\('[^']*',\s*largeDatasets,/gm) || []).length;
assert.ok(routeCount > 0, 'expected at least one route in studioAppDatasets.js');
assert.strictEqual(
    gatedRouteCount,
    routeCount,
    'every route in studioAppDatasets.js must carry the large_datasets gate as its first middleware'
);

// tiers.js carries the same pairing in its own words (TIER_FEATURES comments)
// and had the identical stale claim for both features.
const tiersEntries = readSource('license/tiers.js').match(/\/\/[^\n]*(?:\n\s*\/\/[^\n]*)*\n\s*'(?:large_datasets|blueprint_packaging)',/g) || [];
assert.strictEqual(tiersEntries.length, 2, 'expected a comment block above both large_datasets and blueprint_packaging in tiers.js');
for (const block of tiersEntries) {
    assert.ok(!/applied ROUTER-LEVEL/i.test(block) && !/\(router-level requireFeature/i.test(block),
        `tiers.js: ${block.trim().split('\n').pop()} must not claim its gate is router-level`);
}

console.log('✓ license/featureMap.notes.test.js — all assertions passed');
