/**
 * The chat-signals readers over the server's real shapes (buildView, the
 * summary, the ROPA) and over junk: an allow-list, never a throw.
 */
import {
    readCell,
    readChatSignalsConfig,
    readChatSignalsRopa,
    readChatSignalsSummary,
    readDeletedCount,
    readMissingCodes,
} from './chatSignalsReaders';

const VIEW = {
    settings: {
        enabled: true, surfaces: ['agent_public', 'direct', 'notebook'], signals: ['kinds', 'outcomes', 'mood'],
        effective_from: '2026-09-01T00:00:00.000Z', retention_days: 60, legal_basis: 'art6_1_f', lia_at: '2026-08-20',
        works_council: 'consent', works_council_reason: null, works_council_at: '2026-08-15',
        works_council_scope: { surfaces: ['direct', 'agent_public'], signals: ['outcomes'], max_retention_days: 60 },
        dpia_ref: '  ', dpia_at: null, dpia_risk_level: 'extreme', notice_url: 'https://n.example', enabled_by_name: 'Ada',
    },
    effective: { state: 'on', from: '2026-09-01', surfaces: ['direct'], paused: [{ surface: 'agent_public', missing: ['agent_public_notice', 'Bad Code!'] }, { missing: [] }], signals: ['outcomes'] },
    catalogue: { surfaces: [{ id: 'direct', population: 'employees', available: true }, { id: 'agent_public', population: 'visitors', available: true }, { id: 'BAD' }], retention: { min: 30, max: 90, default: 90 }, k: { outcomes: 5, kinds: 10 } },
    dpia: { kind: 'internal', current: true, expires_at: '2027-06-01', risk_level: 'medium', approved_at: '2026-06-01' },
    dpo_recorded: true,
    can_widen: false,
    install_has_organisations: true,
    contributors: { direct: '10-24', agent: 'many many people', 'Bad Key': '<5' },
    privacy_notice_url_set: true,
    template: { dpo_contact: 'dpo@example.org', dsr_url: '', shield_log_retention_days: 30 },
};

describe('readChatSignalsConfig', () => {
    it('reads the server view through the allow-list', () => {
        const c = readChatSignalsConfig(VIEW);
        expect(c.settings).toMatchObject({
            enabled: true, surfaces: ['direct', 'agent_public'], signals: ['outcomes', 'kinds'], retention_days: 60,
            legal_basis: 'art6_1_f', works_council: 'consent', dpia_ref: null, dpia_risk_level: null, enabled_by_name: 'Ada',
            works_council_scope: { surfaces: ['direct'], signals: ['outcomes'], max_retention_days: 60 },
        });
        expect(c.effective).toEqual({ state: 'on', from: '2026-09-01', surfaces: ['direct'], paused: [{ surface: 'agent_public', missing: ['agent_public_notice'] }], signals: ['outcomes'] });
        expect(c.catalogue.surfaces.map((s) => `${s.id}:${s.population}`)).toEqual(['direct:employees', 'agent_public:visitors']);
        expect(c.dpia).toEqual({ kind: 'internal', current: true, expires_at: '2027-06-01', risk_level: 'medium', approved_at: '2026-06-01' });
        expect(c.contributors).toEqual({ direct: '10-24' });
        expect(c.template).toEqual({ dpoContact: 'dpo@example.org', dsrUrl: null, shieldLogRetentionDays: 30 });
        expect(c).toMatchObject({ dpoRecorded: true, canWiden: false, installHasOrganisations: true, privacyNoticeUrlSet: true });
    });

    it.each([null, 'oops', [], 42, { settings: 'x', catalogue: { surfaces: 'x' } }])('reads %p as an all-off view', (junk) => {
        const c = readChatSignalsConfig(junk);
        expect(c.settings).toMatchObject({ enabled: false, surfaces: [], signals: [], retention_days: 90, legal_basis: null });
        expect(c.effective.state).toBe('off');
        expect(c.catalogue.surfaces.map((s) => s.id)).toEqual(['direct', 'agent', 'agent_public', 'notebook']);
        expect(c.catalogue.retention).toEqual({ min: 30, max: 90, default: 90 });
        expect(c.dpia.kind).toBe('none');
        expect(c.canWiden).toBe(false);
    });
});

describe('readChatSignalsSummary', () => {
    it('reads figures, drops health, and reads unknown cells as hidden', () => {
        const s = readChatSignalsSummary({
            window: { days: 30 },
            surfaces: {
                agent_public: { status: 'no_data' },
                direct: {
                    status: 'shown', k: 5, contributors: '10-24', turns: 120,
                    pct: { scanned: 98.5, blocked: '<5', sent_anyway: 'secret', 'Bad Key': 1, failed: null, neg: -1 },
                    kinds: { status: 'shown', k: 10, rows: { email: { protected: 12, exposed: '<5' }, health: { protected: 3 } } },
                },
                notebook: { status: 'shown' },
            },
        });
        expect(s.surfaces.map((x) => x.surface)).toEqual(['direct', 'agent_public']);
        const direct = s.surfaces[0]!.figures;
        expect(direct.pct).toEqual({ scanned: 98.5, blocked: '<5', sent_anyway: 'hidden', failed: null, neg: 'hidden' });
        expect(direct.kinds.rows).toEqual([{ kind: 'email', protected: 12, exposed: '<5' }]);
        expect(s.surfaces[1]!.figures).toMatchObject({ status: 'no_data', turns: null, kinds: { status: 'off', rows: [] } });
    });

    it('reads junk as no surfaces', () => {
        expect(readChatSignalsSummary('x')).toEqual({ surfaces: [] });
        expect(readCell({})).toBe('hidden');
        expect(readCell(undefined)).toBeNull();
    });
});

describe('readChatSignalsRopa', () => {
    it('keeps only the chat-signals activity and a real controller name', () => {
        const r = readChatSignalsRopa({
            organization_id: 'org-1',
            controller: { name: 'Acme BV' },
            activities: [
                { activity_id: 'other', name: 'Other' },
                { activity_id: 'chat-compliance-signals', name: 'Chat signals', purpose: 'P', processing: 'X', retention: '60 days', legal_basis: 'Art. 6(1)(f)', data_categories: ['a', 1], data_subjects: ['b'], security_measures: ['c'], recipients: 'leak' },
            ],
        });
        expect(r).toEqual({
            controllerName: 'Acme BV',
            activity: { name: 'Chat signals', purpose: 'P', processing: 'X', retention: '60 days', legal_basis: 'Art. 6(1)(f)', data_categories: ['a'], data_subjects: ['b'], security_measures: ['c'] },
        });
        expect(readChatSignalsRopa({ organization_id: 'org-1', controller: { name: 'org-1' }, activities: 'x' })).toEqual({ activity: null, controllerName: null });
    });
});

it('reads the refusal codes and the deleted count', () => {
    expect(readMissingCodes({ code: 'chat_monitoring_preconditions', details: { missing: ['dpia', 'Bad!', 3] } })).toEqual(['dpia']);
    expect(readMissingCodes(null)).toEqual([]);
    expect(readDeletedCount({ deleted: 7 })).toBe(7);
    expect(readDeletedCount('x')).toBe(0);
});
