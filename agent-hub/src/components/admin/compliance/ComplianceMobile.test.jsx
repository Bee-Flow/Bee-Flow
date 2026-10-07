import { render, screen, fireEvent, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import ComplianceMobile, { mobileSubtitle } from './ComplianceMobile';
import { attentionTarget } from './mobile/MobileHomeOverview';

/**
 * The phone frame (artboard 1h). Everything below is about the three things
 * the frame decides that the desktop hub does not:
 *
 *   1. the SEGMENTS are a view state at home, not a route — switching them
 *      must not navigate, and coming home from a section resets them;
 *   2. the BACK chevron means two different things (leave Settings at home,
 *      leave the section inside one) and must never mean both;
 *   3. every row is a THUMB TARGET (≥44px), because this frame exists to be
 *      used one-handed.
 *
 * Nothing here fetches: the hub owns the data and hands the same object every
 * page gets. So the fixtures below ARE the contract with fe-1.
 */
vi.mock('../../../hooks/useTranslation', () => {
    const t = (key, fallback, vars) => {
        let s = typeof fallback === 'string' ? fallback : key;
        for (const [k, v] of Object.entries((typeof fallback === 'object' ? fallback : vars) || {})) {
            s = s.replace(`{${k}}`, String(v));
        }
        return s;
    };
    return { useTranslation: () => ({ t }), default: () => ({ t }) };
});

const COUNTS = {
    attention_open: 3,
    last_run: { at: '2026-09-14T07:12:00Z' },
    frameworks: { gdpr: { score: 79 }, aia: { score: 58 }, iso27001: { score: 88 } },
};

const CHECKS = [
    { id: 'c1', code: 'GDPR-12', status: 'fail', regulation: 'GDPR' },
    { id: 'c2', code: 'GDPR-13', status: 'warn', regulation: 'GDPR' },
    { id: 'c3', code: 'GDPR-14', status: 'pass', regulation: 'GDPR' },
    { id: 'c4', code: 'AIA-2', status: 'fail', frameworks: [{ regulation: 'AI Act' }] },
];

const ATTENTION = [
    { id: 'a1', title: 'Verwerkersovereenkomst ontbreekt', status: 'fail', source: 'check', code: 'GDPR-12',
        meta: { frameworks: [{ regulation: 'GDPR', ref: 'Art. 28' }], severity: 'high' } },
    { id: 'a2', title: 'DPIA nog niet afgerond', status: 'warn', source: 'dpia',
        action: { target: 'admin/compliance/dpia/ag%2F9' }, meta: {} },
];

const DEADLINES = [
    { id: 'd1', ref: 'DSR-41', title: 'Inzageverzoek', kind: 'dsr', state: 'running',
        due_at: '2026-09-20T12:00:00Z', started_at: '2026-09-10T12:00:00Z', pct: 40,
        target: { section: 'dsr', id: 'req/41' } },
    { id: 'd2', ref: 'INC-7', title: 'Datalek', kind: 'incident', state: 'done', due_at: '2026-09-11T12:00:00Z' },
];

function makeData(over = {}) {
    return {
        core: { checks: CHECKS, running: false, runNow: vi.fn(), ...(over.core || {}) },
        counts: over.counts === undefined ? COUNTS : over.counts,
        attention: { items: ATTENTION, failed: false, ...(over.attention || {}) },
        deadlines: { items: DEADLINES, failed: false, ...(over.deadlines || {}) },
        frameworks: { isEnabled: () => false, ...(over.frameworks || {}) },
    };
}

function mount(props = {}) {
    const navigate = props.navigate || vi.fn();
    const onBack = props.onBack || vi.fn();
    const data = props.data || makeData();
    const view = render(
        <ComplianceMobile active="overview" navigate={navigate} onBack={onBack} data={data}
            tab="overview" onTab={vi.fn()} page={<div data-testid="page-node">page</div>} {...props} />,
    );
    return { ...view, navigate, onBack, data };
}

/** Every tappable row in the frame must clear the 44px thumb target. */
function expectThumbTargets(container) {
    const rows = [...container.querySelectorAll('[data-testid^="mobile-fw-"], [data-testid^="mobile-attention-a"], [data-testid^="mobile-deadline-d"], [data-testid^="mobile-row-"]')]
        .filter(el => el.tagName === 'BUTTON');
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
        expect(row.className, `${row.dataset.testid} is not a 44px target`).toContain('min-h-[44px]');
    }
}

