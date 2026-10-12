import { describe, expect, it } from 'vitest';
import { deadlinesFromRegisters } from './aggregates';

/**
 * The Deadlines card's client fallback (no GET /deadlines): the same kinds,
 * citations and dates the server sends, so the card reads the same whichever
 * source filled it.
 */

const NOW = new Date('2026-10-07T12:00:00Z').getTime();

describe('deadlinesFromRegisters — a DSR without a server due date', () => {
    it('is due one calendar month after receipt (Art. 12(3)), not 30 days', () => {
        const [item] = deadlinesFromRegisters({ requests: [{ id: 7, status: 'pending', request_type: 'access', created_at: '2026-09-12T09:00:00Z' }], now: NOW });
        expect(item).toMatchObject({ id: 'dsr:7', kind: 'dsr', ref: '#7', due_at: '2026-10-12T09:00:00.000Z', meta: { article: 'GDPR Art. 12(3)' } });
    });

    it('ends on the last day of a short month', () => {
        const [item] = deadlinesFromRegisters({ requests: [{ id: 8, status: 'in_progress', created_at: '2027-01-31T10:00:00Z' }], now: NOW });
        expect(item.due_at).toBe('2027-02-28T10:00:00.000Z');
    });

    it('takes the server due date or the extension when there is one, and skips closed requests', () => {
        const items = deadlinesFromRegisters({
            requests: [
                { id: 1, status: 'pending', created_at: '2026-09-12T09:00:00Z', due_at: '2026-10-10T09:00:00Z' },
                { id: 2, status: 'pending', created_at: '2026-08-01T09:00:00Z', extended_until: '2026-11-01T09:00:00Z' },
                { id: 3, status: 'fulfilled', created_at: '2026-09-01T09:00:00Z' },
            ],
            now: NOW,
        });
        expect(items.map((i) => [i.id, i.due_at])).toEqual([['dsr:1', '2026-10-10T09:00:00Z'], ['dsr:2', '2026-11-01T09:00:00Z']]);
    });
});

describe('deadlinesFromRegisters — incidents and vulnerabilities', () => {
    const base = { status: 'open', title: 'T', detected_at: '2026-10-06T12:00:00Z', deadline_at: '2026-10-09T12:00:00Z' };

    it('an incident cites each regime it is reported under', () => {
        const [item] = deadlinesFromRegisters({ incidents: [{ ...base, id: 31, kind: 'breach', regimes: ['GDPR', 'NIS2'] }], now: NOW });
        expect(item).toMatchObject({ id: 'incident:31', kind: 'incident', ref: 'INC-31', meta: { article: 'GDPR Art. 33 · NIS2 Art. 23(4)' }, target: { section: 'incidents', id: '31' } });
        const [plain] = deadlinesFromRegisters({ incidents: [{ ...base, id: 32, kind: 'breach' }], now: NOW });
        expect(plain.meta.article).toBe('GDPR Art. 33');
    });

    it('a vulnerability counts down its first open CRA stage, with that stage’s article — never GDPR Art. 33', () => {
        const early = { ...base, id: 4, kind: 'vulnerability', early_warning_due_at: '2026-10-07T12:00:00Z' };
        const [a] = deadlinesFromRegisters({ incidents: [early], now: NOW });
        expect(a).toMatchObject({ kind: 'cra_early_warning', meta: { article: 'CRA Art. 14(2)(a)' }, target: { section: 'vulnerabilities', id: '4' } });
        const [b] = deadlinesFromRegisters({ incidents: [{ ...early, early_warning_sent_at: '2026-10-06T20:00:00Z' }], now: NOW });
        expect(b).toMatchObject({ id: 'cra_notification:4', kind: 'cra_notification', meta: { article: 'CRA Art. 14(2)(b)' } });
        const [c] = deadlinesFromRegisters({ incidents: [{ ...early, early_warning_sent_at: '2026-10-06T20:00:00Z', authority_notified_at: '2026-10-07T08:00:00Z' }], now: NOW });
        expect(c).toMatchObject({ kind: 'cra_full_report', meta: { article: 'CRA Art. 14(2)(c)' } });
    });

    it('a severe incident under the CRA alone runs the same stages, cited from Art. 14(4)', () => {
        const severe = { ...base, id: 6, kind: 'security_incident', regimes: '["CRA"]', early_warning_due_at: '2026-10-07T12:00:00Z' };
        const [a] = deadlinesFromRegisters({ incidents: [severe], now: NOW });
        expect(a).toMatchObject({ id: 'cra_early_warning:6', kind: 'cra_early_warning', meta: { article: 'CRA Art. 14(4)(a)' }, target: { section: 'incidents', id: '6' } });
        const [b] = deadlinesFromRegisters({ incidents: [{ ...severe, early_warning_sent_at: '2026-10-06T20:00:00Z' }], now: NOW });
        expect(b).toMatchObject({ kind: 'cra_notification', meta: { article: 'CRA Art. 14(4)(b)' } });
        // Beside another regime it stays one authority row, each regime cited.
        const [c] = deadlinesFromRegisters({ incidents: [{ ...severe, regimes: ['GDPR', 'CRA'] }], now: NOW });
        expect(c).toMatchObject({ kind: 'incident', meta: { article: 'GDPR Art. 33 · CRA Art. 14(4)' } });
    });

    it('the CRA notification turns urgent under 24 hours', () => {
        const row = { ...base, id: 5, kind: 'vulnerability', deadline_at: '2026-10-08T06:00:00Z' };
        expect(deadlinesFromRegisters({ incidents: [row], now: NOW })[0].state).toBe('urgent');
        expect(deadlinesFromRegisters({ incidents: [{ ...row, deadline_at: '2026-10-09T06:00:00Z' }], now: NOW })[0].state).toBe('ok');
    });
});
