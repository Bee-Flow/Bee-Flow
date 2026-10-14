import { describe, expect, it } from 'vitest';
import { readAgentPermissions, readSkillIds } from './aiStepAgent';

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
