import { render, screen, renderHook, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';

import { TemplateFillList } from './TemplateFillPicker';
import useTemplateFill from './useTemplateFill';
import { buildComposerTools, type ComposerTool } from './composerTools';
import type { TranslateFn } from '@/hooks/useTranslation';

/**
 * "Fill in a template" in the composer: the row exists only where the template
 * tools do (direct chat, signed in, not incognito), the picker lists and
 * searches the templates, and choosing one sends a message that carries the
 * template's id for template_fill_start.
 */

// A t that fills {params} into the fallback, as the real one does without a dictionary.
const t = ((_key: string, fallback?: unknown, params?: Record<string, unknown>) => String(fallback ?? '')
    .replace(/\{(\w+)\}/g, (_m, k: string) => String(params?.[k] ?? ''))) as unknown as TranslateFn;

const TEMPLATES = [
    { id: 'tpl-1', name: 'Engagement letter', docType: 'letter' },
    { id: 'tpl-2', name: 'Quarterly review', docType: 'presentation' },
];

function rows(canFillTemplate: boolean): ComposerTool[] {
    return buildComposerTools({
        t, onAttachClick: vi.fn(), canCreateMedia: false, canPickApps: false,
        canWebSearch: false, webSearchEnabled: false, webSearchBlocked: false, setWebSearchEnabled: vi.fn(),
        showTierSlider: true, memoryMode: 'on', changeMemoryMode: vi.fn(),
        voiceReady: false, voiceMode: false, setVoiceMode: vi.fn(),
        canFillTemplate, templatesOpen: false, setTemplatesOpen: vi.fn(),
    }).filter(Boolean) as ComposerTool[];
}

describe('the "Fill in a template" row', () => {
    it('is a panel row in the add group, only when the composer may offer it', () => {
        const row = rows(true).find((r) => r.id === 'fill-template');
        expect(row).toMatchObject({ group: 'add', kind: 'panel', label: 'Fill in a template' });
        expect(rows(false).some((r) => r.id === 'fill-template')).toBe(false);
    });
});

describe('useTemplateFill', () => {
    const base = { t, directMode: true, simpleMode: false, signedIn: true, incognito: false, isLoading: false };

    it('sends the fill-in message with the template id, and closes the picker', () => {
        const send = vi.fn();
        const { result } = renderHook(() => useTemplateFill({ ...base, send }));
        act(() => result.current.setTemplatesOpen(true));
        act(() => result.current.onPickTemplate(TEMPLATES[0]));
        expect(send).toHaveBeenCalledWith('Fill in the template “Engagement letter” with me.\n\n[template:tpl-1]');
        expect(result.current.templatesOpen).toBe(false);
    });

    it('is not offered in agent chat, Simple Mode, an incognito chat or to a visitor', () => {
        const send = vi.fn();
        for (const over of [{ directMode: false }, { simpleMode: true }, { incognito: true }, { signedIn: false }]) {
            const { result } = renderHook(() => useTemplateFill({ ...base, ...over, send }));
            expect(result.current.canFillTemplate).toBe(false);
        }
    });

    it('sends nothing while an answer is still being written', () => {
        const send = vi.fn();
        const { result } = renderHook(() => useTemplateFill({ ...base, isLoading: true, send }));
        act(() => result.current.onPickTemplate(TEMPLATES[0]));
        expect(send).not.toHaveBeenCalled();
    });
});

describe('<TemplateFillList>', () => {
    it('lists the templates, narrows them by search, and hands the chosen one over', async () => {
        const user = userEvent.setup();
        const onPick = vi.fn();
        render(<TemplateFillList templates={TEMPLATES} loading={false} failed={false} onPick={onPick} />);
        expect(screen.getByTestId('template-fill-option-tpl-1')).toBeInTheDocument();
        expect(screen.getByTestId('template-fill-option-tpl-2').textContent).toContain('Presentation');

        await user.type(screen.getByRole('searchbox'), 'quarter');
        expect(screen.queryByTestId('template-fill-option-tpl-1')).not.toBeInTheDocument();
        await user.click(screen.getByTestId('template-fill-option-tpl-2'));
        expect(onPick).toHaveBeenCalledWith(TEMPLATES[1]);

        await user.clear(screen.getByRole('searchbox'));
        await user.type(screen.getByRole('searchbox'), 'nothing like it');
        expect(screen.getByText('No template matches your search.')).toBeInTheDocument();
    });

    it('says when there are no templates, while loading, and when loading failed', () => {
        const { rerender } = render(<TemplateFillList templates={[]} loading={false} failed={false} onPick={vi.fn()} />);
        expect(screen.getByText(/No templates yet/)).toBeInTheDocument();
        rerender(<TemplateFillList templates={[]} loading failed={false} onPick={vi.fn()} />);
        expect(screen.getByText('Loading templates…')).toBeInTheDocument();
        rerender(<TemplateFillList templates={[]} loading={false} failed onPick={vi.fn()} />);
        expect(screen.getByText('Your templates could not be loaded.')).toBeInTheDocument();
    });
});
