import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Bot } from 'lucide-react';
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

describe('FrameworkScoreCard', () => {
    beforeEach(() => { vi.useFakeTimers({ now: new Date('2026-09-14T09:00:00Z'), toFake: ['Date'] }); });

    it('shows the score, the headline for its band and the breakdown', () => {
        renderCard();
        expect(screen.getByTestId('fw-score-card-ring')).toHaveAttribute('data-score', '58');
        expect(screen.getByTestId('fw-score-card').dataset.tone).toBe('error');
        expect(screen.getByTestId('fw-score-card-headline').textContent).toBe('Clear gaps');
        expect(screen.getByTestId('fw-score-card-breakdown').textContent)
            .toBe('6 checks · 3 passing · 1 attention · 1 failing · 1 n/a');
    });

    it('a breakdown it cannot state in full is not stated at all — no fabricated zeroes', () => {
        // The old code filled every missing bucket with `?? 0`, so a response
        // that never said how many failed printed "0 failing".
        renderCard({ score: { score: 58, total: 6, pass: 3, warn: 1 } });
        expect(screen.queryByTestId('fw-score-card-breakdown')).not.toBeInTheDocument();
        expect(screen.getByTestId('fw-score-card-ring')).toHaveAttribute('data-score', '58');
    });

    it('splits automated from self-attested — a solid chip and a dashed one', () => {
        renderCard();
        const auto = screen.getByTestId('fw-score-card-chip-auto');
        const attested = screen.getByTestId('fw-score-card-chip-attested');
        expect(auto.textContent).toContain('automated: 2/3 passing');
        expect(auto.getAttribute('style')).toContain('solid');
        expect(attested.textContent).toContain('self-attested: 1/2 passing');
        expect(attested.getAttribute('style')).toContain('dashed');
    });

    it('counts hybrid checks with the automated bucket', () => {
        renderCard({ verification: { automated: { total: 3, pass: 2 }, attestation: { total: 0, pass: 0 }, hybrid: { total: 2, pass: 2 } } });
        expect(screen.getByTestId('fw-score-card-chip-auto').textContent).toContain('4/5');
        expect(screen.queryByTestId('fw-score-card-chip-attested')).not.toBeInTheDocument();
    });

    it('prefers the SoA progress over the attested chip (ISO)', () => {
        renderCard({ frameworkId: 'iso27001', soa: { approved: 9, total: 93 }, unit: 'controls' });
        expect(screen.getByTestId('fw-score-card-chip-soa').textContent).toContain('SoA 9/93 approved');
        expect(screen.queryByTestId('fw-score-card-chip-attested')).not.toBeInTheDocument();
        expect(screen.getByTestId('fw-score-card-breakdown').textContent).toContain('6 controls');
    });

    it('prints the in-force footer and the next milestone', () => {
        renderCard({ inForceSince: '2024-08-01', law: 'UAVG', nextMilestone: { date: '2026-12-02', label: 'Marking' } });
        expect(screen.getByTestId('fw-score-card-footer').textContent).toContain('In force since 1 Aug 2024 · UAVG');
        const next = screen.getByTestId('fw-score-card-next');
        expect(next.textContent).toContain('Marking');
        expect(next.getAttribute('style')).toContain('var(--warning-ink)');
    });

    it('omits the footer entirely when neither date nor law is known', () => {
        renderCard();
        expect(screen.queryByTestId('fw-score-card-footer')).not.toBeInTheDocument();
    });

    it('opens the framework on click and on Enter', () => {
        const { onOpen } = renderCard();
        const card = screen.getByTestId('fw-score-card');
        expect(card).toHaveAttribute('role', 'button');
        fireEvent.click(card);
        fireEvent.keyDown(card, { key: 'Enter' });
        expect(onOpen).toHaveBeenCalledTimes(2);
    });

    it('a placeholder card shows no number, no chips and cannot be opened', () => {
        const { onOpen } = renderCard({ placeholder: true, placeholderNote: 'Score after setup — 6 checks are ready' });
        const card = screen.getByTestId('fw-score-card');
        expect(card.dataset.placeholder).toBe('true');
        expect(card).not.toHaveAttribute('role');
        expect(card.className).toContain('border-dashed');
        expect(screen.getByTestId('fw-score-card-ring')).toHaveAttribute('data-placeholder', 'true');
        expect(screen.getByTestId('fw-score-card-note').textContent).toBe('Score after setup — 6 checks are ready');
        expect(screen.queryByTestId('fw-score-card-chips')).not.toBeInTheDocument();
        expect(screen.queryByTestId('fw-score-card-breakdown')).not.toBeInTheDocument();
        fireEvent.click(card);
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
