import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import IconPickerModal from './IconPickerModal';

/**
 * The icon picker, now that it goes through the shared Modal.
 *
 * The emoji tab's search box used to have the focus the moment the picker
 * opened (emoji-picker-react autofocuses it). Modal leaves the focus where an
 * autoFocus field put it, instead of moving it to the first control (the
 * close button). And the backdrop, which never closed it, still does not.
 */
describe('IconPickerModal', () => {
    beforeEach(() => cleanup());

    const props = {
        isOpen: true,
        iconKey: 'rocket',
        iconLabel: 'Rocket',
        defaultEmoji: '🚀',
        currentCustom: null,
        onApply: vi.fn(),
    };

    it('opens as a named dialog with the emoji search focused', () => {
        render(<IconPickerModal {...props} onClose={vi.fn()} />);
        const dialog = screen.getByRole('dialog', { name: /Change emoji/ });
        expect(dialog).toBeInTheDocument();
        expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Type to search for an emoji' }));
    });

    it('closes on Escape but not on a press on the backdrop', () => {
        const onClose = vi.fn();
        render(<IconPickerModal {...props} onClose={onClose} />);
        const dialog = screen.getByRole('dialog', { name: /Change emoji/ });

        fireEvent.mouseDown(dialog.parentElement!);
        expect(onClose).not.toHaveBeenCalled();

        fireEvent.keyDown(document, { key: 'Escape' });
        expect(onClose).toHaveBeenCalledTimes(1);
    });
});

/**
 * AI generation runs on the image models the server is configured with
 * (composerSettings `hasImageGen` / `imageModels`). Without one there is no
 * AI tab to open a request that can only fail; with them, the request names
 * the model picked from that list, whichever provider serves it.
 */
describe('IconPickerModal AI generation', () => {
    const fetchMock = vi.fn();
    beforeEach(() => {
        cleanup();
        fetchMock.mockReset();
        vi.stubGlobal('fetch', fetchMock);
    });
    afterEach(() => vi.unstubAllGlobals());

    const props = {
        isOpen: true,
        onClose: vi.fn(),
        iconKey: 'rocket',
        iconLabel: 'Rocket',
        defaultEmoji: '🚀',
        currentCustom: null,
        onApply: vi.fn(),
    };
    const MODELS = [
        { id: 'gemini-3.1-flash-image-preview', label: 'Flash Image (Fast)', provider: 'google' as const },
        { id: 'azure/icons-deploy', label: 'gpt-image-1.5 (icons-deploy)', provider: 'azure' as const },
    ];

    it('offers no AI tab when no image model is configured', () => {
        render(<IconPickerModal {...props} canGenerate={false} imageModels={[]} />);
        expect(screen.queryByRole('button', { name: /Generate with AI/ })).not.toBeInTheDocument();
        expect(screen.getByText(/Pick an emoji or upload an image/)).toBeInTheDocument();
    });

    it('generates with the configured model the admin picks', async () => {
        const user = userEvent.setup();
        const onApply = vi.fn();
        fetchMock.mockResolvedValue(new Response(JSON.stringify({ url: '/api/icons/data/icon_1.png' }), {
            status: 200, headers: { 'content-type': 'application/json' },
        }));
        render(<IconPickerModal {...props} onApply={onApply} canGenerate imageModels={MODELS} />);

        await user.click(screen.getByRole('button', { name: /Generate with AI/ }));
        const select = screen.getByRole('combobox', { name: 'Image model' });
        expect([...select.querySelectorAll('option')].map((o) => o.textContent)).toEqual(MODELS.map((m) => m.label));
        await user.selectOptions(select, 'azure/icons-deploy');
        await user.type(screen.getByRole('textbox'), 'a bee');
        await user.click(screen.getByRole('button', { name: /Generate icon/ }));

        await waitFor(() => expect(onApply).toHaveBeenCalledWith({ type: 'image', value: '/api/icons/data/icon_1.png' }));
        const call = fetchMock.mock.calls.find(([url]) => String(url).includes('/api/icons/generate'));
        expect(call).toBeDefined();
        expect(JSON.parse(String(call![1].body))).toMatchObject({ prompt: 'a bee', model: 'azure/icons-deploy' });
    });
});
