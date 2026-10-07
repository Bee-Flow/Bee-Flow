import fs from 'node:fs';
import path from 'node:path';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import FrameworkPage from './FrameworkPage';
import { sectionById } from '../sections';

// The transport seam (data/api.js fetchJson → utils/helpers authFetch). The rest of
// helpers stays real: useTranslation imports API_BASE from the same module.
const authFetch = vi.fn();
vi.mock('../../../../utils/helpers', async (importOriginal) => {
    const actual = await importOriginal();
    return { ...actual, authFetch: (...a) => authFetch(...a) };
});

const ok = (body) => Promise.resolve({ ok: true, status: 200, statusText: 'OK', json: () => Promise.resolve(body) });
const fail = () => Promise.resolve({ ok: false, status: 500, statusText: 'Server Error', json: () => Promise.resolve({}) });

const CHECKS = [
    { check_id: 'GDPR-Art32-enc', regulation: 'GDPR', article: '32', status: 'pass', severity: 'critical', verification: 'automated', titleKey: 'compliance.status_pass' },
    { check_id: 'GDPR-Art33-breach', regulation: 'GDPR', article: '33', status: 'fail', severity: 'high', verification: 'automated', titleKey: 'compliance.trail_history',
        remediationLink: 'admin/compliance/incidents', frameworks: [{ regulation: 'GDPR', ref: '33' }, { regulation: 'ISO27001', ref: 'A.5.24' }] },
    { check_id: 'GDPR-Art30-ropa', regulation: 'GDPR', article: '30', status: 'warn', severity: 'medium', verification: 'attestation', titleKey: 'compliance.trail_evidence', remediationLink: 'admin/compliance/ropa' },
    { check_id: 'GDPR-Art28-dpa', regulation: 'GDPR', article: '28', status: 'not_applicable', severity: 'low', verification: 'hybrid', titleKey: 'compliance.status_na' },
    { check_id: 'AIA-Art50-marking', regulation: 'AIA', article: '50', status: 'fail', severity: 'critical', verification: 'automated', titleKey: 'compliance.status_fail' },
    { check_id: 'ISO27001-A.5.1-policies', regulation: 'ISO27001', article: 'A.5.1', status: 'pass', severity: 'medium', verification: 'attestation', titleKey: 'compliance.how_to_fix' },
];

function core(overrides = {}) {
    return {
        overview: { last_run_at: '2026-09-14T06:00:00Z' }, checks: CHECKS, scoreHistory: [], loading: false, running: false,
        rerunningId: null, autoFixingId: null, refresh: vi.fn(), runNow: vi.fn(), rerun: vi.fn(), autoFix: vi.fn(),
        loadTrail: vi.fn().mockResolvedValue({ history: [], evidence: [] }),
        ...overrides,
    };
}

function renderPage(props = {}) {
    const navigate = vi.fn();
    const utils = render(
        <FrameworkPage
            section={sectionById('gdpr')}
            tab="checks"
            onTab={vi.fn()}
            navigate={navigate}
            focusId={null}
            exportsEnabled
            dl={(u) => u}
            data={{ core: core(), calendar: undefined, frameworks: undefined }}
            isMobile={false}
            {...props}
        />,
    );
    return { ...utils, navigate };
}

const rowIds = () => screen.getAllByRole('row').filter((r) => r.dataset.testid?.startsWith('checks-table-row-') && !r.dataset.testid.includes('expansion') && !r.dataset.testid.includes('confirm'))
    .map((r) => r.dataset.testid.replace('checks-table-row-', ''));

beforeEach(() => { authFetch.mockReset(); });

