/**
 * The readers against the payloads the routes send (each api/*.ts header
 * names its route): renames, defaults, and what a replace-on-save must keep.
 */

import { readAzureConfig, readAzureSyncResult, readAzureSyncSettings } from './azureReaders';
import { readGithubSyncItems, readGithubSyncStatus, readPushAll, readPushPending } from './githubReaders';
import { readActiveFeatures, readBetaAllowList, readHasMapsKey, readNcIntegrationGroups, readNcIntegrations } from './integrationReaders';
import { readDiscovered, readN8nConfig, readN8nDiagnostics, readN8nPermissions } from './n8nReaders';
import { readMeetNotes, readNcSync, readPairingCodes, readTalkNotes } from './nextcloudReaders';

describe('integration readers', () => {
    it('reads the Nextcloud catalogue and group switches, dropping rows without an id', () => {
        expect(readNcIntegrations({ ncCatalog: [{ id: 'files', name: 'Files' }, { name: 'x' }], enabled: ['files'], usingDefaults: true })).toEqual({
            catalog: [{ id: 'files', name: 'Files', description: '' }],
            enabled: ['files'],
            usingDefaults: true,
        });
        expect(readNcIntegrationGroups({ groups: [{ id: 'g1', name: 'Sales', userCount: 3 }, { name: 'none' }] })).toEqual([
            { id: 'g1', name: 'Sales', disabledIntegrations: [], userCount: 3 },
        ]);
    });

    it('treats unknown beta governance as governed, and finds the org’s allow-list', () => {
        expect(readActiveFeatures({})).toEqual({ orgId: null, allowedBetaFeatures: [], enabledBetaFeatures: [], betaGoverned: true });
        expect(readBetaAllowList({ assignments: { o1: ['kb_law'], o2: ['x'] } }, 'o1')).toEqual(['kb_law']);
        expect(readHasMapsKey({ hasGoogleMapsKey: true, googleMapsApiKey: 'never read' })).toBe(true);
    });
});

describe('n8n readers', () => {
    it('keeps a stored workflow’s unknown fields for the save', () => {
        const config = readN8nConfig({ configured: true, n8nUrl: 'https://n8n.x', hasApiKey: true, workflows: [{ id: 'w', name: 'W', timeout: 9, inputs: [{ name: 'a', type: 'weird' }] }, { name: 'no id' }] });
        expect(config.workflows).toHaveLength(1);
        expect(config.workflows[0]).toMatchObject({ httpMethod: 'POST', enabled: true, inputs: [{ name: 'a', type: 'string', required: true }], raw: { timeout: 9 } });
        expect(readDiscovered({ workflows: [{ id: 'd', name: 'D', webhookNodes: [{ path: 'p' }] }] })).toEqual([{ id: 'd', name: 'D', webhookNodes: [{ path: 'p', method: 'POST' }] }]);
    });

    it('lifts the diagnostics out of their nesting', () => {
        expect(
            readN8nDiagnostics({
                org: { n8nConfigured: true, enabledIntegrationsIncludesN8n: false, source: 'org_list' },
                userLevel: { passes: true, reason: 'default' },
                permissions: { modify_n8n_workflows: true },
                toolsThatWillBeInjected: ['n8n_a'],
            }),
        ).toEqual({ orgConfigured: true, orgEnabled: false, orgSource: 'org_list', userPasses: true, userReason: 'default', canModify: true, tools: ['n8n_a'] });
        expect(readN8nPermissions({ modify_n8n_workflows: [{ id: 'g', name: 'Ops', userCount: 2 }], availableGroups: [] })).toEqual({
            holders: [{ id: 'g', name: 'Ops', userCount: 2, isGlobal: false }],
            availableGroups: [],
            orgAdminAlways: true,
        });
    });
});