/* ══ The segments ════════════════════════════════════════════════════════ */
describe('ComplianceMobile — the segmented control is a view, not a route', () => {
    it('opens on the overview and switches to the two list views without navigating', () => {
        const { container, navigate } = mount();
        expect(screen.getByTestId('compliance-mobile').dataset.view).toBe('overview');
        expect(screen.getByTestId('mobile-home-overview')).toBeInTheDocument();

        fireEvent.click(screen.getByText('Frameworks'));
        expect(screen.getByTestId('compliance-mobile').dataset.view).toBe('frameworks');
        expect(screen.queryByTestId('mobile-home-overview')).toBeNull();
        expect(screen.getByTestId('mobile-rail-list-frameworks')).toBeInTheDocument();

        fireEvent.click(screen.getByText('Registers'));
        expect(screen.getByTestId('compliance-mobile').dataset.view).toBe('registers');
        expect(screen.getByTestId('mobile-rail-list-registers')).toBeInTheDocument();
        expect(screen.queryByTestId('mobile-rail-list-frameworks')).toBeNull();

        fireEvent.click(screen.getByText('Overview'));
        expect(screen.getByTestId('mobile-home-overview')).toBeInTheDocument();

        // The whole point: none of that touched the address.
        expect(navigate).not.toHaveBeenCalled();
        expectThumbTargets(container);
    });

    it('a row in a list view IS a route, and it navigates to that section', () => {
        const { navigate } = mount();
        fireEvent.click(screen.getByText('Frameworks'));
        fireEvent.click(screen.getByTestId('mobile-row-gdpr'));
        expect(navigate).toHaveBeenCalledWith('gdpr');
    });

    it('resets to the overview segment when a section closes back to home', () => {
        const { rerender, navigate, onBack, data } = mount();
        fireEvent.click(screen.getByText('Registers'));
        expect(screen.getByTestId('compliance-mobile').dataset.view).toBe('registers');

        const props = { navigate, onBack, data, tab: 'overview', onTab: vi.fn(), page: <div data-testid="page-node">page</div> };
        rerender(<ComplianceMobile active="dsr" {...props} />);
        expect(screen.getByTestId('compliance-mobile').dataset.view).toBe('section');
        rerender(<ComplianceMobile active="overview" {...props} />);
        // Not 'registers' — a user who went into a section and came back is at
        // the start of the screen, not wherever they left a sub-tab.
        expect(screen.getByTestId('compliance-mobile').dataset.view).toBe('overview');
    });

    it('hides the segments inside a section and renders the hub page node there', () => {
        mount({ active: 'dsr' });
        expect(screen.queryByText('Frameworks')).toBeNull();
        expect(screen.getByTestId('mobile-section')).toBeInTheDocument();
        expect(screen.getByTestId('page-node')).toBeInTheDocument();
        // The page must sit in a @container so StudioSectionHeader's <1180
        // fold fires at phone width instead of a desktop toolbar overflowing.
        expect(screen.getByTestId('mobile-section').className).toContain('@container');
    });

    it('puts the section\'s actions on a second header row, so the primary is on screen', async () => {
        const onRecordIncident = vi.fn();
        mount({ active: 'incidents', headerCtx: { counts: { incidents: { open: 1, hours_left: 30, next_stage: 'authority' } }, onRecordIncident } });
        const header = screen.getByTestId('compliance-header');
        expect(header).toHaveAttribute('data-layout', 'phone');
        const row = within(header).getByTestId('compliance-header-actions');
        expect(within(row).getByTestId('header-pill')).toHaveTextContent('1 open · authority notice in 30 h');
        expect(within(row).getByTestId('header-info')).toBeInTheDocument();
        await userEvent.click(within(row).getByRole('button', { name: 'Record incident' }));
        expect(onRecordIncident).toHaveBeenCalled();
        // The title bar keeps the section's name.
        expect(within(screen.getByTestId('compliance-header-bar')).getByTestId('studio-section-title')).toHaveTextContent('Incidents & breaches');
    });
});

/* ══ The back chevron ════════════════════════════════════════════════════ */
describe('ComplianceMobile — the back chevron means one thing at a time', () => {
    it('leaves the hub at home and returns to the overview from inside a section', () => {
        const { rerender, navigate, onBack, data } = mount();
        fireEvent.click(screen.getByTestId('mobile-back'));
        expect(onBack).toHaveBeenCalledTimes(1);
        expect(navigate).not.toHaveBeenCalled();

        rerender(<ComplianceMobile active="dsr" navigate={navigate} onBack={onBack} data={data}
            tab="overview" onTab={vi.fn()} page={<div />} />);
        fireEvent.click(screen.getByTestId('mobile-back'));
        expect(navigate).toHaveBeenCalledWith('overview');
        expect(onBack).toHaveBeenCalledTimes(1);   // still one: it did NOT leave Settings
    });

    it('survives a host that passes no onBack at all', () => {
        render(<ComplianceMobile active="overview" navigate={vi.fn()} data={makeData()} tab="overview" onTab={vi.fn()} />);
        expect(() => fireEvent.click(screen.getByTestId('mobile-back'))).not.toThrow();
    });

    it('labels the chevron for what it does in each place', () => {
        const { rerender, navigate, onBack, data } = mount();
        expect(screen.getByTestId('mobile-back').getAttribute('aria-label')).toBe('Back to settings');
        rerender(<ComplianceMobile active="dsr" navigate={navigate} onBack={onBack} data={data}
            tab="overview" onTab={vi.fn()} page={<div />} />);
        expect(screen.getByTestId('mobile-back').getAttribute('aria-label')).toBe('Back to overview');
    });
});