describe('FrameworkPage — the checks tab', () => {
    it('shows only the regulation\'s checks (home OR tagged), sorted by status, with pill counts', () => {
        renderPage();
        expect(screen.getByTestId('framework-page')).toHaveAttribute('data-regulation', 'GDPR');
        expect(rowIds()).toEqual(['GDPR-Art33-breach', 'GDPR-Art30-ropa', 'GDPR-Art32-enc', 'GDPR-Art28-dpa']);
        const pills = screen.getByTestId('checks-table-toolbar-pill');
        expect(within(pills).getByTestId('checks-table-toolbar-pill-all')).toHaveTextContent('4');
        expect(within(pills).getByTestId('checks-table-toolbar-pill-fail')).toHaveTextContent('1');
        expect(within(pills).getByTestId('checks-table-toolbar-pill-warn')).toHaveTextContent('1');
        expect(within(pills).getByTestId('checks-table-toolbar-pill-pass')).toHaveTextContent('1');
        expect(within(pills).getByTestId('checks-table-toolbar-pill-not_applicable')).toHaveTextContent('1');
    });

    it('the ISO page lists the GDPR breach check through its frameworks[] tag, with the "also counts for" line pointing back at GDPR', () => {
        renderPage({ section: sectionById('iso') });
        expect(rowIds()).toEqual(['GDPR-Art33-breach', 'ISO27001-A.5.1-policies']); // fail before pass
        expect(screen.getByTestId('checks-table-row-GDPR-Art33-breach-also-ref')).toHaveTextContent('GDPR Art. 33');
        expect(screen.getByTestId('checks-table-row-GDPR-Art33-breach-article')).toHaveTextContent('A.5.24');
    });

    it('pills filter, the segmented control re-sorts by article, and the search narrows by title', () => {
        renderPage();
        fireEvent.click(screen.getByTestId('checks-table-toolbar-pill-fail'));
        expect(rowIds()).toEqual(['GDPR-Art33-breach']);
        fireEvent.click(screen.getByTestId('checks-table-toolbar-pill-all'));
        fireEvent.click(screen.getByRole('radio', { name: 'By article' }));
        expect(rowIds()).toEqual(['GDPR-Art28-dpa', 'GDPR-Art30-ropa', 'GDPR-Art32-enc', 'GDPR-Art33-breach']);
        fireEvent.change(screen.getByTestId('checks-table-toolbar-search'), { target: { value: 'run history' } });
        expect(rowIds()).toEqual(['GDPR-Art33-breach']);
        fireEvent.change(screen.getByTestId('checks-table-toolbar-search'), { target: { value: 'zzz-nothing' } });
        expect(screen.getByTestId('checks-table-no-match')).toBeInTheDocument();
    });

    it('severity tags appear on open rows only', () => {
        renderPage();
        expect(screen.getByTestId('checks-table-row-GDPR-Art33-breach-severity')).toBeInTheDocument();
        expect(screen.getByTestId('checks-table-row-GDPR-Art30-ropa-severity')).toBeInTheDocument();
        expect(screen.queryByTestId('checks-table-row-GDPR-Art32-enc-severity')).toBeNull();
        expect(screen.queryByTestId('checks-table-row-GDPR-Art28-dpa-severity')).toBeNull();
    });

    it('a row click opens the expansion, which loads the trail lazily — exactly once — and closes again', async () => {
        const c = core();
        renderPage({ data: { core: c } });
        expect(c.loadTrail).not.toHaveBeenCalled();
        fireEvent.click(screen.getByTestId('checks-table-row-GDPR-Art33-breach'));
        expect(screen.getByTestId('checks-table-row-GDPR-Art33-breach')).toHaveAttribute('aria-expanded', 'true');
        expect(screen.getByTestId('checks-table-row-GDPR-Art33-breach-expansion')).toBeInTheDocument();
        await waitFor(() => expect(c.loadTrail).toHaveBeenCalledTimes(1));
        expect(c.loadTrail).toHaveBeenCalledWith('GDPR-Art33-breach', null);
        fireEvent.click(screen.getByTestId('checks-table-row-GDPR-Art33-breach'));
        expect(screen.queryByTestId('checks-table-row-GDPR-Art33-breach-expansion')).toBeNull();
        expect(screen.getByTestId('checks-table-row-GDPR-Art33-breach')).toHaveAttribute('aria-expanded', 'false');
    });

    it('focusId opens that row from the start and scrolls it into view once', async () => {
        const scroll = vi.fn();
        Element.prototype.scrollIntoView = scroll;
        renderPage({ focusId: 'GDPR-Art30-ropa' });
        expect(screen.getByTestId('checks-table-row-GDPR-Art30-ropa')).toHaveAttribute('aria-expanded', 'true');
        expect(screen.getByTestId('checks-table-row-GDPR-Art30-ropa-expansion')).toBeInTheDocument();
        expect(screen.getByTestId('checks-table-row-GDPR-Art33-breach')).toHaveAttribute('aria-expanded', 'false');
        await waitFor(() => expect(scroll).toHaveBeenCalledTimes(1));
    });

    it('fix buttons route through navigate(sectionId); admin escapes need onNavigate and are hidden without it', () => {
        const { navigate, unmount } = renderPage();
        fireEvent.click(screen.getByTestId('checks-table-row-GDPR-Art30-ropa-fix'));
        expect(navigate).toHaveBeenCalledWith('ropa', undefined);
        unmount();
        const checks = [{ ...CHECKS[1], remediationLink: 'admin/monitoring/activity' }];
        renderPage({ data: { core: core({ checks }) } });
        expect(screen.queryByTestId('checks-table-row-GDPR-Art33-breach-fix')).toBeNull();
        const onNavigate = vi.fn();
        renderPage({ data: { core: core({ checks }) }, onNavigate });
        fireEvent.click(screen.getByTestId('checks-table-row-GDPR-Art33-breach-fix'));
        expect(onNavigate).toHaveBeenCalledWith('admin/monitoring/activity');
    });

    it('rerun from a passing row\'s expansion calls core.rerun; a failed checks read is its own state, not an empty list', async () => {
        const { default: userEvent } = await import('@testing-library/user-event');
        const user = userEvent.setup();
        const c = core();
        const { unmount } = renderPage({ data: { core: c } });
        await user.click(screen.getByTestId('checks-table-row-GDPR-Art32-enc'));
        await user.click(within(screen.getByTestId('checks-table-row-GDPR-Art32-enc-expansion')).getByRole('button', { name: 'Re-run this check' }));
        expect(c.rerun).toHaveBeenCalledWith('GDPR-Art32-enc');
        unmount();
        renderPage({ data: { core: core({ checks: null, loading: false }) } });
        expect(screen.getByTestId('checks-table-failed')).toBeInTheDocument();
        expect(screen.queryByText(/No checks have run yet/)).toBeNull();
    });

    it('loading with no rows renders the skeleton and no pill counts; a register section renders nothing', () => {
        const { unmount } = renderPage({ data: { core: core({ checks: [], loading: true }) } });
        expect(screen.getAllByTestId('table-skeleton-row').length).toBeGreaterThan(0);
        expect(screen.getByTestId('checks-table-toolbar-pill-all').textContent).toBe('All');
        unmount();
        const { container } = renderPage({ section: sectionById('dsr') });
        expect(container).toBeEmptyDOMElement();
    });
});

