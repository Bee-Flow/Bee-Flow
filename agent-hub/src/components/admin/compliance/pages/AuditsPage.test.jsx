import { render, screen, cleanup, within, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { editPatch, mrInputLabel, mrInputValue, notRaisedCount } from './audits/isoProcessHelpers';
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

const USERS = [{ id: 'u1', displayName: 'T. Smit', email: 't@example.com' }, { id: 'u2', displayName: 'R. Bakker', email: 'r@example.com' }];
const t = (key, fallback) => fallback;

function auditState(over = {}) {
    return {
        audits: [{ id: 1, title: 'Annual internal audit', status: 'planned', planned_at: '2026-10-01', auditor_user_id: 'u1' }],
        findings: [],
        reviews: [{ id: 7, held_at: '2026-06-01', attendees: ['u1'], decisions: 'Continue' }],
        ncs: [{ id: 3, title: 'Backups untested', status: 'open', severity: 'major', source: 'internal_audit', due_at: '2026-12-01' }],
        objectives: [{ id: 5, title: 'Reduce incident MTTR', status: 'active', measure: 'hours', target: '4', owner_user_id: 'u1' }],
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

/** The create action the tab handed to the header, as the header would click it. */
function clickHeaderPrimary(setHeaderActions) {
    const calls = setHeaderActions.mock.calls.filter(([a]) => a && a.primaryAction);
    const { primaryAction } = calls[calls.length - 1][0];
    act(() => primaryAction.onClick());
    return primaryAction;
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

describe('AuditsPage — the create action sits in the header', () => {
    it.each([
        ['audits', 'Plan audit', 'audit-plan', 'audit-create-drawer'],
        ['reviews', 'Record review', 'review-record', 'review-create-drawer'],
        ['ncs', 'Record nonconformity', 'nc-record', 'nc-create-drawer'],
        ['objectives', 'Add objective', 'objective-add', 'objective-create-drawer'],
    ])('%s hands "%s" to the header and keeps only its intro', (tab, label, toolbarId, drawerId) => {
        const setHeaderActions = vi.fn();
        render(<AuditsPage {...pageProps({ tab, setHeaderActions })} />);
        expect(screen.queryByTestId(toolbarId)).toBeNull();
        const action = clickHeaderPrimary(setHeaderActions);
        expect(action.label).toBe(label);
        expect(screen.getByTestId(drawerId)).toBeTruthy();
    });

    it('takes the action back when the tab goes', () => {
        const setHeaderActions = vi.fn();
        const { unmount } = render(<AuditsPage {...pageProps({ tab: 'ncs', setHeaderActions })} />);
        unmount();
        expect(setHeaderActions).toHaveBeenLastCalledWith({});
    });

    it('a host without a header keeps the button in the toolbar', () => {
        render(<AuditsPage {...pageProps({ setHeaderActions: undefined })} />);
        expect(screen.getByTestId('audit-plan')).toBeTruthy();
    });
});

describe('AuditsPage — nonconformities', () => {
    const NC_CA = { id: 4, title: 'Supplier without DPA', status: 'corrective_action', severity: 'minor', source: 'manual', due_at: '2026-12-01', corrective_action: '' };

    it('the step sends the typed corrective action with the status, in one write', async () => {
        const user = userEvent.setup();
        const updateNc = vi.fn();
        render(<AuditsPage {...pageProps({ tab: 'ncs', audit: { ncs: [NC_CA], updateNc } })} />);
        await user.click(screen.getByTestId('nc-row-4'));
        await user.type(screen.getByTestId('nc-f-corrective'), 'Sign the DPA and gate new suppliers');
        await user.click(screen.getByTestId('nc-to-er'));
        expect(updateNc).toHaveBeenCalledTimes(1);
        expect(updateNc).toHaveBeenCalledWith(4, expect.objectContaining({
            corrective_action: 'Sign the DPA and gate new suppliers',
            status: 'effectiveness_review',
            due_at: '2026-12-01',
        }));
    });

    it('"Move to effectiveness review" waits for a corrective action, and says so', async () => {
        const user = userEvent.setup();
        render(<AuditsPage {...pageProps({ tab: 'ncs', audit: { ncs: [NC_CA] } })} />);
        await user.click(screen.getByTestId('nc-row-4'));
        const step = screen.getByTestId('nc-to-er');
        expect(step.disabled).toBe(true);
        const hint = screen.getByTestId('nc-needs-ca');
        expect(hint.textContent).toBe('Describe the corrective action first');
        expect(step.getAttribute('aria-describedby')).toBe(hint.id);
        await user.type(screen.getByTestId('nc-f-corrective'), 'x');
        expect(screen.getByTestId('nc-to-er').disabled).toBe(false);
        expect(screen.queryByTestId('nc-needs-ca')).toBeNull();
    });

    it('closing confirms effectiveness and also waits for a corrective action', async () => {
        const user = userEvent.setup();
        const updateNc = vi.fn();
        const ncs = [{ ...NC_CA, status: 'effectiveness_review', corrective_action: 'Done' }, { ...NC_CA, id: 9, status: 'effectiveness_review' }];
        render(<AuditsPage {...pageProps({ tab: 'ncs', audit: { ncs, updateNc } })} />);
        await user.click(screen.getByTestId('nc-row-9'));
        expect(screen.getByTestId('nc-confirm-close').disabled).toBe(true);
        await user.click(screen.getByTestId('nc-row-4'));
        await user.click(screen.getByTestId('nc-confirm-close'));
        expect(updateNc).toHaveBeenCalledWith(4, expect.objectContaining({ status: 'closed', confirm_effectiveness: true, corrective_action: 'Done' }));
    });

    it('Save sits in the drawer footer beside the step', async () => {
        const user = userEvent.setup();
        const updateNc = vi.fn();
        render(<AuditsPage {...pageProps({ tab: 'ncs', audit: { updateNc } })} />);
        await user.click(screen.getByTestId('nc-row-3'));
        const footer = screen.getByTestId('nc-footer');
        expect(within(footer).getByTestId('nc-save')).toBeTruthy();
        expect(within(footer).getByTestId('nc-start-ca')).toBeTruthy();
        await user.click(within(footer).getByTestId('nc-save'));
        expect(updateNc).toHaveBeenCalledWith(3, expect.not.objectContaining({ status: expect.anything() }));
    });

    it('editPatch leaves an emptied field out, as Save always did', () => {
        expect(editPatch({ corrective_action: '  ', due_at: '', effectiveness_review_due_at: '2027-01-01', owner_user_id: '' }))
            .toEqual({ corrective_action: undefined, due_at: undefined, effectiveness_review_due_at: '2027-01-01', owner_user_id: undefined });
        expect(editPatch(null)).toEqual({});
    });
});

describe('AuditsPage — internal audits', () => {
    const IN_PROGRESS = { id: 2, title: 'H1 audit', status: 'in_progress', planned_at: '2026-09-01', auditor_user_id: 'u1' };
    const FINDINGS = [
        { id: 'f1', audit_id: 2, severity: 'minor', description: 'Access review missing', nonconformity_id: null },
        { id: 'f2', audit_id: 2, severity: 'observation', description: 'Minutes thin', nonconformity_id: null },
        { id: 'f3', audit_id: 2, severity: 'major', description: 'No DPA', nonconformity_id: 'nc_1' },
    ];

    it('no row carries a state button; the steps live in the drawer', () => {
        render(<AuditsPage {...pageProps({ audit: { audits: [IN_PROGRESS, { id: 1, title: 'Planned one', status: 'planned' }], findings: FINDINGS } })} />);
        expect(within(screen.getByTestId('audit-row-2')).queryByText('Close audit')).toBeNull();
        expect(screen.queryByTestId('audit-close-2')).toBeNull();
        expect(screen.queryByTestId('audit-start-1')).toBeNull();
    });

    it('closing asks first, counting the findings never raised as a nonconformity', async () => {
        const user = userEvent.setup();
        const updateAudit = vi.fn();
        render(<AuditsPage {...pageProps({ audit: { audits: [IN_PROGRESS], findings: FINDINGS, updateAudit } })} />);
        await user.click(screen.getByTestId('audit-row-2'));
        await user.click(screen.getByTestId('audit-close-2'));
        expect(updateAudit).not.toHaveBeenCalled();
        expect(screen.getByTestId('audit-close-confirm').textContent).toContain('Close audit? 3 findings, 1 not raised as NC.');

        await user.click(screen.getByTestId('audit-close-cancel'));
        expect(screen.queryByTestId('audit-close-confirm')).toBeNull();
        expect(updateAudit).not.toHaveBeenCalled();

        await user.click(screen.getByTestId('audit-close-2'));
        await user.click(screen.getByTestId('audit-close-confirm-yes'));
        expect(updateAudit).toHaveBeenCalledWith(2, { status: 'closed' });
    });

    it('a planned audit starts from the drawer footer', async () => {
        const user = userEvent.setup();
        const updateAudit = vi.fn();
        render(<AuditsPage {...pageProps({ audit: { updateAudit } })} />);
        await user.click(screen.getByTestId('audit-row-1'));
        await user.click(screen.getByTestId('audit-start-1'));
        expect(updateAudit).toHaveBeenCalledWith(1, { status: 'in_progress' });
    });

    it('the auditor and planned date ride under the title for when their columns fold', () => {
        render(<AuditsPage {...pageProps()} />);
        expect(screen.getByTestId('audit-folded-1').textContent).toMatch(/^T\. Smit · planned /);
    });

    it('notRaisedCount counts only weighty findings without a nonconformity', () => {
        expect(notRaisedCount(FINDINGS)).toBe(1);
        expect(notRaisedCount(null)).toBe(0);
    });
});

describe('AuditsPage — objectives', () => {
    it('has no button column; a row opens the drawer with measure, target and owner', async () => {
        const user = userEvent.setup();
        const updateObjective = vi.fn();
        render(<AuditsPage {...pageProps({ tab: 'objectives', audit: { updateObjective } })} />);
        const row = screen.getByTestId('objective-row-5');
        expect(within(row).queryByRole('button')).toBeNull();
        expect(screen.getByTestId('objective-measure-5').textContent).toContain('hours → 4');
        await user.click(row);
        expect(screen.getByTestId('objective-drawer-target').textContent).toContain('4');
        expect(screen.getByTestId('objective-drawer-owner').textContent).toContain('T. Smit');
        await user.click(screen.getByTestId('objective-drawer-achieve'));
        expect(updateObjective).toHaveBeenCalledWith(5, { status: 'achieved' });
    });
});

describe('AuditsPage — management reviews', () => {
    it('lists attendees by name, whether stored as ids or as { id, name }', () => {
        const reviews = [
            { id: 7, held_at: '2026-06-01', attendees: ['u1', 'u2'], decisions: 'Continue' },
            { id: 8, held_at: '2026-02-01', attendees: [{ id: 'u2' }, { id: 'u9', name: 'Former Member' }], decisions: '' },
        ];
        render(<AuditsPage {...pageProps({ tab: 'reviews', audit: { reviews } })} />);
        expect(screen.getByTestId('review-attendees-7').textContent).toBe('T. Smit, R. Bakker');
        expect(screen.getByTestId('review-attendees-8').textContent).toBe('R. Bakker, Former Member');
        expect(document.body.textContent).not.toMatch(/\bu1\b|\bu2\b/);
    });

    it('labels the inputs in words and writes a date as a date', () => {
        const mrInputs = { score_90d_ago: 54, soa_approved: '32/93', last_internal_audit: '2026-04-30T12:15:51.090Z', collected_at: '2026-10-01T09:00:00Z', some_new_key: 3 };
        render(<AuditsPage {...pageProps({ tab: 'reviews', audit: { mrInputs } })} />);
        const grid = screen.getByTestId('mr-inputs-grid');
        expect(grid.textContent).toContain('Score 90 days ago');
        expect(grid.textContent).toContain('SoA controls approved');
        expect(grid.textContent).toContain('Some new key');
        expect(screen.getByTestId('mr-inputs-grid-last_internal_audit').textContent).toMatch(/Last internal audit closed30 Apr/);
        expect(grid.textContent).not.toMatch(/T\d\d:\d\d/);
        expect(grid.textContent).not.toContain('score_90d_ago');
    });

    it('mrInputLabel and mrInputValue: known keys get words, _at keys a date, the rest stays as it is', () => {
        expect(mrInputLabel(t, 'score_now')).toBe('Compliance score now');
        expect(mrInputLabel(t, 'brand_new_metric')).toBe('Brand new metric');
        expect(mrInputValue('collected_at', '2026-03-02T10:00:00Z', 'en')).toMatch(/2 Mar/);
        expect(mrInputValue('risks_high', 2, 'en')).toBe('2');
        expect(mrInputValue('risks_high', null, 'en')).toBe('—');
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
        const setHeaderActions = vi.fn();
        render(<AuditsPage {...pageProps({ isMobile: true, setHeaderActions })} />);
        clickHeaderPrimary(setHeaderActions);
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
