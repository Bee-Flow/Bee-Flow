import React from 'react';
import { render, screen, cleanup, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, afterEach } from 'vitest';
import RisksTable, {
    RISK_COLUMNS, severityOfScore, scoreOf, toneOfRiskStatus, isReviewOverdue, ownerName, riskRef,
} from './RisksTable';

vi.mock('../../../../../hooks/useTranslation', () => {
    const useTranslation = () => ({
        t: (key, fallback, params) => {
            let out = typeof fallback === 'string' ? fallback : key;
            for (const [k, v] of Object.entries(params || {})) out = out.split(`{${k}}`).join(String(v));
            return out;
        },
        locale: 'en',
        resolvedLocale: 'en',
    });
    return { default: useTranslation, useTranslation };
});

afterEach(cleanup);

const NOW = Date.now();
const DAY = 86_400_000;
const iso = (ms) => new Date(NOW + ms).toISOString();

// u3 carries an address and NO display name on purpose: it is the only fixture
// that can tell `displayName || null` apart from `displayName || email`, which is
// the BFSF-441 half of what `ownerName` promises (an address never reaches a list).
const NAMELESS_OWNER_EMAIL = 'owner-without-a-name@example.test';
const ORG_USERS = [
    { id: 'u1', displayName: 'T. Smit', email: 'tom@example.org' },
    { id: 'u2', displayName: 'R. Bakker', email: 'r@example.org' },
    { id: 'u3', email: NAMELESS_OWNER_EMAIL },
];

const RISKS = [
    { id: 1, title: 'Provider outage', description: 'The EU inference endpoint is unreachable for a day', category: 'availability', likelihood: 4, impact: 5, score: 20, status: 'open', owner_user_id: 'u1', review_due_at: iso(-3 * DAY) },
    { id: 2, title: 'Prompt leakage', description: 'A prompt carries customer data into a log', category: 'confidentiality', likelihood: 2, impact: 3, status: 'treating', owner_user_id: 'u2', review_due_at: iso(30 * DAY) },
    { id: 3, title: 'Backup never restored', category: 'integrity', likelihood: 1, impact: 2, score: 2, status: 'closed', review_due_at: iso(-90 * DAY) },
    { id: 4, title: 'Retention policy unsigned', category: 'compliance', likelihood: 1, impact: 1, score: 1, status: 'open', owner_user_id: 'u3' },
];

const treatments = new Map([[2, [{ id: 7, risk_id: 2, option: 'mitigate' }, { id: 8, risk_id: 2, option: 'accept' }]]]);

function renderTable(over = {}) {
    return render(
        <RisksTable
            rows={RISKS}
            treatmentsByRisk={treatments}
            orgUsers={ORG_USERS}
            selectedId={null}
            onSelect={vi.fn()}
            {...over}
        />,
    );
}

describe('RisksTable — pure helpers', () => {
    it('maps the ISO score bands onto the severity words the tone table knows', () => {
        expect([1, 4].map(severityOfScore)).toEqual(['low', 'low']);
        expect([5, 9].map(severityOfScore)).toEqual(['medium', 'medium']);
        expect([10, 15].map(severityOfScore)).toEqual(['high', 'high']);
        expect([16, 25].map(severityOfScore)).toEqual(['critical', 'critical']);
        expect(severityOfScore(undefined)).toBeNull();
    });

    it('falls back to likelihood × impact when the row carries no stored score', () => {
        expect(scoreOf({ score: 20, likelihood: 4, impact: 5 })).toBe(20);
        expect(scoreOf({ likelihood: 2, impact: 3 })).toBe(6);
        expect(scoreOf({})).toBe(0);
    });

    it('gives every status its own tone and never paints a closed risk as open', () => {
        expect(toneOfRiskStatus('open')).toBe('error');
        expect(toneOfRiskStatus('treating')).toBe('warning');
        expect(toneOfRiskStatus('accepted')).toBe('neutral');
        expect(toneOfRiskStatus('closed')).toBe('success');
    });

    it('a review is overdue only while the risk is still live', () => {
        expect(isReviewOverdue({ status: 'open', review_due_at: iso(-DAY) }, NOW)).toBe(true);
        expect(isReviewOverdue({ status: 'open', review_due_at: iso(DAY) }, NOW)).toBe(false);
        expect(isReviewOverdue({ status: 'closed', review_due_at: iso(-DAY) }, NOW)).toBe(false);
        expect(isReviewOverdue({ status: 'open' }, NOW)).toBe(false);
    });

    it('resolves an owner by display name only — never by e-mail — and admits when it cannot', () => {
        expect(ownerName(ORG_USERS, 'u2')).toBe('R. Bakker');
        // The one case that separates the claim from `displayName || email`:
        // a member we know only by address stays anonymous (BFSF-441).
        expect(ownerName(ORG_USERS, 'u3')).toBeNull();
        expect(ownerName(ORG_USERS, 'ghost')).toBeNull();
        expect(ownerName(null, 'u1')).toBeNull();
        expect(ownerName(ORG_USERS, null)).toBeNull();
    });

    it('numbers the register R-{id}', () => {
        expect(riskRef({ id: 42 })).toBe('R-42');
    });
});

