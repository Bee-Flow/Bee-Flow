import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WorkModePicker from './WorkModePicker';

vi.mock('../../../../hooks/useTranslation', () => {
    const t = (_k: string, d: string, p?: Record<string, unknown>) => d.replace(/\{(\w+)\}/g, (_m, k) => String(p?.[k] ?? `{${k}}`));
    return { default: () => ({ t }), useTranslation: () => ({ t }) };
});

afterEach(cleanup);

describe('WorkModePicker', () => {
    it('names Alt+M as the shortcut, not Shift+Tab', async () => {
        const user = userEvent.setup();
        render(<WorkModePicker value="plan" onChange={vi.fn()} />);
        await user.click(screen.getByRole('button'));
        expect(screen.getByText('Alt M')).toBeTruthy();
        expect(screen.queryByText(/Tab/)).toBeNull();
    });

    it('opens on the checked mode, moves with the arrow keys and closes on Escape with focus back on the button', async () => {
        const user = userEvent.setup();
        render(<WorkModePicker value="plan" onChange={vi.fn()} />);
        const trigger = screen.getByRole('button');
        await user.click(trigger);
        expect(document.activeElement).toBe(screen.getByRole('menuitemradio', { name: /plan first/i }));
        await user.keyboard('{ArrowDown}');
        expect(document.activeElement).toBe(screen.getByRole('menuitemradio', { name: /build directly/i }));
        await user.keyboard('{ArrowDown}');                      // wraps
        expect(document.activeElement).toBe(screen.getByRole('menuitemradio', { name: /only discuss/i }));
        await user.keyboard('{ArrowUp}');                        // and back
        expect(document.activeElement).toBe(screen.getByRole('menuitemradio', { name: /build directly/i }));
        await user.keyboard('{Home}');
        expect(document.activeElement).toBe(screen.getByRole('menuitemradio', { name: /only discuss/i }));
        await user.keyboard('{End}');
        expect(document.activeElement).toBe(screen.getByRole('menuitemradio', { name: /build directly/i }));
        await user.keyboard('{Escape}');
        expect(screen.queryByRole('menu')).toBeNull();
        expect(document.activeElement).toBe(trigger);
    });

    it('chooses the focused mode with Enter and returns focus to the button', async () => {
        const user = userEvent.setup();
        const onChange = vi.fn();
        render(<WorkModePicker value="approve" onChange={onChange} />);
        const trigger = screen.getByRole('button');
        await user.click(trigger);
        await user.keyboard('{ArrowDown}{Enter}');
        expect(onChange).toHaveBeenCalledWith('plan');
        expect(document.activeElement).toBe(trigger);
    });

    it('opens from the button with the arrow key', async () => {
        const user = userEvent.setup();
        render(<WorkModePicker value="approve" onChange={vi.fn()} />);
        screen.getByRole('button').focus();
        await user.keyboard('{ArrowDown}');
        expect(screen.getByRole('menu')).toBeTruthy();
    });

    it('lets Tab leave the menu closed and does not swallow it', async () => {
        const user = userEvent.setup();
        render(<WorkModePicker value="approve" onChange={vi.fn()} />);
        await user.click(screen.getByRole('button'));
        await user.keyboard('{Shift>}{Tab}{/Shift}');
        expect(screen.queryByRole('menu')).toBeNull();
    });

    it('hangs the menu off the composer when asked, full width, and off its own box otherwise', async () => {
        const user = userEvent.setup();
        const { container, rerender } = render(<WorkModePicker value="approve" onChange={vi.fn()} anchor="composer" />);
        await user.click(screen.getByRole('button'));
        expect(screen.getByRole('menu').className).toContain('inset-x-0');
        expect(container.firstElementChild?.className).not.toContain('relative');
        rerender(<WorkModePicker value="approve" onChange={vi.fn()} />);
        expect(screen.getByRole('menu').className).toContain('left-0');
        expect(container.firstElementChild?.className).toContain('relative');
    });
});

describe('WorkModePicker — an approved plan is being built', () => {
    it('shows "Building plan v2" instead of the chosen mode while the plan is open, and the chosen mode again once it is built', () => {
        const { rerender } = render(<WorkModePicker value="plan" onChange={vi.fn()} planStatus="building" planVersion={2} />);
        expect(screen.getByRole('button').textContent).toContain('Building plan v2');
        expect(screen.getByRole('button').textContent).not.toContain('Plan first');
        rerender(<WorkModePicker value="plan" onChange={vi.fn()} planStatus="paused" planVersion={2} />);
        expect(screen.getByRole('button').textContent).toContain('Building plan v2');
        rerender(<WorkModePicker value="plan" onChange={vi.fn()} planStatus="built" planVersion={2} />);
        expect(screen.getByRole('button').textContent).toContain('Plan first');
        rerender(<WorkModePicker value="plan" onChange={vi.fn()} planStatus="review" planVersion={2} />);
        expect(screen.getByRole('button').textContent).toContain('Plan first');
    });
});
