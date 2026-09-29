import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';

/**
 * The effort select for a model that carries its own vocabulary.
 *
 * Mistral Small 4 and Medium 3.5 reason on a switch: `none` or `high`. The
 * server stamps that list on the model (`efforts` in /ai/providers/:id/models)
 * and maps any other level onto the nearest of the two. Pinned here:
 *
 *   1. the select offers exactly the stamped levels, not OpenAI's five;
 *   2. it shows what the server will really send — a tier stored (or
 *      defaulted) as 'medium' reads as High, 'low' as None;
 *   3. a choice reaches updateFn as the plain value.
 */

vi.mock('../../shared/SearchableModelSelect', () => ({ default: () => null }));

import TierCard from './TierCard';
import { clampToEfforts, defaultTierEffort, stampedEffortOptions } from './modelMeta';

afterEach(cleanup);

const mistralSmall = { id: 'mistral-small-latest', name: 'Mistral Small 4', reasoning: true, efforts: ['none', 'high'] };
const gpt = { id: 'gpt-5.6-terra' };

function renderCard(tierKey: string, tierConfig: Record<string, unknown>, updateFn = vi.fn()) {
    render(
        <TierCard
            tier={{ key: tierKey, label: tierKey, desc: '', icon: '' }}
            tierConfig={tierConfig}
            updateFn={updateFn}
            defaults={{ maxTokens: 4096, temperature: 0.5 }}
            expandedTier={tierKey}
            setExpandedTier={vi.fn()}
            chatModels={[mistralSmall, gpt]}
            byProvider={{}}
            hiddenModelIds={[]}
            toggleHiddenModel={vi.fn()}
            isLocal={() => false}
            reasoningCapable={() => true}
            applyClaudeRecommendedForTier={vi.fn()}
        />,
    );
    return { select: screen.getByRole('combobox') as HTMLSelectElement, updateFn };
}

const optionValues = (select: HTMLSelectElement) => Array.from(select.options).map(o => o.value);

describe('TierCard: a stamped effort vocabulary', () => {
    it('offers exactly the stamped levels', () => {
        const { select } = renderCard('thinking', { modelId: mistralSmall.id });
        expect(optionValues(select)).toEqual(['none', 'high']);
    });

    it('shows what the server sends: an unset thinking tier (medium) reads as High', () => {
        const { select } = renderCard('thinking', { modelId: mistralSmall.id });
        expect(select.value).toBe('high');
    });

    it('shows a stored Low as None, and an unset fast tier as None', () => {
        expect(renderCard('standard', { modelId: mistralSmall.id, reasoningEffort: 'low' }).select.value).toBe('none');
        cleanup();
        expect(renderCard('fast', { modelId: mistralSmall.id }).select.value).toBe('none');
    });

    it('hands the chosen level to updateFn as is', async () => {
        const { select, updateFn } = renderCard('thinking', { modelId: mistralSmall.id });
        await userEvent.selectOptions(select, 'none');
        expect(updateFn).toHaveBeenCalledWith('thinking', 'reasoningEffort', 'none');
    });

    it('leaves a model without a stamped vocabulary on its own options', () => {
        const { select } = renderCard('thinking', { modelId: gpt.id, reasoningEffort: 'medium' });
        expect(optionValues(select)).toContain('medium');
        expect(select.value).toBe('medium');
    });
});

describe('effort helpers', () => {
    it('clampToEfforts: nearest level, a tie goes to the cheaper one', () => {
        const efforts = ['none', 'high'];
        expect(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].map(v => clampToEfforts(v, efforts)))
            .toEqual(['none', 'none', 'none', 'high', 'high', 'high', 'high']);
        expect(clampToEfforts('medium', null)).toBe('medium');
    });

    it('defaultTierEffort mirrors the server tier defaults', () => {
        expect(defaultTierEffort('fast')).toBe('none');
        expect(defaultTierEffort('thinking')).toBe('medium');
        expect(defaultTierEffort('deep_thinking')).toBe('high');
        expect(defaultTierEffort('custom:x')).toBe('none');
    });

    it('stampedEffortOptions labels every level', () => {
        expect(stampedEffortOptions(['none', 'high']).map(([v]) => v)).toEqual(['none', 'high']);
        expect(stampedEffortOptions(['none', 'high']).every(([, label]) => label.length > 0)).toBe(true);
    });
});
