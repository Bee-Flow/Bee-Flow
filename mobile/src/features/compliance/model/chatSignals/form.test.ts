/**
 * Differential: the web's chatMonitoringForm.ts and this port, run on the
 * same fixtures (off -> on, widening, narrowing, unchanged, switching off).
 * A red line means the web changed: update the port, do not loosen this.
 */
import * as port from './form';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const web = require('../../../../../../agent-hub/src/components/admin/compliance/pages/settings/chatMonitoring/chatMonitoringForm') as typeof port;

const NOW = new Date('2026-10-07T10:30:00.000Z');

const OFF: port.StoredSettings = {
    enabled: false, surfaces: [], signals: [], effective_from: null, retention_days: 90, legal_basis: null, lia_at: null,
    works_council: null, works_council_reason: null, works_council_at: null,
    works_council_scope: { surfaces: [], signals: [], max_retention_days: null },
    dpia_ref: null, dpia_at: null, dpia_risk_level: null, dpo_advice_at: null, prior_consultation_at: null,
    notice_url: null, notice_published_at: null, enabled_at: null, enabled_by_name: null,
};

const ON: port.StoredSettings = {
    ...OFF, enabled: true, surfaces: ['direct', 'agent_public'], signals: ['outcomes'], effective_from: '2026-09-01T00:00:00.000Z',
    retention_days: 60, legal_basis: 'art6_1_f', lia_at: '2026-08-20T12:00:00.000Z', works_council: 'consent',
    works_council_at: '2026-08-15T00:00:00.000Z', works_council_scope: { surfaces: ['direct'], signals: ['outcomes'], max_retention_days: 60 },
    dpia_ref: 'EXT-1', dpia_at: '2026-08-01', dpia_risk_level: 'medium', notice_url: 'https://intranet.example/notice',
    notice_published_at: '2026-08-25T00:00:00.000Z',
};

type Edit = (f: port.ChatMonitoringForm) => port.ChatMonitoringForm;
const CASES: [string, port.StoredSettings, Edit, boolean][] = [
    ['off -> on', OFF, (f) => ({ ...f, surfaces: ['direct', 'agent'], legal_basis: 'art6_1_f', ack_lia_documented: true, ack_notice_published: true }), true],
    ['widening: kinds and an employee chat type', ON, (f) => ({ ...f, surfaces: ['direct', 'agent', 'agent_public'], signals: ['outcomes', 'kinds'] }), true],
    ['widening: longer retention, new scope', ON, (f) => ({ ...f, retention_days: '90', scope_max_retention: '90', works_council_at: '2026-10-01' }), true],
    ['narrowing', ON, (f) => ({ ...f, surfaces: ['direct'], retention_days: '30' }), true],
    ['unchanged', ON, (f) => f, true],
    ['maintain: a new notice link', ON, (f) => ({ ...f, notice_url: ' https://intranet.example/v2 ', start_date: '2026-10-07' }), true],
    ['not applicable with a reason, today as start', OFF, (f) => ({ ...f, surfaces: ['agent'], works_council: 'not_applicable', works_council_reason: 'outside_nl', start_date: '2026-10-07' }), true],
    ['switching off', ON, (f) => f, false],
];

describe('chatMonitoringForm port', () => {
    it.each(CASES)('%s: form, PUT body and change match the web', (_name, before, edit, enabled) => {
        const form = edit(port.formFromSettings(before, NOW));
        expect(form).toEqual(edit(web.formFromSettings(before, NOW)));
        const body = port.buildPutBody(form, { enabled, now: NOW });
        expect(body).toEqual(web.buildPutBody(form, { enabled, now: NOW }));
        expect(port.classifyChange(before, body)).toEqual(web.classifyChange(before, body));
    });

    it('classifies the four kinds of change', () => {
        const kind = (i: number) => {
            const [, before, edit, enabled] = CASES[i]!;
            return port.classifyChange(before, port.buildPutBody(edit(port.formFromSettings(before, NOW)), { enabled, now: NOW }));
        };
        expect(kind(0)).toMatchObject({ widen: true, switchOn: true, employeeWidened: true });
        expect(kind(1)).toMatchObject({ widen: true, employeeWidened: true, switchOn: false });
        expect(kind(3)).toMatchObject({ widen: false, narrow: true });
        expect(kind(4)).toMatchObject({ widen: false, narrow: false, maintain: false });
        expect(kind(7)).toMatchObject({ off: true, narrow: true });
    });

    it('keeps the vocabulary and day helpers in step', () => {
        const vocabulary = (m: typeof port) => [
            m.SURFACES, m.EMPLOYEE_SURFACES, m.SIGNALS, m.LEGAL_BASES, m.WORKS_COUNCIL, m.WORKS_COUNCIL_REASONS,
            m.DPIA_RISK_LEVELS, m.RETENTION, m.NOTICE_LEAD_DAYS, m.MISSING_CODES,
        ];
        expect(vocabulary(port)).toEqual(vocabulary(web));
        for (const day of ['2026-10-07', '2026-10-14', '2026-10-08', 'nope']) expect(port.effectiveFromFor(day, NOW)).toBe(web.effectiveFromFor(day, NOW));
        for (const v of ['https://a.example', 'http://a.example', ' ', 'x'.repeat(501)]) expect(port.isHttpsUrl(v)).toBe(web.isHttpsUrl(v));
        expect(port.defaultStartDate(NOW)).toBe('2026-10-14');
        expect(port.addDaysUtc('2026-12-30', 3)).toBe('2027-01-02');
        expect(port.dayOf('2026-08-15T22:00:00.000Z')).toBe('2026-08-15');
    });

    it('sends acknowledgements only when given, as an explicit allow-list', () => {
        const form = { ...port.formFromSettings(ON, NOW), ack_ropa_reviewed: true, extra: 'leak' } as port.ChatMonitoringForm;
        const body = port.buildPutBody(form, { enabled: true, now: NOW });
        expect(body.acknowledgements).toEqual({ ropa_reviewed: true });
        expect(Object.keys(body)).not.toContain('extra');
    });
});
