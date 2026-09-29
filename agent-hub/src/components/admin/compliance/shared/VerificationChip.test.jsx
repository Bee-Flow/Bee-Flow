import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import VerificationChip, { VERIFICATION_KINDS } from './VerificationChip';

describe('VerificationChip — measured vs declared must never look alike', () => {
    it('automated: solid border-default hairline, one ScanSearch glyph, the existing label + hint', () => {
        render(<VerificationChip verification="automated" />);
        const chip = screen.getByTestId('verification-chip');
        expect(chip.style.border).toBe('1px solid var(--border-default)');
        expect(chip.style.borderRadius).toBe('999px');
        expect(chip.style.padding).toBe('1px 7px');
        expect(chip.querySelectorAll('svg')).toHaveLength(1);
        expect(chip.querySelector('svg').style.width).toBe('11px');
        expect(chip).toHaveTextContent('Verified automatically');
        expect(chip).toHaveAttribute('title', 'This result is evaluated from live system state and telemetry.');
        expect(chip.className).toContain('text-[11px]');
        expect(chip.className).toContain('text-[var(--text-secondary)]');
    });

    it('attestation: the border is DASHED in tertiary text colour, with the PenLine glyph', () => {
        render(<VerificationChip verification="attestation" />);
        const chip = screen.getByTestId('verification-chip');
        expect(chip.style.border).toBe('1px dashed var(--text-tertiary)');
        expect(chip.querySelectorAll('svg')).toHaveLength(1);
        expect(chip).toHaveTextContent('Self-attested');
        expect(chip.getAttribute('title')).toMatch(/administrator declared/);
    });

    it('hybrid: solid border with both glyphs', () => {
        render(<VerificationChip verification="hybrid" />);
        const chip = screen.getByTestId('verification-chip');
        expect(chip.style.border).toBe('1px solid var(--border-default)');
        expect(chip.querySelectorAll('svg')).toHaveLength(2);
        expect(chip).toHaveTextContent('Verified + attested');
    });

    it('minimal: glyph + label at 10px, no border or padding (the attention list meta line)', () => {
        render(<VerificationChip verification="attestation" minimal />);
        const chip = screen.getByTestId('verification-chip');
        expect(chip.style.border).toBe('');
        expect(chip.style.padding).toBe('');
        expect(chip.className).toContain('text-[10px]');
        expect(chip.querySelector('svg').style.width).toBe('10px');
        expect(chip).toHaveTextContent('Self-attested');
    });

    it('an unknown or missing verification renders nothing, and the kind list is the contract vocabulary', () => {
        const { container, rerender } = render(<VerificationChip verification="manual" />);
        expect(container).toBeEmptyDOMElement();
        rerender(<VerificationChip />);
        expect(container).toBeEmptyDOMElement();
        expect(VERIFICATION_KINDS).toEqual(['automated', 'attestation', 'hybrid']);
    });
});
