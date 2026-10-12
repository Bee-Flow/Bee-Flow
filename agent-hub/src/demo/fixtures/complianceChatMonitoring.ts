/**
 * Chat signals in the Compliance demo: switched OFF, as routes/compliance/
 * chatMonitoring.js `buildView` answers for an organisation that never set
 * them up.
 *
 * Van Dael Assurantiën has not opted in, so the Settings card shows the
 * set-up path and nothing was ever counted: no DPIA for it, no works-council
 * decision, no notice, and every contributor band is the smallest one. The
 * two checks that judge chat signals read "not applicable" for the same
 * reason (compliance.js STATUS_OVERRIDES).
 *
 * Only the configuration read is fixtured. Switching chat signals on is a
 * legally gated write (DPIA, works council, a published notice) that a demo
 * tab cannot honestly attest to; the demo transport answers it with its own
 * "Not available in the demo".
 */

type Settings = { dpo_name?: string | null; dpo_email?: string | null; privacy_notice_url?: string | null; public_base_url?: string | null };
type Ctx = { state: { settings: Settings } };

// stores/lib/chatMonitoringVocab.js
const SURFACES = ['direct', 'agent', 'agent_public'] as const;
const EMPLOYEE_SURFACES = ['direct', 'agent'] as const;
const FUTURE_SURFACES = ['notebook'] as const;
const SIGNALS = ['outcomes', 'kinds'] as const;
const LEGAL_BASES = ['art6_1_f', 'art6_1_e', 'art6_1_c'];
const WORKS_COUNCIL = ['consent', 'court_replacement', 'not_applicable', 'pending'];
const WORKS_COUNCIL_REASONS = ['no_works_council', 'pvt_without_consent_right', 'cao_regulates', 'outside_nl'];
const DPIA_RISK_LEVELS = ['low', 'medium', 'high'];
const RETENTION = { min: 30, max: 90, default: 90 };
const K = { outcomes: 5, kinds: 10 };
// jobs/monitoringRetention.js default (MONITORING_LOG_RETENTION_DAYS unset).
const SHIELD_LOG_RETENTION_DAYS = 400;

const httpsUrl = (v: unknown) => typeof v === 'string' && /^https:\/\/\S+$/.test(v.trim());
const originOf = (v: unknown) => {
    try { return typeof v === 'string' && v ? new URL(v).origin : ''; } catch { return ''; }
};

/** GET /api/compliance/chat-monitoring for an organisation with chat signals off. */
export function chatMonitoringView(settings: Settings) {
    return {
        settings: {
            enabled: false,
            surfaces: [],
            signals: [],
            effective_from: null,
            retention_days: RETENTION.default,
            legal_basis: null,
            lia_at: null,
            works_council: null,
            works_council_reason: null,
            works_council_at: null,
            works_council_scope: { surfaces: [], signals: [], max_retention_days: null },
            dpia_ref: null,
            dpia_at: null,
            dpia_risk_level: null,
            dpo_advice_at: null,
            prior_consultation_at: null,
            notice_url: null,
            notice_published_at: null,
            enabled_at: null,
            enabled_by_name: null,
        },
        // core/entitlements/chatMonitoringFlag.js OFF.
        effective: {
            state: 'off', version: null, from: null, surfaces: [], paused: [], signals: [],
            noticeUrl: null, visitorNoticeUrl: null, retentionDays: RETENTION.default,
        },
        catalogue: {
            surfaces: [
                ...SURFACES.map(id => ({ id, population: id === 'agent_public' ? 'visitors' : 'employees', available: true })),
                ...FUTURE_SURFACES.map(id => ({ id, population: 'employees', available: false })),
            ],
            signals: SIGNALS.map(id => ({ id, required: id === 'outcomes', available: true })),
            legal_bases: [...LEGAL_BASES],
            works_council: [...WORKS_COUNCIL],
            works_council_reasons: [...WORKS_COUNCIL_REASONS],
            dpia_risk_levels: [...DPIA_RISK_LEVELS],
            retention: { ...RETENTION },
            k: { ...K },
        },
        dpia: { kind: 'none', current: false, expires_at: null, risk_level: null, approved_at: null },
        dpo_recorded: !!(settings.dpo_name || settings.dpo_email),
        // Nothing was ever counted: the smallest band (chatSignalSuppression.contributorBand(0)).
        contributors: Object.fromEntries(EMPLOYEE_SURFACES.map(s => [s, '<5'])),
        install_has_organisations: true,
        privacy_notice_url_set: httpsUrl(settings.privacy_notice_url),
        template: {
            dpo_contact: settings.dpo_email || null,
            dsr_url: `${originOf(settings.public_base_url)}/dsr`,
            shield_log_retention_days: SHIELD_LOG_RETENTION_DAYS,
        },
        can_widen: true,
    };
}

// The figures (GET …/summary) are only asked for once chat signals are on.
export const CHAT_MONITORING_ROUTES = {
    'GET /api/compliance/chat-monitoring': ({ state }: Ctx) => chatMonitoringView(state.settings),
};
