import {
    readEgress,
    readEuModelsConfigured,
    readGuardEvents,
    readGuardOverview,
    readGuardStatus,
    readIntegrationOverview,
    readSaveResult,
    readShieldDoc,
    readShieldEnv,
    readWebSearchEnabled,
} from './readers';

describe('readShieldDoc', () => {
    it('keeps the whole document and reads the response-only keys', () => {
        const raw = {
            enabled: true,
            dlpScope: 'all',
            clamped_fields: ['webSearchGuardEnabled'],
            clamped_tier: 'community',
            stalenessWarnings: [{ collectionId: 'c1', reason: 'collection_empty' }, 'junk'],
            updatedAt: '2026-09-01T00:00:00Z',
            updatedBy: 'u1',
        };
        const doc = readShieldDoc(raw);
        expect(doc?.raw).toEqual(raw);
        expect(doc?.raw).not.toBe(raw);
        expect(doc).toMatchObject({
            clampedFields: ['webSearchGuardEnabled'],
            clampedTier: 'community',
            stalenessWarnings: [{ collectionId: 'c1', reason: 'collection_empty' }],
            updatedAt: '2026-09-01T00:00:00Z',
            updatedBy: 'u1',
        });
    });

    it('reads a non-object as nothing, and missing meta as empty', () => {
        expect(readShieldDoc(null)).toBeNull();
        expect(readShieldDoc([])).toBeNull();
        expect(readShieldDoc({})).toMatchObject({ clampedFields: [], clampedTier: null, stalenessWarnings: [], updatedAt: null });
    });
});

describe('readSaveResult', () => {
    it('reads the config, the refused terms and the clamps', () => {
        expect(readSaveResult({
            ok: true,
            config: { enabled: true },
            termErrors: [{ id: 't1', label: 'X', error: 'Unterminated group' }],
            clamped_fields: ['toolPiiPolicy.external'],
            clamped_tier: 'community',
        })).toEqual({
            config: { enabled: true },
            termErrors: [{ id: 't1', label: 'X', error: 'Unterminated group' }],
            clampedFields: ['toolPiiPolicy.external'],
            clampedTier: 'community',
        });
        expect(readSaveResult(null)).toEqual({ config: null, termErrors: [], clampedFields: [], clampedTier: null });
    });
});

describe('environment and guard', () => {
    it('reads the guard like the web: only an explicit false is a no', () => {
        expect(readGuardStatus({})).toEqual({ configured: true, reachable: true });
        expect(readGuardStatus({ configured: false, reachable: false })).toEqual({ configured: false, reachable: false });
        expect(readGuardStatus(null)).toBeNull();
    });

    it('knows whether web search and EU models are set up', () => {
        expect(readWebSearchEnabled({ searchProvider: 'serper' })).toBe(true);
        expect(readWebSearchEnabled({ searchProvider: 'disabled' })).toBe(false);
        expect(readWebSearchEnabled(null)).toBe(false);
        expect(readEuModelsConfigured({ fast: { modelId: ' ' }, pro: { modelId: 'mistral-large' } })).toBe(true);
        expect(readEuModelsConfigured({ fast: { modelId: '' } })).toBe(false);
        expect(readEuModelsConfigured(null)).toBe(false);
        expect(readShieldEnv(null, null)).toEqual({ hasWebSearchEnabled: false, hasEuModelsConfigured: false });
    });
});

describe('activity', () => {
    it('reads the guardrail overview, with Postgres strings as numbers', () => {
        expect(readGuardOverview({
            summary: { total_events: '12', pii_count: '9', dlp_blocked: '2', unique_users: '3' },
            top_categories: [{ category: 'Email', violation_type: 'pii', count: '4' }],
            top_users: [{ user_id: 'u1', display_name: 'Bea', total: '5' }, { user_id: 'u2', total: 1 }],
            health: { last_event_at: '2026-09-02T00:00:00Z' },
        })).toEqual({
            totalEvents: 12,
            piiCount: 9,
            dlpBlocked: 2,
            uniqueUsers: 3,
            topCategories: [{ category: 'Email', count: 4 }],
            topUsers: [{ userId: 'u1', name: 'Bea', total: 5 }, { userId: 'u2', name: 'u2', total: 1 }],
            lastEventAt: '2026-09-02T00:00:00Z',
        });
        expect(readGuardOverview(null).totalEvents).toBe(0);
    });

    it('reads the integrations overview', () => {
        const r = readIntegrationOverview({
            summary: { total_calls: '10', non_eu_count: '4', pii_non_eu_count: '1', blocked_count: '0', sovereignty_score: 64, score_delta: null },
            top: { destinations: [{ dest_host: 'api.x.com', country_code: 'US', country_name: 'United States', is_eu: false, is_local: false, total: '4', pii_events: '1' }] },
            pii_categories: [{ category: 'Email', count: 1, non_eu_count: 1 }],
        });
        expect(r).toMatchObject({ totalCalls: 10, nonEuCount: 4, piiNonEuCount: 1, sovereigntyScore: 64, scoreDelta: null });
        expect(r.destinations[0]).toEqual({ country_code: 'US', country_name: 'United States', is_eu: false, is_local: false, total: 4, pii_events: 1 });
        expect(readIntegrationOverview(undefined).destinations).toEqual([]);
    });

    it('lists every destination host where the server draws a map, not only its top ten', () => {
        const host = (dest_host: string, country_code: string) => ({ dest_host, country_code, country_name: country_code, is_eu: false, is_local: false, total: 1, pii_events: 0 });
        const r = readIntegrationOverview({
            top: { destinations: [host('a.example', 'US')] },
            map: { destinations: [host('a.example', 'US'), host('b.example', 'JP')] },
        });
        expect(r.destinations.map((d) => d.country_code)).toEqual(['US', 'JP']);
    });

    it('reads event and egress rows', () => {
        expect(readGuardEvents([{ id: 7, timestamp: 't', violation_type: 'pii', violation_categories: 'Email', action_taken: 'redacted', display_name: 'Bea', user_id: 'u1', source: 'direct_chat' }])[0]).toMatchObject({
            id: 7, categories: 'Email', action: 'redacted', userName: 'Bea', agentName: null,
        });
        expect(readEgress([{ id: 3, timestamp: 't', integration_type: '', tool_name: 'gmail', server_endpoint: 'gmail.googleapis.com', country_name: 'US', is_eu: false, is_local: false, pii_categories_detected: 'Email', user_id: 'u1' }])[0]).toMatchObject({
            integration: 'gmail', destination: 'gmail.googleapis.com', userName: 'u1', status: null,
        });
        expect(readGuardEvents({})).toEqual([]);
    });
});
