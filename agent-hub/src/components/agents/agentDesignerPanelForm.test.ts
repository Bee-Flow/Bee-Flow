import { describe, expect, it } from 'vitest';
import { panelFormFromAgent } from './agentDesignerPanelForm';

// On Postgres the agent's on/off columns are BOOLEAN: `=== 1` read a published
// agent as unpublished and `!== 0` read every OFF switch as ON, so a save from
// this panel switched the embed off and copy/workspace on.
describe('panelFormFromAgent', () => {
    it('reads boolean columns as stored', () => {
        const form = panelFormFromAgent({
            id: 'a1', is_published: true, embed_enabled: true, workspace_enabled: false, copy_enabled: false,
        } as never);
        expect(form).toMatchObject({ isPublished: true, embedEnabled: true, workspaceEnabled: false, copyEnabled: false });
    });

    it('still reads the integer spelling, and the column defaults for a missing value', () => {
        expect(panelFormFromAgent({ id: 'a1', is_published: 1, embed_enabled: 0, workspace_enabled: 1, copy_enabled: 0 }))
            .toMatchObject({ isPublished: true, embedEnabled: false, workspaceEnabled: true, copyEnabled: false });
        expect(panelFormFromAgent({ id: 'a1' }))
            .toMatchObject({ isPublished: false, embedEnabled: false, workspaceEnabled: false, copyEnabled: true });
    });

    it('keeps the stored config whole, from an object or JSON text', () => {
        const config = { attachedSkillIds: ['s1'], tools: { gmail: { actions: ['read'] } }, allowCopy: false };
        expect(panelFormFromAgent({ id: 'a1', config }).config).toEqual(config);
        expect(panelFormFromAgent({ id: 'a1', config: JSON.stringify(config) as never }).config).toEqual(config);
        expect(panelFormFromAgent({ id: 'a1', config: 'not json' as never }).config).toEqual({});
    });

    it('parses starter prompts and shared groups stored as JSON text', () => {
        const form = panelFormFromAgent({ id: 'a1', starter_prompts: '["hi"]', shared_groups: '["g1"]' });
        expect(form.starterPrompts).toEqual(['hi']);
        expect(form.sharedGroups).toEqual(['g1']);
    });
});
