import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import TimelinePhases, { layoutPhases } from './TimelinePhases';

// The artboard's day: 14 Sep 2026. The AI Act phasing of frame 1e:
// literacy/prohibitions (done), Art. 50 transparency (done), the marking
// transition end at 79 days (upcoming), Annex III high-risk (future).
const NOW = new Date(2026, 8, 14, 15, 30).getTime();

const AIA_PHASES = [
    { date: '2025-02-02', title: '2 Feb 2025', subtitle: 'Art. 4 · Art. 5', state: 'done' },
    { date: '2026-08-02', title: '2 Aug 2026', subtitle: 'Art. 50 transparency', state: 'done' },
    { date: '2026-12-02', title: '2 Dec 2026', subtitle: 'marking transition', state: 'upcoming', daysLeft: 79 },
    { date: '2027-08-02', title: '2 Aug 2027', subtitle: 'Annex III', state: 'future' },
];

describe('TimelinePhases.layoutPhases — label rows', () => {
    const SIX = [
        { date: '2025-02-02', title: 'Art. 4 literacy · Art. 5 prohibited', state: 'done' },
        { date: '2025-08-02', title: 'GPAI rules', state: 'done' },
        { date: '2026-08-02', title: 'Art. 50 transparency', state: 'done' },
        { date: '2026-12-02', title: 'marking of existing systems', state: 'upcoming' },
        { date: '2027-12-02', title: 'high risk Annex III', state: 'future' },
        { date: '2028-08-02', title: 'high risk Annex I', state: 'future' },
    ];
    it('puts close neighbours on different rows so their labels never overlap', () => {
        const { items, rows } = layoutPhases(SIX, NOW);
        expect(rows).toBeGreaterThan(1);
        for (let i = 0; i < items.length; i++) {
            for (let j = i + 1; j < items.length; j++) {
                if (items[i].row === items[j].row) expect(Math.abs(items[j].pct - items[i].pct)).toBeGreaterThanOrEqual(22);
            }
        }
    });
    it('keeps far-apart phases on one row', () => {
        const two = [SIX[0], SIX[5]];
        expect(layoutPhases(two, NOW).rows).toBe(1);
        expect(layoutPhases(two, NOW).items.map(p => p.row)).toEqual([0, 0]);
    });
    it('grows the track by one label row per extra row', () => {
        render(<TimelinePhases phases={SIX} now={NOW} />);
        const track = screen.getByTestId('timeline-phases');
        expect(Number(track.dataset.rows)).toBeGreaterThan(1);
        expect(track.className).not.toContain('h-[72px]');
        expect(track.className).toMatch(/h-\[(102|132)px\]/);
    });
});

describe('TimelinePhases.layoutPhases — proportional positions', () => {
    it('positions each phase between the first (0) and last (100) date and puts today on the same scale', () => {
        const { items, todayPct } = layoutPhases(AIA_PHASES, NOW);
        expect(items.map(p => p.pct)).toEqual([0, 59.9, 73.3, 100]);
        // 14 Sep 2026 is 589 of 911 days into the span → 64.7 % (ms-proportional, so DST shifts count)
        expect(todayPct).toBeCloseTo(64.7, 1);
        expect(items.map(p => p.state)).toEqual(['done', 'done', 'upcoming', 'future']);
    });

    it('sorts by date whatever the input order and clamps today to the track', () => {
        const shuffled = [AIA_PHASES[2], AIA_PHASES[0], AIA_PHASES[3], AIA_PHASES[1]];
        expect(layoutPhases(shuffled, NOW).items.map(p => p.title)).toEqual(AIA_PHASES.map(p => p.title));
        // long before the first phase → 0; long after the last → 100
        expect(layoutPhases(AIA_PHASES, new Date(2020, 0, 1).getTime()).todayPct).toBe(0);
        expect(layoutPhases(AIA_PHASES, new Date(2031, 0, 1).getTime()).todayPct).toBe(100);
    });

    it('a single phase, or phases on one date, all sit at 0; unparseable dates are dropped; nothing dated → null', () => {
        expect(layoutPhases([AIA_PHASES[1]], NOW).items[0].pct).toBe(0);
        const sameDay = [{ ...AIA_PHASES[0] }, { ...AIA_PHASES[0], title: 'twin' }];
        expect(layoutPhases(sameDay, NOW).items.map(p => p.pct)).toEqual([0, 0]);
        expect(layoutPhases(sameDay, NOW).todayPct).toBe(0);
        const withGarbage = [...AIA_PHASES, { date: 'someday', title: 'no date', state: 'future' }, null];
        expect(layoutPhases(withGarbage, NOW).items).toHaveLength(4);
        expect(layoutPhases([{ date: null, title: 'x' }], NOW)).toBeNull();
        expect(layoutPhases(undefined, NOW)).toBeNull();
        expect(layoutPhases('nope', NOW)).toBeNull();
    });
});

