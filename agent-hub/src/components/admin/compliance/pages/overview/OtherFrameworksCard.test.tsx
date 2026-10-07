import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import OtherFrameworksCard, { otherFrameworkRows } from './OtherFrameworksCard';

/**
 * The Overview's row per optional framework. Pinned: the same set the rail
 * shows (enabled optional frameworks that score a regulation), the Overview's
 * own score with the counts as fallback, the open count from the checks, and
 * nothing at all for an org with only the three core frameworks.
 */
vi.mock('../../../../../hooks/useTranslation', () => {
    const t = (key: string, fallback?: unknown, vars?: Record<string, unknown>) => {
        let s = typeof fallback === 'string' ? fallback : key;
        for (const [k, v] of Object.entries(vars || {})) s = s.split(`{${k}}`).join(String(v));
        return s;
    };
    const hook = () => ({ t, locale: 'en', resolvedLocale: 'en' });
    return { useTranslation: hook, default: hook };
});

const t = (key: string, fallback?: string, vars?: Record<string, unknown>) => {
    let s = fallback ?? key;
    for (const [k, v] of Object.entries(vars || {})) s = s.split(`{${k}}`).join(String(v));
    return s;
};

const enabled = (...ids: string[]) => ({ isEnabled: (id: string) => ids.includes(id) });

const CHECKS = [
    { status: 'fail', regulation: 'DORA' },
    { status: 'warn', regulation: 'DORA' },
    { status: 'pass', regulation: 'DORA' },
    // Evidence that also counts for NIS2 counts there too.
    { status: 'warn', regulation: 'ISO27001', frameworks: [{ regulation: 'NIS2' }] },
];

describe('OtherFrameworksCard', () => {
    it('renders one row per enabled optional framework with its ring, headline and open count, and opens it', async () => {
        const navigate = vi.fn();
        render(<OtherFrameworksCard counts={{ frameworks: { dora: { score: 75 } } }} frameworks={enabled('dora')} checks={CHECKS} navigate={navigate} />);
        expect(screen.getByRole('region', { name: 'Other frameworks' })).toBeInTheDocument();
        const row = screen.getByTestId('other-frameworks-row-dora');
        expect(row.className).toContain('h-10');
        expect(screen.getByTestId('other-frameworks-ring-dora')).toHaveAttribute('data-score', '75');
        expect(row).toHaveTextContent('DORA');
        expect(screen.getByTestId('other-frameworks-headline-dora')).toHaveTextContent('A few items need attention');
        expect(screen.getByTestId('other-frameworks-headline-dora').className).toContain('text-[var(--warning-ink)]');
        expect(screen.getByTestId('other-frameworks-open-dora')).toHaveTextContent('2 open');
        await userEvent.setup().click(row);
        expect(navigate).toHaveBeenCalledWith('dora');
    });

    it('renders nothing when the org has only the core frameworks', () => {
        const { container } = render(<OtherFrameworksCard counts={{}} frameworks={enabled('gdpr', 'aia', 'iso27001')} checks={CHECKS} />);
        expect(container).toBeEmptyDOMElement();
    });

    it('a framework with no score yet gets the placeholder ring and no open count while the checks load', () => {
        render(<OtherFrameworksCard counts={{}} frameworks={enabled('nis2')} checks={null} />);
        expect(screen.getByTestId('other-frameworks-ring-nis2')).toHaveAttribute('data-placeholder', 'true');
        expect(screen.getByTestId('other-frameworks-headline-nis2')).toHaveTextContent('Score after the first run');
        expect(screen.queryByTestId('other-frameworks-open-nis2')).toBeNull();
    });

    it('no "0 open" for a framework with nothing open', () => {
        render(<OtherFrameworksCard counts={{ frameworks: { eaa: { score: 100 } } }} frameworks={enabled('eaa')} checks={CHECKS} />);
        expect(screen.getByTestId('other-frameworks-row-eaa')).toBeInTheDocument();
        expect(screen.queryByTestId('other-frameworks-open-eaa')).toBeNull();
    });
});

describe('otherFrameworkRows', () => {
    it('keeps rail order, prefers the Overview score over the counts and counts open checks per regulation', () => {
        const rows = otherFrameworkRows({
            counts: { frameworks: { dora: { score: 75 }, nis2: { score: 40 } } },
            frameworks: enabled('nis2', 'dora'),
            overview: { frameworks_detail: { nis2: { score: 62 } } },
            checks: CHECKS,
            t,
        });
        expect(rows.map((r) => r.id)).toEqual(['nis2', 'dora']);
        expect(rows[0]).toMatchObject({ id: 'nis2', score: 62, tone: 'warning', open: 1 });
        expect(rows[1]).toMatchObject({ id: 'dora', score: 75, tone: 'warning', open: 2, label: 'DORA' });
    });

    it('a framework the counts score is visible even before the frameworks list arrives', () => {
        const rows = otherFrameworkRows({ counts: { frameworks: { cra: { score: 90 } } }, frameworks: null, overview: null, checks: [], t });
        expect(rows).toEqual([expect.objectContaining({ id: 'cra', score: 90, tone: 'success', open: 0 })]);
    });
});