describe('Nextcloud readers', () => {
    it('reads the sync with the web’s defaults', () => {
        expect(readNcSync({ ncBaseUrl: 'https://nc', mode: 'bogus' })).toEqual({
            ncBaseUrl: 'https://nc',
            mode: 'mirror_all',
            syncGroups: [],
            excludedGroups: [],
            newUserDefaultStatus: 'active',
            lastSyncAt: null,
        });
        expect(readPairingCodes({ codes: [{ id: 'c', code: 'ABC', expiresAt: 'z' }, { code: 'no id' }] })).toEqual([{ id: 'c', code: 'ABC', expiresAt: 'z' }]);
    });

    it('keeps "no opinion" and the legacy lists, since the save replaces the document', () => {
        const talk = readTalkNotes({ autoTranscribe: null, postSummaryBack: 'yes', excludedEventUids: ['u1'], excludedRoomTokens: [{ t: 1 }] });
        expect(talk).toMatchObject({ autoTranscribe: null, postSummaryBack: null, insightsPerPersonStats: true, excludedEventUids: ['u1'], excludedRoomTokens: [{ t: 1 }] });
        expect(readMeetNotes({ autoImport: false, importScope: 'calender', excludedEventIds: ['e', ''] })).toMatchObject({
            autoImport: false,
            importScope: null,
            excludedEventIds: ['e'],
            excludedMeetingCodes: [],
        });
    });
});

describe('GitHub readers', () => {
    it('reads the status, the item rows and the push counts', () => {
        expect(readGithubSyncStatus({ configured: true, githubConnected: true, config: { repoOwner: 'o', repoName: 'r' }, overview: null })).toEqual({
            configured: true,
            githubConnected: true,
            config: { repoOwner: 'o', repoName: 'r', branch: 'main', autoSync: false, lastFullSync: null },
            overview: null,
        });
        expect(readGithubSyncItems([{ id: 7, resource_type: 'agent', resource_id: 'a1', sync_status: 'synced' }, { resource_type: 'x' }])).toEqual([
            { id: '7', resourceType: 'agent', resourceId: 'a1', status: 'synced', lastSyncedAt: null, errorMessage: null },
        ]);
        expect(readPushAll({ results: { agents: { pushed: 2, skipped: 1 } } })).toEqual({ agents: { pushed: 2, skipped: 1 }, skills: { pushed: 0, skipped: 0 } });
        expect(readPushPending({ results: { pushed: 3, errors: 1 } })).toEqual({ pushed: 3, errors: 1 });
    });
});

describe('Azure readers', () => {
    it('reads secrets as flags only, and keeps a tier’s other fields', () => {
        const c = readAzureConfig({ azureEndpoint: 'https://x', azureApiKey: 'never', chatModelTiers: { fast: { modelId: 'gpt-5-mini', label: 'Fast', topP: 1 } } });
        expect(c).not.toHaveProperty('azureApiKey');
        expect(c.ssoTenantId).toBe('common');
        expect(c.chatModelTiers.fast).toMatchObject({ modelId: 'gpt-5-mini', maxTokens: null, raw: { topP: 1 } });
        expect(c.groupSyncSettings).toEqual({ destructiveSync: false, autoActivateUsers: true, periodicSync: false, syncIntervalHours: 6 });
        expect(readAzureSyncSettings({ periodicSync: true, syncIntervalHours: 12 })).toMatchObject({ periodicSync: true, syncIntervalHours: 12 });
    });

    it('reads a sync run’s counts, log and errors', () => {
        expect(readAzureSyncResult({ ok: true, synced: { groups: 2, users: 5 }, details: ['✓ a'], errors: ['group x'] })).toEqual({
            ok: true,
            groups: 2,
            users: 5,
            errors: ['group x'],
            details: ['✓ a'],
        });
        expect(readAzureSyncResult({ ok: false, synced: { groups: 0, users: 0 }, errors: ['Microsoft SSO is not configured'] })).toMatchObject({ ok: false, errors: ['Microsoft SSO is not configured'] });
    });
});