/* ══ The top bar ═════════════════════════════════════════════════════════ */
describe('ComplianceMobile — the top bar', () => {
    it('runs the checks and goes quiet while a run is in flight', () => {
        const runNow = vi.fn();
        const { rerender, navigate, onBack } = mount({ data: makeData({ core: { runNow } }) });
        fireEvent.click(screen.getByTestId('mobile-run-now'));
        expect(runNow).toHaveBeenCalledTimes(1);

        rerender(<ComplianceMobile active="overview" navigate={navigate} onBack={onBack}
            data={makeData({ core: { runNow, running: true } })} tab="overview" onTab={vi.fn()} page={<div />} />);
        const btn = screen.getByTestId('mobile-run-now');
        expect(btn).toBeDisabled();
        fireEvent.click(btn);
        expect(runNow).toHaveBeenCalledTimes(1);
    });

    it('prints only the halves of the subtitle the counts endpoint actually stated', () => {
        const t = (key, fallback, vars) => {
            let s = fallback;
            for (const [k, v] of Object.entries(vars || {})) s = s.replace(`{${k}}`, String(v));
            return s;
        };
        const sameDay = { now: new Date('2026-09-14T07:42:00Z').getTime() };
        expect(mobileSubtitle(null, t)).toBeNull();
        expect(mobileSubtitle({}, t)).toBeNull();
        expect(mobileSubtitle({ attention_open: 3 }, t)).toBe('3 open');
        // A real 0 is a statement and prints; a missing key is not.
        expect(mobileSubtitle({ attention_open: 0 }, t)).toBe('0 open');
        expect(mobileSubtitle({ last_run: { at: '2026-09-14T07:12:00Z' } }, t, sameDay)).toMatch(/^run \d{2}:\d{2}$/);
        expect(mobileSubtitle(COUNTS, t, sameDay)).toMatch(/^run \d{2}:\d{2} · 3 open$/);
    });

    it('names the day of a run that was not today, never "today"', () => {
        const t = (key, fallback, vars) => {
            let s = fallback;
            for (const [k, v] of Object.entries(vars || {})) s = s.replace(`{${k}}`, String(v));
            return s;
        };
        // Local noon, so the calendar day is the same in every zone the suite runs in.
        const counts = { ...COUNTS, last_run: { at: new Date(2026, 8, 14, 12).toISOString() } };
        const later = { now: new Date(2026, 8, 16, 12).getTime() };
        expect(mobileSubtitle(counts, t, later)).toMatch(/^run 14 Sep \d{2}:\d{2} · 3 open$/);
        expect(mobileSubtitle(counts, t, later)).not.toMatch(/today/);
        // A run in an earlier year carries the year.
        expect(mobileSubtitle(counts, t, { now: new Date(2027, 0, 10, 12).getTime() })).toMatch(/^run 14 Sep 2026 \d{2}:\d{2}/);
    });

    it('drops the subtitle line entirely when there is nothing to say', () => {
        mount({ data: makeData({ counts: null }) });
        expect(screen.queryByTestId('mobile-subtitle')).toBeNull();
    });
});

