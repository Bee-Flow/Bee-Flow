import { describe, it, expect } from 'vitest';
import { buildStepFromPayload } from './applyAddNode';

/** "Use an agent" / "Apply a skill" palette items, and agents or skills dragged from Studio. */
describe('buildStepFromPayload — ai_step with an agent or skills', () => {
    it('carries agentId with all three permissions off', () => {
        const step = buildStepFromPayload({ kind: 'ai_step', agentId: 'agt', label: 'Quote assistant' }, { x: 1, y: 2 }) as Record<string, unknown>;
        expect(step.agentId).toBe('agt');
        expect(step.agentPermissions).toEqual({ startAutomations: false, useKnowledge: false, useTools: false });
        expect(step.label).toBe('Quote assistant');
    });

    it('carries skillIds in order, deduped', () => {
        const step = buildStepFromPayload({ kind: 'ai_step', skillIds: ['s1', 's2', 's1', ''] }, null) as Record<string, unknown>;
        expect(step.skillIds).toEqual(['s1', 's2']);
        expect(step.agentId).toBeUndefined();
    });

    it('a plain AI step stays as it was', () => {
        const step = buildStepFromPayload({ kind: 'ai_step' }, null) as Record<string, unknown>;
        expect(step.agentId).toBeUndefined();
        expect(step.skillIds).toBeUndefined();
    });
});
