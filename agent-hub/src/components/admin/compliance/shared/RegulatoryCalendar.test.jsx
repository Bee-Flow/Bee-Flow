import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import RegulatoryCalendar from './RegulatoryCalendar';

// The artboard's day: 14 Sep 2026.
const NOW = new Date(2026, 8, 14, 15, 30).getTime();

const MILESTONES = [
    { id: 'dora_in_force', date: '2025-01-17', framework_id: 'dora', kind: 'in_force', label: 'DORA in force', relevant: false },
    { id: 'aia_art4_5', date: '2025-02-02', framework_id: 'aia', kind: 'phase', label: 'AI Act Art. 4 literacy · Art. 5 prohibited practices', relevant: true },
    { id: 'eaa_in_force', date: '2025-06-28', framework_id: 'eaa', kind: 'in_force', label: 'Accessibility Act (EAA)', relevant: true },
    { id: 'aia_art50', date: '2026-08-02', framework_id: 'aia', kind: 'phase', label: 'AI Act Art. 50 transparency', detail: 'national enforcement starts', relevant: true },
    { id: 'nis2_in_force', date: '2026-08-15', framework_id: 'nis2', kind: 'in_force', label: 'Cybersecurity Act (NIS2)', relevant: true },
    { id: 'cra_art14', date: '2026-09-11', framework_id: 'cra', kind: 'phase', label: 'CRA reporting duty Art. 14', detail: '24 h / 72 h', relevant: true },
    {
        id: 'aia_art50_marking_transition_end', date: '2026-12-02', framework_id: 'aia', kind: 'transition_end',
        label: 'Machine-readable marking of AI content', detail: 'AI Act Art. 50', relevant: true, affects: { automations: 3, agents: 0 },
    },
    { id: 'pld_in_force', date: '2026-12-09', framework_id: 'pld', kind: 'in_force', label: 'New product liability', detail: 'software, AI systems and connected services', relevant: true },
    { id: 'data_act_switching', date: '2027-01-12', framework_id: 'data_act', kind: 'transition_end', label: 'Switching charges abolished', detail: 'Data Act', relevant: true },
    { id: 'machinery_in_force', date: '2027-01-20', framework_id: 'machinery', kind: 'in_force', label: 'Machinery Regulation replaces the Directive', relevant: false },
    { id: 'omnibus_data_part', date: null, framework_id: 'gdpr', kind: 'uncertain', label: 'Digital Omnibus (data / privacy / NIS2 part)', expected: '2026-Q4', relevant: true },
    { id: 'nl_uitvoeringswet_ai', date: null, framework_id: 'aia', kind: 'uncertain', label: 'Dutch AI implementation act', detail: 'consultation closed 1 Jun 2026', relevant: true },
];

