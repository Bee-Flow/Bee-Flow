/**
 * Port of agent-hub chatMonitoring/chatMonitoringForm.ts (the setup form),
 * pinned by form.test.ts, which runs the web module beside it. Change the web
 * file first, then this one.
 *
 * Chat signals, the setup form without React: the vocabulary, the form state
 * and the PUT body built from it, the change classification that picks the
 * button label, and a client-side preview of the server's missing codes
 * (build spec 3.1), so "Switch on" stays disabled until the preconditions
 * hold. The server stays the authority: its 422 list is what the card shows
 * when the two disagree.
 *
 * Days are UTC 'YYYY-MM-DD' strings throughout: the start date people see is
 * the UTC date part of `effective_from`, and string order is date order.
 */

export const SURFACES = ['direct', 'agent', 'agent_public'] as const;
export type Surface = typeof SURFACES[number];
export const EMPLOYEE_SURFACES: readonly Surface[] = ['direct', 'agent'];
export const SIGNALS = ['outcomes', 'kinds'] as const;
export type Signal = typeof SIGNALS[number];
export const LEGAL_BASES = ['art6_1_f', 'art6_1_e', 'art6_1_c'] as const;
export type LegalBasis = typeof LEGAL_BASES[number];
export const WORKS_COUNCIL = ['consent', 'court_replacement', 'not_applicable', 'pending'] as const;
export type WorksCouncil = typeof WORKS_COUNCIL[number];
export const WORKS_COUNCIL_REASONS = ['no_works_council', 'pvt_without_consent_right', 'cao_regulates', 'outside_nl'] as const;
export type WorksCouncilReason = typeof WORKS_COUNCIL_REASONS[number];
export const DPIA_RISK_LEVELS = ['low', 'medium', 'high'] as const;
export type RiskLevel = typeof DPIA_RISK_LEVELS[number];
export const RETENTION = Object.freeze({ min: 30, max: 90, default: 90 });
export const NOTICE_LEAD_DAYS = 7;

/** Every code the server can name, in the order of build spec 3.1; the card lists them in this order. */
export const MISSING_CODES = [
    'surfaces_required', 'surface_not_available', 'outcomes_required', 'signal_not_available', 'legal_basis',
    'lia_documented', 'retention_days', 'notice_published', 'ropa_reviewed', 'effective_from', 'informed_before_start',
    'objection_unavailable', 'default_bucket_has_orgs', 'dpia', 'dpia_risk_level', 'prior_consultation_at', 'dpo_advice_at',
    'works_council', 'works_council_reason', 'works_council_at', 'works_council_scope', 'notice_url', 'notice_published_at',
    'agent_public_notice',
] as const;
export type MissingCode = typeof MISSING_CODES[number];

export interface WorksCouncilScope {
    surfaces: Surface[];
    signals: Signal[];
    max_retention_days: number | null;
}

/** `settings` of GET /api/compliance/chat-monitoring, after the allow-list. */
export interface StoredSettings {
    enabled: boolean;
    surfaces: Surface[];
    signals: Signal[];
    effective_from: string | null;
    retention_days: number;
    legal_basis: LegalBasis | null;
    lia_at: string | null;
    works_council: WorksCouncil | null;
    works_council_reason: WorksCouncilReason | null;
    works_council_at: string | null;
    works_council_scope: WorksCouncilScope;
    dpia_ref: string | null;
    dpia_at: string | null;
    dpia_risk_level: RiskLevel | null;
    dpo_advice_at: string | null;
    prior_consultation_at: string | null;
    notice_url: string | null;
    notice_published_at: string | null;
    enabled_at: string | null;
    enabled_by_name: string | null;
}

/** `dpia` of the GET: the server's view, of which only an internal record matters to the preview. */
export interface DpiaInfo {
    kind: 'internal' | 'external' | 'none';
    current: boolean;
    expires_at: string | null;
    risk_level: RiskLevel | null;
    approved_at: string | null;
}

export interface ChatMonitoringForm {
    surfaces: Surface[];
    signals: Signal[];
    retention_days: string;
    legal_basis: LegalBasis | '';
    works_council: WorksCouncil | '';
    works_council_reason: WorksCouncilReason | '';
    works_council_at: string;
    scope_surfaces: Surface[];
    scope_signals: Signal[];
    scope_max_retention: string;
    dpia_external: boolean;
    dpia_ref: string;
    dpia_at: string;
    dpia_risk_level: RiskLevel | '';
    dpo_advice_at: string;
    prior_consultation_at: string;
    notice_url: string;
    notice_published_at: string;
    start_date: string;
    ack_notice_published: boolean;
    ack_ropa_reviewed: boolean;
    ack_informed_before_start: boolean;
    ack_lia_documented: boolean;
}

