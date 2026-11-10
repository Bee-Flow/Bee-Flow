// BFSF-249: the org editor sends only what the admin changed, so a stale
// override it merely loaded never travels back as an explicit limit.
import { describe, expect, it } from 'vitest';
import { orgSavePayload, type OrgForm } from './orgSavePayload';

const loaded: OrgForm = {
    plan_id: 'launch',
    status: 'active',
    max_cost_per_month: null,
    max_users: null,
    max_agents: 5,
    max_knowledge_sources: 3,
    allowed_features: ['a'],
    notes: '',
};

describe('orgSavePayload', () => {
    it('sends nothing when nothing changed, not the loaded limits', () => {
        expect(orgSavePayload(loaded, { ...loaded })).toEqual({});
    });

    it('sends a changed plan without the untouched stale limits', () => {
        const payload = orgSavePayload(loaded, { ...loaded, plan_id: 'pro' });
        expect(payload).toEqual({ plan_id: 'pro' });
        expect(payload).not.toHaveProperty('max_agents');
        expect(payload).not.toHaveProperty('max_knowledge_sources');
    });

    it('sends a limit the admin changed, and a switched-off override as null', () => {
        expect(orgSavePayload(loaded, { ...loaded, max_agents: 20, max_knowledge_sources: null }))
            .toEqual({ max_agents: 20, max_knowledge_sources: null });
    });

    it('treats an override switched on but left empty as no change from "no override"', () => {
        expect(orgSavePayload(loaded, { ...loaded, max_users: '' })).toEqual({});
    });

    it('sends an emptied limit as null, never as an empty string (the server reads it as 0)', () => {
        expect(orgSavePayload(loaded, { ...loaded, max_agents: '' })).toEqual({ max_agents: null });
    });

    it('compares feature lists by value', () => {
        expect(orgSavePayload(loaded, { ...loaded, allowed_features: ['a'] })).toEqual({});
        expect(orgSavePayload(loaded, { ...loaded, allowed_features: ['a', 'b'] })).toEqual({ allowed_features: ['a', 'b'] });
    });
});
