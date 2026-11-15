import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import ClaudeSettingsSection from './ClaudeSettingsSection';
import useClaudeSettings from './useClaudeSettings';
import type { TierConfig } from './tierTypes';

/**
 * "Apply all recommended" only touches tiers whose recommended model family
 * this server offers, and only after the admin confirms. A recommendation
 * names the newest model of its family the catalogue lists.
 */

const SONNET_ONLY = [{ id: 'claude-sonnet-4-6', providerName: 'Anthropic', providerType: 'claude' }];

function renderSection(over: Partial<Parameters<typeof ClaudeSettingsSection>[0]> = {}) {
    const props = {
        claudeMessage: null, claudeRecAppliedTier: null,
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
        expect(dialog.textContent).toContain('4 tiers');
        await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
        expect(props.applyAllClaudeRecommended).not.toHaveBeenCalled();

        await user.click(screen.getByRole('button', { name: 'Apply all recommended' }));
        const again = await screen.findByRole('dialog');
        await user.click(within(again).getByRole('button', { name: 'Apply all recommended' }));
        expect(props.applyAllClaudeRecommended).toHaveBeenCalledWith(SONNET_ONLY);
    });

    it('disables Apply on the rows whose model family the server does not offer', () => {
        renderSection();
        const applyButtons = screen.getAllByRole('button', { name: 'Apply' });
        // fast (Haiku), standard, swarm, thinking, writer (Sonnet), pro (Opus): only the Sonnet rows apply.
        expect(applyButtons.map(b => (b as HTMLButtonElement).disabled)).toEqual([true, false, false, false, false, true]);
    });

    it('names the newest model of each family the catalogue offers, not a fixed one', () => {
        renderSection({ chatModels: [{ id: 'claude-opus-4-7' }, { id: 'claude-opus-5' }, { id: 'claude-sonnet-5' }] });
        const rows = screen.getAllByRole('row').slice(1);
        expect(rows[5].textContent).toContain('Claude Opus 5');
        expect(rows[3].textContent).toContain('Claude Sonnet 5');
        expect(rows[0].textContent).toContain('This server offers no model of this kind.');
    });

    it('says "1 tier", not "1 tiers", when one recommendation applies', async () => {
        const user = userEvent.setup();
        renderSection({ chatModels: [{ id: 'claude-haiku-4-5-20251001', providerName: 'Anthropic' }] });
        await user.click(screen.getByRole('button', { name: 'Apply all recommended' }));
        const dialog = await screen.findByRole('dialog');
        expect(dialog.textContent).toContain('1 tier (');
        expect(dialog.textContent).not.toContain('1 tiers');
    });

    it('disables Apply all when no recommended family is offered', () => {
        renderSection({ chatModels: [{ id: 'my-claude-deployment', providerName: 'Azure' }] });
        expect((screen.getByRole('button', { name: 'Apply all recommended' }) as HTMLButtonElement).disabled).toBe(true);
    });
});

describe('useClaudeSettings: applying recommendations', () => {
    const start: TierConfig = {
        fast: { modelId: 'mistral-small-latest' },
        standard: { modelId: 'mistral-large-latest' },
        pro: { modelId: 'mistral-large-latest' },
    };
    const setup = () => {
        const setConfig = vi.fn();
        const setEuConfig = vi.fn();
        const view = renderHook(() => useClaudeSettings({ setConfig, setEuConfig }));
        return { setConfig, setEuConfig, result: view.result };
    };

    it('Apply all changes only the tiers whose family is in the catalogue', () => {
        const { setConfig, result } = setup();
        let changed = 0;
        act(() => { changed = result.current.applyAllClaudeRecommended([{ id: 'claude-haiku-4-5-20251001' }, { id: 'claude-sonnet-4-6' }]); });
        expect(changed).toBe(5);
        const update = setConfig.mock.calls[0][0] as (prev: TierConfig) => TierConfig;
        const next = update(start);
        expect(next.fast.modelId).toBe('claude-haiku-4-5-20251001');
        expect(next.standard.modelId).toBe('claude-sonnet-4-6');
        expect(next.thinking.modelId).toBe('claude-sonnet-4-6');
        expect(next.pro).toEqual(start.pro);
    });

    it('Apply all lays the recommendations over the latest config, not the one the confirm saw', () => {
        const { setConfig, result } = setup();
        act(() => { result.current.applyAllClaudeRecommended([{ id: 'claude-sonnet-4-6' }]); });
        const update = setConfig.mock.calls[0][0] as (prev: TierConfig) => TierConfig;
        // The tier config loaded while the confirm dialog was open: it survives.
        const next = update(start);
        expect(next.fast).toEqual(start.fast);
        expect(next.pro).toEqual(start.pro);
        expect(next.standard.modelId).toBe('claude-sonnet-4-6');
    });

    it('Apply all with nothing applicable leaves the configuration alone', () => {
        const { setConfig, result } = setup();
        act(() => { result.current.applyAllClaudeRecommended([{ id: 'mistral-large-latest' }]); });
        expect(setConfig).not.toHaveBeenCalled();
    });

    it('one tier: no-op when its family is not offered, the catalogue id when it is', () => {
        const { setConfig, result } = setup();
        act(() => { result.current.applyClaudeRecommendedForTier('pro', [{ id: 'claude-sonnet-4-6' }]); });
        expect(setConfig).not.toHaveBeenCalled();
        act(() => { result.current.applyClaudeRecommendedForTier('fast', [{ id: 'claude-haiku-4-5-20251001' }]); });
        const update = setConfig.mock.calls[0][0] as (prev: TierConfig) => TierConfig;
        expect(update(start).fast.modelId).toBe('claude-haiku-4-5-20251001');
    });

    // An Apply on an EU tier wrote the REGULAR tier: the EU table was bound to
    // the regular setter. It now lands in the EU table, and only there.
    it('one EU tier: the recommendation lands in the EU table, the regular one stays as it is', () => {
        const { setConfig, setEuConfig, result } = setup();
        act(() => { result.current.applyClaudeRecommendedForTier('standard', [{ id: 'claude-sonnet-5' }], 'eu'); });
        expect(setConfig).not.toHaveBeenCalled();
        const update = setEuConfig.mock.calls[0][0] as (prev: TierConfig) => TierConfig;
        expect(update(start).standard.modelId).toBe('claude-sonnet-5');
    });
});
