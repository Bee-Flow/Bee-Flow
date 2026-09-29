/**
 * Which organisation a routine run belongs to.
 *
 * `automations.organization_id` is never written — routes/automation/crud.js
 * creates with `userId` only — so `ctx.orgId` was null for every routine ever
 * made. Everything hanging off it ran with no organisation: resolveOrgShield
 * bails on a falsy id, so the org Privacy Shield — including its "Also protect
 * routines" switch, which reads as ON in the settings page — applied to nothing
 * at all. The guardrail audit rows and the audience checks were equally
 * org-less.
 *
 * This is the one failure mode worth a dedicated test: nothing looked broken.
 * Every run went green, the settings page said routines were covered, and no
 * routine was ever scanned. The guard STEP is what finally said so out loud
 * ("no_organisation"), and only because it reports what policy it resolved.
 *
 * Run: node --test core/automationRunner.orgScope.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

function mock(relPath, exports) {
    const resolved = require.resolve(relPath);
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

// The runner pulls in the world at require time; none of it is needed to test
// the rule itself, so the heavy leaves are stubbed before it loads.
mock('../stores/automationStore', {});
mock('../stores/userStore', { getUser: async () => null, getOrganization: async () => null });
mock('../stores/configStore', { getConfig: async () => null, getSecret: async () => '' });
mock('../stores/notificationStore', {});
mock('../stores/usageStore', { logUsage: () => Promise.resolve() });
mock('../stores/terminationStore', { logTermination: () => Promise.resolve() });
mock('../db', { pool: { query: async () => ({ rows: [] }) } });
mock('./aiAgent', { getProviderForModel: async () => null, getAIConfig: async () => ({}) });
mock('./providers', { getAdapter: () => ({}) });
mock('../automation/codeSandbox', { run: async () => ({}) });

const { _runOrgFor: runOrgFor } = require('./automationRunner');

const session = (organizationId) => ({ user: { id: 'tomsmit', organizationId } });

test("a routine with no organisation of its own runs as its OWNER's", () => {
    // Exactly what the create path produces: organizationId null, owner in an
    // org. Without the fallback the org Privacy Shield resolves to nothing.
    assert.strictEqual(runOrgFor({ organizationId: null, userId: 'tomsmit' }, session('bee-flow')), 'bee-flow');
    assert.strictEqual(runOrgFor({ userId: 'tomsmit' }, session('bee-flow')), 'bee-flow');
});

test('a routine that DOES name an organisation keeps its own', () => {
    // A fallback, never an override: a routine deliberately scoped to one org
    // must not drift to another when its author's membership changes.
    assert.strictEqual(runOrgFor({ organizationId: 'org-smoke' }, session('bee-flow')), 'org-smoke');
});

test('no organisation anywhere stays null rather than guessing one', () => {
    // A personal install has no org, and inventing one would attach that run's
    // audit rows to an organisation that does not exist.
    assert.strictEqual(runOrgFor({ organizationId: null }, session(null)), null);
    assert.strictEqual(runOrgFor({}, {}), null);
    assert.strictEqual(runOrgFor(null, null), null);
    // The empty string is what users."organizationId" defaults to — it must
    // read as "none", not as an org whose id is ''.
    assert.strictEqual(runOrgFor({ organizationId: '' }, session('')), null);
});