export interface PutBody {
    enabled: boolean;
    surfaces: Surface[];
    signals: Signal[];
    effective_from: string | null;
    retention_days: number;
    legal_basis: LegalBasis | null;
    works_council: WorksCouncil | null;
    works_council_reason: WorksCouncilReason | null;
    works_council_at: string | null;
    works_council_scope: WorksCouncilScope | null;
    dpia_ref: string | null;
    dpia_at: string | null;
    dpia_risk_level: RiskLevel | null;
    dpo_advice_at: string | null;
    prior_consultation_at: string | null;
    notice_url: string | null;
    notice_published_at: string | null;
    acknowledgements: { notice_published?: boolean; ropa_reviewed?: boolean; informed_before_start?: boolean; lia_documented?: boolean };
}

export interface ChangeKind {
    widen: boolean;
    narrow: boolean;
    maintain: boolean;
    off: boolean;
    employeeWidened: boolean;
    visitorOnly: boolean;
    switchOn: boolean;
}

export interface PreviewContext {
    before: StoredSettings;
    dpia: DpiaInfo | null;
    dpoRecorded: boolean;
    privacyNoticeUrlSet: boolean;
    now: Date;
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
export const isDay = (v: unknown): v is string => typeof v === 'string' && DAY_RE.test(v);
export const isEmployeeSurface = (s: string): boolean => (EMPLOYEE_SURFACES as readonly string[]).includes(s);

/* ───────────────────────── days ───────────────────────── */

export function utcDay(now: Date): string {
    return now.toISOString().slice(0, 10);
}

export function addDaysUtc(day: string, days: number): string {
    const d = new Date(`${day}T00:00:00.000Z`);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
}

export function defaultStartDate(now: Date): string {
    return addDaysUtc(utcDay(now), NOTICE_LEAD_DAYS);
}

/** The day part of a stored date or timestamp, or ''. */
export function dayOf(value: string | null | undefined): string {
    return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : '';
}

export function isHttpsUrl(value: string | null | undefined): boolean {
    if (typeof value !== 'string' || !value.trim() || value.length > 500) return false;
    try {
        return new URL(value.trim()).protocol === 'https:';
    } catch {
        return false;
    }
}

/**
 * The start date as the PUT sends it. The default (today + 7) goes as null,
 * so the server sets exactly now + 7 days; today goes as this moment (never
 * in the past); any other day as its UTC midnight.
 */
export function effectiveFromFor(startDate: string, now: Date): string | null {
    if (!isDay(startDate) || startDate === defaultStartDate(now)) return null;
    if (startDate === utcDay(now)) return now.toISOString();
    return `${startDate}T00:00:00.000Z`;
}

/* ───────────────────────── form ⇄ settings ───────────────────────── */

function ordered<T extends string>(values: readonly string[], vocabulary: readonly T[]): T[] {
    return vocabulary.filter((v) => values.includes(v));
}

function withOutcomes(signals: readonly string[]): Signal[] {
    return ordered([...signals, 'outcomes'], SIGNALS);
}

export function formFromSettings(s: StoredSettings, now: Date): ChatMonitoringForm {
    const signals = withOutcomes(s.signals);
    const scope = s.works_council_scope;
    const hasScope = scope.surfaces.length > 0 || scope.signals.length > 0;
    return {
        surfaces: ordered(s.surfaces, SURFACES),
        signals,
        retention_days: String(s.retention_days || RETENTION.default),
        legal_basis: s.legal_basis || '',
        works_council: s.works_council || '',
        works_council_reason: s.works_council_reason || '',
        works_council_at: dayOf(s.works_council_at),
        scope_surfaces: hasScope ? ordered(scope.surfaces, EMPLOYEE_SURFACES) : s.surfaces.filter(isEmployeeSurface),
        scope_signals: hasScope ? ordered(scope.signals, SIGNALS) : signals,
        scope_max_retention: String(scope.max_retention_days || s.retention_days || RETENTION.default),
        dpia_external: !!s.dpia_ref,
        dpia_ref: s.dpia_ref || '',
        dpia_at: dayOf(s.dpia_at),
        dpia_risk_level: s.dpia_risk_level || '',
        dpo_advice_at: dayOf(s.dpo_advice_at),
        prior_consultation_at: dayOf(s.prior_consultation_at),
        notice_url: s.notice_url || '',
        notice_published_at: dayOf(s.notice_published_at),
        start_date: defaultStartDate(now),
        ack_notice_published: false,
        ack_ropa_reviewed: false,
        ack_informed_before_start: false,
        ack_lia_documented: false,
    };
}

const orNull = (v: string): string | null => (v.trim() ? v.trim() : null);
const dayOrNull = (v: string): string | null => (isDay(v) ? v : null);
const hasDecision = (wc: string): boolean => wc === 'consent' || wc === 'court_replacement';

function retentionNumber(value: string): number {
    const n = Number(value);
    return Number.isInteger(n) ? n : NaN;
}

function scopeOf(form: ChatMonitoringForm): WorksCouncilScope | null {
    if (!hasDecision(form.works_council)) return null;
    const max = retentionNumber(form.scope_max_retention);
    return {
        surfaces: ordered(form.scope_surfaces, EMPLOYEE_SURFACES),
        signals: withOutcomes(form.scope_signals),
        max_retention_days: Number.isFinite(max) ? max : retentionNumber(form.retention_days),
    };
}

function acknowledgementsOf(form: ChatMonitoringForm): PutBody['acknowledgements'] {
    const out: PutBody['acknowledgements'] = {};
    if (form.ack_notice_published) out.notice_published = true;
    if (form.ack_ropa_reviewed) out.ropa_reviewed = true;
    if (form.ack_informed_before_start) out.informed_before_start = true;
    if (form.ack_lia_documented) out.lia_documented = true;
    return out;
}

/** The PUT body: an explicit list of fields, never the form minus a few keys. */
export function buildPutBody(form: ChatMonitoringForm, { enabled, now }: { enabled: boolean; now: Date }): PutBody {
    const external = form.dpia_external;
    return {
        enabled,
        surfaces: ordered(form.surfaces, SURFACES),
        signals: withOutcomes(form.signals),
        effective_from: enabled ? effectiveFromFor(form.start_date, now) : null,
        retention_days: retentionNumber(form.retention_days),
        legal_basis: form.legal_basis || null,
        works_council: form.works_council || null,
        works_council_reason: form.works_council === 'not_applicable' ? form.works_council_reason || null : null,
        works_council_at: hasDecision(form.works_council) ? dayOrNull(form.works_council_at) : null,
        works_council_scope: scopeOf(form),
        dpia_ref: external ? orNull(form.dpia_ref) : null,
        dpia_at: external ? dayOrNull(form.dpia_at) : null,
        dpia_risk_level: external ? form.dpia_risk_level || null : null,
        dpo_advice_at: dayOrNull(form.dpo_advice_at),
        prior_consultation_at: dayOrNull(form.prior_consultation_at),
        notice_url: orNull(form.notice_url),
        notice_published_at: dayOrNull(form.notice_published_at),
        acknowledgements: acknowledgementsOf(form),
    };
}

/* ───────────────────────── change ───────────────────────── */

const added = <T>(after: readonly T[], before: readonly T[]): T[] => after.filter((x) => !before.includes(x));
const scopeKey = (scope: WorksCouncilScope | null): string => JSON.stringify(scope && scope.surfaces.length
    ? [ordered(scope.surfaces, SURFACES), ordered(scope.signals, SIGNALS), scope.max_retention_days]
    : null);

/** The fields that change nothing about what is counted ("maintain"). */
const MAINTAIN_FIELDS = [
    'works_council', 'works_council_reason', 'works_council_at', 'dpia_ref', 'dpia_at', 'dpia_risk_level',
    'dpo_advice_at', 'prior_consultation_at', 'notice_url', 'notice_published_at',
] as const;

function storedValue(before: StoredSettings, key: typeof MAINTAIN_FIELDS[number]): string | null {
    const v = before[key];
    if (v === null || v === undefined || v === '') return null;
    return key.endsWith('_at') ? dayOf(v) || null : v;
}

interface Deltas {
    surfacesAdded: Surface[];
    signalsAdded: boolean;
    retentionUp: boolean;
    basisChanged: boolean;
    scopeChanged: boolean;
}

/** What grows when an enabled configuration is saved over `before`. From off, everything is new. */
function deltasOf(before: StoredSettings, body: PutBody): Deltas {
    if (!before.enabled) {
        return { surfacesAdded: body.surfaces, signalsAdded: true, retentionUp: false, basisChanged: false, scopeChanged: false };
    }
    return {
        surfacesAdded: added(body.surfaces, before.surfaces),
        signalsAdded: added(body.signals, before.signals).length > 0,
        retentionUp: body.retention_days > before.retention_days,
        basisChanged: body.legal_basis !== before.legal_basis,
        scopeChanged: scopeKey(body.works_council_scope) !== scopeKey(before.works_council_scope),
    };
}

function isNarrowing(before: StoredSettings, body: PutBody): boolean {
    if (!before.enabled) return false;
    return added(before.surfaces, body.surfaces).length > 0
        || added(before.signals, body.signals).length > 0
        || body.retention_days < before.retention_days;
}

/**
 * What saving this body would do, as the server classifies it (build spec
 * 3.2): turning on, a chat type or signal added, a longer retention, another
 * legal basis or another works-council scope widen; the reverse narrows;
 * anything else maintains. A widen "touches employees" when it adds an
 * employee chat type, or grows anything while one is selected.
 */
export function classifyChange(before: StoredSettings, body: PutBody): ChangeKind {
    const wasOn = before.enabled === true;
    if (!body.enabled) {
        return { widen: false, narrow: wasOn, maintain: false, off: true, employeeWidened: false, visitorOnly: false, switchOn: false };
    }
    const d = deltasOf(before, body);
    const grows = d.signalsAdded || d.retentionUp || d.basisChanged || d.scopeChanged;
    const widen = !wasOn || d.surfacesAdded.length > 0 || grows;
    const employeeWidened = widen && (d.surfacesAdded.some(isEmployeeSurface) || (grows && body.surfaces.some(isEmployeeSurface)));
    const maintain = MAINTAIN_FIELDS.some((k) => (body[k] ?? null) !== storedValue(before, k));
    return {
        widen, narrow: isNarrowing(before, body), maintain, off: false,
        employeeWidened, visitorOnly: widen && !employeeWidened, switchOn: !wasOn,
    };
}