describe('FrameworkPage — timeline and evidence tabs', () => {
    it('timeline: phases from data.calendar filtered to the framework, plus the framework\'s calendar; loading and failed lines', () => {
        const calendar = {
            milestones: [
                { id: 'aia_gpai', date: '2025-08-02', framework_id: 'aia', kind: 'phase', label: 'GPAI obligations' },
                { id: 'aia_annex_iii', date: '2027-12-02', framework_id: 'aia', kind: 'phase', label: 'Annex III' },
                { id: 'gdpr_in_force', date: '2018-05-25', framework_id: 'gdpr', kind: 'in_force', label: 'GDPR applies' },
            ],
        };
        const { unmount } = renderPage({ section: sectionById('aia'), tab: 'timeline', data: { core: core(), calendar, frameworks: undefined } });
        const phases = screen.getAllByTestId('timeline-tab-phases-phase');
        expect(phases).toHaveLength(2);
        expect(phases.map((p) => p.dataset.state)).toEqual(['done', 'future']);
        expect(screen.getByTestId('timeline-tab-calendar')).toBeInTheDocument();
        expect(screen.getAllByTestId('cal-row')).toHaveLength(2);
        expect(screen.queryByText('GDPR applies')).toBeNull();
        unmount();
        renderPage({ tab: 'timeline', data: { core: core(), calendar: undefined } });
        expect(screen.getByTestId('timeline-tab-loading')).toBeInTheDocument();
        renderPage({ tab: 'timeline', data: { core: core(), calendar: null } });
        expect(screen.getByTestId('timeline-tab-failed')).toBeInTheDocument();
    });

    it('timeline (AI Act): the passed Art. 50 phase is "missed" while a disclosure check fails, done once it passes', () => {
        const calendar = {
            milestones: [
                { id: 'aia_art4_art5', date: '2025-02-02', framework_id: 'aia', kind: 'phase', label: 'Literacy · prohibitions' },
                { id: 'aia_art50_enforcement', date: '2026-08-02', framework_id: 'aia', kind: 'phase', label: 'Art. 50 transparency' },
                { id: 'aia_annex_iii', date: '2027-12-02', framework_id: 'aia', kind: 'phase', label: 'Annex III' },
            ],
        };
        // CHECKS carries a failing AIA Art. 50 check.
        const { unmount } = renderPage({ section: sectionById('aia'), tab: 'timeline', data: { core: core(), calendar } });
        expect(screen.getAllByTestId('timeline-tab-phases-phase').map((p) => p.dataset.state)).toEqual(['done', 'missed', 'future']);
        unmount();
        const passing = CHECKS.map((c) => (c.regulation === 'AIA' ? { ...c, status: 'pass' } : c));
        renderPage({ section: sectionById('aia'), tab: 'timeline', data: { core: core({ checks: passing }), calendar } });
        expect(screen.getAllByTestId('timeline-tab-phases-phase').map((p) => p.dataset.state)).toEqual(['done', 'done', 'future']);
    });

    it('timeline: the track takes the catalogue\'s short phase label; the calendar list keeps the full one', () => {
        const calendar = {
            milestones: [
                { id: 'aia_gpai', date: '2025-08-02', framework_id: 'aia', kind: 'phase', label: 'AI Act GPAI rules', detail: 'obligations for providers of general-purpose AI models' },
                { id: 'aia_gpai_legacy_models', date: '2027-08-02', framework_id: 'aia', kind: 'transition_end', label: 'AI Act GPAI: models placed on the market before Aug 2025' },
            ],
        };
        const frameworks = { active: [{ id: 'aia', phases: [{ date: '2025-08-02', label: 'GPAI rules' }] }] };
        renderPage({ section: sectionById('aia'), tab: 'timeline', data: { core: core(), calendar, frameworks } });
        const labels = screen.getAllByTestId('timeline-tab-phases-label');
        expect(labels[0].querySelector('b').textContent).toBe('GPAI rules');
        expect(labels[0].getAttribute('title')).toBe('GPAI rules — obligations for providers of general-purpose AI models');
        // no catalogue phase on that date: the milestone's own label
        expect(labels[1].querySelector('b').textContent).toBe('AI Act GPAI: models placed on the market before Aug 2025');
        expect(screen.getByTestId('timeline-tab-calendar')).toHaveTextContent('AI Act GPAI rules');
    });

    it('evidence: fetches GET /evidence?regulation=&limit=&offset= through authFetch, renders rows + pager, pages on Next', async () => {
        authFetch.mockImplementation((url) => {
            const u = new URL(url, 'http://x');
            const offset = Number(u.searchParams.get('offset'));
            return ok({ rows: [{ id: 100 + offset, check_id: 'GDPR-Art33-breach', captured_at: '2026-09-14T07:00:00Z', hash: 'abcdef0123456789', seq: 412 - offset }], total: 60 });
        });
        renderPage({ tab: 'evidence' });
        await waitFor(() => expect(screen.getByTestId('evidence-tab')).toHaveAttribute('data-state', 'ready'));
        const url = new URL(authFetch.mock.calls[0][0], 'http://x');
        expect(url.pathname).toBe('/api/compliance/evidence');
        expect(url.searchParams.get('regulation')).toBe('GDPR');
        expect(url.searchParams.get('limit')).toBe('25');
        expect(url.searchParams.get('offset')).toBe('0');
        expect(screen.getByTestId('evidence-tab-row-100')).toHaveTextContent('abcdef012345');
        expect(screen.getByTestId('evidence-tab-row-100')).toHaveTextContent('412');
        expect(screen.getByTestId('evidence-tab-row-100')).toHaveTextContent('Run history'); // title from the checks list
        expect(screen.getByTestId('evidence-tab-pager-range')).toHaveTextContent('1–25 of 60');
        fireEvent.click(screen.getByTestId('evidence-tab-pager-next'));
        await waitFor(() => expect(screen.getByTestId('evidence-tab-row-125')).toBeInTheDocument());
        expect(new URL(authFetch.mock.calls[1][0], 'http://x').searchParams.get('offset')).toBe('25');
    });

    it('evidence: a per-subject ledger row names its subject under the title; the check id is the title\'s tooltip', async () => {
        const dpia = (scope_id, name) => ({
            check_id: 'GDPR-Art35-dpia', regulation: 'GDPR', article: '35', status: 'pass', severity: 'high', verification: 'attestation',
            titleKey: 'compliance.trail_history', scope_id, evidence: { agent_id: scope_id, subject_label: name },
        });
        authFetch.mockImplementation(() => ok([
            { id: 7, seq: 7, check_id: 'GDPR-Art35-dpia', subject_type: 'per-source', subject_id: 'agent_intake', hash: 'abcdef0123456789' },
            { id: 8, seq: 8, check_id: 'GDPR-Art35-dpia', subject_type: 'per-source', subject_id: 'agent_gone', hash: 'abcdef0123456789' },
        ]));
        renderPage({ tab: 'evidence', data: { core: core({ checks: [dpia('agent_claims', 'Schadebeoordeling'), dpia('agent_intake', 'Polisintake')] }) } });
        await waitFor(() => expect(screen.getByTestId('evidence-tab-row-7')).toBeInTheDocument());
        const row = screen.getByTestId('evidence-tab-row-7');
        expect(within(row).getByTestId('evidence-tab-subject-label')).toHaveTextContent('Polisintake');
        expect(within(row).getByText('Run history')).toHaveAttribute('title', 'GDPR-Art35-dpia');
        expect(within(screen.getByTestId('evidence-tab-row-8')).queryByTestId('evidence-tab-subject-label')).toBeNull();
    });

    it('evidence: a failed read or a non-list body is the "could not read" state; an array body has no pager; exports off hides the JSON links', async () => {
        authFetch.mockImplementation(fail);
        const { unmount } = renderPage({ tab: 'evidence' });
        await waitFor(() => expect(screen.getByTestId('evidence-tab-failed')).toBeInTheDocument());
        unmount();
        authFetch.mockImplementation(() => ok({ nonsense: true }));
        const r2 = renderPage({ tab: 'evidence' });
        await waitFor(() => expect(screen.getByTestId('evidence-tab-failed')).toBeInTheDocument());
        r2.unmount();
        authFetch.mockImplementation(() => ok([{ id: 1, check_id: 'GDPR-Art32-enc', hash: 'ff00ff00ff00ff00', seq: 1 }]));
        renderPage({ tab: 'evidence', exportsEnabled: false });
        await waitFor(() => expect(screen.getByTestId('evidence-tab-row-1')).toBeInTheDocument());
        expect(screen.queryByTestId('evidence-tab-pager-range')).toBeNull();
        expect(screen.queryByRole('link')).toBeNull();
    });
});

