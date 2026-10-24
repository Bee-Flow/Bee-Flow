// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { extractFormState, buildPatch } from './formState';

/**
 * The round trip of the three R2 fields on an ai_step: `agentId`, `skillIds` and
 * `agentPermissions`.
 *
 * The rule fixed here is not "the values come through" but this: `agentPermissions` is REBUILT
 * on BOTH sides from the three known names, never passed through and never mixed in. A half
 * object that stays behind yields an `undefined`, and the next reader who writes `!== false`
 * reads that as yes. That is precisely the mistake this layer made two rounds in a row.
 *
 * Run: cd agent-hub && ./node_modules/.bin/vitest run src/components/automation/Builder/flow/settings/formState.agentStep.test.js
 */

const aiStep = (over = {}) => ({ id: 's1', type: 'ai_step', prompt: 'Do X', inputs: {}, ...over });
const roundTrip = (step) => buildPatch(step, extractFormState(step));

describe('ai_step round trip — agent, skills, permissions', () => {
    it('a plain step says all three out loud rather than leaving them absent', () => {
        const patch = roundTrip(aiStep());
        expect(patch.agentId).toBeNull();
        expect(patch.skillIds).toEqual([]);
        expect(patch.agentPermissions).toEqual({ startAutomations: false, useKnowledge: false, useTools: false });
    });

    it('says nothing about an already-canonical step — buildPatch sends only what changed', () => {
        const patch = roundTrip(aiStep({
            agentId: 'agt_1',
            skillIds: ['sk_2', 'sk_1'],
            agentPermissions: { startAutomations: true, useKnowledge: false, useTools: true },
        }));
        expect('agentId' in patch).toBe(false);
        expect('skillIds' in patch).toBe(false);
        expect('agentPermissions' in patch).toBe(false);
    });

    it('binding a step to an agent writes the three permissions along with it', () => {
        // Not "leaves them out and lets the runner guess": the step arrives at
        // the server saying all three noes out loud.
        const step = aiStep();
        const patch = buildPatch(step, { ...extractFormState(step), agentId: 'agt_1' });
        expect(patch.agentId).toBe('agt_1');
        expect(patch.agentPermissions).toEqual({ startAutomations: false, useKnowledge: false, useTools: false });
    });

    it('keeps the order of a re-ordered skill list — the first one leads', () => {
        const step = aiStep({ skillIds: ['sk_1', 'sk_2'] });
        const patch = buildPatch(step, { ...extractFormState(step), skillIds: ['sk_2', 'sk_1'] });
        expect(patch.skillIds).toEqual(['sk_2', 'sk_1']);
    });

    it('a half-written permission object comes back whole, with the rest OFF', () => {
        const patch = roundTrip(aiStep({ agentId: 'agt_1', agentPermissions: { useTools: true } }));
        expect(patch.agentPermissions).toEqual({ startAutomations: false, useKnowledge: false, useTools: true });
    });

    it('a permission object nobody can read is three noes, not three yeses', () => {
        const patch = roundTrip(aiStep({ agentId: 'agt_1', agentPermissions: 'all' }));
        expect(patch.agentPermissions).toEqual({ startAutomations: false, useKnowledge: false, useTools: false });
    });

    it('trims the agent id and turns a blank one into no agent at all', () => {
        expect(roundTrip(aiStep({ agentId: '  agt_1  ' })).agentId).toBe('agt_1');
        expect(roundTrip(aiStep({ agentId: '   ' })).agentId).toBeNull();
    });

    it('cuts the skill list at the cap the runner also cuts at', () => {
        const patch = roundTrip(aiStep({ skillIds: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] }));
        expect(patch.skillIds).toEqual(['a', 'b', 'c', 'd', 'e']);
    });
});
