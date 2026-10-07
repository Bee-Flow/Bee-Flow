import { describe, expect, it } from 'vitest';
import {
    buildPutBody,
    classifyChange,
    defaultStartDate,
    effectiveFromFor,
    formFromSettings,
    type ChatMonitoringForm,
    type PreviewContext,
    type StoredSettings,
} from './chatMonitoringForm';
import { dpiaView, previewMissing } from './chatMonitoringPreview';

const NOW = new Date('2026-10-07T10:00:00.000Z');

const OFF_SETTINGS: StoredSettings = {
    enabled: false, surfaces: [], signals: [], effective_from: null, retention_days: 90,
    legal_basis: null, lia_at: null, works_council: null, works_council_reason: null, works_council_at: null,
    works_council_scope: { surfaces: [], signals: [], max_retention_days: null },
    dpia_ref: null, dpia_at: null, dpia_risk_level: null, dpo_advice_at: null, prior_consultation_at: null,
    notice_url: null, notice_published_at: null, enabled_at: null, enabled_by_name: null,
};

const ctx = (over: Partial<PreviewContext> = {}): PreviewContext => ({
    before: OFF_SETTINGS, dpia: null, dpoRecorded: false, privacyNoticeUrlSet: false, now: NOW, ...over,
});

/** A form that satisfies every precondition for direct chat. */
function readyForm(over: Partial<ChatMonitoringForm> = {}): ChatMonitoringForm {
    return {
        ...formFromSettings(OFF_SETTINGS, NOW),
        surfaces: ['direct'],
        legal_basis: 'art6_1_e',
        works_council: 'not_applicable', works_council_reason: 'no_works_council',
        dpia_external: true, dpia_ref: 'DPIA-2026-04', dpia_at: '2026-09-01', dpia_risk_level: 'medium',
        notice_url: 'https://intranet.example.org/chat-signals', notice_published_at: '2026-10-01',
        ack_notice_published: true, ack_ropa_reviewed: true,
        ...over,
    };
}

describe('formFromSettings and the start date', () => {
    it('starts with outcomes, retention 90 and a start date seven days out', () => {
        const form = formFromSettings(OFF_SETTINGS, NOW);
        expect(form.signals).toEqual(['outcomes']);
        expect(form.retention_days).toBe('90');
        expect(form.start_date).toBe('2026-10-14');
        expect(defaultStartDate(NOW)).toBe('2026-10-14');
    });

    it('sends the default start as null (the server sets now + 7 days), today as now, other days as UTC midnight', () => {
        expect(effectiveFromFor('2026-10-14', NOW)).toBeNull();
        expect(effectiveFromFor('2026-10-07', NOW)).toBe(NOW.toISOString());
        expect(effectiveFromFor('2026-10-20', NOW)).toBe('2026-10-20T00:00:00.000Z');
        expect(effectiveFromFor('nonsense', NOW)).toBeNull();
    });
});

describe('buildPutBody: an explicit list of fields', () => {
    it('builds the strict body with field codes only, nothing else', () => {
        const body = buildPutBody(readyForm(), { enabled: true, now: NOW });
        expect(Object.keys(body).sort()).toEqual([
            'acknowledgements', 'dpia_at', 'dpia_ref', 'dpia_risk_level', 'dpo_advice_at', 'effective_from', 'enabled',
            'legal_basis', 'notice_published_at', 'notice_url', 'prior_consultation_at', 'retention_days', 'signals',
            'surfaces', 'works_council', 'works_council_at', 'works_council_reason', 'works_council_scope',
        ]);
        expect(body).toMatchObject({
            enabled: true, surfaces: ['direct'], signals: ['outcomes'], retention_days: 90, effective_from: null,
            works_council: 'not_applicable', works_council_reason: 'no_works_council', works_council_at: null, works_council_scope: null,
            acknowledgements: { notice_published: true, ropa_reviewed: true },
        });
    });

    it('drops the external DPIA fields when the DPIA is kept inside Bee Flow, and the reason unless not applicable', () => {
        const body = buildPutBody(readyForm({ dpia_external: false, works_council: 'consent', works_council_at: '2026-09-15', scope_surfaces: ['direct'] }), { enabled: true, now: NOW });
        expect(body).toMatchObject({ dpia_ref: null, dpia_at: null, dpia_risk_level: null, works_council_reason: null, works_council_at: '2026-09-15' });
        expect(body.works_council_scope).toEqual({ surfaces: ['direct'], signals: ['outcomes'], max_retention_days: 90 });
    });

    it('always keeps outcomes first, and switching off sends no start date', () => {
        expect(buildPutBody(readyForm({ signals: ['kinds'] }), { enabled: true, now: NOW }).signals).toEqual(['outcomes', 'kinds']);
        expect(buildPutBody(readyForm({ start_date: '2026-10-20' }), { enabled: false, now: NOW }).effective_from).toBeNull();
    });
});

