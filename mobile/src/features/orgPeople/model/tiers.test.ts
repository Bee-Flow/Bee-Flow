import { translate } from '@/core/i18n';

import {
    applyDraft,
    collides,
    draftOf,
    newTier,
    parseMaxTokens,
    removeTier,
    slugifyTierLabel,
    standardTiers,
    taskTypeLabel,
    tierPills,
    toggleTier,
    upsertTier,
} from './tiers';
import type { CustomTier } from './types';

const tier = (id: string, extra: Partial<CustomTier> = {}): CustomTier => ({
    id,
    label: id.replace('custom:', ''),
    icon: '✨',
    description: '',
    modelId: '',
    euModelId: '',
    maxTokens: 16384,
    temperature: 0.7,
    allowedTaskTypes: ['direct_chat'],
    ...extra,
});

describe('group tiers', () => {
    it('lists the four standard tiers, then the custom ones', () => {
        expect(standardTiers(translate).map((x) => x.id)).toEqual(['fast', 'thinking', 'writer', 'pro']);
        const pills = tierPills(translate, [{ id: 'custom:x', label: '' }]);
        expect(pills[4]).toEqual({ id: 'custom:x', label: 'custom:x', icon: '✨', custom: true });
    });

    it('restricts an unrestricted group to the first tier picked, and lifts one again', () => {
        expect(toggleTier([], 'fast')).toEqual(['fast']);
        expect(toggleTier(['fast', 'pro'], 'fast')).toEqual(['pro']);
    });
});

describe('custom tiers', () => {
    it('slugs a label the way the web does', () => {
        expect(slugifyTierLabel('  Sales Team — EU!  ')).toBe('custom:sales-team-eu');
        expect(slugifyTierLabel('???')).toBe('');
    });

    it('starts a new tier on the first free placeholder id with the web’s defaults', () => {
        const next = newTier([tier('custom:org-tier-2')]);
        expect(next.id).toBe('custom:org-tier-3');
        expect(next).toMatchObject({ maxTokens: 16384, temperature: 0.7, allowedTaskTypes: ['direct_chat', 'agent_chat'] });
        expect(newTier([]).id).toBe('custom:org-tier-1');
    });

    it('applies a draft: the id follows the label, unknown keys survive, bad numbers keep the old value', () => {
        const base = tier('custom:old', { reasoningEffort: 'high' });
        const draft = { ...draftOf(base), label: ' New Name ', maxTokens: 'abc', allowedTaskTypes: ['agent_chat', 'x'] };
        const next = applyDraft(base, draft);
        expect(next).toMatchObject({ id: 'custom:new-name', label: 'New Name', maxTokens: 16384, reasoningEffort: 'high' });
        expect(next.allowedTaskTypes).toEqual(['agent_chat']);
        expect(applyDraft(base, { ...draftOf(base), label: '!!', icon: '' })).toMatchObject({ id: 'custom:old', icon: '✨' });
    });

    it('bounds max tokens to the web’s input', () => {
        expect(parseMaxTokens('4096')).toBe(4096);
        expect(parseMaxTokens('100')).toBeNull();
        expect(parseMaxTokens('1.5')).toBeNull();
    });

    it('replaces, appends, removes and spots a rename onto another tier', () => {
        const list = [tier('custom:a'), tier('custom:b')];
        expect(upsertTier(list, 'custom:a', tier('custom:c')).map((x) => x.id)).toEqual(['custom:c', 'custom:b']);
        expect(upsertTier(list, null, tier('custom:c')).map((x) => x.id)).toEqual(['custom:a', 'custom:b', 'custom:c']);
        expect(removeTier(list, 'custom:a').map((x) => x.id)).toEqual(['custom:b']);
        expect(collides(list, 'custom:a', 'custom:b')).toBe(true);
        expect(collides(list, 'custom:a', 'custom:a')).toBe(false);
    });

    it('names the task types', () => {
        expect(taskTypeLabel('agent_chat', translate)).toBe('Agent Chat');
        expect(taskTypeLabel('direct_chat', translate)).toBe('Direct Chat');
    });
});
