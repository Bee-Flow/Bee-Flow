// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
    clocksOf, nextClock, lastDone, nextCraStage, kindsOfSection, matchesSection, kindOf,
    toneOfIncidentStatus, parseCveIds, createBodyOf, URGENT_BELOW,
} from './incidentClocks';
import { HOUR_MS, DAY_MS } from '../../../../shared/deadlineMath';

const T0 = '2026-09-14T08:00:00.000Z';
const plus = (ms) => new Date(new Date(T0).getTime() + ms).toISOString();

describe('incidentClocks — which register', () => {
    it('the vulnerabilities section shows kind=vulnerability; incidents shows breach + security_incident; no kind = breach', () => {
        expect(kindsOfSection('vulnerabilities')).toEqual(['vulnerability']);
        expect(kindsOfSection('incidents')).toEqual(['breach', 'security_incident']);
        expect(kindOf({})).toBe('breach');
        expect(matchesSection({ kind: 'vulnerability' }, 'incidents')).toBe(false);
        expect(matchesSection({ kind: 'security_incident' }, 'incidents')).toBe(true);
        expect(matchesSection({}, 'incidents')).toBe(true);
        expect(matchesSection({ kind: 'vulnerability' }, 'vulnerabilities')).toBe(true);
    });
});

describe('incidentClocks — vulnerability clocks (CRA Art. 14)', () => {
    it('derives 24 h · 72 h · 14 d from detected_at when the server columns are absent', () => {
        const clocks = clocksOf({ kind: 'vulnerability', status: 'open', detected_at: T0 });
        expect(clocks.map(c => c.stage)).toEqual(['early_warning', 'notification', 'final_report']);
        expect(clocks[0].dueAt).toBe(plus(24 * HOUR_MS));
        expect(clocks[1].dueAt).toBe(plus(72 * HOUR_MS));
        expect(clocks[2].dueAt).toBe(plus(14 * DAY_MS));
        expect(clocks.every(c => c.derived)).toBe(true);
        expect(clocks[0].urgentBelowMs).toBe(URGENT_BELOW.cra_early_warning);
        expect(clocks[1].urgentBelowMs).toBe(URGENT_BELOW.cra_later);
    });

    it('prefers the server columns and reports the early warning as done once sent', () => {
        const inc = {
            kind: 'vulnerability', status: 'early_warning_sent', detected_at: T0,
            early_warning_due_at: plus(20 * HOUR_MS), early_warning_sent_at: plus(3 * HOUR_MS),
            deadline_at: plus(70 * HOUR_MS), final_report_due_at: plus(13 * DAY_MS),
        };
        const clocks = clocksOf(inc);
        expect(clocks[0]).toMatchObject({ stage: 'early_warning', dueAt: plus(20 * HOUR_MS), sentAt: plus(3 * HOUR_MS), derived: false });
        expect(clocks[1]).toMatchObject({ stage: 'notification', dueAt: plus(70 * HOUR_MS), sentAt: null, derived: false });
        expect(nextClock(inc).stage).toBe('notification');
        expect(nextCraStage(inc)).toBe('notification');
        expect(lastDone(inc).stage).toBe('early_warning');
    });

    it('walks the stages: open → early_warning, then notification, then final_report, then nothing', () => {
        const base = { kind: 'vulnerability', status: 'open', detected_at: T0 };
        expect(nextCraStage(base)).toBe('early_warning');
        expect(nextCraStage({ ...base, early_warning_sent_at: plus(HOUR_MS) })).toBe('notification');
        expect(nextCraStage({ ...base, early_warning_sent_at: plus(HOUR_MS), notification_sent_at: plus(2 * HOUR_MS) })).toBe('final_report');
        const all = { ...base, early_warning_sent_at: plus(HOUR_MS), notification_sent_at: plus(2 * HOUR_MS), final_report_sent_at: plus(3 * DAY_MS) };
        expect(nextClock(all)).toBe(null);
        expect(nextCraStage(all)).toBe(null);
        expect(lastDone(all).stage).toBe('final_report');
    });

    it('closing a vulnerability marks every open stage done at closed_at', () => {
        const inc = { kind: 'vulnerability', status: 'closed', detected_at: T0, closed_at: plus(5 * HOUR_MS) };
        expect(nextClock(inc)).toBe(null);
        expect(clocksOf(inc).every(c => c.sentAt === plus(5 * HOUR_MS))).toBe(true);
    });
});

