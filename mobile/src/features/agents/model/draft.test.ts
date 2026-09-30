import { configFlag, createPayload, draftOf, emptyDraft, sameDraft, savePayload, toggleId, validateDraft, type AgentDetail } from './draft';

const t = (_key: string, fallback: string) => fallback;

const AGENT: AgentDetail = {
    id: 'a1',
    name: 'Helpdesk',
    description: null,
    avatar: null,
    model: 'tier:fast',
    owner_id: 'u1',
    is_published: false,
    starter_prompts: '["Reset my password", "  "]',
    config: { avatar: '🛠️', knowledge_base_ids: ['kb1'] },
    organization_id: 'o1',
    shared_groups: [],
    category_id: 'c1',
    rev: 7,
    system_prompt: 'Be helpful.',
};

describe('the agent draft', () => {
    it('reads an agent into the editor, legacy picture and JSON starters included', () => {
        expect(draftOf(AGENT)).toEqual({
            name: 'Helpdesk',
            description: '',
            avatar: '🛠️',
            systemPrompt: 'Be helpful.',
            model: 'tier:fast',
            categoryId: 'c1',
            starterPrompts: ['Reset my password'],
            config: { avatar: '🛠️', knowledge_base_ids: ['kb1'] },
        });
    });

    it('saves the full snapshot against the loaded rev, and no persona unless given', () => {
        const draft = { ...draftOf(AGENT), name: '  Service desk ', model: '', starterPrompts: ['a', ' ', ' b '] };
        const body = savePayload(draft, 7);
        expect(body).toEqual({
            name: 'Service desk',
            description: '',
            systemPrompt: 'Be helpful.',
            model: null,
            avatar: '🛠️',
            categoryId: 'c1',
            starterPrompts: ['a', 'b'],
            config: { avatar: '🛠️', knowledge_base_ids: ['kb1'] },
            baseVersion: 7,
        });
        expect(body).not.toHaveProperty('persona');
        expect(savePayload(draft, undefined, null)).toMatchObject({ persona: null });
        expect(savePayload(draft)).not.toHaveProperty('baseVersion');
    });

    it('creates with the picture in config, where POST /agents reads it', () => {
        const body = createPayload({ ...emptyDraft('New'), avatar: '🐝' });
        expect(body.config).toMatchObject({ avatar: '🐝', enabledIntegrations: [], knowledge_base_ids: [] });
        expect(body).not.toHaveProperty('avatar');
    });

    it('needs a name, and nothing else', () => {
        expect(validateDraft(t, emptyDraft('  '))).toEqual({ name: 'Give the agent a name.' });
        expect(validateDraft(t, emptyDraft('x'))).toEqual({});
    });

    it('compares drafts by value', () => {
        expect(sameDraft(draftOf(AGENT), draftOf(AGENT))).toBe(true);
        expect(sameDraft(draftOf(AGENT), { ...draftOf(AGENT), name: 'x' })).toBe(false);
    });

    it('toggles ids and reads flags with the web defaults', () => {
        expect(toggleId(['a'], 'b')).toEqual(['a', 'b']);
        expect(toggleId(['a', 'b'], 'a')).toEqual(['b']);
        expect(toggleId(null, 'a')).toEqual(['a']);
        expect(configFlag({}, 'allowCopy')).toBe(true);
        expect(configFlag({ allowCopy: false }, 'allowCopy')).toBe(false);
        expect(configFlag({}, 'useGeneralMemory')).toBe(true);
        expect(configFlag({}, 'memoryEnabled')).toBe(false);
        expect(configFlag({ strictKnowledge: true }, 'strictKnowledge')).toBe(true);
    });
});
