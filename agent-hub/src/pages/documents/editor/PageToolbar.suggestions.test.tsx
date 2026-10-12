import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import PageToolbar, { type PageToolbarProps } from './PageToolbar';

vi.mock('../../../editor/react/CollabPresence', () => ({ default: () => null }));

function props(over: Partial<PageToolbarProps> = {}): PageToolbarProps {
    return {
        doc: { id: 'd1', name: 'Plan' } as PageToolbarProps['doc'], isPanel: false, readOnly: false, live: null,
        save: { state: 'saved', lastSavedAt: null, onRetry: vi.fn(), onResolve: vi.fn() } as unknown as PageToolbarProps['save'],
        side: null, onSide: vi.fn(), canComment: false, downloading: false,
        onLeave: vi.fn(), onRename: vi.fn(), onFind: vi.fn(), onPrint: vi.fn(), onDownload: vi.fn(), ...over,
    };
}

describe('the Suggestions toggle', () => {
    it('shows the open count and toggles the panel', async () => {
        const p = props({ openSuggestions: 3 });
        render(<PageToolbar {...p} />);
        const btn = screen.getByTestId('document-suggestions-toggle');
        expect(btn).toHaveTextContent('Suggestions (3)');
        await userEvent.click(btn);
        expect(p.onSide).toHaveBeenCalledWith('suggestions');
    });

    it('is absent when there is nothing to review and the panel is closed', () => {
        render(<PageToolbar {...props({ openSuggestions: 0 })} />);
        expect(screen.queryByTestId('document-suggestions-toggle')).toBeNull();
    });
});