describe('classifyChange', () => {
    const ON: StoredSettings = { ...OFF_SETTINGS, enabled: true, surfaces: ['direct'], signals: ['outcomes'], legal_basis: 'art6_1_e', effective_from: '2026-10-14T10:00:00.000Z' };
    const body = (over: Partial<ChatMonitoringForm>, enabled = true) => buildPutBody({ ...formFromSettings(ON, NOW), ...over }, { enabled, now: NOW });

    it('from off is a widen that switches on', () => {
        const c = classifyChange(OFF_SETTINGS, buildPutBody(readyForm(), { enabled: true, now: NOW }));
        expect(c).toMatchObject({ widen: true, switchOn: true, employeeWidened: true, visitorOnly: false });
    });

    it('a website-visitor chat alone is a visitor-only widen', () => {
        const c = classifyChange(OFF_SETTINGS, buildPutBody(readyForm({ surfaces: ['agent_public'] }), { enabled: true, now: NOW }));
        expect(c).toMatchObject({ widen: true, employeeWidened: false, visitorOnly: true });
    });

    it('adding a signal or a longer retention widens; removing narrows; the notice alone maintains', () => {
        expect(classifyChange(ON, body({ signals: ['outcomes', 'kinds'] }))).toMatchObject({ widen: true, employeeWidened: true });
        expect(classifyChange({ ...ON, retention_days: 60 }, body({ retention_days: '90' })).widen).toBe(true);
        expect(classifyChange(ON, body({ retention_days: '60' }))).toMatchObject({ widen: false, narrow: true });
        expect(classifyChange(ON, body({ notice_url: 'https://new.example.org' }))).toMatchObject({ widen: false, narrow: false, maintain: true });
        expect(classifyChange(ON, body({}, false))).toMatchObject({ off: true, narrow: true, widen: false });
    });
});

describe('previewMissing: the global rules', () => {
    it('a ready form has nothing missing', () => {
        expect(previewMissing(readyForm(), ctx())).toEqual([]);
    });

    it('names an empty selection, a missing basis and the acknowledgements on a widen', () => {
        const codes = previewMissing(readyForm({ surfaces: [], legal_basis: '', ack_notice_published: false, ack_ropa_reviewed: false }), ctx());
        expect(codes).toEqual(expect.arrayContaining(['surfaces_required', 'legal_basis', 'notice_published', 'ropa_reviewed']));
    });

    it('legitimate interest needs the LIA attested, unless it is already on file for that basis', () => {
        expect(previewMissing(readyForm({ legal_basis: 'art6_1_f' }), ctx())).toEqual(['lia_documented']);
        expect(previewMissing(readyForm({ legal_basis: 'art6_1_f', ack_lia_documented: true }), ctx())).toEqual([]);
        const before = { ...OFF_SETTINGS, legal_basis: 'art6_1_f' as const, lia_at: '2026-09-01T00:00:00.000Z' };
        expect(previewMissing(readyForm({ legal_basis: 'art6_1_f' }), ctx({ before }))).toEqual([]);
    });

    it('a retention outside 30 to 90 days', () => {
        expect(previewMissing(readyForm({ retention_days: '120' }), ctx())).toEqual(['retention_days']);
    });

    it('a start date in the past, or earlier than seven days without "people were informed"', () => {
        expect(previewMissing(readyForm({ start_date: '2026-10-01' }), ctx())).toEqual(['effective_from']);
        expect(previewMissing(readyForm({ start_date: '2026-10-09' }), ctx())).toEqual(['informed_before_start']);
        expect(previewMissing(readyForm({ start_date: '2026-10-09', ack_informed_before_start: true }), ctx())).toEqual([]);
    });
});