describe('FrameworkPage — the AI Act systems tab (per-agent classification)', () => {
    const ROWS = [
        { target_kind: 'automation', target_id: 'a1', title: 'Intake bot', outcome: 'transparency', attested_at: '2026-06-01T00:00:00Z', expires_at: '2027-06-01T00:00:00Z', current: true },
        { target_kind: 'agent', target_id: 'g1', title: null, outcome: 'not_applicable', attested_at: '2025-01-01T00:00:00Z', expires_at: '2026-01-01T00:00:00Z', current: false },
    ];

    it('the AI Act has a systems tab; other frameworks do not', () => {
        expect(sectionById('aia').tabs).toContain('systems');
        expect(sectionById('gdpr').tabs).not.toContain('systems');
        renderPage({ section: sectionById('gdpr'), tab: 'systems' });
        // a tab the section does not have falls back to its checks
        expect(screen.getByTestId('framework-page').dataset.tab).toBe('checks');
    });

    it('lists GET /ai-act/assessments with the Attested column, and the row action calls onOpenLadder(kind, id, title)', async () => {
        const { default: userEvent } = await import('@testing-library/user-event');
        const user = userEvent.setup();
        authFetch.mockImplementation(() => ok(ROWS));
        const onOpenLadder = vi.fn();
        renderPage({ section: sectionById('aia'), tab: 'systems', onOpenLadder });
        expect(screen.getByTestId('framework-page').dataset.tab).toBe('systems');
        await waitFor(() => expect(screen.getAllByTestId('fw-per-automation-row')).toHaveLength(2));
        expect(authFetch.mock.calls[0][0]).toMatch(/\/ai-act\/assessments$/);
        expect(screen.getByRole('columnheader', { name: 'Attested' })).toBeInTheDocument();
        const pills = screen.getAllByTestId('fw-per-automation-outcome');
        expect(pills[0].textContent).toBe('Art. 4 + Art. 50');
        expect(pills[0].dataset.tone).toBe('warning');
        const buttons = screen.getAllByTestId('fw-per-automation-open');
        expect(buttons[1].textContent).toBe('Reassess');
        await user.click(buttons[0]);
        expect(onOpenLadder).toHaveBeenCalledWith('automation', 'a1', 'Intake bot');
    });

    it('on a phone: the card list, same outcome pill and a 44px ladder action', async () => {
        const { default: userEvent } = await import('@testing-library/user-event');
        const user = userEvent.setup();
        authFetch.mockImplementation(() => ok([ROWS[0]]));
        const onOpenLadder = vi.fn();
        renderPage({ section: sectionById('aia'), tab: 'systems', onOpenLadder, isMobile: true });
        await waitFor(() => expect(screen.getAllByTestId('fw-per-automation-card')).toHaveLength(1));
        expect(screen.getByTestId('fw-per-automation-table').dataset.view).toBe('cards');
        expect(screen.queryAllByTestId('fw-per-automation-row')).toHaveLength(0);
        expect(screen.getByTestId('fw-per-automation-card').textContent).toMatch(/Intake bot/);
        const open = screen.getByTestId('fw-per-automation-open');
        expect(open.className).toMatch(/min-h-\[44px\]/);
        await user.click(open);
        expect(onOpenLadder).toHaveBeenCalledWith('automation', 'a1', 'Intake bot');
    });

    it('a 404 (endpoint not shipped) is a failed state, not an empty table', async () => {
        authFetch.mockImplementation(() => Promise.resolve({ ok: false, status: 404, statusText: 'Not Found', json: () => Promise.resolve({}) }));
        renderPage({ section: sectionById('aia'), tab: 'systems' });
        await waitFor(() => expect(screen.getByTestId('fw-per-automation-failed')).toBeInTheDocument());
    });
});