describe('incidentClocks — GDPR breach clocks', () => {
    it('a breach carries only the 72 h authority clock with the 24 h urgency, done at authority_notified_at', () => {
        const inc = { status: 'assessing', detected_at: T0, deadline_at: plus(72 * HOUR_MS) };
        const clocks = clocksOf(inc);
        expect(clocks).toHaveLength(1);
        expect(clocks[0]).toMatchObject({ stage: 'notification', dueAt: plus(72 * HOUR_MS), sentAt: null, urgentBelowMs: URGENT_BELOW.breach });
        expect(nextCraStage(inc)).toBe(null);
        const done = { ...inc, status: 'authority_notified', authority_notified_at: plus(10 * HOUR_MS) };
        expect(nextClock(done)).toBe(null);
        expect(lastDone(done).sentAt).toBe(plus(10 * HOUR_MS));
    });

    it('a NIS2 + DORA row lists early warning, notification, final report and the customer notice; nothing is derived', () => {
        const inc = {
            kind: 'security_incident', status: 'open', detected_at: T0, regimes: ['GDPR', 'NIS2', 'DORA'],
            early_warning_due_at: plus(24 * HOUR_MS), deadline_at: plus(72 * HOUR_MS), final_report_due_at: plus(30 * DAY_MS), customer_notice_due_at: plus(4 * HOUR_MS),
        };
        const clocks = clocksOf(inc);
        expect(clocks.map(c => c.stage)).toEqual(['early_warning', 'notification', 'final_report', 'customer_notice']);
        expect(clocks.some(c => c.derived)).toBe(false);
        expect(nextClock(inc).stage).toBe('customer_notice'); // the earliest due wins
        expect(nextCraStage(inc)).toBe(null);
    });

    it('a row without any clock has none', () => {
        expect(clocksOf({ status: 'open' })).toEqual([]);
        expect(nextClock({ status: 'open' })).toBe(null);
        expect(clocksOf(null)).toEqual([]);
    });
});

describe('incidentClocks — status tone, CVE parsing and the create body', () => {
    it('maps status to tone', () => {
        expect(toneOfIncidentStatus('open')).toBe('error');
        expect(toneOfIncidentStatus('assessing')).toBe('warning');
        expect(toneOfIncidentStatus('early_warning_sent')).toBe('warning');
        expect(toneOfIncidentStatus('authority_notified')).toBe('neutral');
        expect(toneOfIncidentStatus('closed')).toBe('success');
    });

    it('parses CVE ids from commas, spaces and newlines, upper-cased and deduped', () => {
        expect(parseCveIds('cve-2026-1234, CVE-2026-5678\nCVE-2026-1234')).toEqual(['CVE-2026-1234', 'CVE-2026-5678']);
        expect(parseCveIds('')).toEqual([]);
    });

    it('builds an allow-listed body: vulnerability fields only for a vulnerability, high_risk only for a breach', () => {
        const vuln = createBodyOf({ title: ' Heap overflow ', description: '', severity: 'high', occurred_at: '', cve_ids: 'CVE-2026-1', exploited_in_wild: true, affected_products: 'agent-hub 1.2 – 1.4\nserver', high_risk: true, evil: 'x' }, 'vulnerability');
        expect(vuln).toEqual({
            kind: 'vulnerability', title: 'Heap overflow', description: undefined, severity: 'high', occurred_at: undefined,
            cve_ids: ['CVE-2026-1'], exploited_in_wild: true,
            affected_products: [{ name: 'agent-hub', version_range: '1.2 – 1.4' }, { name: 'server', version_range: undefined }],
        });
        expect('high_risk' in vuln).toBe(false);
        expect('evil' in vuln).toBe(false);
        const breach = createBodyOf({ title: 'Lost laptop', description: 'unencrypted', severity: 'medium', occurred_at: '2026-09-13T10:00', high_risk: true, cve_ids: 'CVE-1' }, 'breach');
        expect(breach).toEqual({ kind: 'breach', title: 'Lost laptop', description: 'unencrypted', severity: 'medium', occurred_at: '2026-09-13T10:00', high_risk: true });
    });
});
