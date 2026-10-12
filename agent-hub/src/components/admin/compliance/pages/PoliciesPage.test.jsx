import React from 'react';
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, afterEach } from 'vitest';
import PoliciesPage, { isReviewOverdue } from './PoliciesPage';

vi.mock('../../../../hooks/useTranslation', () => {
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

const USERS = [{ id: 'u1', displayName: 'T. Smit', email: 't@example.com' }, { id: 'u2', displayName: 'R. Bakker', email: 'r@example.com' }];

const DOCS = {
    documents: [
        { slug: 'information-security-policy', title: 'Information security policy', status: 'published', current_version: 3, ack_count: 1, edited: true, owner_user_id: 'u1', review_due_at: '2027-01-01' },
        { slug: 'access-control', title: 'Access control policy', status: 'draft', current_version: 0, ack_count: 0, edited: false, owner_user_id: null, review_due_at: null },
    ],
    missing_seeds: [{ slug: 'exit-procedure', title: 'Exit procedure' }],
};

function policyState(over = {}) {
    return {
        docs: DOCS,
        busySlug: null,
        refresh: vi.fn(),
        seed: vi.fn(),
        loadDoc: vi.fn().mockResolvedValue({
            slug: 'access-control', title: 'Access control policy', draft_body: 'Template body',
            owner_user_id: '', review_due_at: null, edited: false, status: 'draft', current_version: 0, ack_count: 0,
        }),
        save: vi.fn().mockResolvedValue({}),
        publish: vi.fn().mockResolvedValue({}),
        ...over,
    };
}

function pageProps(over = {}) {
    const { policies, ...rest } = over;
    return {
        section: { id: 'policies' }, tab: null, onTab: vi.fn(), navigate: vi.fn(), focusId: null,
        exportsEnabled: true, dl: (u) => u, api: '/api/compliance', isMobile: false, setHeaderActions: vi.fn(),
        data: { policies: policyState(policies), orgUsers: USERS },
        ...rest,
    };
}

describe('PoliciesPage', () => {
    it('lists every document without a slug column; the status is said once, in the pill, with the version', () => {
        render(<PoliciesPage {...pageProps()} />);
        const header = screen.getByTestId('policies-table-header');
        expect(within(header).getAllByRole('columnheader').map(c => c.textContent)).toEqual(['Title', 'Acknowledged', 'Status', 'Owner', 'Review due']);
        const row = screen.getByTestId('policies-row-information-security-policy');
        expect(row.textContent).not.toContain('information-security-policy');
        expect(screen.getByTestId('policies-status-information-security-policy').textContent).toBe('Published · v3');
        expect(screen.getByTestId('policies-status-information-security-policy').dataset.state).toBe('published');
        expect(screen.getByTestId('policies-status-access-control').textContent).toBe('Draft');
        // No second "Published v3" under the title.
        expect(row.textContent.match(/Published/g)).toHaveLength(1);
    });

    it('Owner and Review due have their own columns, which fold below 900px into the line under the title', () => {
        render(<PoliciesPage {...pageProps()} />);
        expect(screen.getByTestId('policies-owner-information-security-policy').textContent).toBe('T. Smit');
        expect(screen.getByTestId('policies-clock-information-security-policy')).toBeTruthy();
        const header = screen.getByTestId('policies-table-header');
        expect(header.style.getPropertyValue('--ct-cols-900')).toBe('1fr 110px 130px');
        // The folded copy is only shown while the columns are folded.
        const folded = screen.getByTestId('policies-folded-information-security-policy');
        expect(folded.className).toMatch(/\bhidden\b/);
        expect(folded.textContent).toMatch(/T\. Smit · Review due 1 Jan/);
    });

    it('the line under the title carries only exceptions, so a red stripe has its reason on the row', () => {
        const docs = {
            documents: [
                ...DOCS.documents,
                { slug: 'supplier', title: 'Supplier security policy', status: 'published', current_version: 1, ack_count: 1, edited: true, owner_user_id: 'u2', review_due_at: '2026-01-05' },
            ],
            missing_seeds: [],
        };
        render(<PoliciesPage {...pageProps({ policies: { docs } })} />);
        const overdue = screen.getByTestId('policies-row-supplier');
        expect(overdue.getAttribute('data-accent')).toBe('error');
        expect(screen.getByTestId('policies-overdue-supplier').textContent).toMatch(/review overdue 5 Jan/);
        expect(screen.getByTestId('policies-meta-supplier').className).not.toMatch(/\bhidden\b/);
        // A published, customised, in-date document has no visible meta line.
        expect(screen.getByTestId('policies-meta-information-security-policy').className).toMatch(/\bhidden\b/);
        expect(screen.queryByTestId('policies-overdue-information-security-policy')).toBeNull();
    });

    it('marks a template that was never customised', () => {
        render(<PoliciesPage {...pageProps()} />);
        expect(screen.getByTestId('policies-untouched-access-control')).toBeTruthy();
        expect(screen.queryByTestId('policies-untouched-information-security-policy')).toBeNull();
    });

    it('shows acknowledgements as n / m when the roster size is known', () => {
        render(<PoliciesPage {...pageProps()} />);
        expect(screen.getByTestId('policies-acks-information-security-policy').textContent).toContain('1 / 2');
    });

    it('never invents a denominator when the roster is unknown', () => {
        render(<PoliciesPage {...pageProps({ data: { policies: policyState(), orgUsers: null } })} />);
        const cell = screen.getByTestId('policies-acks-information-security-policy').textContent;
        expect(cell).toContain('1');
        expect(cell).not.toContain('/');
    });

    it('never invents a numerator either — an unstated count renders nothing', () => {
        // `d.ack_count ?? 0` printed "0", which says nobody acknowledged the
        // policy. A count the server did not state is unknown, not zero.
        const docs = [{ slug: 'information-security-policy', title: 'Information security policy', status: 'published', current_version: 3, edited: true, owner_user_id: 'u1', review_due_at: '2027-01-01' }];
        render(<PoliciesPage {...pageProps({ data: { policies: policyState({ docs }), orgUsers: null } })} />);
        expect(screen.queryByTestId('policies-acks-information-security-policy')).toBeNull();
    });

    it('offers the seed action only while templates are missing', () => {
        render(<PoliciesPage {...pageProps()} />);
        expect(screen.getByTestId('policies-seed').textContent).toContain('1');
        cleanup();
        render(<PoliciesPage {...pageProps({ policies: { docs: { documents: DOCS.documents, missing_seeds: [] } } })} />);
        expect(screen.queryByTestId('policies-seed')).toBeNull();
    });

    it('calls the hook seed handler', async () => {
        const user = userEvent.setup();
        const seed = vi.fn();
        render(<PoliciesPage {...pageProps({ policies: { seed } })} />);
        await user.click(screen.getByTestId('policies-seed'));
        expect(seed).toHaveBeenCalled();
    });

    it('a failed read is its own state, not an empty register', () => {
        render(<PoliciesPage {...pageProps({ policies: { docs: { error: 'boom' } } })} />);
        expect(screen.getByTestId('policies-failed')).toBeTruthy();
        expect(screen.queryByTestId('policies-table')).toBeNull();
    });

    it('shows the skeleton while the register is still being read', () => {
        render(<PoliciesPage {...pageProps({ policies: { docs: null } })} />);
        expect(screen.getAllByTestId('table-skeleton-row').length).toBeGreaterThan(0);
    });

    it('opens the drawer on a row and loads the full document', async () => {
        const loadDoc = vi.fn().mockResolvedValue({
            slug: 'access-control', title: 'Access control policy', draft_body: 'Template body',
            owner_user_id: 'u2', review_due_at: '2027-02-02', edited: false, status: 'draft', current_version: 0,
        });
        render(<PoliciesPage {...pageProps({ policies: { loadDoc } })} />);
        fireEvent.click(screen.getByTestId('policies-row-access-control'));
        await waitFor(() => expect(screen.getByTestId('policy-drawer-body')).toBeTruthy());
        expect(loadDoc).toHaveBeenCalledWith('access-control');
        expect(screen.getByTestId('policy-drawer-title').value).toBe('Access control policy');
        expect(screen.getByTestId('policy-drawer-owner').value).toBe('u2');
        expect(screen.getByTestId('policy-drawer-nudge')).toBeTruthy();
    });

    it('saves the edited draft through the hook', async () => {
        const save = vi.fn().mockResolvedValue({});
        render(<PoliciesPage {...pageProps({ policies: { save } })} />);
        fireEvent.click(screen.getByTestId('policies-row-access-control'));
        await waitFor(() => expect(screen.getByTestId('policy-drawer-body')).toBeTruthy());
        fireEvent.change(screen.getByTestId('policy-drawer-body'), { target: { value: 'Our own words' } });
        fireEvent.change(screen.getByTestId('policy-drawer-review'), { target: { value: '2027-03-03' } });
        fireEvent.click(screen.getByTestId('policy-drawer-save'));
        expect(save).toHaveBeenCalledWith('access-control', expect.objectContaining({ body: 'Our own words', review_due_at: '2027-03-03' }));
    });

    it('publish asks first, then saves and publishes', async () => {
        const user = userEvent.setup();
        const order = [];
        const save = vi.fn(async () => { order.push('save'); });
        const publish = vi.fn(async () => { order.push('publish'); });
        render(<PoliciesPage {...pageProps({ policies: { save, publish } })} />);
        await user.click(screen.getByTestId('policies-row-access-control'));
        await waitFor(() => expect(screen.getByTestId('policy-drawer-publish')).toBeTruthy());
        await user.click(screen.getByTestId('policy-drawer-publish'));
        expect(publish).not.toHaveBeenCalled();
        expect(screen.getByTestId('policy-drawer-confirm-text').textContent).toBe('Publish v1? Members will be asked to acknowledge this version.');
        await user.click(screen.getByTestId('policy-drawer-confirm-go'));
        await waitFor(() => expect(publish).toHaveBeenCalledWith('access-control'));
        expect(order).toEqual(['save', 'publish']);
    });

    it('a document that cannot be loaded says so instead of showing an empty editor', async () => {
        render(<PoliciesPage {...pageProps({ policies: { loadDoc: vi.fn().mockResolvedValue(null) } })} />);
        fireEvent.click(screen.getByTestId('policies-row-access-control'));
        await waitFor(() => expect(screen.getByTestId('policy-drawer-failed')).toBeTruthy());
        expect(screen.queryByTestId('policy-drawer-body')).toBeNull();
    });

    it('closes the drawer on a second click of the same row', async () => {
        render(<PoliciesPage {...pageProps()} />);
        fireEvent.click(screen.getByTestId('policies-row-access-control'));
        await waitFor(() => expect(screen.getByTestId('policy-drawer')).toBeTruthy());
        fireEvent.click(screen.getByTestId('policies-row-access-control'));
        expect(screen.queryByTestId('policy-drawer')).toBeNull();
    });

    it('opens the drawer straight onto the focused slug', async () => {
        render(<PoliciesPage {...pageProps({ focusId: 'information-security-policy' })} />);
        await waitFor(() => expect(screen.getByTestId('policy-drawer-slug').textContent).toBe('information-security-policy'));
    });

    it('isReviewOverdue only fires on a past date', () => {
        expect(isReviewOverdue({ review_due_at: '2020-01-01' })).toBe(true);
        expect(isReviewOverdue({ review_due_at: '2099-01-01' })).toBe(false);
        expect(isReviewOverdue({})).toBe(false);
        expect(isReviewOverdue({ review_due_at: 'nonsense' })).toBe(false);
    });
});

describe('PoliciesPage — phone (artboard 1h)', () => {
    it('a card shows the status pill, the acknowledgements, the owner and the warning, with no padding of its own', () => {
        render(<PoliciesPage {...pageProps({ isMobile: true })} />);
        const published = screen.getByTestId('policies-card-information-security-policy');
        expect(published.textContent).toMatch(/Published · v3/);
        expect(published.textContent).toMatch(/1 \/ 2/);
        expect(published.textContent).toMatch(/T\. Smit/);
        expect(published.className).not.toMatch(/\bpx-/);
        const draft = screen.getByTestId('policies-card-access-control');
        expect(draft.textContent).toMatch(/Draft/);
        expect(within(draft).getByTestId('policies-untouched-access-control')).toBeTruthy();
    });

    it('the drawer is a right-side modal; desktop keeps the inline card', () => {
        const { unmount } = render(<PoliciesPage {...pageProps({ isMobile: true })} />);
        fireEvent.click(screen.getByTestId('policies-card-information-security-policy'));
        expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();
        expect(screen.getByTestId('policy-drawer').dataset.mode).toBe('modal');
        unmount();
        render(<PoliciesPage {...pageProps()} />);
        fireEvent.click(screen.getByTestId('policies-row-information-security-policy'));
        expect(document.body.querySelector('[role="dialog"]')).toBeNull();
        expect(screen.getByTestId('policy-drawer').dataset.mode).toBe('inline');
    });
});