describe('FrameworkPage — phone (artboard 1h)', () => {
    it('checks and the evidence ledger both take the card path', async () => {
        authFetch.mockImplementation(() => ok({ rows: [{ id: 100, check_id: 'GDPR-Art33-breach', captured_at: '2026-09-14T07:00:00Z', hash: 'abcdef0123456789', seq: 412 }], total: 1 }));
        const { unmount } = renderPage({ isMobile: true });
        expect(screen.getByTestId('checks-table-table').dataset.view).toBe('cards');
        expect(screen.getByTestId('checks-table-card-GDPR-Art33-breach')).toBeInTheDocument();
        unmount();
        renderPage({ tab: 'evidence', isMobile: true });
        await waitFor(() => expect(screen.getByTestId('evidence-tab-card-100')).toBeInTheDocument());
        expect(screen.getByTestId('evidence-tab-table').dataset.view).toBe('cards');
        expect(screen.queryByTestId('evidence-tab-row-100')).toBeNull();
        const card = screen.getByTestId('evidence-tab-card-100');
        expect(card).toHaveTextContent('abcdef012345');
        expect(card).toHaveTextContent('412');
        expect(card).toHaveTextContent('Run history');
    });
});

describe('FrameworkPage — hygiene', () => {
    it('no hex colours, --status-* tokens or purple words in the page tree', () => {
        const dir = path.resolve(__dirname);
        const files = ['FrameworkPage.jsx', ...fs.readdirSync(path.join(dir, 'framework')).filter((f) => /\.jsx?$/.test(f) && !f.includes('.test.')).map((f) => path.join('framework', f))];
        for (const f of files) {
            const src = fs.readFileSync(path.join(dir, f), 'utf8');
            expect(src, f).not.toMatch(/#[0-9a-f]{3,8}\b/i);
            expect(src, f).not.toMatch(/--status-/);
            expect(src, f).not.toMatch(/indigo|violet|purple/i);
        }
    });
});
