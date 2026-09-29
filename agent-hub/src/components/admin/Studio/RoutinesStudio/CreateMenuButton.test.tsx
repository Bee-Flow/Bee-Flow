import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import CreateMenuButton from './CreateMenuButton';

/**
 * The split + (owner, 2026-09-28): the main part makes an automation, the
 * chevron beside it opens a menu that also makes a building block.
 */
describe('CreateMenuButton', () => {
    afterEach(cleanup);

    const setup = (props: Partial<Parameters<typeof CreateMenuButton>[0]> = {}) => {
        const onCreateAutomation = vi.fn();
        const onCreateBlock = vi.fn();
        render(
            <CreateMenuButton
                onCreateAutomation={onCreateAutomation}
                onCreateBlock={onCreateBlock}
                tourAnchor="routine-create"
                {...props}
            />,
        );
        return { onCreateAutomation, onCreateBlock };
    };

    it('the main part makes an automation straight away and carries the tour anchor', async () => {
        const user = userEvent.setup();
        const { onCreateAutomation, onCreateBlock } = setup();
        const main = screen.getByRole('button', { name: 'New automation' });
        expect(main.getAttribute('data-tour')).toBe('routine-create');
        await user.click(main);
        expect(onCreateAutomation).toHaveBeenCalledTimes(1);
        expect(onCreateBlock).not.toHaveBeenCalled();
        expect(screen.queryByRole('menu')).toBeNull();
    });

    it('the chevron is a menu button: automation first (the default), then building block', async () => {
        const user = userEvent.setup();
        const { onCreateAutomation, onCreateBlock } = setup();
        const chevron = screen.getByRole('button', { name: 'Choose what to create' });
        expect(chevron.getAttribute('aria-haspopup')).toBe('menu');
        expect(chevron.getAttribute('aria-expanded')).toBe('false');

        await user.click(chevron);
        expect(chevron.getAttribute('aria-expanded')).toBe('true');
        const menu = screen.getByRole('menu', { name: 'Choose what to create' });
        const items = within(menu).getAllByRole('menuitem');
        expect(items.map(i => i.textContent)).toEqual([
            'New automationDefaultRuns by itself when something happens, or when you start it',
            'New building blockA reusable step you can drop into any automation',
        ]);

        await user.click(items[1]);
        expect(onCreateBlock).toHaveBeenCalledTimes(1);
        expect(onCreateAutomation).not.toHaveBeenCalled();
        expect(screen.queryByRole('menu')).toBeNull();
    });

    it('works from the keyboard: ArrowDown opens, arrows move, Enter picks, Escape closes back onto the chevron', async () => {
        const user = userEvent.setup();
        const { onCreateAutomation, onCreateBlock } = setup();
        const chevron = screen.getByRole('button', { name: 'Choose what to create' });
        chevron.focus();
        await user.keyboard('{ArrowDown}');
        const items = within(screen.getByRole('menu')).getAllByRole('menuitem');
        expect(document.activeElement).toBe(items[0]);
        await user.keyboard('{ArrowDown}');
        expect(document.activeElement).toBe(items[1]);
        await user.keyboard('{Escape}');
        expect(screen.queryByRole('menu')).toBeNull();
        expect(document.activeElement).toBe(chevron);

        await user.keyboard('{ArrowDown}');
        await user.keyboard('{Enter}');
        expect(onCreateAutomation).toHaveBeenCalledTimes(1);
        expect(onCreateBlock).not.toHaveBeenCalled();
    });

    it('Escape in the menu closes the menu only, not a dialog around it', async () => {
        const user = userEvent.setup();
        setup();
        const outer = vi.fn();
        document.addEventListener('keydown', outer);
        try {
            await user.click(screen.getByRole('button', { name: 'Choose what to create' }));
            await user.keyboard('{Escape}');
            expect(screen.queryByRole('menu')).toBeNull();
            expect(outer).not.toHaveBeenCalled();
        } finally {
            document.removeEventListener('keydown', outer);
        }
    });

    it('without a building-block handler it is a plain +', () => {
        setup({ onCreateBlock: null });
        expect(screen.getByRole('button', { name: 'New automation' })).toBeTruthy();
        expect(screen.queryByRole('button', { name: 'Choose what to create' })).toBeNull();
    });

    it('the label variant is the accent "New" of the overview', () => {
        setup({ variant: 'label', testId: 'overview-create' });
        const main = screen.getByTestId('overview-create-main');
        expect(main.textContent).toBe('New');
        expect(screen.getByTestId('overview-create').className).toContain('bg-[var(--accent-primary)]');
        expect(screen.getByTestId('overview-create').className).toContain('text-[var(--accent-primary-fg)]');
    });
});
