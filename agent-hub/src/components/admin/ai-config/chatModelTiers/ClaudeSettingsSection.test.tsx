import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import ClaudeSettingsSection from './ClaudeSettingsSection';
import useClaudeSettings from './useClaudeSettings';
import type { TierConfig } from './tierTypes';

/**
 * "Apply all recommended" only touches tiers whose recommended model this
 * server offers, and only after the admin confirms.
 */

const SONNET_ONLY = [{ id: 'claude-sonnet-4-6', providerName: 'Anthropic', providerType: 'claude' }];

function renderSection(over: Partial<Parameters<typeof ClaudeSettingsSection>[0]> = {}) {
    const props = {
        claudeAutoRetry: true, setClaudeAutoRetry: vi.fn(), claudeSaving: false, claudeMessage: null,
        claudeRecAppliedTier: null, saveClaudeSettings: vi.fn(async () => {}),
        applyClaudeRecommendedForTier: vi.fn(), applyAllClaudeRecommended: vi.fn(() => 0),
        chatModels: SONNET_ONLY,
        ...over,
    };
    render(<ClaudeSettingsSection {...props} />);
    return props;
}

describe('ClaudeSettingsSection', () => {
    it('asks before applying all, names how many tiers change, and applies nothing on cancel', async () => {
        const user = userEvent.setup();
        const props = renderSection();
        await user.click(screen.getByRole('button', { name: 'Apply all recommended' }));
        const dialog = await screen.findByRole('dialog');
        expect(dialog.textContent).toContain('3 tiers');
        await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
        expect(props.applyAllClaudeRecommended).not.toHaveBeenCalled();

        await user.click(screen.getByRole('button', { name: 'Apply all recommended' }));
        const again = await screen.findByRole('dialog');
        await user.click(within(again).getByRole('button', { name: 'Apply all recommended' }));
        expect(props.applyAllClaudeRecommended).toHaveBeenCalledWith(SONNET_ONLY);
    });

    it('disables Apply on the rows whose model the server does not offer', () => {
        renderSection();
        const applyButtons = screen.getAllByRole('button', { name: 'Apply' });
        // fast (Haiku), standard, swarm, thinking (Sonnet 5), writer, pro (Opus): only the Sonnet 4.6 rows apply.
        expect(applyButtons.map(b => (b as HTMLButtonElement).disabled)).toEqual([true, false, false, true, false, true]);
    });

    it('says "1 tier", not "1 tiers", when one recommendation applies', async () => {
        const user = userEvent.setup();
        renderSection({ chatModels: [{ id: 'claude-haiku-4-5-20251001', providerName: 'Anthropic' }] });
        await user.click(screen.getByRole('button', { name: 'Apply all recommended' }));
        const dialog = await screen.findByRole('dialog');
        expect(dialog.textContent).toContain('1 tier (');
        expect(dialog.textContent).not.toContain('1 tiers');
    });

    it('disables Apply all when no recommended model is offered', () => {
        renderSection({ chatModels: [{ id: 'claude-opus-4-8', providerName: 'Anthropic' }] });
        expect((screen.getByRole('button', { name: 'Apply all recommended' }) as HTMLButtonElement).disabled).toBe(true);
    });
});

describe('useClaudeSettings: applying recommendations', () => {
    const start: TierConfig = {
        fast: { modelId: 'mistral-small-latest' },
        standard: { modelId: 'mistral-large-latest' },
        pro: { modelId: 'mistral-large-latest' },
    };

    it('Apply all changes only the tiers whose recommended model is in the catalogue', () => {
        const setConfig = vi.fn();
        const { result } = renderHook(() => useClaudeSettings(start, setConfig));
        let changed = 0;
        act(() => { changed = result.current.applyAllClaudeRecommended([{ id: 'claude-haiku-4-5-20251001' }, { id: 'claude-sonnet-4-6' }]); });
        expect(changed).toBe(4);
        const update = setConfig.mock.calls[0][0] as (prev: TierConfig) => TierConfig;
        const next = update(start);
        expect(next.fast.modelId).toBe('claude-haiku-4-5-20251001');
        expect(next.standard.modelId).toBe('claude-sonnet-4-6');
        expect(next.pro).toEqual(start.pro);
        expect(next.thinking).toBeUndefined();
    });

    it('Apply all lays the recommendations over the latest config, not the one the confirm saw', () => {
        const setConfig = vi.fn();
        const { result } = renderHook(() => useClaudeSettings({}, setConfig));
        act(() => { result.current.applyAllClaudeRecommended([{ id: 'claude-sonnet-4-6' }]); });
        const update = setConfig.mock.calls[0][0] as (prev: TierConfig) => TierConfig;
        // The tier config loaded while the confirm dialog was open: it survives.
        const next = update(start);
        expect(next.fast).toEqual(start.fast);
        expect(next.pro).toEqual(start.pro);
        expect(next.standard.modelId).toBe('claude-sonnet-4-6');
    });

    it('Apply all with nothing applicable leaves the configuration alone', () => {
        const setConfig = vi.fn();
        const { result } = renderHook(() => useClaudeSettings(start, setConfig));
        act(() => { result.current.applyAllClaudeRecommended([{ id: 'mistral-large-latest' }]); });
        expect(setConfig).not.toHaveBeenCalled();
    });

    it('one tier: no-op when its model is not offered, the catalogue id when it is', () => {
        const setConfig = vi.fn();
        const { result } = renderHook(() => useClaudeSettings(start, setConfig));
        act(() => { result.current.applyClaudeRecommendedForTier('pro', [{ id: 'claude-sonnet-4-6' }]); });
        expect(setConfig).not.toHaveBeenCalled();
        act(() => { result.current.applyClaudeRecommendedForTier('fast', [{ id: 'claude-haiku-4-5-20251001' }]); });
        const update = setConfig.mock.calls[0][0] as (prev: TierConfig) => TierConfig;
        expect(update(start).fast.modelId).toBe('claude-haiku-4-5-20251001');
    });
});
