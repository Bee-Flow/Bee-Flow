/**
 * The framework row's decisions: differential against the web's
 * FrameworkCandidateCard.jsx and FrameworksPage.jsx functions, plus units
 * for the phone's own helpers.
 */

import { loadWebFunctions, loadWebModule } from '@/shared/testing/webModule';

import * as port from './frameworkCard';

const cal = loadWebModule<Record<string, unknown>>('components/admin/compliance/shared/calendarMath.js');
type WebCard = Omit<typeof port, 'countLabel'> & { countLabel: (t: unknown, key: string, n: number, fallback: string, one?: string) => string };
const card = loadWebFunctions<WebCard>(
    'components/admin/compliance/pages/frameworks/FrameworkCandidateCard.jsx',
    ['statusChipOf', 'enableIsPrimary', 'recommendedReason', 'countLabel'],
    { daysUntil: cal.daysUntil, parseDay: cal.parseDay, SOON_DAYS: cal.SOON_DAYS },
);
const page = loadWebFunctions<typeof port>('components/admin/compliance/pages/FrameworksPage.jsx', ['candidateList', 'frameworkGroups']);

const t = (key: string, fallback: string, params?: Record<string, unknown>) =>
    `${key}|${fallback.replace(/\{(\w+)\}/g, (_m, k: string) => String(params?.[k] ?? `{${k}}`))}`;
const NOW = new Date(2026, 8, 14, 12).getTime();

const FWS: port.FrameworkLike[] = [
    { id: 'gdpr', core: true, enabled: true, in_force_since: '2018-05-25' },
    { id: 'pld', enabled: false, in_force_from: '2026-12-09', relevance: 'relevant' },
    { id: 'machinery', enabled: false, in_force_from: '2027-01-20', recently_in_force: false },
    { id: 'aia', enabled: true, in_force_since: '2024-08-01', recently_in_force: true },
    { id: 'soon', enabled: false, in_force_from: '2026-10-01' },
    { id: 'today', enabled: false, in_force_from: '2026-09-14' },
    { id: 'nodate', enabled: false, locked: 'ceiling' },
];

describe('frameworkCard (differential)', () => {
    it('agrees on statusChipOf, minus the web-only tint', () => {
        for (const f of [...FWS, null]) {
            const w = card.statusChipOf(f, NOW) as (port.StatusChip & { tint?: number }) | null;
            const strip = w ? (({ tint: _tint, ...rest }) => rest)(w) : null;
            expect(port.statusChipOf(f, NOW)).toEqual(strip);
        }
        expect(port.statusChipOf(FWS[4], NOW)).toMatchObject({ tone: 'warning', days: 17 });
        expect(port.statusChipOf(FWS[2], NOW)?.tone).toBe('neutral');
    });

    it('agrees on enableIsPrimary, recommendedReason and countLabel', () => {
        for (const f of [...FWS, null]) {
            expect(port.enableIsPrimary(f)).toBe(card.enableIsPrimary(f));
            expect(port.recommendedReason(f, t)).toBe(card.recommendedReason(f, t));
        }
        for (const n of [0, 1, 2]) {
            expect(port.countLabel(t, 'compliance.fw_meta_checks', n, { many: '{n} checks', one: '1 check' })).toBe(card.countLabel(t, 'compliance.fw_meta_checks', n, '{n} checks', '1 check'));
            expect(port.countLabel(t, 'k', n, { many: '{n} things' })).toBe(card.countLabel(t, 'k', n, '{n} things'));
        }
    });

    it('agrees on the groups: core dropped, enabled and available', () => {
        expect(port.frameworkGroups(FWS)).toEqual(page.frameworkGroups(FWS));
        expect(port.frameworkGroups(null)).toBeNull();
        const groups = port.frameworkGroups(FWS);
        expect(groups?.enabled.map((f) => f.id)).toEqual(['aia']);
        expect(groups?.available.map((f) => f.id)).toEqual(['pld', 'machinery', 'soon', 'today', 'nodate']);
    });
});

describe('frameworkCard (phone helpers)', () => {
    it('gates DORA, Machinery and a relevance gate; locks for two reasons', () => {
        expect(port.isGated({ id: 'dora' })).toBe(true);
        expect(port.isGated({ id: 'machinery' })).toBe(true);
        expect(port.isGated({ id: 'x', relevance_gate: true })).toBe(true);
        expect(port.isGated({ id: 'nis2' })).toBe(false);
        expect(port.isLocked({ id: 'x', locked: 'ceiling' })).toBe(true);
        expect(port.isLocked({ id: 'x', locked: 'not_granted' })).toBe(true);
        expect(port.isLocked({ id: 'x', locked: null })).toBe(false);
    });

    it('words the affects counts and the meta line', () => {
        expect(port.affectsCounts({ automations: 3, agents: 1, forms: 0 }, t)).toBe('3 compliance.fw_affects_automations|automations · 1 compliance.fw_affects_agents_one|agent');
        expect(port.affectsCounts(null, t)).toBe('');
        expect(port.frameworkMeta({ id: 'x', checks_count: 1, registers: ['a', 'b'], calendar_count: 0 }, t)).toBe('compliance.fw_meta_checks_one|1 check · compliance.fw_meta_registers|2 registers');
    });

    it('chooses the legal status line and the summary', () => {
        expect(port.legalStatusOf(null, t)).toEqual({ tone: 'warning', text: 'compliance.hdr_fw_review_unknown|Legal status not recorded · due for review' });
        expect(port.legalStatusOf({ verified_on: '2026-09-29', stale: true }, t).tone).toBe('warning');
        expect(port.legalStatusOf({ verified_on: '2026-09-29', stale: false }, t)).toEqual({ tone: 'info', text: 'compliance.hdr_fw_checked|Legal status checked 2026-09-29 · not legal advice' });
        expect(port.frameworkSummary({ active: 3, candidates: 4, recent: 2 }, t)).toBe('compliance.hdr_fw_summary|3 active · 4 candidates · compliance.hdr_fw_recent|2 just in force');
        expect(port.frameworkSummary({ active: null, candidates: 4, recent: 0 }, t)).toBeNull();
    });

    it('says the plan sentence only on a 403', () => {
        expect(port.toggleFailureText(403, t)).toMatch(/fw_toast_locked/);
        expect(port.toggleFailureText(500, t)).toMatch(/fw_toast_failed/);
        expect(port.toggleFailureText(undefined, t)).toMatch(/fw_toast_failed/);
    });
});
