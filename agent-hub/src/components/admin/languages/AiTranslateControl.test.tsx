/**
 * The AI translate control offers the server's configured single-model tiers
 * (no fixed model names, no orchestration modes), and a tier the server does
 * not have moves to the first one it does, so the select shows what is sent.
 */
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import AiTranslateControl from './AiTranslateControl';
import { renderWithClient } from '@/test/render';

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
const TIERS = {
    auto: {},
    fast: { modelId: 'model-a' },
    standard: { modelId: 'model-b' },
    thinking: { modelId: 'model-c' },
    writer: {},
    'custom:legal': { modelId: 'model-d' },
};

let fetchSpy: MockInstance<typeof fetch>;
beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => json(String(url).endsWith('/ai/config/chat-models') ? TIERS : {}));
});
afterEach(() => { cleanup(); fetchSpy.mockRestore(); });

describe('AiTranslateControl', () => {
    it('lists only the configured single-model tiers', async () => {
        renderWithClient(<AiTranslateControl tier="fast" onTierChange={vi.fn()} onTranslate={vi.fn()} translating={false} missing={3} />);
        const select = screen.getByRole('combobox', { name: 'Model tier for AI translation' });
        await waitFor(() => expect(within(select).getAllByRole('option')).toHaveLength(2));
        expect(within(select).getAllByRole('option').map(o => (o as HTMLOptionElement).value)).toEqual(['fast', 'thinking']);
    });

    it('moves a tier the server does not have to the first configured one', async () => {
        const onTierChange = vi.fn();
        renderWithClient(<AiTranslateControl tier="pro" onTierChange={onTierChange} onTranslate={vi.fn()} translating={false} missing={3} />);
        await waitFor(() => expect(onTierChange).toHaveBeenCalledWith('fast'));
    });
});
