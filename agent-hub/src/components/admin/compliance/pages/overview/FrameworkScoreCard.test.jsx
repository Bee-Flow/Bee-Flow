import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Bot } from 'lucide-react';
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import FrameworkScoreCard from './FrameworkScoreCard';

function tr(key, fallbackOrParams, paramsArg) {
    const hasFallback = typeof fallbackOrParams === 'string';
    const params = hasFallback ? paramsArg : fallbackOrParams;
    let value = hasFallback ? fallbackOrParams : key;
    if (params && typeof params === 'object') {
        for (const [k, v] of Object.entries(params)) value = value.split(`{${k}}`).join(String(v));
    }
    return value;
}
vi.mock('../../../../../hooks/useTranslation', () => ({
    useTranslation: () => ({ t: tr, locale: 'en', resolvedLocale: 'en' }),
}));

const SCORE = { score: 58, total: 6, pass: 3, warn: 1, fail: 1, na: 1 };
const VERIFICATION = {
    automated: { total: 3, pass: 2 },
    attestation: { total: 2, pass: 1 },
    hybrid: { total: 0, pass: 0 },
};

function renderCard(props = {}) {
    const onOpen = vi.fn();
    const utils = render(
        <FrameworkScoreCard frameworkId="aia" name="AI Act" icon={Bot} score={SCORE} verification={VERIFICATION} onOpen={onOpen} {...props} />,
    );
    return { ...utils, onOpen };
}

const freezeClock = () => { vi.useFakeTimers({ now: new Date('2026-09-14T09:00:00Z'), toFake: ['Date'] }); };

describe('FrameworkScoreCard — the head and the verification line', () => {
    beforeEach(freezeClock);

    it('shows the score, the headline for its band and the breakdown', () => {
        renderCard();
        expect(screen.getByTestId('fw-score-card-ring')).toHaveAttribute('data-score', '58');
        expect(screen.getByTestId('fw-score-card').dataset.tone).toBe('error');
        expect(screen.getByTestId('fw-score-card-headline').textContent).toBe('Clear gaps');
        const breakdown = screen.getByTestId('fw-score-card-breakdown');
        // Problems first; the total and n/a are in the title and the screen-reader text.
        expect(breakdown.querySelector('[aria-hidden="true"]').textContent).toBe('1 failing · 1 attention · 3 passing');
        expect(breakdown).toHaveAttribute('title', '6 checks · 3 passing · 1 attention · 1 failing · 1 n/a');
        expect(breakdown.querySelector('.sr-only').textContent).toBe('6 checks · 3 passing · 1 attention · 1 failing · 1 n/a');
    });

    it('prints only the non-zero buckets', () => {
        renderCard({ score: { score: 94, total: 33, pass: 30, warn: 1, fail: 0, na: 2 } });
        expect(screen.getByTestId('fw-score-card-breakdown').querySelector('[aria-hidden="true"]').textContent).toBe('1 attention · 30 passing');
        expect(screen.getByTestId('fw-score-card-breakdown').querySelector('[aria-hidden="true"]').textContent).not.toMatch(/\b0 /);
    });

    it('a breakdown it cannot state in full is not stated at all — no fabricated zeroes', () => {
        // The old code filled every missing bucket with `?? 0`, so a response
        // that never said how many failed printed "0 failing".
        renderCard({ score: { score: 58, total: 6, pass: 3, warn: 1 } });
        expect(screen.queryByTestId('fw-score-card-breakdown')).not.toBeInTheDocument();
        expect(screen.getByTestId('fw-score-card-ring')).toHaveAttribute('data-score', '58');
    });

    it('one plain verification line: automated and self-attested told apart by glyph, no pill borders', () => {
        renderCard();
        const line = screen.getByTestId('fw-score-card-verification');
        expect(line.textContent).toContain('2/3 automated');
        expect(line.textContent).toContain('1/2 self-attested');
        expect(line.querySelector('[style*="border"]')).toBeNull();
        expect(line.className).toContain('text-[var(--text-tertiary)]');
        // What the short form means stays in the title and the screen-reader text.
        expect(screen.getByTestId('fw-score-card-verif-auto')).toHaveAttribute('title', 'automated: 2/3 passing');
        expect(screen.getByTestId('fw-score-card-verif-attested')).toHaveAttribute('title', 'self-attested: 1/2 passing');
        expect(screen.getByTestId('fw-score-card-verif-attested')).toHaveAttribute('data-verification', 'attestation');
    });

    it('counts hybrid checks with the automated bucket', () => {
        renderCard({ verification: { automated: { total: 3, pass: 2 }, attestation: { total: 0, pass: 0 }, hybrid: { total: 2, pass: 2 } } });
        expect(screen.getByTestId('fw-score-card-verif-auto').textContent).toContain('4/5');
        expect(screen.queryByTestId('fw-score-card-verif-attested')).not.toBeInTheDocument();
    });

    it('prefers the SoA progress over the attested count (ISO)', () => {
        renderCard({ frameworkId: 'iso27001', soa: { approved: 9, total: 93 }, unit: 'controls' });
        expect(screen.getByTestId('fw-score-card-verif-soa').textContent).toContain('SoA 9/93 approved');
        expect(screen.queryByTestId('fw-score-card-verif-attested')).not.toBeInTheDocument();
        expect(screen.getByTestId('fw-score-card-breakdown')).toHaveAttribute('title', expect.stringContaining('6 controls'));
    });

});

