import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { TriangleAlert } from 'lucide-react';
import StatusPill from './StatusPill';

describe('StatusPill — hairline in the raw tone, text in the ink tone', () => {
    it.each([
        ['success', 'var(--success)', 'var(--success-ink)'],
        ['warning', 'var(--warning)', 'var(--warning-ink)'],
        ['error', 'var(--error)', 'var(--error-ink)'],
    ])('%s: border 1px solid raw, colour ink, no fill', (tone, raw, ink) => {
        render(<StatusPill tone={tone}>7 open</StatusPill>);
        const pill = screen.getByTestId('status-pill');
        expect(pill.style.border).toBe(`1px solid ${raw}`);
        expect(pill.style.color).toBe(ink);
        expect(pill.style.background).toBe('');
        expect(pill).toHaveAttribute('data-tone', tone);
        expect(pill).toHaveTextContent('7 open');
    });

    it('neutral (and the default, and an unknown tone) = border-default hairline + secondary text', () => {
        const { rerender } = render(<StatusPill>nothing to say</StatusPill>);
        let pill = screen.getByTestId('status-pill');
        expect(pill.style.border).toBe('1px solid var(--border-default)');
        expect(pill.style.color).toBe('var(--text-secondary)');
        expect(pill).toHaveAttribute('data-tone', 'neutral');
        rerender(<StatusPill tone="lilac">x</StatusPill>);
        pill = screen.getByTestId('status-pill');
        expect(pill).toHaveAttribute('data-tone', 'neutral');
    });

    it('the recipe: inline-flex, 11px semibold, r999, 8px/3px padding', () => {
        render(<StatusPill tone="warning">x</StatusPill>);
        const cls = screen.getByTestId('status-pill').className;
        for (const c of ['inline-flex', 'items-center', 'gap-1.5', 'text-[11px]', 'font-semibold', 'px-2', 'py-[3px]', 'rounded-full']) {
            expect(cls).toContain(c);
        }
    });

    it('icon: a lucide component is drawn at 11px, a ready element is used as-is, className/title/testId pass through', () => {
        const { rerender } = render(<StatusPill tone="warning" icon={TriangleAlert} className="ml-2" title="hint" testId="hdr-pill">x</StatusPill>);
        const pill = screen.getByTestId('hdr-pill');
        expect(pill.querySelector('svg').style.width).toBe('11px');
        expect(pill.className).toContain('ml-2');
        expect(pill).toHaveAttribute('title', 'hint');
        rerender(<StatusPill icon={<i data-testid="custom-glyph" />}>x</StatusPill>);
        expect(screen.getByTestId('custom-glyph')).toBeInTheDocument();
        rerender(<StatusPill>x</StatusPill>);
        expect(screen.getByTestId('status-pill').querySelector('svg')).toBeNull();
    });
});
