/**
 * Een geplande run moet de tier oplossen ONDER DE ORG VAN ZIJN EIGENAAR.
 *
 * Elke route-aanroep van resolveModelForTier geeft {userOrgId, userId} mee;
 * de taakrunner deed dat niet. Gevolg: applyEUOverrides zag nooit een org,
 * dus een organisatie die EU-modus aanzette kreeg EU-modellen in chat
 * terwijl haar nachtelijke coworks stil op het niet-EU-model bleven
 * draaien — precies het soort stille afwijking dat dit product verkoopt
 * niet te hebben. Dit is een GEDRAGStest, geen bronscan: hij draait de
 * echte modelResolver met een gestubde configlaag en laat executeTask
 * bewijzen welk model er werkelijk bij de provider aankomt.
 *
 * Run: node --test --test-force-exit core/aiTaskRunner.tierContext.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { installResolveStub } = require('../testUtils/stubRequire');

const seen = { providerModel: [], chats: 0 };
let orgForUser = 'org-eu';

const CONFIGS = {
    // Globale tiers + het EU-schaduwregister dat applyEUOverrides mergt.
    chat_model_tiers: { fast: { modelId: 'model-us' }, thinking: { modelId: 'think-us' } },
    chat_model_tiers_eu: { fast: { modelId: 'model-eu' } },
    'org_privacy_shield_org-eu': { enabled: true, euModeEnabled: true },
};

const restore = installResolveStub({
    // — de runner zelf —
    '../stores/coworkStore': {
        markRunning: async () => {}, markCompleted: async () => {},
        markError: async () => {},
        updateTask: async () => {}, advanceSchedule: async () => {},
    },
    '../db': { pool: { query: async () => ({ rows: [] }) } },
    '../stores/terminationStore': { logTermination: async () => {} },
    './aiAgent': {
        getProviderForModel: async (modelId) => {
            seen.providerModel.push(modelId);
            return { providerType: 'stub', url: 'http://stub', apiKey: 'k' };
        },
    },
    './providers': {
        getAdapter: () => ({
            chat: async () => {
                seen.chats += 1;
                return { content: 'Klaar.', usage: { prompt_tokens: 1, completion_tokens: 1 } };
            },
        }),
    },
    './integrations/integrationTools': {
        getIntegrationTools: async () => ({ tools: [] }),
        buildToolHint: async () => '',
    },
    '../integrations/agentSearchTools': { buildAgentSearchTool: () => null },
    '../stores/notificationStore': { createNotification: async () => {} },
    // — de ECHTE modelResolver, met zijn eigen leveranciers gestubd —
    '../../stores/configStore': { getConfig: async (key) => CONFIGS[key] ?? null },
    '../../auth/permissions': { resolveUserOrgIds: async () => new Set() },
    '../../stores/userStore': {
        getUser: async () => (orgForUser ? { organizationId: orgForUser, groups: [] } : null),
        getAllGroups: async () => [],
    },
});

const { executeTask } = require('./aiTaskRunner');

test('een geplande run onder EU-modus kiest het EU-model', async () => {
    orgForUser = 'org-eu';
    await executeTask({ id: 't1', userId: 'u1', modelTier: 'fast', title: 'T', prompt: 'Doe iets.' });
    assert.deepStrictEqual(seen.providerModel, ['model-eu'],
        'de provider hoort het EU-model te krijgen, niet het globale');
    assert.ok(seen.chats >= 1, 'de run hoort de adapter echt aan te roepen');
});

test('zonder org valt hij terug op de globale tier-map (het oude gedrag)', async () => {
    orgForUser = null; // gebruiker zonder org — en u2 omzeilt de per-user orgcache
    seen.providerModel.length = 0;
    await executeTask({ id: 't2', userId: 'u2', modelTier: 'fast', title: 'T', prompt: 'Doe iets.' });
    assert.deepStrictEqual(seen.providerModel, ['model-us']);
});

test.after(() => restore());
