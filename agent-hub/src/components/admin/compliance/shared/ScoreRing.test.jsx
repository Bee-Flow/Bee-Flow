import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ScoreRing from './ScoreRing';

const here = path.dirname(fileURLToPath(import.meta.url));

describe('ScoreRing — conic ring, token-only', () => {
    it('draws the arc as a conic-gradient in the score tone and prints the number in the disc', () => {
        render(<ScoreRing score={79} />);
        const ring = screen.getByRole('img');
        expect(ring).toHaveAttribute('aria-label', '79 of 100');
        expect(ring).toHaveAttribute('data-tone', 'warning');
        expect(ring.style.background).toContain('conic-gradient(var(--warning) 0 79%, var(--bg-tertiary) 79% 100%)');
        expect(ring.style.width).toBe('52px');
        expect(ring.style.height).toBe('52px');
        expect(ring).toHaveTextContent('79');
        const disc = ring.firstElementChild;
        expect(disc.style.width).toBe('40px');
        expect(disc.style.fontSize).toBe('15px');
    });

    it('follows the statusTone thresholds: ≥ 85 success, ≥ 60 warning, else error — or the tone the caller passes', () => {
        const { rerender } = render(<ScoreRing score={88} />);
        expect(screen.getByRole('img')).toHaveAttribute('data-tone', 'success');
        rerender(<ScoreRing score={58} />);
        expect(screen.getByRole('img')).toHaveAttribute('data-tone', 'error');
        expect(screen.getByRole('img').style.background).toContain('var(--error) 0 58%');
        rerender(<ScoreRing score={58} tone="neutral" />);
        expect(screen.getByRole('img')).toHaveAttribute('data-tone', 'neutral');
        expect(screen.getByRole('img').style.background).toContain('var(--bg-tertiary) 0 58%');
        rerender(<ScoreRing score={58} tone="lilac" />); // unknown tone → derived from the score
        expect(screen.getByRole('img')).toHaveAttribute('data-tone', 'error');
    });

    it('the phone size is exact too: 36px ring, 27px disc, 11px number', () => {
        render(<ScoreRing score={88} size={36} />);
        const ring = screen.getByRole('img');
        expect(ring.style.width).toBe('36px');
        const disc = ring.firstElementChild;
        expect(disc.style.width).toBe('27px');
        expect(disc.style.height).toBe('27px');
        expect(disc.style.fontSize).toBe('11px');
    });

    it('clamps and rounds the score', () => {
        const { rerender } = render(<ScoreRing score={104.6} />);
        expect(screen.getByRole('img')).toHaveTextContent('100');
        expect(screen.getByRole('img').style.background).toContain('0 100%');
        rerender(<ScoreRing score={-4} />);
        expect(screen.getByRole('img')).toHaveTextContent('0');
        rerender(<ScoreRing score="79.4" />);
        expect(screen.getByRole('img')).toHaveTextContent('79');
    });

    it('placeholder (1g): a dashed ring with "—", no gradient, an accessible "no score" name — also for an unknown score', () => {
        const { rerender } = render(<ScoreRing placeholder score={79} />);
        let ring = screen.getByRole('img');
        expect(ring).toHaveAttribute('data-placeholder', 'true');
        expect(ring).toHaveTextContent('—');
        expect(ring).not.toHaveTextContent('79');
        expect(ring.style.border).toBe('2px dashed var(--border-default)');
        expect(ring.style.background).toBe('');
        expect(ring).toHaveAttribute('aria-label', 'No score yet');

        // An unknown score is NEVER drawn as 0 — a zero would claim the org failed everything.
        for (const score of [null, undefined, '', 'n/a', NaN]) {
            rerender(<ScoreRing score={score} />);
            ring = screen.getByRole('img');
            expect(ring).toHaveAttribute('data-placeholder', 'true');
            expect(ring).not.toHaveTextContent('0');
        }
    });

    it('a label names WHAT is scored in the accessible name', () => {
        render(<ScoreRing score={79} label="GDPR" />);
        expect(screen.getByRole('img')).toHaveAttribute('aria-label', 'GDPR: 79 of 100');
    });

    it('carries no hex colour, no --status-* token, and no SVG stroke maths', () => {
        const src = fs.readFileSync(path.join(here, 'ScoreRing.jsx'), 'utf8');
        expect(src).not.toMatch(/#[0-9a-f]{3,8}\b/i);
        expect(src).not.toMatch(/--status-/);
        expect(src).not.toMatch(/<svg|strokeDasharray/);
    });
});
