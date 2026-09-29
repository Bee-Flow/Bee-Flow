import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import ChecksTable from './ChecksTable';

/**
 * The phone variant of the checks register (artboards 1b/1h). The table gates
 * its card list on BOTH `isMobile` and `renderCard`, so the thing that must
 * hold is that this table passes one: without it a 390px frame renders the
 * six-column desktop grid and clips the actions cell off the right edge.
 */

// "Ran at 09:05" only if the run was TODAY; otherwise the row says "Sep 14".
// The clock is therefore pinned, not read from the machine — without this the
// test passes on 14 September and fails on the 15th.
const RAN_AT = new Date(2026, 8, 14, 9, 5);
const NOW = new Date(2026, 8, 14, 17, 30).getTime();

const CHECK = {
    check_id: 'GDPR-Art33-breach',
    regulation: 'GDPR',
    article: '33',
    status: 'fail',
    severity: 'high',
    verification: 'automated',
    titleKey: 'compliance.check_breach_title',
    details: 'No breach detector configured',
    frameworks: [{ regulation: 'GDPR', ref: '33' }],
    run_at: RAN_AT.toISOString(),
};

describe('ChecksTable — phone cards', () => {
    it('desktop is untouched: the grid table, no cards', () => {
        render(<ChecksTable checks={[CHECK]} regulation="GDPR" now={NOW} testId="ct" />);
        expect(screen.getByTestId('ct-table').dataset.view).toBe('table');
        expect(screen.queryByTestId('ct-card-GDPR-Art33-breach')).toBeNull();
        expect(screen.getByTestId('ct-row-GDPR-Art33-breach')).toBeInTheDocument();
    });

    it('isMobile: the card list, one ≥44px tappable card per check', () => {
        render(<ChecksTable checks={[CHECK]} regulation="GDPR" isMobile now={NOW} testId="ct" />);
        const table = screen.getByTestId('ct-table');
        expect(table.dataset.view).toBe('cards');
        expect(screen.getByTestId('ct-card-GDPR-Art33-breach')).toBeInTheDocument();
        const card = screen.getByTestId('ct-row-GDPR-Art33-breach');
        expect(card.tagName).toBe('BUTTON');
        expect(card.className).toMatch(/min-h-\[44px\]/);
        expect(card).toHaveAttribute('aria-expanded', 'false');
    });

    it('the card carries the desktop row’s data: glyph, title, severity, article, verification, last run', () => {
        render(<ChecksTable checks={[CHECK]} regulation="GDPR" isMobile now={NOW} testId="ct" />);
        const card = screen.getByTestId('ct-row-GDPR-Art33-breach');
        expect(screen.getByTestId('ct-row-GDPR-Art33-breach-glyph').style.color).toBe('var(--error-ink)');
        expect(screen.getByTestId('ct-row-GDPR-Art33-breach-severity')).toHaveAttribute('data-severity', 'high');
        expect(screen.getByTestId('ct-row-GDPR-Art33-breach-article')).toHaveTextContent('Art. 33');
        expect(screen.getByTestId('ct-row-GDPR-Art33-breach-verification')).toHaveAttribute('data-verification', 'automated');
        expect(card.textContent).toContain('09:05');
    });

    it('tapping a card opens the same expansion the desktop row opens', () => {
        render(<ChecksTable checks={[CHECK]} regulation="GDPR" isMobile now={NOW} testId="ct" />);
        expect(screen.queryByTestId('ct-row-GDPR-Art33-breach-expansion')).toBeNull();
        fireEvent.click(screen.getByTestId('ct-row-GDPR-Art33-breach'));
        expect(screen.getByTestId('ct-row-GDPR-Art33-breach-expansion')).toBeInTheDocument();
        expect(screen.getByTestId('ct-row-GDPR-Art33-breach')).toHaveAttribute('aria-expanded', 'true');
    });

    it('a passing check shows no severity tag on the card either', () => {
        render(<ChecksTable checks={[{ ...CHECK, status: 'pass' }]} regulation="GDPR" isMobile testId="ct" />);
        expect(screen.queryByTestId('ct-row-GDPR-Art33-breach-severity')).toBeNull();
        expect(screen.getByTestId('ct-row-GDPR-Art33-breach-glyph').style.color).toBe('var(--success-ink)');
    });
});
