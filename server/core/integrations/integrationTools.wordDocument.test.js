/**
 * create_word_document is injected next to create_presentation: every
 * signed-in user outside simple mode gets both, simple mode neither, and the
 * tool hint tells the model what the Word tool is for.
 *
 * Run: SESSION_SECRET=test-session-secret-at-least-32-chars-long node core/integrations/integrationTools.wordDocument.test.js
 *
 * Plain-script style with an explicit exit, like the other
 * integrationTools.*.test.js files: requiring integrationTools pulls modules
 * that keep the event loop alive. DB-free: the data sources are patched on the
 * cached module objects (see integrationTools.notebooks.test.js).
 */

const assert = require('assert');

const permissions = require('../../auth/permissions');
permissions.hasPermission = async () => true;

const betaFeatures = require('../entitlements/betaFeatures');
betaFeatures.userHasBetaFeature = async () => false;

const configStore = require('../../stores/configStore');
let simpleMode = false;
configStore.getConfig = async (key) => (String(key).startsWith('simple_mode_user_') ? simpleMode : null);
configStore.getSecret = async () => null;

const userStore = require('../../stores/userStore');
userStore.getUser = async () => ({ id: 'u1', organizationId: 'o1', groups: [], role: 'user' });
userStore.getOrganization = async () => ({ enabledIntegrations: null });
userStore.getAllGroups = async () => [];
userStore.getAppPassword = async () => null;

try {
    const mcpManager = require('../mcpManager');
    mcpManager.getAllToolsAsOpenAI = async () => [];
} catch (_) { /* appendMcpTools fails closed on its own */ }

const ent = require('../entitlements/entitlements');
ent.resolveEntitlements = async () => ({
    degraded: false,
    tier: 'enterprise',
    ceiling: { core: [], integration: [], beta: [] },
    effective: { core: [], integration: [], beta: [] },
});

const { getIntegrationTools, buildToolHint } = require('./integrationTools');

const session = { user: { id: 'u1', role: 'user' } };
const toolNames = (r) => r.tools.map((t) => t.function.name);

const run = async () => {
    simpleMode = false;
    let res = await getIntegrationTools({ userId: 'u1', session, isAdmin: false });
    assert.ok(toolNames(res).includes('create_presentation'), 'the deck tool is there');
    assert.ok(toolNames(res).includes('create_word_document'), 'the Word tool sits next to it');
    const word = res.tools.find((t) => t.function.name === 'create_word_document');
    assert.deepStrictEqual(word.function.parameters.required, ['title', 'markdown']);
    console.log('✓ create_word_document is offered next to create_presentation');

    const hint = await buildToolHint(res.tools, 'u1');
    assert.match(hint, /create_word_document builds a real, editable \.docx/);
    console.log('✓ the tool hint names the Word tool');

    simpleMode = true;
    res = await getIntegrationTools({ userId: 'u1', session, isAdmin: false });
    assert.ok(!toolNames(res).includes('create_word_document'), 'simple mode: no Word tool');
    assert.ok(!toolNames(res).includes('create_presentation'), 'simple mode: no deck tool either');
    console.log('✓ simple mode withholds both artefact tools');

    console.log('\nALL WORD DOCUMENT INJECTION TESTS PASSED');
};

run().then(() => process.exit(0)).catch((e) => { console.error('TEST FAILED:', e); process.exit(1); });