describe('RegulatoryCalendar — full variant (artboard 1e)', () => {
    it('renders the two recent past rows, the today divider, upcoming rows and the uncertain footer, in that order', async () => {
        render(<RegulatoryCalendar milestones={MILESTONES} now={NOW} variant="full" />);
        const root = screen.getByTestId('reg-calendar');
        const order = [...root.querySelectorAll('[data-testid]')].map(el => el.getAttribute('data-testid'));
        const firstUpcoming = order.indexOf('cal-row');
        expect(order.indexOf('cal-today')).toBeGreaterThan(firstUpcoming); // past rows before the divider…
        const kinds = () => screen.getAllByTestId('cal-row').map(r => r.getAttribute('data-when'));
        expect(kinds()).toEqual(['recent', 'recent', 'upcoming', 'upcoming', 'upcoming', 'upcoming']);
        expect(order.indexOf('cal-uncertain')).toBeGreaterThan(order.lastIndexOf('cal-row'));

        // The older dates are one click away, oldest first, above the recent two.
        const toggle = screen.getByTestId('cal-earlier-toggle');
        expect(toggle).toHaveTextContent('Show 4 earlier dates');
        expect(toggle).toHaveAttribute('aria-expanded', 'false');
        await userEvent.setup().click(toggle);
        expect(kinds()).toEqual(['past', 'past', 'past', 'past', 'recent', 'recent', 'upcoming', 'upcoming', 'upcoming', 'upcoming']);
        expect(toggle).toHaveAttribute('aria-expanded', 'true');
        expect(toggle).toHaveTextContent('Show fewer');
        expect(document.getElementById(toggle.getAttribute('aria-controls'))).toBeInTheDocument();
    });

    it('has no earlier toggle when at most two dates are past', () => {
        render(<RegulatoryCalendar milestones={MILESTONES.slice(4)} now={NOW} variant="full" />);
        expect(screen.queryByTestId('cal-earlier-toggle')).toBeNull();
        expect(screen.getAllByTestId('cal-row').filter(r => r.getAttribute('data-when') === 'recent')).toHaveLength(2);
    });

    it('the today divider: two kind-coloured lines around "today · 14 Sep 2026"', () => {
        render(<RegulatoryCalendar milestones={MILESTONES} now={NOW} variant="full" />);
        const divider = screen.getByTestId('cal-today');
        expect(divider).toHaveTextContent('today · 14 Sep 2026');
        const lines = divider.querySelectorAll('.bg-\\[var\\(--kind-compliance\\)\\]');
        expect(lines).toHaveLength(2);
        expect(divider.querySelector('.text-\\[var\\(--kind-compliance\\)\\]')).toHaveTextContent('today');
    });

    it('past rows are greyed one-liners with the full date; the two most recent keep secondary text, a bold title and "n days ago"', async () => {
        render(<RegulatoryCalendar milestones={MILESTONES} now={NOW} variant="full" />);
        await userEvent.setup().click(screen.getByTestId('cal-earlier-toggle'));
        const rows = screen.getAllByTestId('cal-row');
        const older = rows[0];
        expect(older).toHaveTextContent('17 Jan 2025');
        expect(older).toHaveTextContent('DORA in force');
        expect(older).toHaveTextContent('not relevant');
        expect(older.className).toContain('text-[var(--text-tertiary)]');
        expect(older.querySelector('b')).toBeNull();
        expect(older).not.toHaveTextContent('days ago');

        const nis2 = rows[4];
        expect(nis2).toHaveAttribute('data-when', 'recent');
        expect(nis2.className).toContain('text-[var(--text-secondary)]');
        expect(nis2.querySelector('b')).toHaveTextContent('Cybersecurity Act (NIS2)');
        expect(nis2).toHaveTextContent('30 days ago');
        const cra = rows[5];
        expect(cra).toHaveTextContent('CRA reporting duty Art. 14 · 24 h / 72 h · 3 days ago');
        // Only the recent two carry a detail — Art. 50's "national enforcement starts" is older and stays a one-liner.
        expect(rows[3]).not.toHaveTextContent('national enforcement');
    });

    it('upcoming rows: bold date, title, meta with detail · affects · countdown; warning ink at ≤ 90 days, months beyond', () => {
        render(<RegulatoryCalendar milestones={MILESTONES} now={NOW} variant="full" />);
        const rows = screen.getAllByTestId('cal-row').filter(r => r.getAttribute('data-when') === 'upcoming');
        expect(rows.map(r => r.firstElementChild.textContent)).toEqual(['2 Dec 2026', '9 Dec 2026', '12 Jan 2027', '20 Jan 2027']);
        expect(rows[0].firstElementChild.className).toContain('font-semibold');

        expect(rows[0]).toHaveTextContent('Machine-readable marking of AI content');
        expect(rows[0]).toHaveTextContent('AI Act Art. 50 · affects 3 automations · in 79 days');
        expect(rows[0]).toHaveAttribute('data-soon', 'true');
        const soon = rows[0].querySelector('[data-testid="cal-countdown"]');
        expect(soon.style.color).toBe('var(--warning-ink)');

        expect(rows[1]).toHaveTextContent('in 86 days');
        expect(rows[2]).toHaveTextContent('Data Act · in 4 months');
        expect(rows[2]).toHaveAttribute('data-soon', 'false');
        expect(rows[2].querySelector('[data-testid="cal-countdown"]').style.color).toBe('');
        expect(rows[3]).toHaveTextContent('not relevant · in 4 months');
    });

    it('the uncertain footer lists undated items with detail and the expected window', () => {
        render(<RegulatoryCalendar milestones={MILESTONES} now={NOW} variant="full" />);
        const box = screen.getByTestId('cal-uncertain');
        expect(box).toHaveTextContent('Still uncertain:');
        const items = screen.getAllByTestId('cal-uncertain-item');
        expect(items).toHaveLength(2);
        expect(items[0]).toHaveTextContent('Digital Omnibus (data / privacy / NIS2 part) · expected 2026-Q4');
        expect(items[1]).toHaveTextContent('Dutch AI implementation act — consultation closed 1 Jun 2026');
        expect(box.className).toContain('bg-[var(--bg-secondary)]');
    });

    it('translates label_key / detail_key through t() and falls back to the id; an undefined list renders nothing', () => {
        const t = vi.fn((key, fallback, params) => {
            const dict = { 'compliance.cal_ms_x_label': 'Translated X', 'compliance.cal_ms_x_detail': 'Detail X' };
            let v = dict[key] ?? fallback ?? key;
            for (const [k, val] of Object.entries(params || {})) v = v.replace(`{${k}}`, String(val));
            return v;
        });
        const { rerender, container } = render(
            <RegulatoryCalendar
                milestones={[
                    { id: 'x', date: '2026-12-02', label_key: 'compliance.cal_ms_x_label', detail_key: 'compliance.cal_ms_x_detail' },
                    { id: 'y', date: '2026-12-09', label_key: 'compliance.cal_ms_y_label', detail_key: 'compliance.cal_ms_y_detail' },
                ]}
                now={NOW} variant="full" t={t} locale="nl"
            />,
        );
        const rows = screen.getAllByTestId('cal-row');
        expect(rows[0]).toHaveTextContent('Translated X');
        expect(rows[0]).toHaveTextContent('Detail X');
        expect(rows[1]).toHaveTextContent('y'); // unknown key → the id, never the raw key
        expect(rows[1]).not.toHaveTextContent('compliance.cal_ms_y');
        expect(rows[0].firstElementChild).toHaveTextContent('2 dec 2026'); // locale prop drives Intl
        expect(t).toHaveBeenCalledWith('compliance.cal_ms_y_detail', '');

        rerender(<RegulatoryCalendar milestones={undefined} now={NOW} variant="full" />);
        expect(container).toBeEmptyDOMElement();
        rerender(<RegulatoryCalendar milestones={[]} now={NOW} variant="full" />);
        expect(screen.getByTestId('cal-empty')).toHaveTextContent('No upcoming dates');
        expect(screen.queryByTestId('cal-uncertain')).toBeNull();
    });
});