describe('RisksTable — the register rows', () => {
    it('lays the columns out 64px 1fr 110px 150px 120px; the status column is called "Status", as its filter', () => {
        renderTable({ testId: 'risk-table' });
        const header = screen.getByTestId('risk-table-header');
        expect(header.style.getPropertyValue('--ct-cols')).toBe('64px 1fr 110px 150px 120px');
        // Below 900px of card width the Owner column folds and gives its track back.
        expect(header.style.getPropertyValue('--ct-cols-900')).toBe('64px 1fr 110px 150px');
        expect(RISK_COLUMNS.map(c => c.width)).toEqual(['64px', '1fr', '110px', '150px', '120px']);
        expect(within(header).getAllByRole('columnheader').map(c => c.textContent))
            .toEqual(['Risk', 'Title · scenario', 'Score', 'Status', 'Owner']);
    });

    it('keeps the reference on one line', () => {
        renderTable();
        const ref = screen.getByTestId('risk-table-row-1').querySelector('[role="cell"]');
        expect(ref.className).toMatch(/\bwhitespace-nowrap\b/);
    });

    it('draws R-{id}, the title with its category · scenario line, and the owner (— when nobody owns it)', () => {
        renderTable();
        const row = screen.getByTestId('risk-table-row-1');
        expect(row.textContent).toMatch(/R-1/);
        expect(row.textContent).toMatch(/Provider outage/);
        expect(row.textContent).toMatch(/Availability · The EU inference endpoint is unreachable for a day/i);
        expect(row.textContent).toMatch(/T\. Smit/);
        expect(screen.getByTestId('risk-table-row-3').textContent).toMatch(/—/);
    });

    it('an owner known only by e-mail is drawn as — : the address never reaches the DOM', () => {
        const { container } = renderTable();
        // u3 owns R-4 and has no display name. The cell must fall back to the
        // dash, not to the address (BFSF-441: personal data stays out of lists).
        const row = screen.getByTestId('risk-table-row-4');
        expect(row.textContent).toMatch(/R-4/);
        expect(row.textContent).toMatch(/—/);
        expect(row.textContent).not.toMatch(/@/);
        // …and nowhere else on the page either — attributes (title=, aria-label=)
        // included, which textContent would not see.
        expect(container.innerHTML).not.toContain(NAMELESS_OWNER_EMAIL);
        expect(container.innerHTML).not.toContain('owner-without-a-name');
        expect(screen.queryByText(NAMELESS_OWNER_EMAIL)).toBeNull();
    });

    it('scores L×I in the severity tone: 20 is critical, 6 medium, 2 low', () => {
        renderTable();
        expect(screen.getByTestId('risk-table-score-1').getAttribute('data-severity')).toBe('critical');
        expect(screen.getByTestId('risk-table-score-1').textContent).toMatch(/20/);
        expect(screen.getByTestId('risk-table-score-1').textContent).toMatch(/L4 × I5/);
        // no stored score → the pill computes 2 × 3
        expect(screen.getByTestId('risk-table-score-2').getAttribute('data-severity')).toBe('medium');
        expect(screen.getByTestId('risk-table-score-2').textContent).toMatch(/6/);
        expect(screen.getByTestId('risk-table-score-3').getAttribute('data-severity')).toBe('low');
    });

});

