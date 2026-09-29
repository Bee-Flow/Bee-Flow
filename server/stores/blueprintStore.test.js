/**
 * The Blueprint gallery's store.
 *
 * The pure halves are tested here; the SQL is not, because these tests run
 * without a database. What matters and is testable:
 *
 *   - A size refusal has to be ACTIONABLE. A Solution is many entities, so it
 *     reaches a ceiling far more easily than a single app ever did, and
 *     "the Blueprint is 6 MB" is not something a person can act on. "The app
 *     'orders' is 5 MB of it" is.
 *   - Visibility: the organisation, falling back to the creator alone.
 *
 * Run: cd server && node --test stores/blueprintStore.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const { canRead, isBlueprintId, largestEntity, MAX_BLUEPRINT_BYTES } = require('./blueprintStore');

const bp = (over = {}) => ({ id: 'bp_1', createdBy: 'alice', organizationId: 'org1', ...over });

test('an id from this store is recognisable on sight', () => {
    assert.strictEqual(isBlueprintId('bp_abc'), true);
    assert.strictEqual(isBlueprintId('utpl_abc'), false, 'not a captured app template');
    assert.strictEqual(isBlueprintId('sol_p1'), false, 'not a solution key');
    assert.strictEqual(isBlueprintId(null), false);
});

test('the creator can always read their own', () => {
    assert.strictEqual(canRead(bp({ organizationId: null }), { userId: 'alice' }), true);
});

test('an org member can install one their colleague saved', () => {
    assert.strictEqual(canRead(bp(), { userId: 'bob', organizationId: 'org1' }), true);
});

test('another org cannot', () => {
    assert.strictEqual(canRead(bp(), { userId: 'bob', organizationId: 'org2' }), false);
});

test('one captured outside an organisation stays private to its creator', () => {
    // No org to belong to, so org membership cannot be the thing that grants it.
    assert.strictEqual(canRead(bp({ organizationId: null }), { userId: 'bob', organizationId: 'org1' }), false);
});

test('nothing is readable that does not exist', () => {
    assert.strictEqual(canRead(null, { userId: 'alice' }), false);
});

test('the ceiling is bigger than one app, because a Solution is many', () => {
    assert.ok(MAX_BLUEPRINT_BYTES > 4 * 1024 * 1024);
});

test('the largest entity is named, so a size refusal can be acted on', () => {
    const manifest = {
        solution: {
            entities: {
                automations: [{ ref: 'aut_1', title: 'Small', definition: {} }],
                apps: [{ ref: 'app_1', name: 'Orders', definition: { blob: 'x'.repeat(5000) } }],
                webpages: [{ ref: 'web_1', name: 'Status', files: { html: 'y'.repeat(50) } }],
            },
        },
    };
    const worst = largestEntity(manifest);
    assert.strictEqual(worst.name, 'Orders');
    assert.strictEqual(worst.kind, 'apps');
    assert.ok(worst.bytes > 5000);
});

test('an entity with no name is still identifiable by its ref', () => {
    const worst = largestEntity({ solution: { entities: { apps: [{ ref: 'app_1', definition: {} }] } } });
    assert.strictEqual(worst.name, 'app_1');
});

test('an empty Blueprint has no offender to name', () => {
    assert.strictEqual(largestEntity({ solution: { entities: {} } }), null);
    assert.strictEqual(largestEntity(null), null);
});

// ── canRead and listBlueprintsFor must answer the same question ──────

test('the creator of an ORG Blueprint who left that org cannot read it any more', () => {
    // The wound: the creator clause used to sit ABOVE the org check and return
    // true unconditionally. `listBlueprintsFor` never showed this row to Alice
    // once she moved — its WHERE scopes an org Blueprint to the org, full stop —
    // so the list and the fetch disagreed, and which one you got depended on
    // whether you browsed or knew the id.
    assert.strictEqual(canRead(bp({ createdBy: 'alice', organizationId: 'org1' }), { userId: 'alice', organizationId: 'org2' }), false);
    assert.strictEqual(canRead(bp({ createdBy: 'alice', organizationId: 'org1' }), { userId: 'alice', organizationId: null }), false);
});

test('…and still can while she is in it — through the org clause, like everyone else', () => {
    assert.strictEqual(canRead(bp({ createdBy: 'alice', organizationId: 'org1' }), { userId: 'alice', organizationId: 'org1' }), true);
});

test('canRead agrees with the list query it mirrors, clause for clause', () => {
    // Genuinely textual, by this file's own design (no database here): the
    // SQL WHERE in listBlueprintsFor cannot be run without Postgres, so the
    // only way to compare it against canRead()'s branching is to read it. The
    // branching itself — organizationId decides, falling back to the creator
    // — is not restated here: it is already exercised behaviourally, both
    // ways, by every canRead(...) call above (own Blueprint, org member,
    // other org, no org, left the org, still in the org). This is only the
    // half those calls cannot reach: does the SQL split the same way.
    const fs = require('node:fs');
    const path = require('node:path');
    const src = fs.readFileSync(path.join(__dirname, 'blueprintStore.js'), 'utf8');
    assert.match(src, /organization_id IS NOT NULL AND organization_id = \$2/);
    assert.match(src, /organization_id IS NULL AND created_by = \$1/);
});
