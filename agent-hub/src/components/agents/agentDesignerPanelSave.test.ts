// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { panelConfigForSave } from './agentDesignerPanelSave';

describe('panelConfigForSave', () => {
    const loaded = { attachedSkillIds: ['s1'], memoryEnabled: false, old: 1 };
    const draft = { attachedSkillIds: ['s1'], memoryEnabled: true, old: 1, tools: { gmail: {} } };

    it('keeps the draft where the panel changed nothing', () => {
        expect(panelConfigForSave(draft, loaded, { ...loaded })).toEqual(draft);
    });

    it('an edited key wins over the draft', () => {
        const out = panelConfigForSave(draft, loaded, { ...loaded, attachedSkillIds: ['s1', 's2'] });
        expect(out).toEqual({ ...draft, attachedSkillIds: ['s1', 's2'] });
    });

    it('a key the panel added is sent, a key it removed is dropped', () => {
        const edited: Record<string, unknown> = { attachedSkillIds: ['s1'], memoryEnabled: false, added: true };
        const out = panelConfigForSave(draft, loaded, edited);
        expect(out.added).toBe(true);
        expect('old' in out).toBe(false);
        expect(out.tools).toEqual({ gmail: {} });
        expect(out.memoryEnabled).toBe(true);
    });
});