describe('RisksTable — status, flags, selection and phone cards', () => {
    it('draws the status in the register vocabulary with "· {n} actions" beside it, and nothing for no actions', () => {
        renderTable();
        expect(screen.getByTestId('risk-table-status-2').dataset.state).toBe('treating');
        expect(screen.getByTestId('risk-table-status-2').textContent).toBe('Treating');
        expect(screen.getByTestId('risk-table-actions-2').textContent).toBe('· 2 actions');
        expect(screen.getByTestId('risk-table-row-1').textContent).toMatch(/Open/);
        expect(screen.queryByTestId('risk-table-actions-1')).toBeNull();
        expect(screen.getByTestId('risk-table-row-1').textContent).not.toMatch(/· 0/);
        cleanup();
        renderTable({ treatmentsByRisk: new Map([[2, [{ id: 7, risk_id: 2, option: 'mitigate' }]]]) });
        expect(screen.getByTestId('risk-table-actions-2').textContent).toBe('· 1 action');
    });

    it('flags an overdue review on a live risk only, at the start of the second line, never beside the title', () => {
        renderTable();
        const flag = screen.getByTestId('risk-table-overdue-1');
        const meta = screen.getByTestId('risk-table-meta-1');
        expect(meta.contains(flag)).toBe(true);
        expect(meta.firstElementChild).toBe(flag);
        expect(meta.textContent).toMatch(/^\s*review overdue · /);
        // The title line holds the title alone, so the flag cannot shrink it.
        expect(meta.previousElementSibling.textContent).toBe('Provider outage');
        expect(screen.queryByTestId('risk-table-overdue-3')).toBeNull(); // closed
        expect(screen.queryByTestId('risk-table-overdue-2')).toBeNull(); // due in a month
    });

    it('puts a separator only between parts on screen: the folded owner carries its own', () => {
        const bare = { id: 9, title: 'No scenario yet', likelihood: 3, impact: 3, status: 'open', owner_user_id: 'u1', review_due_at: iso(-DAY) };
        renderTable({ rows: [bare] });
        const meta = screen.getByTestId('risk-table-meta-9');
        // With no category or scenario, nothing follows the owner, and the
        // owner (shown only while its column is folded) brings its own dot.
        expect(meta.textContent.trim()).toBe('review overdue · T. Smit');
        const owner = within(meta).getByText((_, el) => el?.tagName === 'SPAN' && el.textContent === ' · T. Smit');
        expect(owner.className).toContain('@max-[900px]/ctable:inline');
    });

    it('stripes the row in its STATUS tone, and the selected row in the area colour', () => {
        renderTable({ selectedId: 2 });
        expect(screen.getByTestId('risk-table-row-1').getAttribute('data-accent')).toBe('error');
        expect(screen.getByTestId('risk-table-row-3').getAttribute('data-accent')).toBeNull(); // closed = no stripe
        const selected = screen.getByTestId('risk-table-row-2');
        expect(selected.getAttribute('data-selected')).toBe('true');
        expect(selected.getAttribute('data-accent')).toBe('kind');
    });

    it('hands the clicked row back to the page', async () => {
        const user = userEvent.setup();
        const onSelect = vi.fn();
        renderTable({ onSelect });
        await user.click(screen.getByTestId('risk-table-row-2'));
        expect(onSelect).toHaveBeenCalledWith(RISKS[1]);
    });

    it('shows the skeleton while loading and the empty state instead of a bare table', () => {
        const { rerender } = renderTable({ rows: [], loading: true });
        expect(screen.getAllByTestId('table-skeleton-row').length).toBeGreaterThan(0);
        expect(screen.queryByTestId('risk-table-row-1')).toBeNull();
        rerender(<RisksTable rows={[]} loading={false} empty={<span>No risks yet</span>} onSelect={vi.fn()} />);
        expect(screen.getByText('No risks yet')).toBeTruthy();
    });

    it('phones get the card list, not the grid: status, the overdue flag and the owner', () => {
        renderTable({ isMobile: true });
        expect(screen.getByTestId('risk-table').getAttribute('data-view')).toBe('cards');
        const card = screen.getByTestId('risk-table-card-1');
        expect(card.textContent).toMatch(/R-1/);
        expect(card.textContent).toMatch(/Provider outage/);
        expect(card.textContent).toMatch(/Open/);
        expect(screen.getByTestId('risk-table-card-overdue-1')).toBeTruthy();
        expect(screen.getByTestId('risk-table-card-owner-1').textContent).toBe('T. Smit');
        expect(screen.getByTestId('risk-table-card-owner-3').textContent).toBe('No owner');
        expect(screen.getByTestId('risk-table-card-2').textContent).toMatch(/· 2 actions/);
    });
});
