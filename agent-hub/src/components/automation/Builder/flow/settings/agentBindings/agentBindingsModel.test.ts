import { describe, expect, it } from 'vitest';
import type { BoundAgent } from '../../../../../../api/queries/automation/agentBindings';
import { editableIds, pickableAgents, refusalText, withAgent, withoutAgent } from './agentBindingsModel';

const bound = (over: Partial<BoundAgent>): BoundAgent => ({ agentId: 'a1', name: 'A', canEdit: true, missing: false, usable: true, notGranted: false, ...over });

describe('what a save sends', () => {
    const rows = [
        bound({ agentId: 'a1' }),
        bound({ agentId: null, name: null, canEdit: false, usable: null, notGranted: null }),
        bound({ agentId: 'gone', missing: true, usable: false }),
        bound({ agentId: 'a2' }),
    ];

    it('is the linked agents the viewer can edit: not the anonymous ones, not a deleted one', () => {
        expect(editableIds(rows)).toEqual(['a1', 'a2']);
    });

    it('adds an agent once and removes one without touching the rest', () => {
        expect(withAgent(rows, 'a3')).toEqual(['a1', 'a2', 'a3']);
        expect(withAgent(rows, 'a1')).toEqual(['a1', 'a2']);
        expect(withoutAgent(rows, 'a1')).toEqual(['a2']);
        expect(withoutAgent(rows, 'gone')).toEqual(['a1', 'a2']);
    });
});

describe('what the picker still offers', () => {
    it('leaves out the agents that are already linked', () => {
        const candidates = [{ id: 'a1', name: 'A', description: null }, { id: 'a9', name: 'Z', description: null }];
        expect(pickableAgents({ bindings: [bound({ agentId: 'a1' })], candidates }).map((c) => c.id)).toEqual(['a9']);
    });

    it('offers nothing when the candidates could not be read', () => {
        expect(pickableAgents({ bindings: [], candidates: null })).toEqual([]);
    });
});

describe('refusalText', () => {
    it('gives each server code its own sentence key, and 403 without a code the forbidden one', () => {
        expect(refusalText('agent_not_linkable', 403).key).toBe('automationAgentBindings.error.agent_not_linkable');
        expect(refusalText('agent_owner_cannot_use', 403).key).toBe('automationAgentBindings.error.agent_owner_cannot_use');
        expect(refusalText('tool_name_taken', 409).key).toBe('automationAgentBindings.error.tool_name_taken');
        expect(refusalText('not_agent_call', 409).key).toBe('automationAgentBindings.error.not_agent_call');
        expect(refusalText('automation_forbidden', 403).key).toBe('automationAgentBindings.error.forbidden');
        expect(refusalText(null, 403).key).toBe('automationAgentBindings.error.forbidden');
        expect(refusalText(null, 500).key).toBe('automationAgentBindings.error.generic');
    });
});
