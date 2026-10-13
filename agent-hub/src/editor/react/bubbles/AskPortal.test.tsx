import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import AskPortal from './AskPortal';

const t = (key: string, fallback?: unknown) => (typeof fallback === 'string' ? fallback : key);
const ask = { anchor: { top: 200, left: 40 }, from: 1, to: 5, text: 'the selected passage' };

function mount(query = '') {
    const props = { onSubmit: vi.fn(), onClose: vi.fn(), setQuery: vi.fn() };
    render(<AskPortal ask={ask} query={query} t={t} {...props} />);
    return props;
}

describe('AskPortal', () => {
    it('previews the selected text', () => {
        mount();
        expect(screen.getByText('the selected passage')).toBeInTheDocument();
        expect(screen.getByText('Selected text')).toBeInTheDocument();
    });

    it('submits on Enter and closes on Escape', async () => {
        const user = userEvent.setup();
        const props = mount('shorter please');
        const input = screen.getByPlaceholderText('Ask me…');
        await user.type(input, '{Enter}');
        expect(props.onSubmit).toHaveBeenCalledTimes(1);
        await user.type(input, '{Escape}');
        expect(props.onClose).toHaveBeenCalled();
    });

    it('closes on a click outside, and the send button waits for a question', async () => {
        const user = userEvent.setup();
        const props = mount('');
        expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
        await user.click(document.body);
        expect(props.onClose).toHaveBeenCalled();
    });
});