/* ══ The overview ════════════════════════════════════════════════════════ */
describe('ComplianceMobile — the overview segment', () => {
    it('lists the framework rows with their score and opens one', () => {
        const { navigate } = mount();
        const row = screen.getByTestId('mobile-fw-gdpr');
        expect(row).toBeInTheDocument();
        expect(screen.getByTestId('mobile-fw-ring-gdpr')).toBeInTheDocument();
        fireEvent.click(row);
        expect(navigate).toHaveBeenCalledWith('gdpr');
    });

    it('sends an attention row to the target the server computed, id decoded', () => {
        const { navigate } = mount();
        fireEvent.click(screen.getByTestId('mobile-attention-a2'));
        expect(navigate).toHaveBeenCalledWith('dpia', 'ag/9', undefined); // (section, id, tab)
    });

    it('falls back to the section scoring a check\'s first framework', () => {
        expect(attentionTarget(ATTENTION[0])).toEqual({ section: 'gdpr', id: 'GDPR-12' });
        expect(attentionTarget({ action: { target: '/admin/compliance/dsr' } })).toEqual({ section: 'dsr', id: null });
    });

    // openChecksFor moved to data/openChecks.ts; its cases live in openChecks.test.ts.

    it('shows only the RUNNING deadlines, with a clock each', () => {
        mount();
        expect(screen.getByTestId('mobile-deadline-d1')).toBeInTheDocument();
        expect(screen.getByTestId('mobile-deadline-clock-d1')).toBeInTheDocument();
        expect(screen.queryByTestId('mobile-deadline-d2')).toBeNull();   // state 'done'
        expect(screen.getByText('1 running')).toBeInTheDocument();
    });

    it('carries the open-items badge, and hides it at zero', () => {
        const { rerender, navigate, onBack } = mount();
        expect(screen.getByTestId('mobile-attention-count')).toHaveTextContent('3');

        const page = <div />;
        rerender(<ComplianceMobile active="overview" navigate={navigate} onBack={onBack}
            data={makeData({ counts: { ...COUNTS, attention_open: 0 } })} tab="overview" onTab={vi.fn()} page={page} />);
        expect(screen.queryByTestId('mobile-attention-count')).toBeNull();
        rerender(<ComplianceMobile active="overview" navigate={navigate} onBack={onBack}
            data={makeData({ counts: null })} tab="overview" onTab={vi.fn()} page={page} />);
        expect(screen.queryByTestId('mobile-attention-count')).toBeNull();
    });

    it('tells a failed read apart from an empty one, in both lists', () => {
        const { rerender, navigate, onBack } = mount({
            data: makeData({ attention: { items: null, failed: true }, deadlines: { items: null, failed: true } }),
        });
        expect(screen.getByTestId('mobile-attention-failed')).toBeInTheDocument();
        expect(screen.getByTestId('mobile-deadlines-failed')).toBeInTheDocument();

        const page = <div />;
        rerender(<ComplianceMobile active="overview" navigate={navigate} onBack={onBack}
            data={makeData({ attention: { items: null, failed: false }, deadlines: { items: null, failed: false } })}
            tab="overview" onTab={vi.fn()} page={page} />);
        expect(screen.getByTestId('mobile-attention-loading')).toBeInTheDocument();
        expect(screen.getByTestId('mobile-deadlines-loading')).toBeInTheDocument();

        rerender(<ComplianceMobile active="overview" navigate={navigate} onBack={onBack}
            data={makeData({ attention: { items: [] }, deadlines: { items: [] } })}
            tab="overview" onTab={vi.fn()} page={page} />);
        expect(screen.getByTestId('mobile-attention-empty')).toBeInTheDocument();
        expect(screen.getByTestId('mobile-deadlines-empty')).toBeInTheDocument();
    });
});

