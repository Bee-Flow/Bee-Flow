// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
    clocksOf, nextClock, lastDone, nextCraStage, kindsOfSection, matchesSection, kindOf,
    parseCveIds, createBodyOf, URGENT_BELOW,
    isClosedUnfiled, filedCount, reportingRowsOf, stepsOf, localToIso, localInputValue,
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
        // deadline_at is the server's EARLIEST open clock, not the notification:
        // the notification has no column and is 72 h after detection.
        const inc = {
            kind: 'vulnerability', status: 'early_warning_sent', detected_at: T0,
            early_warning_due_at: plus(20 * HOUR_MS), early_warning_sent_at: plus(3 * HOUR_MS),
            deadline_at: plus(72 * HOUR_MS), final_report_due_at: plus(13 * DAY_MS),
        };
        const clocks = clocksOf(inc);
        expect(clocks[0]).toMatchObject({ stage: 'early_warning', dueAt: plus(20 * HOUR_MS), sentAt: plus(3 * HOUR_MS), derived: false });
        expect(clocks[1]).toMatchObject({ stage: 'notification', dueAt: plus(72 * HOUR_MS), sentAt: null, derived: true });
        expect(clocks[2]).toMatchObject({ stage: 'final_report', dueAt: plus(13 * DAY_MS), derived: false });
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

    it('closing a vulnerability stops every unfiled stage as notFiled — never as filed at closed_at', () => {
        const inc = { kind: 'vulnerability', status: 'closed', detected_at: T0, closed_at: plus(5 * HOUR_MS) };
        expect(nextClock(inc)).toBe(null);
        expect(clocksOf(inc).every(c => c.notFiled && c.sentAt === null)).toBe(true);
        expect(lastDone(inc)).toBe(null);
        expect(isClosedUnfiled(inc)).toBe(true);
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

    it('a NIS2 + DORA row lists early warning, notification, final report and the customer notice; only the notification is derived', () => {
        // As the server stores it: deadline_at is the earliest open clock, here the DORA customer notice.
        const inc = {
            kind: 'security_incident', status: 'open', detected_at: T0, regimes: ['GDPR', 'NIS2', 'DORA'],
            early_warning_due_at: plus(24 * HOUR_MS), deadline_at: plus(4 * HOUR_MS), final_report_due_at: plus(30 * DAY_MS), customer_notice_due_at: plus(4 * HOUR_MS),
        };
        const clocks = clocksOf(inc);
        expect(clocks.map(c => c.stage)).toEqual(['early_warning', 'notification', 'final_report', 'customer_notice']);
        expect(clocks.filter(c => c.derived).map(c => c.stage)).toEqual(['notification']);
        expect(clocks[1].dueAt).toBe(plus(72 * HOUR_MS));
        expect(nextClock(inc).stage).toBe('customer_notice'); // the earliest due wins
        expect(nextCraStage(inc)).toBe(null);
    });

    it('a closed breach that was deliberately not notified: notFiled, no running clock, "closed · not notified"', () => {
        // The server empties deadline_at once an incident is closed (incidentStore.nextOpenDeadline).
        const inc = { status: 'closed', detected_at: T0, deadline_at: null, recipients_notified_at: plus(HOUR_MS) };
        expect(clocksOf(inc)).toEqual([expect.objectContaining({ stage: 'notification', sentAt: null, notFiled: true })]);
        expect(nextClock(inc)).toBe(null);
        expect(isClosedUnfiled(inc)).toBe(true);
        expect(filedCount(inc)).toEqual({ filed: 0, total: 1 });
        // a notified-then-closed breach is filed, not "not notified"
        const notified = { ...inc, authority_notified_at: plus(30 * HOUR_MS) };
        expect(isClosedUnfiled(notified)).toBe(false);
        expect(lastDone(notified).sentAt).toBe(plus(30 * HOUR_MS));
        expect(filedCount(notified)).toEqual({ filed: 1, total: 1 });
        // an open breach is never notFiled
        expect(clocksOf({ ...inc, status: 'assessing' })[0].notFiled).toBe(false);
    });

    it('a notified breach keeps its filed notification after the server cleared deadline_at', () => {
        const inc = { status: 'authority_notified', detected_at: T0, deadline_at: null, authority_notified_at: plus(30 * HOUR_MS), authority_reference: 'AP-1' };
        expect(clocksOf(inc)).toEqual([expect.objectContaining({ stage: 'notification', dueAt: plus(72 * HOUR_MS), sentAt: plus(30 * HOUR_MS) })]);
        expect(filedCount(inc)).toEqual({ filed: 1, total: 1 });
        expect(reportingRowsOf(inc).find(r => r.id === 'notification')).toMatchObject({ reference: 'AP-1', filedAt: plus(30 * HOUR_MS) });
    });

    it('a DORA-only incident has the customer notice and no authority notification', () => {
        const inc = { kind: 'security_incident', status: 'open', detected_at: T0, regimes: ['DORA'], deadline_at: plus(4 * HOUR_MS), customer_notice_due_at: plus(4 * HOUR_MS) };
        expect(clocksOf(inc).map(c => c.stage)).toEqual(['customer_notice']);
        expect(stepsOf(inc).primary).toBe('customers');
    });

    it('a row without any clock has none', () => {
        expect(clocksOf({ status: 'open' })).toEqual([]);
        expect(nextClock({ status: 'open' })).toBe(null);
        expect(clocksOf(null)).toEqual([]);
    });
});

