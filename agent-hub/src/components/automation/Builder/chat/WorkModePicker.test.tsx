import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WorkModePicker, { WORK_MODES } from './WorkModePicker';

vi.mock('@/hooks/useTranslation', () => {
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
        expect(document.activeElement).toBe(screen.getByRole('menuitemradio', { name: /ask, plan, then build/i }));
        await user.keyboard('{ArrowDown}');
        expect(document.activeElement).toBe(screen.getByRole('menuitemradio', { name: /change it right away/i }));
        await user.keyboard('{ArrowDown}');                      // wraps
        expect(document.activeElement).toBe(screen.getByRole('menuitemradio', { name: /describe it/i }));
        await user.keyboard('{ArrowUp}');                        // and back
        expect(document.activeElement).toBe(screen.getByRole('menuitemradio', { name: /change it right away/i }));
        await user.keyboard('{Home}');
        expect(document.activeElement).toBe(screen.getByRole('menuitemradio', { name: /describe it/i }));
        await user.keyboard('{End}');
        expect(document.activeElement).toBe(screen.getByRole('menuitemradio', { name: /change it right away/i }));
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

describe('WorkModePicker — plain words', () => {
    it('asks "How should I work?" and names each mode by what the assistant does', async () => {
        const user = userEvent.setup();
        render(<WorkModePicker value="approve" onChange={vi.fn()} alwaysPlanLarge onAlwaysPlanLargeChange={vi.fn()} />);
        expect(screen.getByRole('button').textContent).toContain('Show me before changing');
        await user.click(screen.getByRole('button'));
        expect(screen.getByRole('menu', { name: 'How should I work?' })).toBeTruthy();
        expect(screen.getAllByRole('menuitemradio').map((el) => el.querySelector('span span')?.textContent)).toEqual([
            'Describe it', 'Just advise', 'Show me before changing', 'Ask, plan, then build', 'Change it right away',
        ]);
        expect(screen.getByRole('menuitemradio', { name: /describe it/i }).textContent).toContain('Tell me what should happen, in your own words. I ask a few questions, write a plan, build it, test it and hand it over.');
        expect(screen.getByRole('checkbox', { name: 'Check with me for big changes' })).toBeTruthy();
        expect(screen.getByRole('menuitemradio', { name: /change it right away/i }).textContent).toContain('You can undo that. A table it creates stays.');
        expect(screen.queryByTestId('work-mode-note')).toBeNull();
    });

    it('shows the note it is given above the modes', async () => {
        render(<WorkModePicker value="approve" onChange={vi.fn()} note="Changes go to your working copy." />);
        await userEvent.setup().click(screen.getByRole('button'));
        expect(screen.getByTestId('work-mode-note').textContent).toBe('Changes go to your working copy.');
    });

    it('chooses "Describe it" as the describe mode, and an unknown value still shows the default', async () => {
        const user = userEvent.setup();
        const onChange = vi.fn();
        const { rerender } = render(<WorkModePicker value="approve" onChange={onChange} />);
        await user.click(screen.getByRole('button'));
        await user.click(screen.getByRole('menuitemradio', { name: /describe it/i }));
        expect(onChange).toHaveBeenCalledWith('describe');
        rerender(<WorkModePicker value="describe" onChange={onChange} />);
        expect(screen.getByRole('button').textContent).toContain('Describe it');
        rerender(<WorkModePicker value="nonsense" onChange={onChange} />);
        expect(screen.getByRole('button').textContent).toContain('Show me before changing');
    });

    it('the checkbox reports the choice', async () => {
        const user = userEvent.setup();
        const onAlwaysPlanLargeChange = vi.fn();
        render(<WorkModePicker value="approve" onChange={vi.fn()} alwaysPlanLarge onAlwaysPlanLargeChange={onAlwaysPlanLargeChange} />);
        await user.click(screen.getByRole('button'));
        await user.click(screen.getByRole('checkbox', { name: 'Check with me for big changes' }));
        expect(onAlwaysPlanLargeChange).toHaveBeenCalledWith(false);
    });
});

describe('WorkModePicker — an approved plan is being built', () => {
    it('shows "Building plan v2" instead of the chosen mode while the plan is open, and the chosen mode again once it is built', () => {
        const { rerender } = render(<WorkModePicker value="plan" onChange={vi.fn()} planStatus="building" planVersion={2} />);
        expect(screen.getByRole('button').textContent).toContain('Building plan v2');
        expect(screen.getByRole('button').textContent).not.toContain('Ask, plan, then build');
        rerender(<WorkModePicker value="plan" onChange={vi.fn()} planStatus="paused" planVersion={2} />);
        expect(screen.getByRole('button').textContent).toContain('Building plan v2');
        rerender(<WorkModePicker value="plan" onChange={vi.fn()} planStatus="built" planVersion={2} />);
        expect(screen.getByRole('button').textContent).toContain('Ask, plan, then build');
        rerender(<WorkModePicker value="plan" onChange={vi.fn()} planStatus="review" planVersion={2} />);
        expect(screen.getByRole('button').textContent).toContain('Ask, plan, then build');
    });
});

describe('WorkModePicker with its own modes', () => {
    it('lists the given modes in order under the given i18n prefix, and leaves the default list alone', async () => {
        const user = userEvent.setup();
        const modes = [
            { id: 'a', Icon: WORK_MODES[0].Icon, key: 'alpha', label: 'Alpha', description: 'First one.' },
            { id: 'b', Icon: WORK_MODES[1].Icon, key: 'beta', label: 'Beta', description: 'Second one.' },
        ];
        render(<WorkModePicker value="b" onChange={vi.fn()} modes={modes} keyPrefix="x.mode" />);
        await user.click(screen.getByRole('button', { name: /beta/i }));
        const items = screen.getAllByRole('menuitemradio');
        expect(items.map((i) => i.textContent)).toEqual(['AlphaFirst one.', 'BetaSecond one.']);
        expect(screen.queryByRole('menuitemradio', { name: /describe it/i })).toBeNull();
    });
});
