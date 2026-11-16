import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { OptionCard, SAVE_BUTTON } from './SettingsList';
import { PRIMARY_TONE } from './buttonClasses';

describe('OptionCard', () => {
    it('is a radio whose selected state is the ink-on-tint recipe, not a status colour', () => {
        render(
            <div role="radiogroup" aria-label="Provider">
                <OptionCard selected onClick={() => {}} title="Local" description="In process" />
                <OptionCard selected={false} onClick={() => {}} title="Remote" />
            </div>,
        );
        const on = screen.getByRole('radio', { name: /Local/ });
        const off = screen.getByRole('radio', { name: /Remote/ });
        expect(on).toHaveAttribute('aria-checked', 'true');
        expect(off).toHaveAttribute('aria-checked', 'false');
        expect(on.className).toContain('bg-[var(--item-active-bg)]');
        expect(on.className).toContain('border-[var(--text-primary)]');
        expect(off.className).toContain('border-[var(--border-default)]');
        expect(on.innerHTML).toContain('bg-[var(--text-primary)]');
        expect(on.innerHTML).not.toMatch(/--success|bg-white/);
        expect(screen.getByText('In process').className).toContain('text-xs');
        expect(screen.getByText('In process').className).toContain('text-[var(--text-secondary)]');
    });

    it('calls onClick when chosen', async () => {
        const onClick = vi.fn();
        render(<OptionCard selected={false} onClick={onClick} title="Remote" />);
        await userEvent.click(screen.getByRole('radio', { name: /Remote/ }));
        expect(onClick).toHaveBeenCalledTimes(1);
    });
});

describe('SAVE_BUTTON', () => {
    it('uses the shared Button primary colours', () => {
        expect(SAVE_BUTTON).toContain(PRIMARY_TONE);
    });
});
