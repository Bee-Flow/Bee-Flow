import React from 'react';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import AuditsPage, { AUDIT_TABS, resolveTab } from './AuditsPage';

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

const USERS = [{ id: 'u1', displayName: 'T. Smit', email: 't@example.com' }];

function auditState(over = {}) {
    return {
        audits: [{ id: 1, title: 'Annual internal audit', status: 'planned', planned_at: '2026-10-01', auditor_user_id: 'u1' }],
        findings: [],
        reviews: [{ id: 7, held_at: '2026-06-01', attendees: ['u1'], decisions: 'Continue' }],
        ncs: [{ id: 3, title: 'Backups untested', status: 'open', severity: 'major', source: 'internal_audit', due_at: '2026-12-01' }],
        objectives: [{ id: 5, title: 'Reduce incident MTTR', status: 'active', measure: 'hours', target: '4' }],
        mrInputs: null,
        busy: false,
        independenceWarning: null,
        refresh: vi.fn(),
        createAudit: vi.fn(), updateAudit: vi.fn(), addFinding: vi.fn(),
        createReview: vi.fn(), createNc: vi.fn(), updateNc: vi.fn(),
        createObjective: vi.fn(), updateObjective: vi.fn(),
        ...over,
    };
}

function pageProps(over = {}) {
    const { audit, ...rest } = over;
    return {
        section: { id: 'audits', tabs: AUDIT_TABS },
        tab: 'audits',
        onTab: vi.fn(),
        navigate: vi.fn(),
        focusId: null,
        exportsEnabled: true,
        dl: (u) => u,
        api: '/api/compliance',
        isMobile: false,
        setHeaderActions: vi.fn(),
        data: { audit: auditState(audit), orgUsers: USERS },
        ...rest,
    };
}

describe('AuditsPage', () => {
    it('declares the four tabs sections.js promises', () => {
        expect(AUDIT_TABS).toEqual(['audits', 'reviews', 'ncs', 'objectives']);
    });

    it('resolveTab falls back to the first tab for unknown/missing values', () => {
        expect(resolveTab('ncs')).toBe('ncs');
        expect(resolveTab('objectives')).toBe('objectives');
        expect(resolveTab('nonsense')).toBe('audits');
        expect(resolveTab(undefined)).toBe('audits');
        expect(resolveTab(null)).toBe('audits');
    });

    it('renders the audits register for tab=audits', () => {
        render(<AuditsPage {...pageProps()} />);
        expect(screen.getByTestId('audits-tab')).toBeTruthy();
        expect(screen.queryByTestId('reviews-tab')).toBeNull();
        expect(screen.getByTestId('audits-page').getAttribute('data-tab')).toBe('audits');
    });

    it('renders the reviews register for tab=reviews', () => {
        render(<AuditsPage {...pageProps({ tab: 'reviews' })} />);
        expect(screen.getByTestId('reviews-tab')).toBeTruthy();
        expect(screen.queryByTestId('audits-tab')).toBeNull();
    });

    it('renders the nonconformities register for tab=ncs', () => {
        render(<AuditsPage {...pageProps({ tab: 'ncs' })} />);
        expect(screen.getByTestId('ncs-tab')).toBeTruthy();
    });

    it('renders the objectives register for tab=objectives', () => {
        render(<AuditsPage {...pageProps({ tab: 'objectives' })} />);
        expect(screen.getByTestId('objectives-tab')).toBeTruthy();
    });

    it('falls back to the audits register for a stale ?tab value', () => {
        render(<AuditsPage {...pageProps({ tab: 'findings' })} />);
        expect(screen.getByTestId('audits-tab')).toBeTruthy();
        expect(screen.getByTestId('audits-page').getAttribute('data-tab')).toBe('audits');
    });

    it('survives a page props object without an audit hook (no crash, no rows invented)', () => {
        render(<AuditsPage {...pageProps({ data: { audit: undefined, orgUsers: null } })} />);
        expect(screen.getByTestId('audits-page')).toBeTruthy();
    });

    it('passes the roster and the focus id through to the active tab', () => {
        render(<AuditsPage {...pageProps({ tab: 'ncs', focusId: '3' })} />);
        expect(screen.getByTestId('ncs-tab')).toBeTruthy();
        // focusId reaches the tab: the row is listed AND its drawer is opened on it.
        expect(screen.getAllByText('Backups untested').length).toBeGreaterThan(1);
    });
});

describe('AuditsPage — phone (artboard 1h)', () => {
    it('every one of the four registers takes the card path', () => {
        const check = (tab, tableId, cardId, text) => {
            const { unmount } = render(<AuditsPage {...pageProps({ tab, isMobile: true })} />);
            expect(screen.getByTestId(tableId).dataset.view).toBe('cards');
            expect(screen.getByTestId(cardId).textContent).toMatch(text);
            unmount();
        };
        check('audits', 'audits-table', 'audit-card-1', /Annual internal audit/);
        check('reviews', 'reviews-table', 'review-card-7', /Continue/);
        check('ncs', 'ncs-table', 'nc-card-3', /Backups untested/);
        check('objectives', 'objectives-table', 'objective-card-5', /Reduce incident MTTR/);
    });

    it('the audit drawer is a right-side modal on a phone', () => {
        render(<AuditsPage {...pageProps({ isMobile: true })} />);
        fireEvent.click(screen.getByTestId('audit-plan'));
        expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();
        expect(screen.getByTestId('audit-create-drawer').dataset.mode).toBe('modal');
    });

    it('desktop still renders the grid rows', () => {
        render(<AuditsPage {...pageProps()} />);
        expect(screen.getByTestId('audits-table').dataset.view).toBe('table');
        expect(screen.getByTestId('audit-row-1')).toBeTruthy();
        expect(screen.queryByTestId('audit-card-1')).toBeNull();
    });
});