describe('TimelinePhases — the 72px track (artboard 1e)', () => {
    it('renders nothing without a dated phase (the caller owns the empty state)', () => {
        const { container } = render(<TimelinePhases phases={[]} now={NOW} />);
        expect(container).toBeEmptyDOMElement();
    });

    it('draws the base line, the progressed segment up to today and the today marker in the kind colour', () => {
        render(<TimelinePhases phases={AIA_PHASES} now={NOW} />);
        const root = screen.getByTestId('timeline-phases');
        // 72px per artboard, plus one 30px label row for every extra row of labels.
        expect(root.className).toContain(['h-[72px]', 'h-[102px]', 'h-[132px]'][Number(root.dataset.rows) - 1]);
        expect(root.querySelector('.bg-\\[var\\(--bg-tertiary\\)\\].top-\\[9px\\]')).not.toBeNull();

        const progress = screen.getByTestId('timeline-phases-progress');
        expect(progress.className).toContain('bg-[var(--text-primary)]');
        expect(parseFloat(progress.style.width)).toBeCloseTo(64.7, 1);

        const today = screen.getByTestId('timeline-phases-today');
        expect(parseFloat(today.style.left)).toBeCloseTo(64.7, 1);
        expect(today.style.transform).toBe('translateX(-50%)');
        expect(today).toHaveTextContent('today');
        expect(today.querySelector('.bg-\\[var\\(--kind-compliance\\)\\]')).not.toBeNull();
        expect(today.querySelector('.text-\\[var\\(--kind-compliance\\)\\]')).not.toBeNull();
    });

    it('marker per state: done = ink disc + check, missed = error disc + x, upcoming = warning ring, future = border ring', () => {
        const phases = [
            AIA_PHASES[0],
            { date: '2026-01-01', title: 'missed one', state: 'missed' },
            AIA_PHASES[2],
            AIA_PHASES[3],
        ];
        render(<TimelinePhases phases={phases} now={NOW} />);
        const items = screen.getAllByTestId('timeline-phases-phase');
        expect(items.map(el => el.getAttribute('data-state'))).toEqual(['done', 'missed', 'upcoming', 'future']);

        const marker = (el) => el.firstElementChild;
        const [done, missed, upcoming, future] = items.map(marker);

        expect(done.className).toContain('bg-[var(--text-primary)]');
        expect(done.querySelector('svg')).not.toBeNull();
        expect(done.querySelector('svg').style.color).toBe('var(--bg-card)');

        expect(missed.style.background).toBe('var(--error)');
        expect(missed.querySelector('svg')).not.toBeNull();

        expect(upcoming.style.border).toBe('2px solid var(--warning)');
        expect(upcoming.className).toContain('bg-[var(--bg-card)]');
        expect(upcoming.querySelector('svg')).toBeNull();

        expect(future.style.border).toBe('2px solid var(--border-default)');
        expect(future.querySelector('svg')).toBeNull();

        for (const m of [done, missed, upcoming, future]) expect(m.className).toContain('w-5 h-5 rounded-full');
    });

    it('labels: bold date, subtitle in secondary text, daysLeft in warning ink', () => {
        render(<TimelinePhases phases={AIA_PHASES} now={NOW} />);
        const upcoming = screen.getAllByTestId('timeline-phases-phase')[2];
        const label = upcoming.querySelector('span.text-\\[10px\\]');
        expect(label.className).toContain('text-[var(--text-secondary)]');
        expect(label.querySelector('b')).toHaveTextContent('2 Dec 2026');
        expect(label).toHaveTextContent('marking transition');
        const days = [...label.querySelectorAll('span')].find(s => s.style.color === 'var(--warning-ink)');
        expect(days).toHaveTextContent('79 d');
        // a phase without daysLeft prints no countdown
        const done = screen.getAllByTestId('timeline-phases-phase')[0];
        expect([...done.querySelectorAll('span')].some(s => s.style.color === 'var(--warning-ink)')).toBe(false);
    });

    it('the first label anchors left, the last right, the rest are centred with translateX(-50%)', () => {
        render(<TimelinePhases phases={AIA_PHASES} now={NOW} />);
        const [first, second, third, last] = screen.getAllByTestId('timeline-phases-phase');
        expect(first.style.left).toBe('0px');
        expect(first.style.transform).toBe('');
        expect(first.className).toContain('items-start');
        expect(last.style.right).toBe('0px');
        expect(last.style.transform).toBe('');
        expect(last.className).toContain('items-end');
        for (const mid of [second, third]) {
            expect(mid.style.transform).toBe('translateX(-50%)');
            expect(mid.className).toContain('items-center');
        }
        expect(second.style.left).toBe('59.9%');
        expect(third.style.left).toBe('73.3%');
    });

    it('a single phase is anchored left, not right (there is no "last" to pin to the edge)', () => {
        render(<TimelinePhases phases={[AIA_PHASES[1]]} now={NOW} />);
        const only = screen.getByTestId('timeline-phases-phase');
        expect(only.style.left).toBe('0px');
        expect(only.style.right).toBe('');
    });
});