describe('previewMissing: the employee preconditions', () => {
    it('pending blocks employee chat types only', () => {
        expect(previewMissing(readyForm({ works_council: 'pending' }), ctx())).toEqual(['works_council']);
        expect(previewMissing(readyForm({ surfaces: ['agent_public'], works_council: 'pending' }), ctx({ privacyNoticeUrlSet: true }))).toEqual([]);
    });

    it('not applicable needs a reason; consent needs a date and a scope that covers the selection', () => {
        expect(previewMissing(readyForm({ works_council_reason: '' }), ctx())).toEqual(['works_council_reason']);
        expect(previewMissing(readyForm({ works_council: 'consent', scope_surfaces: [] }), ctx()))
            .toEqual(['works_council_at', 'works_council_scope']);
        expect(previewMissing(readyForm({ works_council: 'consent', works_council_at: '2026-09-15', scope_surfaces: ['direct'] }), ctx())).toEqual([]);
    });

    it('a wider scope needs a newer decision date than the stored one', () => {
        const before: StoredSettings = {
            ...OFF_SETTINGS, works_council: 'consent', works_council_at: '2026-09-15',
            works_council_scope: { surfaces: ['direct'], signals: ['outcomes'], max_retention_days: 90 },
        };
        const form = readyForm({ surfaces: ['direct', 'agent'], works_council: 'consent', works_council_at: '2026-09-15', scope_surfaces: ['direct', 'agent'] });
        expect(previewMissing(form, ctx({ before }))).toEqual(['works_council_scope']);
        expect(previewMissing({ ...form, works_council_at: '2026-10-01' }, ctx({ before }))).toEqual([]);
    });

    it('the DPIA: current, with a risk level; a high risk needs the prior consultation; a DPO needs the advice date', () => {
        expect(previewMissing(readyForm({ dpia_external: false }), ctx())).toEqual(['dpia']);
        expect(previewMissing(readyForm({ dpia_at: '2025-09-01' }), ctx())).toEqual(['dpia']);
        expect(previewMissing(readyForm({ dpia_risk_level: '' }), ctx())).toEqual(['dpia_risk_level']);
        expect(previewMissing(readyForm({ dpia_risk_level: 'high' }), ctx())).toEqual(['prior_consultation_at']);
        expect(previewMissing(readyForm(), ctx({ dpoRecorded: true }))).toEqual(['dpo_advice_at']);
    });

    it('an internal DPIA record wins over the external fields', () => {
        const internal = { kind: 'internal' as const, current: true, expires_at: '2027-09-01', risk_level: 'low' as const, approved_at: '2026-09-01' };
        expect(previewMissing(readyForm({ dpia_external: false }), ctx({ dpia: internal }))).toEqual([]);
        expect(dpiaView(readyForm(), internal, NOW)).toMatchObject({ kind: 'internal', current: true, riskLevel: 'low' });
    });

    it('the staff notice: an https link, published on or before the start date', () => {
        expect(previewMissing(readyForm({ notice_url: 'http://intranet.example.org' }), ctx())).toEqual(['notice_url']);
        expect(previewMissing(readyForm({ notice_published_at: '2026-10-20' }), ctx())).toEqual(['notice_published_at']);
    });

    it('a typed link that is not https is refused even for website visitors alone', () => {
        const visitors = readyForm({ surfaces: ['agent_public'], notice_url: 'http://www.example.org/privacy' });
        expect(previewMissing(visitors, ctx({ privacyNoticeUrlSet: true }))).toEqual(['notice_url']);
    });

    it('a works-council scope needs a whole retention of 30 to 90 days', () => {
        const form = readyForm({ works_council: 'consent', works_council_at: '2026-09-15', scope_surfaces: ['direct'], scope_max_retention: '120' });
        expect(previewMissing(form, ctx())).toEqual(['works_council_scope']);
    });

    it('website visitors need an https notice, theirs or the privacy notice', () => {
        const visitors = readyForm({ surfaces: ['agent_public'], notice_url: '' });
        expect(previewMissing(visitors, ctx())).toEqual(['agent_public_notice']);
        expect(previewMissing(visitors, ctx({ privacyNoticeUrlSet: true }))).toEqual([]);
    });

    it('switching off or only narrowing needs nothing', () => {
        const before: StoredSettings = { ...OFF_SETTINGS, enabled: true, surfaces: ['direct', 'agent'], signals: ['outcomes'], legal_basis: 'art6_1_e' };
        expect(previewMissing({ ...formFromSettings(before, NOW), surfaces: ['direct'] }, ctx({ before }))).toEqual([]);
    });
});
