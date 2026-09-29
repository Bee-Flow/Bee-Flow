// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { extractFormState, buildPatch, readAgentPermissions, readSkillIds } from './formState';

/**
 * De heen-en-terugreis van de drie R2-velden op een ai_step: `agentId`,
 * `skillIds` en `agentPermissions`.
 *
 * De regel die hier wordt vastgelegd is niet "de waarden komen door" maar:
 * `agentPermissions` wordt aan BEIDE kanten OPNIEUW OPGEBOUWD uit de drie
 * bekende namen, nooit doorgegeven en nooit ingemengd. Een half object dat
 * blijft staan levert een `undefined`, en de eerstvolgende lezer die
 * `!== false` schrijft leest die als ja — dat is precies de fout die deze
 * laag twee ronden achter elkaar opleverde.
 *
 * Draaien: cd agent-hub && ./node_modules/.bin/vitest run src/components/automation/Builder/flow/settings/formState.agentStep.test.js
 */

const aiStep = (over = {}) => ({ id: 's1', type: 'ai_step', prompt: 'Do X', inputs: {}, ...over });
const roundTrip = (step) => buildPatch(step, extractFormState(step));

describe('readAgentPermissions', () => {
    it('is three real booleans, whatever came in', () => {
        expect(readAgentPermissions(undefined)).toEqual({ startAutomations: false, useKnowledge: false, useTools: false });
        expect(readAgentPermissions(null)).toEqual({ startAutomations: false, useKnowledge: false, useTools: false });
        expect(readAgentPermissions('yes')).toEqual({ startAutomations: false, useKnowledge: false, useTools: false });
        expect(readAgentPermissions([])).toEqual({ startAutomations: false, useKnowledge: false, useTools: false });
    });

    it('a value nobody can read is not a grant', () => {
        // `"false"`, `1` and `"no"` are all truthy in JavaScript. Only a real
        // `true` is a yes — anything else is somebody's typo, and a typo may
        // not turn into permission.
        const out = readAgentPermissions({ startAutomations: 'false', useKnowledge: 1, useTools: 'yes' });
        expect(out).toEqual({ startAutomations: false, useKnowledge: false, useTools: false });
    });

    it('fills the keys a half-written object left out', () => {
        expect(readAgentPermissions({ useTools: true })).toEqual({
            startAutomations: false, useKnowledge: false, useTools: true,
        });
    });

    it('drops a key nobody enforces instead of carrying it along', () => {
        const out = readAgentPermissions({ useTools: true, deleteEverything: true });
        expect(Object.keys(out).sort()).toEqual(['startAutomations', 'useKnowledge', 'useTools']);
    });
});

describe('readSkillIds', () => {
    it('keeps the author\'s order — the first is the leading skill', () => {
        expect(readSkillIds(['b', 'a', 'c'])).toEqual(['b', 'a', 'c']);
    });

    it('dedupes without re-ordering, and drops what is not an id', () => {
        expect(readSkillIds(['a', 'b', 'a', '', null, 7, 'c'])).toEqual(['a', 'b', 'c']);
    });

    it('anything that is not a list is no skills', () => {
        expect(readSkillIds(undefined)).toEqual([]);
        expect(readSkillIds('sk_1')).toEqual([]);
    });
});

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
