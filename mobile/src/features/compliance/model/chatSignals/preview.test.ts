/**
 * Differential: the web's chatMonitoringPreview.ts and this port on the same
 * forms and contexts (missing codes and the DPIA view).
 */
import { formFromSettings, type ChatMonitoringForm, type DpiaInfo, type PreviewContext, type StoredSettings } from './form';
import * as port from './preview';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const web = require('../../../../../../agent-hub/src/components/admin/compliance/pages/settings/chatMonitoring/chatMonitoringPreview') as typeof port;

const NOW = new Date('2026-10-07T10:30:00.000Z');
const OFF: StoredSettings = {
    enabled: false, surfaces: [], signals: [], effective_from: null, retention_days: 90, legal_basis: null, lia_at: null,
    works_council: null, works_council_reason: null, works_council_at: null,
    works_council_scope: { surfaces: [], signals: [], max_retention_days: null },
    dpia_ref: null, dpia_at: null, dpia_risk_level: null, dpo_advice_at: null, prior_consultation_at: null,
    notice_url: null, notice_published_at: null, enabled_at: null, enabled_by_name: null,
};
const ON: StoredSettings = { ...OFF, enabled: true, surfaces: ['agent_public'], signals: ['outcomes'], legal_basis: 'art6_1_e', retention_days: 60 };

const INTERNAL: DpiaInfo = { kind: 'internal', current: true, expires_at: '2027-06-01T00:00:00.000Z', risk_level: 'high', approved_at: '2026-06-01' };
const EXPIRED: DpiaInfo = { kind: 'internal', current: false, expires_at: '2026-01-01', risk_level: 'low', approved_at: null };

const ctx = (before: StoredSettings, dpia: DpiaInfo | null, extra: Partial<PreviewContext> = {}): PreviewContext =>
    ({ before, dpia, dpoRecorded: false, privacyNoticeUrlSet: false, now: NOW, ...extra });

const full = (f: ChatMonitoringForm): ChatMonitoringForm => ({
    ...f, surfaces: ['direct', 'agent'], legal_basis: 'art6_1_f', ack_lia_documented: true, ack_notice_published: true, ack_ropa_reviewed: true,
    works_council: 'consent', works_council_at: '2026-09-01', scope_surfaces: ['direct', 'agent'], notice_url: 'https://n.example',
    notice_published_at: '2026-10-01', prior_consultation_at: '2026-09-15',
});

const CASES: [string, ChatMonitoringForm, PreviewContext][] = [
    ['empty form from off', formFromSettings(OFF, NOW), ctx(OFF, null)],
    ['complete employee set-up', full(formFromSettings(OFF, NOW)), ctx(OFF, INTERNAL)],
    ['expired DPIA, DPO recorded', full(formFromSettings(OFF, NOW)), ctx(OFF, EXPIRED, { dpoRecorded: true })],
    ['external DPIA without risk', { ...full(formFromSettings(OFF, NOW)), dpia_external: true, dpia_ref: 'R', dpia_at: '2026-05-01' }, ctx(OFF, null)],
    ['early start without acknowledgement', { ...full(formFromSettings(OFF, NOW)), start_date: '2026-10-08' }, ctx(OFF, INTERNAL)],
    ['visitors without a privacy notice', { ...formFromSettings(ON, NOW), surfaces: ['agent_public'], signals: ['outcomes', 'kinds'] }, ctx(ON, null)],
    ['visitors with the org notice set', { ...formFromSettings(ON, NOW), surfaces: ['agent_public'], notice_url: 'http://x' }, ctx(ON, null, { privacyNoticeUrlSet: true })],
    ['unchanged while on', formFromSettings(ON, NOW), ctx(ON, null)],
    ['works council pending', { ...full(formFromSettings(OFF, NOW)), works_council: 'pending' }, ctx(OFF, INTERNAL)],
];

describe('chatMonitoringPreview port', () => {
    it.each(CASES)('%s: missing codes and DPIA view match the web', (_name, form, context) => {
        expect(port.previewMissing(form, context)).toEqual(web.previewMissing(form, context));
        expect(port.dpiaView(form, context.dpia, NOW)).toEqual(web.dpiaView(form, context.dpia, NOW));
    });

    it('reads the DPIA as current, expired or none', () => {
        const form = formFromSettings(OFF, NOW);
        expect(port.dpiaView(form, INTERNAL, NOW)).toEqual({ kind: 'internal', current: true, riskLevel: 'high', expiresAt: '2027-06-01' });
        expect(port.dpiaView(form, EXPIRED, NOW)).toMatchObject({ current: false, expiresAt: '2026-01-01' });
        expect(port.dpiaView(form, null, NOW)).toEqual({ kind: 'none', current: false, riskLevel: null, expiresAt: null });
    });

    it('needs nothing for an unchanged configuration, and the preconditions for a new one', () => {
        expect(port.previewMissing(formFromSettings(ON, NOW), ctx(ON, null))).toEqual([]);
        expect(port.previewMissing(formFromSettings(OFF, NOW), ctx(OFF, null))).toEqual(['surfaces_required', 'legal_basis', 'notice_published', 'ropa_reviewed']);
    });
});