describe('RegulatoryCalendar — compact variant (artboard 1a "Komende data")', () => {
    it('shows only the next three upcoming dates in the 78px column, no past rows, no divider, no footer', () => {
        render(<RegulatoryCalendar milestones={MILESTONES} now={NOW} variant="compact" />);
        const rows = screen.getAllByTestId('cal-row');
        expect(rows).toHaveLength(3);
        expect(rows.every(r => r.getAttribute('data-when') === 'upcoming')).toBe(true);
        expect(rows[0].style.gridTemplateColumns).toBe('78px 1fr');
        expect(rows.map(r => r.firstElementChild.textContent)).toEqual(['2 Dec', '9 Dec', "12 Jan '27"]);
        expect(screen.queryByTestId('cal-today')).toBeNull();
        expect(screen.queryByTestId('cal-uncertain')).toBeNull();
        expect(screen.queryByTestId('cal-more')).toBeNull(); // no onOpenCalendar → no link
    });

    it('limitUpcoming and the "n more dates" link to the full calendar', async () => {
        const onOpen = vi.fn();
        render(<RegulatoryCalendar milestones={MILESTONES} now={NOW} variant="compact" limitUpcoming={2} onOpenCalendar={onOpen} />);
        expect(screen.getAllByTestId('cal-row')).toHaveLength(2);
        const more = screen.getByTestId('cal-more');
        expect(more).toHaveTextContent('2 more dates');
        await userEvent.setup().click(more);
        expect(onOpen).toHaveBeenCalledTimes(1);
    });

    it('keeps the meta to one line with the full text in the title, and the countdown outside the clamp', () => {
        render(<RegulatoryCalendar milestones={MILESTONES} now={NOW} variant="compact" />);
        const first = screen.getAllByTestId('cal-row')[0];
        const meta = within(first).getByTestId('cal-meta');
        const clamped = meta.querySelector('.line-clamp-1');
        expect(clamped).toHaveAttribute('title', 'AI Act Art. 50 · affects 3 automations');
        expect(clamped).not.toContainElement(within(first).getByTestId('cal-countdown'));
        expect(within(first).getByTestId('cal-countdown')).toHaveTextContent('in 79 days');
        expect(screen.queryByTestId('cal-earlier-toggle')).toBeNull();
    });

    it('full variant uses the 80px column and never caps the upcoming list by default', () => {
        render(<RegulatoryCalendar milestones={MILESTONES} now={NOW} variant="full" />);
        const upcoming = screen.getAllByTestId('cal-row').filter(r => r.getAttribute('data-when') === 'upcoming');
        expect(upcoming).toHaveLength(4);
        expect(upcoming[0].style.gridTemplateColumns).toBe('80px 1fr');
    });
});
