import { agentKnowledgeBases, audienceLabel, availableAgentApps, modelLabel, modelOptions, selectableTierKeys, tierName } from './editorOptions';

const t = (_key: string, fallback: string) => fallback;

describe('editor options', () => {
    it('offers the org default, then the tiers in the web words, never auto', () => {
        const options = modelOptions(t, { auto: {}, fast: {}, standard: {}, 'custom:legal': { label: 'Legal' } }, '');
        expect(options.map((o) => [o.value, o.label])).toEqual([
            ['', 'Your organisation’s default'],
            ['tier:fast', 'Fast'],
            ['tier:standard', 'Flow'],
            ['tier:custom:legal', 'Legal'],
        ]);
    });

    it('keeps a model the list no longer carries', () => {
        const options = modelOptions(t, { fast: {} }, 'gpt-4o');
        expect(modelLabel(t, options, 'gpt-4o')).toBe('gpt-4o');
        expect(modelLabel(t, modelOptions(t, {}, 'tier:thinking'), 'tier:thinking')).toBe('Think');
    });

    it('names tiers like the web', () => {
        expect(tierName(t, 'pro')).toBe('Deep Thinking');
        expect(tierName(t, 'custom:x')).toBe('x');
        expect(selectableTierKeys({ auto: {}, fast: {}, thinking: {} })).toEqual(['fast', 'thinking']);
        expect(selectableTierKeys(undefined)).toEqual([]);
    });

    it('offers only the built-ins until the org allow-list is known', () => {
        const catalog = [{ id: 'agent-search' }, { id: 'gmail' }, { id: 'slack' }];
        expect(availableAgentApps(catalog, null, false).map((a) => a.id)).toEqual(['agent-search']);
        expect(availableAgentApps(catalog, null, true).map((a) => a.id)).toEqual(['agent-search', 'gmail', 'slack']);
        expect(availableAgentApps(catalog, ['slack'], true).map((a) => a.id)).toEqual(['agent-search', 'slack']);
    });

    it('filters knowledge bases to the agent context, silence meaning everywhere', () => {
        const bases = [{ id: 'a' }, { id: 'b', usage_contexts: ['direct_chat'] }, { id: 'c', usage_contexts: ['agent'] }];
        expect(agentKnowledgeBases(bases).map((b) => b.id)).toEqual(['a', 'c']);
    });

    it('says who may use it', () => {
        expect(audienceLabel(t, false, [])).toBe('Personal');
        expect(audienceLabel(t, true, [])).toBe('Entire Organisation');
        expect(audienceLabel(t, true, ['g1'])).toBe('Visible to groups');
    });
});
