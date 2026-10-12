/**
 * The per-action grant list vs. the n8n block.
 *
 * `config.tools[app].actions` narrows an app the agent already has ON down to
 * named actions, and it is applied inside `addTools` precisely so no
 * integration block can forget it. The n8n block pushed straight onto `tools`
 * instead, on both of its loops — so an agent curated down to
 * `n8n_workflow_list` was handed all fifteen workflow tools, `delete`,
 * `execute` and `activate` included.
 *
 * That grant was not theoretical: it is storable, normalisation validates it
 * against the same registry the picker renders (`n8n_workflow_list` survives
 * with no warning), and `isToolAllowed` refuses `n8n_workflow_delete` when
 * asked. The owner read a limit back in the picker that the runtime ignored,
 * which is the exact failure the whole grants layer exists to prevent.
 *
 * DB-free: the same monkeypatch harness as integrationTools.agentAutomations
 * — the module under test lazy-requires its data sources, and the two n8n
 * modules are patched BEFORE it is required because it destructures them at
 * load time.
 *
 * Run: cd server && node --test --test-force-exit core/integrations/integrationTools.n8nGrants.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');

// ── Patch destructure-at-load deps BEFORE requiring the module ──────
const permissions = require('../../auth/permissions');
permissions.hasPermission = async () => true;          // incl. modify_n8n_workflows

const betaFeatures = require('../entitlements/betaFeatures');
betaFeatures.userHasBetaFeature = async () => false;

// One dynamic webhook-trigger tool, carrying the `_n8n` marker the block
// strips. Its name is per-workflow, so no registry entry claims it.
const n8nTools = require('../../integrations/n8nTools');
n8nTools.buildN8nTools = async () => [{
    type: 'function',
    function: { name: 'n8n_run_invoice_flow', description: 'x', parameters: { type: 'object', properties: {} } },
    _n8n: { workflowId: 'wf-1' },
}];

// ── Patch the lazy-required data sources ────────────────────────────
const configStore = require('../../stores/configStore');
configStore.getConfig = async (k) => (/^n8n_url_org_/.test(k) ? 'https://n8n.example' : null);
configStore.getSecret = async (k) => (/^n8n_api_key_org_/.test(k) ? 'k' : null);

const userStore = require('../../stores/userStore');
userStore.getUser = async () => ({ id: 'u1', organizationId: 'o1', groups: [], role: 'user' });
userStore.getOrganization = async () => ({ enabledIntegrations: null });
userStore.getAllGroups = async () => [];
userStore.getAppPassword = async () => null;
userStore.getOrgEnabledIntegrations = async () => ['n8n'];

try {
    const mcpManager = require('../mcpManager');
    mcpManager.getAllToolsAsOpenAI = async () => [];
} catch (_) { /* appendMcpTools fails closed on its own */ }

const ent = require('../entitlements/entitlements');
ent.resolveEntitlements = async () => ({
    degraded: false,
    tier: 'enterprise',
    ceiling: { core: [], integration: [], beta: [] },
    effective: { core: [], integration: ['n8n'], beta: [] },
});
ent.hasCapability = async () => false;          // no automations in this file

const callable = require('../../automation/agentCallableTools');
callable.getAgentCallableToolsForUser = async () => [];
callable.getStepToolsForUser = async () => [];

const { getIntegrationTools } = require('./integrationTools');
const P = require('../agentRuntime/toolPolicy');

const session = { user: { id: 'u1', role: 'user' } };
const run = (agentConfig) => getIntegrationTools({ userId: 'u1', session, isAdmin: false, agentConfig });
const n8nOf = (res) => res.tools.map(t => t.function.name).filter(n => n.startsWith('n8n_')).sort();

test('an agent nobody curated is offered every n8n tool, as before', async () => {
    const got = await n8nOf(await run({ enabledIntegrations: ['n8n'] }));
    assert.ok(got.includes('n8n_workflow_list'));
    assert.ok(got.includes('n8n_workflow_delete'), 'the RBAC bucket is the only gate here, and it is open');
    assert.ok(got.includes('n8n_run_invoice_flow'), 'including the dynamic webhook tools');
});

test('a curated n8n grant is enforced, not just stored', async () => {
    const grants = { n8n: { actions: ['n8n_workflow_list'], actAs: 'viewer' } };

    // The grant survives normalisation against the registry the picker uses,
    // and the policy layer says the destructive action is out.
    const norm = P.normaliseToolsConfig({ tools: grants });
    assert.deepStrictEqual(norm.tools.n8n.actions, ['n8n_workflow_list']);
    assert.deepStrictEqual(norm.warnings, []);
    assert.strictEqual(P.isToolAllowed('n8n_workflow_delete', grants), false);

    const got = await n8nOf(await run({ enabledIntegrations: ['n8n'], tools: grants }));
    assert.ok(got.includes('n8n_workflow_list'), 'what the owner picked is offered');
    for (const refused of ['n8n_workflow_delete', 'n8n_workflow_execute', 'n8n_workflow_activate',
        'n8n_workflow_create', 'n8n_workflow_update']) {
        assert.ok(!got.includes(refused),
            `${refused} was pushed past the grant filter — the stack disagreed with both the picker and isToolAllowed`);
    }
});

test('per-workflow webhook tools are unattributed, so no app grant speaks about them', async () => {
    // The documented hole in the GRANT layer (a grant is keyed on an app, and
    // no app claims a per-workflow name), not a new one: what closes the stack
    // for a curated agent is buildToolPolicy's allowedToolNames, built from
    // the tools that were actually offered.
    const got = await n8nOf(await run({
        enabledIntegrations: ['n8n'],
        tools: { n8n: { actions: ['n8n_workflow_list'], actAs: 'viewer' } },
    }));
    assert.ok(got.includes('n8n_run_invoice_flow'));
});

test('curating a DIFFERENT app leaves n8n alone', async () => {
    // Narrowing Gmail is not a statement about n8n: an app with no entry keeps
    // every action, which is the no-migration rule the whole layer rests on.
    const got = await n8nOf(await run({
        enabledIntegrations: ['n8n'], tools: { gmail: { actions: ['gmail_search'] } },
    }));
    assert.ok(got.includes('n8n_workflow_delete'));
});
