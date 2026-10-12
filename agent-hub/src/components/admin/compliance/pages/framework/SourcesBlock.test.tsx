import { render, screen } from '@testing-library/react';
import React from 'react';
import { describe, expect, it } from 'vitest';
import { SourcesBlock } from './TimelineTab';
import { legalStatusChip } from '../../ComplianceHeader';

const t = (_key: string, fallback: string, vars: Record<string, unknown> = {}) =>
    fallback.replace(/\{(\w+)\}/g, (_m, k) => String(vars[k] ?? ''));

const RECORD = {
    id: 'gdpr',
    sources: [
        { label: 'Regulation (EU) 2016/679 — EUR-Lex', url: 'https://eur-lex.europa.eu/eli/reg/2016/679/oj' },
        { label: 'not a link', url: 'javascript:alert(1)' },
    ],
    legal_review: { verified_on: '2026-10-06', age_days: 3, stale: false, stale_after_days: 90, sources: 2 },
};

describe('SourcesBlock', () => {
    it('lists only https sources as external links, with the day they were checked', () => {
        render(<SourcesBlock record={RECORD} />);
        const links = screen.getAllByRole('link');
        expect(links).toHaveLength(1);
        expect(links[0]).toHaveAttribute('href', 'https://eur-lex.europa.eu/eli/reg/2016/679/oj');
        expect(links[0]).toHaveAttribute('target', '_blank');
        expect(links[0]).toHaveAttribute('rel', 'noopener noreferrer');
        expect(screen.getByTestId('timeline-sources-checked')).toHaveAttribute('data-stale', 'false');
        expect(screen.getByTestId('timeline-sources-checked').textContent).toContain('2026-10-06');
    });

    it('says a stale entry is due for review', () => {
        render(<SourcesBlock record={{ ...RECORD, legal_review: { ...RECORD.legal_review, stale: true, age_days: 120 } }} />);
        expect(screen.getByTestId('timeline-sources-checked')).toHaveAttribute('data-stale', 'true');
        expect(screen.getByTestId('timeline-sources-checked').textContent).toMatch(/Due for review/);
    });

    it('renders nothing for a record without sources (an older server)', () => {
        const { container } = render(<SourcesBlock record={{ id: 'gdpr' }} />);
        expect(container).toBeEmptyDOMElement();
    });
});

describe('legalStatusChip', () => {
    it('shows the day the legal status was checked, not today', () => {
        render(<>{legalStatusChip({ verified_on: '2026-09-14', stale: false }, t)}</>);
        expect(screen.getByTestId('header-info').textContent).toBe('Legal status checked 2026-09-14 · not legal advice');
        expect(screen.getByTestId('header-info')).not.toHaveAttribute('data-tone');
    });

    it('turns into a warning once the check is overdue, or was never recorded', () => {
        const { unmount } = render(<>{legalStatusChip({ verified_on: '2026-01-02', stale: true }, t)}</>);
        expect(screen.getByTestId('header-info').textContent).toBe('Legal status checked 2026-01-02 · due for review');
        expect(screen.getByTestId('header-info')).toHaveAttribute('data-tone', 'warning');
        unmount();
        render(<>{legalStatusChip({ verified_on: null, stale: true }, t)}</>);
        expect(screen.getByTestId('header-info').textContent).toBe('Legal status not recorded · due for review');
    });
});