/* ══ The Overview's other tabs ═══════════════════════════════════════════ */
describe('ComplianceMobile — the calendar and the reports are reachable from home', () => {
    it.each([
        ['calendar', 'mobile-entry-calendar', 'Regulatory calendar'],
        ['reports', 'mobile-entry-reports', 'Reports and downloads'],
    ])('the %s entry opens that tab, which renders the page under a back row', async (tab, entry, title) => {
        const user = userEvent.setup();
        const onTab = vi.fn();
        const { rerender, navigate, onBack, data } = mount({ onTab });
        await user.click(screen.getByTestId(entry));
        expect(onTab).toHaveBeenLastCalledWith(tab);
        expect(navigate).not.toHaveBeenCalled();

        const props = { navigate, onBack, data, onTab, page: <div data-testid="page-node">page</div> };
        rerender(<ComplianceMobile active="overview" tab={tab} {...props} />);
        expect(screen.getByTestId('compliance-mobile').dataset.view).toBe('tab');
        const frame = screen.getByTestId('mobile-home-tab');
        expect(within(frame).getByRole('heading', { name: title })).toBeInTheDocument();
        expect(within(frame).getByTestId('page-node')).toBeInTheDocument();
        expect(screen.queryByTestId('mobile-home-overview')).toBeNull();

        // Both ways back land on the Overview's status tab, never out of Settings.
        const back = screen.getByTestId('mobile-home-tab-back');
        expect(back).toHaveAccessibleName('Back to overview');
        expect(back.className).toContain('min-h-[44px]');
        await user.click(back);
        expect(onTab).toHaveBeenLastCalledWith('status');
        expect(screen.getByTestId('mobile-back')).toHaveAccessibleName('Back to overview');
        await user.click(screen.getByTestId('mobile-back'));
        expect(onTab).toHaveBeenCalledTimes(3);
        expect(onTab).toHaveBeenLastCalledWith('status');
        expect(onBack).not.toHaveBeenCalled();
    });

    it('the attention card folds after five rows behind one "Show all {n}" row, like the desktop list', async () => {
        const user = userEvent.setup();
        const items = Array.from({ length: 7 }, (_, i) => ({
            id: `r${i}`, title: `Open item ${i + 1}`, status: 'warn', source: 'register',
            meta: { severity: 'high', verification: 'register', frameworks: [{ regulation: 'ISO27001', ref: 'cl. 9' }] },
            action: { target: '/app/admin/compliance/training' },
        }));
        mount({ data: makeData({ attention: { items } }) });
        const card = screen.getByTestId('mobile-attention-card');
        const rows = () => within(card).getAllByRole('button').filter(b => b.dataset.testid?.startsWith('mobile-attention-r'));
        expect(rows()).toHaveLength(5);
        const toggle = screen.getByTestId('mobile-attention-toggle');
        expect(toggle).toHaveTextContent('Show all 7');
        expect(toggle).toHaveAttribute('aria-expanded', 'false');
        expect(toggle.className).toContain('min-h-[44px]');
        await user.click(toggle);
        expect(rows()).toHaveLength(7);
        expect(toggle).toHaveTextContent('Show fewer');
        // The meta reads like the desktop one: the reference once, no 'register', no dangling dot.
        const meta = rows()[0].textContent.replace('Open item 1', '');
        expect(meta).toBe('ISO cl. 9 · high');
    });

    it('a framework row says what the number is: "· 2 open"', () => {
        mount();
        expect(screen.getByTestId('mobile-fw-gdpr')).toHaveTextContent(/ · 2 open$/);
    });

    it('the status tab is the home screen', () => {
        mount({ tab: 'status' });
        expect(screen.getByTestId('mobile-home-overview')).toBeInTheDocument();
        expect(screen.queryByTestId('mobile-home-tab')).toBeNull();
    });
});

/* ══ The list views ══════════════════════════════════════════════════════ */
describe('ComplianceMobile — the rail as a phone list', () => {
    it('hides a growing-set framework until the org has it', () => {
        const { rerender, navigate, onBack } = mount();
        fireEvent.click(screen.getByText('Frameworks'));
        expect(screen.queryByTestId('mobile-row-nis2')).toBeNull();

        rerender(<ComplianceMobile active="overview" navigate={navigate} onBack={onBack}
            data={makeData({ frameworks: { isEnabled: (id) => id === 'nis2' } })}
            tab="overview" onTab={vi.fn()} page={<div />} />);
        fireEvent.click(screen.getByText('Frameworks'));
        expect(screen.getByTestId('mobile-row-nis2')).toBeInTheDocument();
    });

    it('groups registers and admin under their own headings, all as thumb targets', () => {
        const { container } = mount();
        fireEvent.click(screen.getByText('Registers'));
        const list = screen.getByTestId('mobile-rail-list');
        expect(within(list).getByText('Registers')).toBeInTheDocument();
        expect(within(list).getByText('Admin')).toBeInTheDocument();
        expect(screen.getByTestId('mobile-rail-list-registers')).toBeInTheDocument();
        expect(screen.getByTestId('mobile-rail-list-admin')).toBeInTheDocument();
        expectThumbTargets(container);
    });

    // NOTE (review 2026-09-14): this test used to be named "marks the active
    // row rather than leaving the list unanchored", which is the opposite of
    // what it asserts — and of what the frame can do. MobileRailList is only
    // rendered while `atHome` (ComplianceMobile.jsx:56, 111, 114), so the
    // `active` it receives is always 'overview', a section that lives in no
    // group. MobileSectionRow's `aria-current={active ? 'page' : undefined}`
    // (mobile/MobileRailList.jsx:65) therefore never fires on the phone. The
    // assertion below is correct; the name was not. The `active` prop wiring
    // is dead — either drop it or render the list from a section too.
    it('never marks a row: the list is only shown at home, where no section is active', () => {
        mount({ active: 'overview' });
        fireEvent.click(screen.getByText('Registers'));
        const rows = [...screen.getByTestId('mobile-rail-list').querySelectorAll('button')];
        expect(rows.length).toBeGreaterThan(0); // not vacuous: there are rows to check
        expect(rows.every(r => r.getAttribute('aria-current') === null)).toBe(true);
    });
});
