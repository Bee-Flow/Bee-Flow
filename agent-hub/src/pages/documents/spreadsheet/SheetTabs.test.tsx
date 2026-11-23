import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, test, vi } from 'vitest';
import SheetTabs from './SheetTabs';

const TABS = [{ id: 't1', name: 'One' }, { id: 't2', name: 'Two' }, { id: 't3', name: 'Three' }];

function setup(activeTab = 't1') {
    const props = { onChange: vi.fn(), onAdd: vi.fn(), onRename: vi.fn(), onDelete: vi.fn() };
    render(<SheetTabs tabs={TABS} activeTab={activeTab} {...props} />);
    return props;
}

describe('SheetTabs', () => {
    test('is a tablist with one focusable tab, the open one', () => {
        setup('t2');
        expect(screen.getByRole('tablist', { name: 'Sheet tabs' })).toBeInTheDocument();
        const tabs = screen.getAllByRole('tab');
        expect(tabs.map((tab) => tab.tabIndex)).toEqual([-1, 0, -1]);
        expect(screen.getByRole('tab', { name: 'Two' })).toHaveAttribute('aria-selected', 'true');
    });

    test('the arrow keys move to the next tab and open it, wrapping around', async () => {
        const user = userEvent.setup();
        const { onChange } = setup('t1');
        screen.getByRole('tab', { name: 'One' }).focus();
        await user.keyboard('{ArrowRight}');
        expect(onChange).toHaveBeenLastCalledWith('t2');
        expect(screen.getByRole('tab', { name: 'Two' })).toHaveFocus();
        await user.keyboard('{ArrowLeft}{ArrowLeft}');
        expect(onChange).toHaveBeenLastCalledWith('t3');
    });

    test('F2 renames the focused tab', async () => {
        const user = userEvent.setup();
        const { onRename } = setup('t1');
        screen.getByRole('tab', { name: 'One' }).focus();
        await user.keyboard('{F2}');
        const input = screen.getByRole('textbox', { name: 'Tab name' });
        await user.clear(input);
        await user.type(input, 'Budget{Enter}');
        expect(onRename).toHaveBeenCalledWith('t1', 'Budget');
    });

    test('the delete button of the open tab is visible without hovering', () => {
        setup('t1');
        const [first, second] = screen.getAllByRole('button', { name: 'Delete tab' });
        expect(first.className).toContain('opacity-100');
        expect(second.className).toMatch(/(^| )opacity-0/);
        expect(second.className).toContain('focus-visible:opacity-100');
    });
});