describe('incidentClocks — the drawer\'s Reporting list and filing steps', () => {
    const BREACH = { status: 'open', high_risk: true, detected_at: T0, deadline_at: plus(72 * HOUR_MS) };

    it('Reporting: recipients, the stages, then Art. 34 for a high-risk breach; the authority row carries its reference', () => {
        const rows = reportingRowsOf({ ...BREACH, authority_notified_at: plus(20 * HOUR_MS), authority_reference: 'AP-1' });
        expect(rows.map(r => r.id)).toEqual(['recipients', 'notification', 'subjects']);
        expect(rows[1]).toMatchObject({ dueAt: plus(72 * HOUR_MS), filedAt: plus(20 * HOUR_MS), reference: 'AP-1', notFiled: false });
        expect(rows[0]).toMatchObject({ dueAt: null, filedAt: null, notFiled: false });
        expect(reportingRowsOf({ ...BREACH, high_risk: false }).map(r => r.id)).toEqual(['recipients', 'notification']);
        const closed = reportingRowsOf({ ...BREACH, status: 'closed' });
        expect(closed.find(r => r.id === 'notification').notFiled).toBe(true);
    });

    it('Reporting for a vulnerability: the CRA stages (with the channel) and the customer notice', () => {
        const rows = reportingRowsOf({ kind: 'vulnerability', status: 'early_warning_sent', detected_at: T0, early_warning_sent_at: plus(HOUR_MS), reported_via: 'ENISA SRP' });
        expect(rows.map(r => r.id)).toEqual(['early_warning', 'notification', 'final_report', 'customers']);
        expect(rows[0]).toMatchObject({ filedAt: plus(HOUR_MS), via: 'ENISA SRP' });
    });

    it('steps: the running stage\'s action is primary; the rest stay reachable', () => {
        expect(stepsOf(BREACH)).toEqual({ primary: 'authority', others: ['subjects'] });
        expect(stepsOf({ ...BREACH, authority_notified_at: plus(HOUR_MS) })).toEqual({ primary: 'subjects', others: [] });
        // DORA: the 4 h customer notice runs first
        const dora = { ...BREACH, high_risk: false, customer_notice_due_at: plus(4 * HOUR_MS) };
        expect(stepsOf(dora)).toEqual({ primary: 'customers', others: ['authority'] });
        // CRA: the early warning, then the full report; the customer notice is always reachable
        const vuln = { kind: 'vulnerability', status: 'open', detected_at: T0 };
        expect(stepsOf(vuln)).toEqual({ primary: 'cra_early_warning', others: ['customers'] });
        expect(stepsOf({ ...vuln, early_warning_sent_at: plus(HOUR_MS) }).primary).toBe('cra_notification');
        expect(stepsOf({ ...BREACH, status: 'closed' })).toEqual({ primary: null, others: [] });
    });
});

describe('incidentClocks — CVE parsing and the create body', () => {
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
        expect(breach).toEqual({ kind: 'breach', title: 'Lost laptop', description: 'unencrypted', severity: 'medium', occurred_at: new Date('2026-09-13T10:00').toISOString(), high_risk: true });
    });

    it('sends when the organisation became aware (detected_at) as an ISO instant, so the 72 h run from there', () => {
        const body = createBodyOf({ title: 'Found yesterday', severity: 'high', detected_at: '2026-10-05T09:30' }, 'breach');
        expect(body.detected_at).toBe(new Date('2026-10-05T09:30').toISOString());
        expect(Object.keys(body)).toContain('detected_at');
        expect(createBodyOf({ title: 'x', detected_at: '' }, 'breach').detected_at).toBeUndefined();
        expect(localToIso('not a date')).toBeUndefined();
    });

    it('the form\'s datetime-local value is the reader\'s own clock, and reads back as the same minute', () => {
        const ms = new Date(2026, 9, 5, 9, 30, 42).getTime();
        expect(localInputValue(ms)).toBe('2026-10-05T09:30');
        expect(localToIso(localInputValue(ms))).toBe(new Date(2026, 9, 5, 9, 30).toISOString());
    });
});
