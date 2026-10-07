/**
 * The Timeline tab's model: differential against the web's TimelineTab.jsx
 * functions (milestonesOf, frameworkRecord, toPhases), units for the
 * phaseRules.ts port (a TS file the loader cannot run, so its rule lines are
 * checked textually) and the stepper order.
 */

import fs from 'node:fs';

import { AGENT_HUB_SRC, loadWebFunctions, loadWebModule } from '@/shared/testing/webModule';

import * as port from './timeline';

const cal = loadWebModule<Record<string, unknown>>('components/admin/compliance/shared/calendarMath.js');
const labelOf = (m: { label?: string | null; label_key?: string | null; id?: string | null }, t: (k: string, f: string) => string) => m.label ?? (m.label_key ? t(m.label_key, m.id ?? '') : m.id);
const TAB = 'components/admin/compliance/pages/framework/TimelineTab.jsx';
const DEPS = { parseDay: cal.parseDay, daysUntil: cal.daysUntil, SOON_DAYS: cal.SOON_DAYS, isArt50Phase: port.isArt50Phase, labelOf };
const web = loadWebFunctions<typeof port>(TAB, ['milestonesOf', 'frameworkRecord'], DEPS);

/** toPhases destructures its options in the signature, which the brace matcher cannot skip: cut it at its closing line. */
function webToPhases(): typeof port.toPhases {
    const src = fs.readFileSync(`${AGENT_HUB_SRC}/${TAB}`, 'utf8');
    const start = src.indexOf('export function toPhases(');
    const fn = src.slice(start, src.indexOf('\n}\n', start) + 2).replace(/^export /, '');
    return new Function(...Object.keys(DEPS), `${fn}\nreturn toPhases;`)(...Object.values(DEPS)) as typeof port.toPhases;
}
const webPhases = webToPhases();

const t = (key: string, fallback: string) => `${key}|${fallback}`;
const NOW = new Date(2026, 8, 14, 12).getTime();
const CAL = [
    { id: 'aia_art50', date: '2026-08-02', framework_id: 'aia', label_key: 'compliance.cal_aia_art50', detail_key: 'compliance.cal_aia_art50_d' },
    { id: 'aia_gpai', date: '2025-08-02', framework_id: 'aia', label_key: 'compliance.cal_aia_gpai', detail_key: null },
    { id: 'aia_annex3', date: '2027-12-02', framework_id: 'aia', label_key: 'compliance.cal_aia_annex3', detail_key: null },
    { id: 'aia_soon', date: '2026-10-01', framework_id: 'aia', label_key: null, detail_key: null },
    { id: 'aia_omnibus', date: null, framework_id: 'aia', label_key: 'compliance.cal_omnibus', detail_key: null },
    { id: 'pld', date: '2026-12-09', framework_id: 'pld', label_key: 'compliance.cal_pld', detail_key: null },
];
const AIA = { id: 'aia', phases: [{ date: '2025-08-02', label_key: 'compliance.ph_gpai', label: 'GPAI rules' }, { date: '2026-08-02', label_key: null, label: 'Art. 50' }] };

describe('timeline (differential)', () => {
    it('agrees on milestonesOf and frameworkRecord', () => {
        expect(port.milestonesOf(CAL, 'aia')).toEqual(web.milestonesOf(CAL, 'aia'));
        expect(port.milestonesOf(CAL, 'aia')?.map((m) => m.id)).toEqual(['aia_gpai', 'aia_art50', 'aia_soon', 'aia_annex3', 'aia_omnibus']);
        expect(port.milestonesOf(null, 'aia')).toBeNull();
        expect(port.frameworkRecord([AIA], 'aia')).toBe(web.frameworkRecord([AIA], 'aia'));
        expect(port.frameworkRecord([AIA], 'nis2')).toBeNull();
    });

    it('agrees on toPhases, with and without the Art. 50 rule and short titles', () => {
        const rows = port.milestonesOf(CAL, 'aia');
        for (const art50Missed of [false, true]) {
            const opts = { art50Missed, shortTitles: port.shortTitlesOf(AIA, t) };
            expect(port.toPhases(rows, t, NOW, opts)).toEqual(webPhases(rows, t, NOW, opts));
        }
        const phases = port.toPhases(rows, t, NOW, { art50Missed: true, shortTitles: port.shortTitlesOf(AIA, t) });
        expect(phases.map((p) => p.state)).toEqual(['done', 'missed', 'upcoming', 'future']);
        expect(phases[0]?.title).toBe('compliance.ph_gpai|GPAI rules');
        expect(phases[2]?.daysLeft).toBe(17);
    });
});

describe('timeline (phaseRules port)', () => {
    const src = fs.readFileSync(`${AGENT_HUB_SRC}/components/admin/compliance/pages/framework/phaseRules.ts`, 'utf8');

    it('keeps the web rule lines', () => {
        expect(src).toContain('const ART50_RE = /(^|_)art50($|_)/i;');
        expect(src).toContain("String(c.article ?? '').startsWith('50')");
        expect(src).toContain("String(c.regulation ?? '').toUpperCase() === 'AIA'");
    });

    it('recognises the Art. 50 phase and a failing disclosure check', () => {
        expect(port.isArt50Phase({ id: 'aia_art50' })).toBe(true);
        expect(port.isArt50Phase({ label_key: 'compliance.art50_x' })).toBe(false);
        expect(port.isArt50Phase({ article: '50(1)' })).toBe(true);
        expect(port.isArt50Phase(null)).toBe(false);
        expect(port.disclosureFails([{ status: 'fail', regulation: 'aia', article: '50' }])).toBe(true);
        expect(port.disclosureFails([{ status: 'pass', regulation: 'AIA', article: '50' }, null])).toBe(false);
        expect(port.disclosureFails(null)).toBe(false);
    });

    it('drops short titles of dates with more than one phase', () => {
        const titles = port.shortTitlesOf({ phases: [{ date: 'a', label: 'One' }, { date: 'b', label: 'Two' }, { date: 'b', label: 'Three' }, null] }, t);
        expect([...titles]).toEqual([['a', 'One']]);
    });
});

describe('timeline (phone)', () => {
    it('fills the track from the catalogue when the calendar has nothing', () => {
        const phases = port.phasesOf([], AIA, 'aia', { t, now: NOW, art50Missed: false });
        expect(phases.map((p) => [p.title, p.state])).toEqual([['GPAI rules', 'done'], ['Art. 50', 'done']]);
        expect(port.phasesOf(null, null, 'aia', { t, now: NOW, art50Missed: false })).toEqual([]);
    });

    it('orders the stepper and puts today after the last phase not later than today', () => {
        const phases = port.toPhases(port.milestonesOf(CAL, 'aia'), t, NOW);
        const { items, todayIndex } = port.stepperOf([...phases].reverse(), NOW);
        expect(items.map((p) => p.date)).toEqual(['2025-08-02', '2026-08-02', '2026-10-01', '2027-12-02']);
        expect(todayIndex).toBe(2);
    });
});