describe('FrameworkScoreCard — background, footer and opening', () => {
    beforeEach(freezeClock);

    it('keeps the in-force date in the card\'s title and accessible description, and only the next milestone in the footer', () => {
        renderCard({ inForceSince: '2024-08-01', law: 'UAVG', nextMilestone: { date: '2026-12-02', label: 'Marking' } });
        const card = screen.getByTestId('fw-score-card');
        expect(card).toHaveAttribute('title', 'In force since 1 Aug 2024 · UAVG');
        expect(card).toHaveAccessibleDescription('In force since 1 Aug 2024 · UAVG');
        expect(screen.getByTestId('fw-score-card-in-force')).toHaveClass('sr-only');
        const next = screen.getByTestId('fw-score-card-next');
        expect(next.textContent).toContain('Marking');
        expect(next.textContent).not.toContain('In force');
        expect(next.getAttribute('style')).toContain('var(--warning-ink)');
    });

    it('an in-force date without a law, and no footer without a milestone', () => {
        renderCard({ inForceSince: '2024-08-01' });
        expect(screen.getByTestId('fw-score-card')).toHaveAccessibleDescription('In force since 1 Aug 2024');
        expect(screen.queryByTestId('fw-score-card-next')).not.toBeInTheDocument();
    });

    it('no description when neither date nor law is known', () => {
        renderCard();
        expect(screen.getByTestId('fw-score-card')).not.toHaveAttribute('aria-describedby');
        expect(screen.queryByTestId('fw-score-card-in-force')).not.toBeInTheDocument();
    });

    it('opens the framework on click and on Enter', async () => {
        const { onOpen } = renderCard();
        const user = userEvent.setup();
        const card = screen.getByTestId('fw-score-card');
        expect(card).toHaveAttribute('role', 'button');
        await user.click(card);
        card.focus();
        await user.keyboard('{Enter}');
        expect(onOpen).toHaveBeenCalledTimes(2);
    });

    it('a placeholder card shows no number, no chips and cannot be opened', async () => {
        const { onOpen } = renderCard({ placeholder: true, placeholderNote: 'Score after setup — 6 checks are ready' });
        const card = screen.getByTestId('fw-score-card');
        expect(card.dataset.placeholder).toBe('true');
        expect(card).not.toHaveAttribute('role');
        expect(card.className).toContain('border-dashed');
        expect(screen.getByTestId('fw-score-card-ring')).toHaveAttribute('data-placeholder', 'true');
        expect(screen.getByTestId('fw-score-card-note').textContent).toBe('Score after setup — 6 checks are ready');
        expect(screen.queryByTestId('fw-score-card-verification')).not.toBeInTheDocument();
        expect(screen.queryByTestId('fw-score-card-breakdown')).not.toBeInTheDocument();
        await userEvent.setup().click(card);
        expect(onOpen).not.toHaveBeenCalled();
    });

    it('a missing score falls back to the placeholder ring, never a red 0', () => {
        renderCard({ score: null, verification: null });
        expect(screen.getByTestId('fw-score-card').dataset.tone).toBe('neutral');
        expect(screen.getByTestId('fw-score-card-ring')).toHaveAttribute('data-placeholder', 'true');
        expect(screen.queryByTestId('fw-score-card-breakdown')).not.toBeInTheDocument();
    });

    it('paints with tone tokens only — no hex anywhere in the card', () => {
        const { container } = renderCard({ inForceSince: '2024-08-01', law: 'UAVG' });
        expect(container.innerHTML).not.toMatch(/#[0-9a-fA-F]{6}\b/);
    });
});
