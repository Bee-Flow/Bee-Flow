import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Button } from './Button';
import { BUTTON_VARIANTS, PRIMARY_TONE } from './buttonClasses';
import { TONES } from './statusTone';

describe('Button', () => {
    it('draws primary from the accent with its own foreground, never text-white or a palette blue', () => {
        render(<Button>Save</Button>);
        const cls = screen.getByRole('button', { name: 'Save' }).className;
        expect(cls).toContain('bg-[var(--accent-primary)]');
        expect(cls).toContain('enabled:hover:bg-[var(--accent-primary-hover)]');
        expect(cls).toContain('text-[var(--accent-primary-fg)]');
        expect(cls).toContain('focus-visible:ring-[var(--focus-ring)]');
        expect(cls).not.toMatch(/text-white|blue-|emerald-|rose-|amber-/);
    });

    it('takes success, warning and danger from the statusTone pairs', () => {
        const pairs = { success: TONES.success, warning: TONES.warning, danger: TONES.error } as const;
        for (const [variant, tone] of Object.entries(pairs)) {
            const cls = BUTTON_VARIANTS[variant as keyof typeof pairs];
            expect(cls).toContain(`text-[${tone.ink}]`);
            expect(cls).toContain(`${tone.raw}_`);
        }
    });

    it('has no palette class or hex literal in any variant', () => {
        for (const cls of Object.values(BUTTON_VARIANTS)) {
            expect(cls).not.toMatch(/(?:^|\s)(?:\w+:)*(?:bg|text|border)-(?:blue|emerald|rose|amber|red|green|gray|white)\b|#[0-9a-f]{3,8}/i);
        }
        expect(BUTTON_VARIANTS.primary).toBe(PRIMARY_TONE);
    });

    it('stays disabled while busy, even when the caller passes disabled={false}', async () => {
        const onClick = vi.fn();
        render(<Button busy disabled={false} onClick={onClick}>Save</Button>);
        const button = screen.getByRole('button', { name: 'Save' });
        expect(button).toBeDisabled();
        expect(button).toHaveAttribute('aria-busy', 'true');
        await userEvent.click(button);
        expect(onClick).not.toHaveBeenCalled();
    });
});
