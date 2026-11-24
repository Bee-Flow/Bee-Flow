import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, test, vi } from 'vitest';
import CommandPalette from './CommandPalette';
import type { PaletteCommand } from './buildCommands';

const COMMANDS = ['Bold', 'Italic', 'Heading'].map((label) => ({ id: label.toLowerCase(), label, run: vi.fn() })) as unknown as PaletteCommand[];

const original = Element.prototype.scrollIntoView;
afterEach(() => { Element.prototype.scrollIntoView = original; });

describe('CommandPalette', () => {
    test('scrolls the active option into view as the arrows move', async () => {
        const scrolled: string[] = [];
        Element.prototype.scrollIntoView = function scrollIntoView(this: Element) { scrolled.push(this.id); };
        const user = userEvent.setup();
        render(<CommandPalette open commands={COMMANDS} />);
        await user.click(screen.getByRole('combobox'));
        await user.keyboard('{ArrowDown}{ArrowDown}');
        expect(scrolled.at(-1)).toBe('bf-cmd-heading');
        expect(screen.getByRole('option', { name: 'Heading' })).toHaveAttribute('aria-selected', 'true');
    });

    test('ArrowDown on an empty list keeps the index at 0, so the first command is active once there are some', async () => {
        const user = userEvent.setup();
        const { rerender } = render(<CommandPalette open commands={[]} />);
        await user.click(screen.getByRole('combobox'));
        await user.keyboard('{ArrowDown}');
        rerender(<CommandPalette open commands={COMMANDS} />);
        expect(screen.getByRole('combobox')).toHaveAttribute('aria-activedescendant', 'bf-cmd-bold');
    });
});
