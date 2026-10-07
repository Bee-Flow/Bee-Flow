import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { visiblePills, isBusyRow } from './checkSort';
import ChecksTable, { CHECK_CARDS_BELOW } from './ChecksTable';

/**
 * The checks register (artboards 1b/1h). The phone variant gates its card
 * list on BOTH `isMobile` and `renderCard`, so the thing that must hold is
 * that this table passes one: without it a 390px frame renders the six-column
 * desktop grid and clips the actions cell off the right edge. The same cards
 * appear on any device once the table card is narrower than 860px.
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

const DPIA = (scope_id, name, status) => ({
    check_id: 'GDPR-Art35-dpia-high-risk', regulation: 'GDPR', article: '35', severity: 'high', verification: 'attestation',
    titleKey: 'compliance.checks.gdpr_art35.title', scope_id, status, autoFixId: 'fix-dpia',
    evidence: { agent_id: scope_id, agent_name: name },
    details: status === 'fail' ? `No DPIA on record for "${name}".` : 'DPIA on record.',
});
const FOUR = [DPIA('agent_claims', 'Schadebeoordeling', 'fail'), DPIA('agent_intake', 'Polisintake', 'pass'), DPIA('agent_helpdesk', 'Klantenservice', 'pass'), DPIA('agent_kifid', 'Klachtdossier', 'pass')];
const rowId = (scope) => `ct-row-GDPR-Art35-dpia-high-risk:${scope}`;

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

    it('the card carries the desktop row’s data: glyph, title, severity, finding, article, verification, last run', () => {
        render(<ChecksTable checks={[CHECK]} regulation="GDPR" isMobile now={NOW} testId="ct" />);
        const card = screen.getByTestId('ct-row-GDPR-Art33-breach');
        expect(screen.getByTestId('ct-row-GDPR-Art33-breach-glyph').style.color).toBe('var(--error-ink)');
        expect(screen.getByTestId('ct-row-GDPR-Art33-breach-severity')).toHaveAttribute('data-severity', 'high');
        expect(screen.getByTestId('ct-row-GDPR-Art33-breach-details')).toHaveTextContent('No breach detector configured');
        expect(screen.getByTestId('ct-row-GDPR-Art33-breach-article')).toHaveTextContent('Art. 33');
        expect(screen.getByTestId('ct-row-GDPR-Art33-breach-verification')).toHaveAttribute('data-verification', 'automated');
        expect(card.textContent).toContain('09:05');
    });

    it('tapping a card opens the same expansion the desktop row opens', async () => {
        render(<ChecksTable checks={[CHECK]} regulation="GDPR" isMobile now={NOW} testId="ct" />);
        expect(screen.queryByTestId('ct-row-GDPR-Art33-breach-expansion')).toBeNull();
        await userEvent.setup().click(screen.getByTestId('ct-row-GDPR-Art33-breach'));
        expect(screen.getByTestId('ct-row-GDPR-Art33-breach-expansion')).toBeInTheDocument();
        expect(screen.getByTestId('ct-row-GDPR-Art33-breach')).toHaveAttribute('aria-expanded', 'true');
    });

    it('a passing check shows no severity tag on the card either', () => {
        render(<ChecksTable checks={[{ ...CHECK, status: 'pass' }]} regulation="GDPR" isMobile testId="ct" />);
        expect(screen.queryByTestId('ct-row-GDPR-Art33-breach-severity')).toBeNull();
        expect(screen.getByTestId('ct-row-GDPR-Art33-breach-glyph').style.color).toBe('var(--success-ink)');
    });
});

describe('ChecksTable — narrow cards (cardsBelow)', () => {
    afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

    function stubWidth(width) {
        vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
        vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width });
    }

    it('a table card narrower than 860px renders the checks as cards', () => {
        expect(CHECK_CARDS_BELOW).toBe(860);
        stubWidth(700);
        render(<ChecksTable checks={FOUR} regulation="GDPR" now={NOW} testId="ct" />);
        expect(screen.getByTestId('ct-table').dataset.view).toBe('cards');
        expect(screen.getByTestId('ct-card-GDPR-Art35-dpia-high-risk:agent_claims')).toBeInTheDocument();
    });

    it('a wide card keeps the table', () => {
        stubWidth(1100);
        render(<ChecksTable checks={FOUR} regulation="GDPR" now={NOW} testId="ct" />);
        expect(screen.getByTestId('ct-table').dataset.view).toBe('table');
    });
});

describe('ChecksTable — one row per subject', () => {
    it('two rows of the same check open independently, and each names its agent', async () => {
        const user = userEvent.setup();
        render(<ChecksTable checks={FOUR} regulation="GDPR" now={NOW} testId="ct" />);
        expect(within(screen.getByTestId(rowId('agent_intake'))).getByText('Polisintake')).toBeInTheDocument();
        expect(within(screen.getByTestId(rowId('agent_kifid'))).getByText('Klachtdossier')).toBeInTheDocument();
        await user.click(screen.getByTestId(rowId('agent_claims')));
        expect(screen.getByTestId(rowId('agent_claims'))).toHaveAttribute('aria-expanded', 'true');
        for (const other of ['agent_intake', 'agent_helpdesk', 'agent_kifid']) {
            expect(screen.getByTestId(rowId(other))).toHaveAttribute('aria-expanded', 'false');
            expect(screen.queryByTestId(`${rowId(other)}-expansion`)).toBeNull();
        }
        await user.click(screen.getByTestId(rowId('agent_intake')));
        expect(screen.getAllByTestId(/-expansion$/)).toHaveLength(2);
    });

    it('focusId "check:scope" opens that row only; a bare check id opens the first (most urgent) row', () => {
        const { unmount } = render(<ChecksTable checks={FOUR} regulation="GDPR" focusId="GDPR-Art35-dpia-high-risk:agent_kifid" now={NOW} testId="ct" />);
        expect(screen.getByTestId(rowId('agent_kifid'))).toHaveAttribute('aria-expanded', 'true');
        expect(screen.getByTestId(rowId('agent_claims'))).toHaveAttribute('aria-expanded', 'false');
        unmount();
        render(<ChecksTable checks={FOUR} regulation="GDPR" focusId="GDPR-Art35-dpia-high-risk" now={NOW} testId="ct" />);
        expect(screen.getByTestId(rowId('agent_claims'))).toHaveAttribute('aria-expanded', 'true');
        expect(screen.getAllByTestId(/-expansion$/)).toHaveLength(1);
    });

    it('a focus target that arrives with the list (after mount) still opens', () => {
        const { rerender } = render(<ChecksTable checks={[]} loading regulation="GDPR" focusId="GDPR-Art35-dpia-high-risk:agent_intake" now={NOW} testId="ct" />);
        rerender(<ChecksTable checks={FOUR} regulation="GDPR" focusId="GDPR-Art35-dpia-high-risk:agent_intake" now={NOW} testId="ct" />);
        expect(screen.getByTestId(rowId('agent_intake'))).toHaveAttribute('aria-expanded', 'true');
    });

    it('the rerun spinner follows the row whose Re-run was clicked, not every row of the check', async () => {
        const user = userEvent.setup();
        const onRerun = vi.fn();
        const props = { checks: FOUR, regulation: 'GDPR', now: NOW, testId: 'ct', onRerun };
        const { rerender } = render(<ChecksTable {...props} />);
        await user.click(screen.getByTestId(rowId('agent_intake')));
        await user.click(screen.getByTestId(rowId('agent_kifid')));
        await user.click(within(screen.getByTestId(`${rowId('agent_intake')}-expansion`)).getByRole('button', { name: 'Re-run this check' }));
        expect(onRerun).toHaveBeenCalledWith('GDPR-Art35-dpia-high-risk');
        rerender(<ChecksTable {...props} rerunningId="GDPR-Art35-dpia-high-risk" />);
        expect(within(screen.getByTestId(`${rowId('agent_intake')}-expansion`)).getByRole('button', { name: 'Re-run this check' })).toBeDisabled();
        expect(within(screen.getByTestId(`${rowId('agent_kifid')}-expansion`)).getByRole('button', { name: 'Re-run this check' })).toBeEnabled();
    });

    it('the auto-fix spinner follows the row that asked', async () => {
        const user = userEvent.setup();
        const onAutoFix = vi.fn();
        const checks = [DPIA('agent_claims', 'Schadebeoordeling', 'fail'), DPIA('agent_intake', 'Polisintake', 'fail')];
        const props = { checks, regulation: 'GDPR', now: NOW, testId: 'ct', onAutoFix };
        const { rerender } = render(<ChecksTable {...props} />);
        await user.click(screen.getByTestId(rowId('agent_claims')));
        await user.click(screen.getByTestId(rowId('agent_intake')));
        const claims = () => within(screen.getByTestId(`${rowId('agent_claims')}-expansion`));
        await user.click(claims().getByRole('button', { name: /Auto-fix/ }));
        await user.click(claims().getByRole('button', { name: /Apply fix/ }));
        expect(onAutoFix).toHaveBeenCalledWith('GDPR-Art35-dpia-high-risk');
        rerender(<ChecksTable {...props} autoFixingId="GDPR-Art35-dpia-high-risk" />);
        expect(claims().getByTestId(`${rowId('agent_claims')}-expansion-autofix`)).toHaveTextContent('Applying fix');
        expect(within(screen.getByTestId(`${rowId('agent_intake')}-expansion`)).getByTestId(`${rowId('agent_intake')}-expansion-autofix`)).toHaveTextContent('Auto-fix');
    });

    it('isBusyRow: a row key is exact; a check id is the asking row, or every row of the check when started elsewhere', () => {
        const a = DPIA('a', 'A', 'fail'); const b = DPIA('b', 'B', 'fail');
        expect(isBusyRow('GDPR-Art35-dpia-high-risk:a', a, null)).toBe(true);
        expect(isBusyRow('GDPR-Art35-dpia-high-risk:a', b, null)).toBe(false);
        expect(isBusyRow('GDPR-Art35-dpia-high-risk', b, 'GDPR-Art35-dpia-high-risk:a')).toBe(false);
        expect(isBusyRow('GDPR-Art35-dpia-high-risk', b, null)).toBe(true);
        expect(isBusyRow('GDPR-Art35-dpia-high-risk', b, 'OTHER:x')).toBe(true);
        expect(isBusyRow(null, a, null)).toBe(false);
    });
});

describe('ChecksTable — toolbar', () => {
    it('no legend chips; a status with no rows has no pill unless it is the active filter', async () => {
        render(<ChecksTable checks={FOUR} regulation="GDPR" now={NOW} testId="ct" />);
        expect(screen.queryByTestId('ct-toolbar-legend')).toBeNull();
        expect(screen.getByTestId('ct-toolbar-pill-all')).toBeInTheDocument();
        expect(screen.getByTestId('ct-toolbar-pill-fail')).toBeInTheDocument();
        expect(screen.getByTestId('ct-toolbar-pill-pass')).toBeInTheDocument();
        expect(screen.queryByTestId('ct-toolbar-pill-not_applicable')).toBeNull();
        expect(screen.queryByTestId('ct-toolbar-pill-warn')).toBeNull();
        expect(screen.getByTestId('ct-toolbar-search').parentElement.className).toContain('w-[200px]');
        expect(screen.getByTestId('ct-toolbar-search').parentElement.getAttribute('style')).toBeNull();
    });

    it('visiblePills keeps the active pill at zero and shows every pill while uncounted', () => {
        const counts = { all: 3, fail: 0, warn: 1, pass: 2, not_applicable: 0 };
        expect(visiblePills(counts, 'all')).toEqual(['all', 'warn', 'pass']);
        expect(visiblePills(counts, 'fail')).toEqual(['all', 'fail', 'warn', 'pass']);
        expect(visiblePills(null, 'all')).toEqual(['all', 'fail', 'warn', 'pass', 'not_applicable']);
    });

    it('the search finds a row by its agent\'s name', async () => {
        const user = userEvent.setup();
        render(<ChecksTable checks={FOUR} regulation="GDPR" now={NOW} testId="ct" />);
        await user.type(screen.getByTestId('ct-toolbar-search'), 'Klacht');
        await waitFor(() => expect(screen.queryByTestId(rowId('agent_claims'))).toBeNull());
        expect(screen.getByTestId(rowId('agent_kifid'))).toBeInTheDocument();
    });
});
