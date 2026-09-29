import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import SeverityTag from './SeverityTag';

describe('SeverityTag — the weight word, in the severity ink', () => {
    it.each([
        ['critical', 'Must fix', 'error', 'var(--error-ink)'],
        ['high', 'Should fix', 'error', 'var(--error-ink)'],
        ['medium', 'Consider', 'warning', 'var(--warning-ink)'],
        ['low', 'Low priority', 'neutral', 'var(--text-tertiary)'],
    ])('%s → "%s" in the %s ink', (severity, label, tone, ink) => {
        render(<SeverityTag severity={severity} />);
        const tag = screen.getByTestId('severity-tag');
        expect(tag).toHaveTextContent(label);
        expect(tag).toHaveAttribute('data-severity', severity);
        expect(tag).toHaveAttribute('data-tone', tone);
        expect(tag.style.color).toBe(ink);
    });

    it('is 10px uppercase semibold with .04em tracking', () => {
        render(<SeverityTag severity="high" />);
        const cls = screen.getByTestId('severity-tag').className;
        for (const c of ['text-[10px]', 'font-semibold', 'uppercase', 'tracking-[.04em]']) expect(cls).toContain(c);
    });

    it('an unknown or missing severity renders nothing', () => {
        const { container, rerender } = render(<SeverityTag severity="urgent" />);
        expect(container).toBeEmptyDOMElement();
        rerender(<SeverityTag />);
        expect(container).toBeEmptyDOMElement();
    });
});
